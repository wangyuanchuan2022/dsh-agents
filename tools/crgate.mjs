#!/usr/bin/env node
/**
 * crgate — DSH 代码评审的确定性工程闸门（直译自 alibaba/open-code-review 的核心机制）
 *
 * 机制溯源（OCR 文件 → 本实现）：
 *   internal/agent/selection.go   纯函数文件选择器（闸门固定优先级链 + 封闭枚举排除理由）→ freeze
 *   internal/agent/agent.go       hashFields 长度前缀防字段拼接碰撞（:1094-1107）       → hashFields
 *   internal/diff/resolver.go     三级定位链（同文件 → 跨文件唯一命中 → 歧义即弃权）      → anchor
 *   internal/session/manifest.go  覆盖清单状态机（四态闭合 + 终态推导 + sweep 兜底）     → finalize
 *
 * 设计纪律（继承 OCR）：
 *   - 选择是纯函数：同一输入下 freeze 的结果确定，preview 与真实评审消费同一份 spec（防 #782 式漂移）
 *   - 秘密路径闸在用户规则之前：任何 include 都不能放行凭据文件
 *   - 排除理由取封闭枚举，不允许无理由缺项
 *   - 定位：歧义不得二选一；"位置未锚定" 价值高于指错行
 *   - 覆盖账：reviewed + skipped + blocked + waived == 分母；"没查"必须落账带理由
 *
 * 零依赖。git 子进程经 fd-stdio 捕获输出（DSH 沙箱内命名管道被禁，命名管道 spawnSync 会 EPERM；
 * 文件描述符 stdio 直传是已实证的合法通道）。
 *
 * 用法：
 *   node crgate.mjs freeze   --repo <dir> [--from <ref> --to <ref>] [--exclude <globs>] [--include <globs>] [--max-lines <n>] [--out <spec.json>]
 *   node crgate.mjs anchor   --repo <dir> --report <review.md> --spec <spec.json> [--strict] [--out <anchor-report.json>]
 *   node crgate.mjs finalize --spec <spec.json> --ledger <ledger.json> [--out <final.json>]
 *   node crgate.mjs hash     file <paths...> | fields <f1> <f2> ...
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, closeSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const VERSION = '1.0.0';
const SCHEMA_VERSION = '1';

/* ---------------- 基础工具 ---------------- */

function sha256hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function sha256_16(s) { return sha256hex(s).slice(0, 16); }

/** OCR agent.go:1094-1107 直译：每字段前置 8 字节大端长度前缀再折叠，防字段边界拼接碰撞。 */
export function hashFields(fields) {
  const h = createHash('sha256');
  for (const f of fields) {
    const buf = Buffer.from(String(f), 'utf8');
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(buf.length));
    h.update(len); h.update(buf);
  }
  return h.digest('hex').slice(0, 16).toUpperCase();
}

/** 极简 glob：支持 **（跨段）、*（段内）、?（单字符）、尾随 / 等价目录前缀。 */
export function globToRegex(glob) {
  let g = String(glob).trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function matchAny(globs, p) { return globs.some((g) => globToRegex(g).test(p)); }

/* ---------------- git 访问（fd-stdio，沙箱安全） ---------------- */

let tmpSeq = 0;
function runGit(repoDir, args) {
  const tag = `${process.pid}-${Date.now()}-${tmpSeq++}`;
  const outPath = join(tmpdir(), `crgate-out-${tag}.txt`);
  const errPath = join(tmpdir(), `crgate-err-${tag}.txt`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  try {
    const r = spawnSync('git', args, { cwd: repoDir, stdio: ['ignore', outFd, errFd] });
    const stdout = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
    return { code: r.status, stdout, stderr };
  } finally {
    closeSync(outFd); closeSync(errFd);
    try { rmSync(outPath, { force: true }); } catch {}
    try { rmSync(errPath, { force: true }); } catch {}
  }
}

/** 返回 stdout；git 失败时响亮报错（禁止静默降级）。 */
function gitOut(repoDir, args, what) {
  const r = runGit(repoDir, args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.code}) while ${what}: ${r.stderr.trim().slice(0, 400)}`);
  }
  return r.stdout;
}

/* ---------------- freeze：文件选择器（OCR selection.go 直译） ---------------- */

// 封闭枚举（OCR fileDecision.Reason 同构）
const REASONS = {
  DELETED: 'deleted', BINARY: 'binary', SECRET: 'secret-path', USER: 'user-excluded',
  EXT: 'extension-not-allowed', DEFAULT: 'default-excluded', LARGE: 'too-large', NONE: '',
};

const SECRET_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa*', 'id_ed25519*',
  '*.rsa', 'credentials*.json', 'secrets.*', '.npmrc', '.netrc', '*.keystore', '*.jks',
];
const DEFAULT_EXCLUDED = [
  'node_modules/**', 'dist/**', 'build/**', 'out/**', 'vendor/**', 'coverage/**',
  '.git/**', '__snapshots__/**', '*.min.js', '*.min.css', '*.map',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock',
  '*.pb.go', '*.pb.ts', '*.generated.*',
];
const ALLOWED_EXT = new Set((
  'js,ts,jsx,tsx,mjs,cjs,py,go,kt,kts,java,rs,c,h,cpp,hpp,cc,cs,rb,php,swift,scala,'
  + 'md,mdx,json,jsonc,yaml,yml,toml,ini,cfg,xml,html,htm,css,scss,less,sql,sh,bat,ps1,'
  + 'vue,svelte,astro,graphql,proto,tf,dockerfile,makefile,gradle,properties'
).split(','));

/** 闸门链：固定优先级 = binary → secret → user-exclude → user-include → ext → default-path → size。
 *  秘密闸先于用户规则（OCR selection.go:78-82：任何 include 都不能放行凭据路径）。 */
export function selectFiles(entries, opts) {
  const toArr = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);
  const userEx = toArr(opts.exclude);
  const userIn = toArr(opts.include);
  const maxLines = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : 0;
  const decisions = [];
  for (const e of entries) {
    const p = e.path;
    let reason = REASONS.NONE;
    do {
      if (e.status === 'D') { reason = REASONS.DELETED; break; }
      if (e.binary) { reason = REASONS.BINARY; break; }
      if (matchAny(SECRET_PATTERNS, p) || matchAny(SECRET_PATTERNS, p.split('/').pop())) { reason = REASONS.SECRET; break; }
      if (userEx.length && matchAny(userEx, p)) { reason = REASONS.USER; break; }
      if (userIn.length && matchAny(userIn, p)) break; // include 命中即入选（但翻不了上面两道闸）
      const ext = p.includes('.') ? p.split('.').pop().toLowerCase() : '';
      if (ext && !ALLOWED_EXT.has(ext)) { reason = REASONS.EXT; break; }
      if (!ext && !userIn.length && matchAny(DEFAULT_EXCLUDED, p)) { reason = REASONS.DEFAULT; break; }
      if (matchAny(DEFAULT_EXCLUDED, p)) { reason = REASONS.DEFAULT; break; }
      if (maxLines > 0 && (e.insertions + e.deletions) > maxLines) { reason = REASONS.LARGE; break; }
    } while (false);
    decisions.push({ ...e, exclude_reason: reason });
  }
  return decisions;
}

/** scan 模式（OCR `ocr scan` 对应物：陌生仓库/全量审计，无需 git 历史）。
 *  git 仓库 → 全部跟踪 + 未忽略未跟踪文件；非 git 目录 → 文件树遍历（跳过 .git）。
 *  同一闸门链（secret/ext/default/size）原样生效。 */
export function scanEntries(repoDir) {
  const entries = [];
  let files = [];
  if (existsSync(join(repoDir, '.git'))) {
    const out = gitOut(repoDir, ['ls-files', '--cached', '--others', '--exclude-standard'], 'scan: listing files');
    files = out.split(/\r?\n/).filter(Boolean);
  } else {
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const relPath = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), relPath);
        else files.push(relPath);
      }
    };
    walk(repoDir, '');
  }
  for (const p of files) {
    let binary = false; let lines = 0;
    try {
      const buf = readFileSync(join(repoDir, p));
      binary = buf.includes(0);
      if (!binary) lines = buf.toString('utf8').split('\n').length;
    } catch { binary = true; }
    entries.push({ path: p.replace(/\\/g, '/'), status: 'A', insertions: binary ? 0 : lines, deletions: 0, binary });
  }
  return entries;
}

function diffEntries(repoDir, from, to) {
  const entries = [];
  const range = from && to ? [from, to] : null;
  // range 模式取 merge-base（三点语义，OCR 同款）：审 feat 分支时不得把主干上的新改动算进来
  let base = from;
  if (range) {
    const mb = runGit(repoDir, ['merge-base', from, to]);
    base = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : from;
  }
  const nsArgs = range ? ['diff', '--name-status', base, to] : ['diff', '--name-status', 'HEAD'];
  const numArgs = range ? ['diff', '--numstat', base, to] : ['diff', '--numstat', 'HEAD'];
  const ns = gitOut(repoDir, nsArgs, 'reading name-status');
  const num = gitOut(repoDir, numArgs, 'reading numstat');
  const numMap = new Map();
  for (const line of num.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(line);
    if (!m) continue;
    const ins = m[1] === '-' ? -1 : parseInt(m[1], 10);
    const del = m[2] === '-' ? -1 : parseInt(m[2], 10);
    const key = m[3];
    numMap.set(key, { ins, del });
    const ar = key.indexOf(' => ');
    if (ar >= 0) numMap.set(key.slice(ar + 4).replace(/[{}]/g, ''), { ins, del });
  }
  const arrow = (s) => { const i = s.lastIndexOf(' => '); return i >= 0 ? s.slice(i + 4).replace(/[{}]/g, '') : s; };
  for (const line of ns.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const st = parts[0][0];
    let path, oldPath = '';
    if (st === 'R' || st === 'C') { oldPath = parts[1]; path = parts[2]; }
    else path = parts[1];
    const n = numMap.get(parts[parts.length - 1]) || numMap.get(path)
      || (oldPath ? numMap.get(`${oldPath} => ${path}`) : null)
      || numMap.get(oldPath) || { ins: 0, del: 0 };
    const binary = n.ins < 0 || n.del < 0;
    entries.push({
      path, old_path: oldPath || undefined, status: st,
      insertions: binary ? 0 : n.ins, deletions: binary ? 0 : n.del, binary,
    });
  }
  // 工作区模式补未跟踪文件（OCR workspace 模式含 untracked）
  if (!range) {
    const un = gitOut(repoDir, ['ls-files', '--others', '--exclude-standard'], 'listing untracked');
    for (const p of un.split(/\r?\n/)) {
      if (!p.trim() || entries.some((e) => e.path === p)) continue;
      let lines = 0; let binary = false;
      try {
        const buf = readFileSync(join(repoDir, p));
        binary = buf.includes(0);
        if (!binary) lines = buf.toString('utf8').split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1).length;
      } catch { binary = true; }
      entries.push({ path: p, status: 'A', insertions: binary ? 0 : lines, deletions: 0, binary });
    }
  }
  return entries;
}

function selectionHash(entries) {
  // 选择身份 = name-status + numstat 行的稳定序列哈希（内容级漂移检测靠 anchor/finalize 阶段）
  const canon = entries.map((e) => `${e.status}\t${e.old_path || ''}\t${e.path}\t${e.insertions}\t${e.deletions}\t${e.binary}`).sort().join('\n');
  return sha256_16(canon);
}

function cmdFreeze(args) {
  const repo = resolve(args.repo || '.');
  if (!existsSync(repo)) fail(`repo not found: ${repo}`);
  const isScan = !!args.all;
  let mode = isScan ? 'scan' : (args.from && args.to ? 'range' : 'workspace');
  let head = isGitRepo(repo) ? gitOut(repo, ['rev-parse', 'HEAD'], 'reading HEAD').trim() : '';
  let entries;
  let from = args.from || '', to = args.to || '';
  if (args.commit) {
    // 单提交模式（OCR --commit 对应物）：vs 第一父提交；根提交 vs 空树
    const rootTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const full = gitOut(repo, ['rev-parse', args.commit + '^{commit}'], 'resolving commit').trim();
    const pr = runGit(repo, ['rev-parse', '--verify', full + '^']);
    const parent = pr.code === 0 && pr.stdout.trim() ? pr.stdout.trim() : rootTree;
    entries = diffEntries(repo, parent, full);
    head = full; mode = 'commit'; from = parent; to = full;
  } else {
    entries = isScan ? scanEntries(repo) : diffEntries(repo, args.from, args.to);
  }
  const decisions = selectFiles(entries, {
    exclude: (args.exclude || '').split(','),
    include: (args.include || '').split(','),
    maxLines: args.maxLines ? parseInt(args.maxLines, 10) : 3000,
  });
  const reviewable = decisions.filter((d) => !d.exclude_reason);
  const excluded = decisions.filter((d) => d.exclude_reason);
  const selHash = selectionHash(decisions);
  const spec = {
    schema_version: SCHEMA_VERSION,
    crgate_version: VERSION,
    mode,
    repository: repo,
    from, to,
    head_sha: head,
    selection_hash: selHash,
    generated_at: new Date().toISOString(),
    total_files: decisions.length,
    reviewable_count: reviewable.length,
    excluded_count: excluded.length,
    total_insertions: reviewable.reduce((a, e) => a + e.insertions, 0),
    total_deletions: reviewable.reduce((a, e) => a + e.deletions, 0),
    reviewable_files: reviewable.map((e) => ({ path: e.path, status: e.status, insertions: e.insertions, deletions: e.deletions })),
    excluded_files: excluded.map((e) => ({ path: e.path, exclude_reason: e.exclude_reason })),
    warnings: reviewable.length > 40 ? ['large-changeset: reviewable files exceed 40; declare split-batches or partial in the report'] : [],
  };
  spec.spec_sha = sha256_16(JSON.stringify({ ...spec, spec_sha: undefined, generated_at: undefined }));
  const out = args.out || join(repo, 'review-spec.json');
  writeJson(out, spec);
  console.log(`[crgate] freeze: ${spec.reviewable_count} reviewable / ${spec.total_files} total` +
    ` (head=${spec.head_sha.slice(0, 12)}, selection=${selHash}) -> ${out}`);
  if (spec.warnings.length) spec.warnings.forEach((w) => console.log(`[crgate] WARNING: ${w}`));
  return spec;
}

/* ---------------- anchor：定位校验器（OCR resolver.go 直译） ---------------- */

const SEVERITY_TOKENS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** 从评审报告 markdown 抽取发现块：以 `位置:` 行为锚，向后读到下一个 `位置:` 或节标题。 */
export function parseFindings(markdown) {
  const lines = markdown.split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^位置:\s*(\S+?):(\d+)(?:-(\d+))?\s*$/.exec(lines[i].trim());
    if (!m) continue;
    const f = { claim_path: m[1], claim_line: parseInt(m[2], 10), claim_end: m[3] ? parseInt(m[3], 10) : undefined, raw_index: i };
    // 向后收集证据与严重度，直到下一个 位置: 或空行+节标题
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const t = lines[j].trim();
      if (/^位置:/.test(t)) break;
      if (/^#{2,3}\s/.test(t) && j > i + 1) break;
      const ev = /^证据:\s*(.*)$/.exec(t);
      if (ev && f.evidence === undefined) {
        const bt = /`([^`]+)`/.exec(ev[1]);
        f.evidence = bt ? bt[1] : ev[1].replace(/^["']|["']$/g, '');
      }
      const sv = /^(?:严重度|severity):\s*\[?([A-Za-z]+)\]??/.exec(t);
      if (sv && f.severity === undefined) {
        const up = sv[1].toUpperCase();
        f.severity = SEVERITY_TOKENS.includes(up) ? up : 'UNKNOWN';
      }
    }
    if (f.severity === undefined) f.severity = 'UNKNOWN';
    findings.push(f);
  }
  return findings;
}

/** 归一化：去所有空白 + 剥行首 +/-（OCR normalizeLine 同构）。 */
function normalize(s) { return String(s).replace(/\s+/g, '').replace(/^[+-]/, ''); }

function findInContent(content, snippet) {
  const exact = content.indexOf(snippet);
  if (exact >= 0) return { hit: true, exact: true };
  const nc = normalize(content); const ns = normalize(snippet);
  if (!ns) return { hit: false };
  const idx = nc.indexOf(ns);
  if (idx < 0) return { hit: false };
  // 近似命中：把归一化下标近似映射回原文行（按累计归一长度定位）
  let acc = 0; let line = 1; let lineStart = 0;
  const raw = content;
  for (let i = 0; i < raw.length; i++) {
    if (acc >= idx) { break; }
    if (raw[i] === '\n') { line++; lineStart = i + 1; }
    if (!/\s/.test(raw[i])) acc++;
  }
  return { hit: true, exact: false, line };
}

export function anchorFindings(findings, repoDir, scopeFiles, atCommit) {
  const cache = new Map();
  const readP = (p) => {
    if (cache.has(p)) return cache.get(p);
    let content = null; let missing = false;
    if (atCommit) {
      // 历史审查：对照被审快照（git show <commit>:<path>），而非工作区
      const r = runGit(repoDir, ['show', atCommit + ':' + p]);
      if (r.code === 0) content = r.stdout; else missing = true;
    } else {
      try { content = readFileSync(join(repoDir, p), 'utf8'); } catch { missing = true; }
    }
    const v = { content, missing };
    cache.set(p, v); return v;
  };
  const scope = new Set(scopeFiles);
  const results = [];
  for (const f of findings) {
    const r = { ...f, verdict: '', detail: '' };
    const file = readP(f.claim_path);
    if (file.missing) {
      r.verdict = 'unverifiable'; r.detail = 'file not readable at review time (deleted or path wrong)';
      results.push(r); continue;
    }
    if (!f.evidence) {
      r.verdict = 'no-evidence'; r.detail = 'finding has no 证据 line; nothing to anchor against';
      results.push(r); continue;
    }
    const inFile = findInContent(file.content, f.evidence);
    if (inFile.hit) {
      if (inFile.exact) {
        // 精确命中：核对声称行号附近（±3 行窗口）是否真有该片段
        const win = file.content.split(/\r?\n/).slice(Math.max(0, f.claim_line - 4), f.claim_line + 3).join('\n');
        r.verdict = win.includes(f.evidence.trim()) || normalize(win).includes(normalize(f.evidence)) ? 'anchored' : 'drifted';
        r.detail = r.verdict === 'anchored' ? 'exact hit at claimed line window' : `snippet exists in file but not at line ${f.claim_line}`;
      } else {
        r.verdict = 'anchored-fuzzy'; r.detail = `whitespace-normalized hit near line ${inFile.line || f.claim_line}`;
      }
      results.push(r); continue;
    }
    // 跨文件搜索（仅在冻结清单范围内）
    const hits = [];
    for (const p of scope) {
      if (p === f.claim_path) continue;
      const o = readP(p);
      if (o.missing || !o.content) continue;
      const hit = findInContent(o.content, f.evidence);
      if (hit.hit) hits.push({ path: p, line: hit.line || 0 });
      if (hits.length > 1) break; // 唯一命中才改判：歧义即弃权
    }
    if (hits.length === 1) { r.verdict = 'refiled'; r.detail = `evidence uniquely matches ${hits[0].path}${hits[0].line ? ':' + hits[0].line : ''}; claim should be refiled`; }
    else if (hits.length > 1) { r.verdict = 'ambiguous'; r.detail = `evidence matches ${hits.length} files (${hits.map((h) => h.path).join(', ')}); refusing to pick one`; }
    else { r.verdict = 'unanchored'; r.detail = 'evidence not found in claim file nor unique elsewhere; line number must stay blank'; }
    results.push(r);
  }
  return results;
}

function cmdAnchor(args) {
  const repo = resolve(args.repo || '.');
  const report = readFileSync(args.report, 'utf8');
  const spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  const scope = (spec.reviewable_files || []).map((e) => e.path)
    .concat((spec.excluded_files || []).map((e) => e.path)); // 被排除文件仍可作跨文件证据源（过滤≠不可见）
  const findings = parseFindings(report);
  if (!findings.length) { console.log('[crgate] anchor: no `位置:` findings found in report; nothing to verify'); return; }
  const results = anchorFindings(findings, repo, scope, args.at);
  const by = { anchored: 0, 'anchored-fuzzy': 0, drifted: 0, refiled: 0, ambiguous: 0, unanchored: 0, 'no-evidence': 0, unverifiable: 0 };
  let criticalBad = 0;
  for (const r of results) {
    by[r.verdict] = (by[r.verdict] || 0) + 1;
    const sev = r.severity || 'UNKNOWN';
    const bad = r.verdict === 'unanchored' || r.verdict === 'ambiguous' || r.verdict === 'no-evidence';
    if (bad && (sev === 'CRITICAL' || sev === 'HIGH')) criticalBad++;
    console.log(`[crgate] anchor ${r.verdict.toUpperCase().padEnd(12)} ${sev.padEnd(8)} ${r.claim_path}:${r.claim_line} — ${r.detail}`);
  }
  const out = args.out || join(dirname(args.report), 'anchor-report.json');
  writeJson(out, { schema_version: SCHEMA_VERSION, report: args.report, at: args.at || '', total: results.length, tally: by, critical_high_unanchored: criticalBad, findings: results });
  console.log(`[crgate] anchor: ${results.length} findings` + (args.at ? ` (against snapshot ${args.at.slice(0, 12)})` : '') + ` -> ${out}` + (args.strict ? ` [strict: ${criticalBad} CRITICAL/HIGH unanchored]` : ''));
  if (args.strict && criticalBad > 0) { console.error(`[crgate] STRICT FAIL: ${criticalBad} CRITICAL/HIGH findings lack a trustworthy anchor`); process.exitCode = 2; }
}

/* ---------------- finalize：覆盖账终局校验（OCR manifest.go validateLocked 直译） ---------------- */

const LEDGER_STATUS = ['reviewed', 'skipped', 'blocked', 'waived'];
const SKIPPED_REASONS = ['user-excluded', 'generated-or-binary', 'unrelated-change', 'over-size', 'tool-unreachable', 'checklist-missing'];

export function validateLedger(spec, ledger) {
  const errors = [];
  const reviewable = (spec.reviewable_files || []).map((e) => e.path);
  const items = ledger.items || [];
  const byPath = new Map();
  for (const it of items) {
    if (!LEDGER_STATUS.includes(it.status)) { errors.push(`unknown status "${it.status}" for ${it.path}`); continue; }
    if (byPath.has(it.path)) errors.push(`duplicate ledger entry for ${it.path}`);
    byPath.set(it.path, it);
    if (it.status !== 'reviewed' && !(it.reason || '').trim()) errors.push(`${it.status} entry for ${it.path} lacks reason`);
    if (it.status === 'skipped' && !(SKIPPED_REASONS.includes(it.reason) || SKIPPED_REASONS.some((r) => (it.reason || '').startsWith(r)))) {
      errors.push(`skipped reason for ${it.path} not in closed enum (${SKIPPED_REASONS.join('|')}|<enum>-prefixed)`);
    }
  }
  // 闭世界：分母中每个文件恰有一条；账中不存在分母外的路径（越界发现走报告单独节，不入账）
  for (const p of reviewable) if (!byPath.has(p)) errors.push(`missing ledger entry for ${p} (swept to failed/unknown)`);
  for (const p of byPath.keys()) if (!reviewable.includes(p)) errors.push(`ledger path outside frozen spec: ${p}`);
  const counts = { reviewed: 0, skipped: 0, blocked: 0, waived: 0, failed_unknown: 0 };
  for (const p of reviewable) {
    const it = byPath.get(p);
    if (!it) { counts.failed_unknown++; continue; }
    counts[it.status]++;
  }
  const terminal = errors.some((e) => e.startsWith('missing ledger entry')) || counts.failed_unknown > 0 ? 'failed'
    : (counts.skipped + counts.blocked + counts.waived === 0) ? 'complete' : 'partial';
  return { errors, counts, terminal, coverage_rate: reviewable.length ? counts.reviewed / reviewable.length : 0 };
}

function cmdFinalize(args) {
  const spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  const ledger = JSON.parse(readFileSync(args.ledger, 'utf8'));
  const v = validateLedger(spec, ledger);
  for (const e of v.errors) console.error(`[crgate] LEDGER ERROR: ${e}`);
  console.log(`[crgate] finalize: reviewed=${v.counts.reviewed} skipped=${v.counts.skipped} blocked=${v.counts.blocked}` +
    ` waived=${v.counts.waived} failed(unknown)=${v.counts.failed_unknown} -> terminal=${v.terminal}` +
    ` coverage=${(v.coverage_rate * 100).toFixed(1)}%`);
  const out = args.out || join(dirname(args.ledger), 'final.json');
  writeJson(out, { schema_version: SCHEMA_VERSION, terminal: v.terminal, counts: v.counts, coverage_rate: v.coverage_rate, errors: v.errors });
  console.log(`[crgate] finalize: verdict ${v.terminal} -> ${out}`);
  if (v.errors.length) { console.error(`[crgate] FINALIZE FAIL: ${v.errors.length} structural error(s)`); process.exitCode = 2; }
}

/* ---------------- hash 子命令 ---------------- */

function cmdHash(args) {
  if (args._[0] === 'file') {
    const o = {};
    for (const p of args._.slice(1)) o[p] = sha256_16(readFileSync(p, 'utf8'));
    console.log(JSON.stringify(o, null, 2));
  } else if (args._[0] === 'fields') {
    console.log(hashFields(args._.slice(1)));
  } else fail('hash: usage: crgate hash file <paths...> | fields <f1> <f2> ...');
}

/* ---------------- 入口 ---------------- */

function isGitRepo(dir) { return existsSync(join(dir, '.git')); }

function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function fail(msg) { console.error('[crgate] FAIL: ' + msg); process.exit(1); }

const BOOLEAN_FLAGS = new Set(['all', 'strict']);
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) args[name] = true;
      else args[name] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'freeze': return cmdFreeze(args);
    case 'anchor': return cmdAnchor(args);
    case 'finalize': return cmdFinalize(args);
    case 'hash': return cmdHash(args);
    default:
      console.log('crgate ' + VERSION + ' — deterministic gates for DSH code review (ported from alibaba/open-code-review)');
      console.log('  freeze   <repo> [--from --to | --commit <sha> | --all] [--exclude --include --max-lines --out] : 冻结覆盖分母 + 身份哈希（--commit=单提交 vs 父；--all=scan 全量审计；range 自动取 merge-base）');
      console.log('  anchor   --repo <dir> --report <md> --spec <json> [--strict] [--out]           : 三级定位校验（歧义即弃权）');
      console.log('  finalize --spec <json> --ledger <json> [--out]                                 : 覆盖账闭世界校验 + 终态推导');
      console.log('  hash     file <paths...> | fields <f1> <f2> ...                                : sha256-16 / 长度前缀字段哈希');
  }
}
main();
