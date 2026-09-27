#!/usr/bin/env node
/**
 * publish-scan -- 发布前脱敏机检（ECC opensource-sanitizer 的确定性工程直译 + DSH 本机适配）
 *
 * 机制溯源（ECC 文件 -> 本实现）：
 *   agents/opensource-sanitizer.md:31-197
 *     Step1 Secrets Scan（任意命中=FAIL）            -> SECRET_RULES（十类，逐字同源 memory-vault-format.js:49-60）
 *     Step2 PII Scan（消费级邮箱/内网IP/SSH，CRITICAL）-> PII_RULES + IP_RULES（+ 手机号特征，DSH 增量）
 *     Step3 Internal References（本机家目录/用户名）   -> INTERNAL_RULES（+ 本机用户名运行时解析，DSH 增量）
 *     Step4 Dangerous Files（存在即 FAIL）            -> DANGEROUS_FILE_RULES（凭证类 CRITICAL / 产物类 WARNING，见下适配）
 *     Step5 Configuration Completeness（WARNING）     -> .env.example 存在性 + docker-compose 硬编码 env 启发式
 *     Step6 Git History Audit                         -> --git-history 显式开启（默认 skipped 留痕）
 *   opensource-sanitizer.md:196  single CRITICAL = overall FAIL   -> verdictOf()
 *   opensource-packager.md:253   每条命令实测存在为硬门            -> repo-onboard 第 3 阶段（见配套技能 SKILL.md）
 *
 * 设计纪律（继承 ECC + 本机固化闸门纪律）：
 *   - 偏执优先：误报可接受，漏报不可接受（sanitizer:195）
 *   - 秘密值永不全量显示：命中片段截断掩码（sanitizer:191）
 *   - single CRITICAL = FAIL；仅 WARNING = PASS-WITH-WARNINGS；无发现 = PASS（:196-197）
 *   - 正则误报配 PASS-WITH-WARNINGS 中间档与人工复核口径：
 *       (a) 回环地址 127.0.0.0/8 = 文档化本机代理白名单，恒 WARNING
 *       (b) 典型占位样本（xxxx.../your/example/AKIAIOSFODNN7EXAMPLE 等）降级 WARNING
 *       (c) 内部路径/用户名/内网 IP 家族在纯文档文件（.md/.txt 等）降级 WARNING（人工复核），
 *           在可执行/配置面保持 CRITICAL（见 DOC_POLICY 注释）
 *   - 文档化 provenance 豁免：.publish-scan-allow.json（waivers[]，缺 reason 响亮报错）
 *   - 注入必红：publish-scan.test.mjs 变异体 fixture 必须全红，本闸门才算闭合
 *
 * DSH 适配声明（与 ECC 原文的差异，全部显式）：
 *   1) 本机用户名不做硬编码字面量（避免本工具入库时自身泄名）：运行时解析
 *      USERNAME/USER 环境变量或 os.userInfo()，可 --user 覆盖
 *   2) 危险文件分两级：凭证类（.env/key/pem/credentials.json 等）CRITICAL；
 *      产物类（*.map/__pycache__/venv 等）WARNING —— 发布流水线（技能文本）仍按 ECC
 *      原文「存在即 FAIL」由 agent 执行更严口径
 *   3) git 历史：根仓库非 git 或未开 --git-history 时记 skipped（原因+复跑命令），
 *      多提交仓库默认 WARNING，--strict-single-commit 升 CRITICAL（ECC 原文硬规则保留在技能侧）
 *   4) env 变量覆盖率（.env.example 双向比对）为 agent 级检查，工具记 skipped
 *   5) git-aware 发布面判定（v1.0.1 引入；v1.0.2 扩至全部内容类规则）：发布前脱敏的本义
 *      是查「会随 push 出去的内容」——位于 git 仓库内且未被 git ls-files 跟踪的文件，
 *      其 secrets/pii/internal/net 家族命中降级 WARNING（not-git-tracked, outside publish
 *      surface，仍列示人工复核）；tracked 文件保持 CRITICAL（push 放行门语义不变）。
 *      dangerous-files（文件级存在性）与 git-history 不降级（ECC 偏执条款保持）。
 *      --strict-tracked 关闭该降级恢复全 CRITICAL。
 *      两层定位：对工作区全量跑 = 卫生巡检（雷达）；对即将 push 的单仓跑 = 放行门（闸）。
 *   6) int-secrets-ref 的文档面降级（v1.0.1）：文档引用 .secrets/ 规则模式文本属常见误报；
 *      真正的 .secrets/ 目录存在性由 dg-secrets-dir 危险文件规则兜底（不受降级影响）。
 *   7) 掩码覆盖全部命中 span（v1.0.2 修复）：span 去重丢弃的命中若不掩码，其明文会随同行
 *      snippet 泄漏——S7 真实跑取证抓出（证据文件曾带出上游测试键明文）。
 *      另：顺序测试值（0123456789/1234567890/abcdefgh）入占位样本提示。
 *   8) 扫描器产物自豁免 + 短匹配掩码收紧（v1.0.3）：--allow 豁免清单（reason 引用被豁免
 *      模式的字面量）与 --out 报告 JSON（user 元数据/掩码片段）按绝对路径自豁免；
 *      掩码对 ≤6 字符匹配只留前 3 字符，防掩码文本在重扫时再次命中规则。
 *   9) git-history 面文件上下文自豁免（v1.0.4）：history diff 按 +++ b/<path> 跟踪当前文件，
 *      扫描器自身源码/自测文件的行（规则字面量+合成 fixture）跳过并计数留痕（849 行先例）。
 *  10) git-history 面 canonical-placeholder 降级（v1.0.5）：与文件面同口径——顺序测试值/
 *      x{8,}/your/example 等占位样本在 history 面同样降 WARNING，不误报 CRITICAL
 *      （先例：ECC sanitizer 原文讲解占位规则的句子本身含 sk-0123456789abcdef 举例）。
 *
 * 沙箱安全：git 子进程经 fd-stdio 捕获（DSH 沙箱命名管道 spawnSync EPERM，fd 直传是
 * 已实证合法通道，同 crgate.mjs）。stdout 全 ASCII（Windows GBK 控制台安全）。
 *
 * 用法：
 *   node publish-scan.mjs --repo <dir> [--out <report.json>] [--json]
 *        [--max-files <n>] [--max-file-kb <n>] [--exclude <glob>]... [--extra-ignore <dir>]...
 *        [--allow <allowlist.json>] [--git-history] [--max-history-commits <n>]
 *        [--strict-single-commit] [--strict-tracked] [--user <name>]
 *   退出码：0 = PASS / PASS-WITH-WARNINGS；1 = FAIL；2 = 用法或 IO 错误（响亮）
 */
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, readdirSync, existsSync, rmSync,
  openSync, closeSync,
} from 'node:fs';
import { dirname, join, resolve, extname, basename, relative } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const VERSION = '1.0.3';
const SCHEMA = '1';

/* ---------------- 十类秘密模式（IMP-03 同源：memory-vault-format.js:49-60 逐字） ---------------- */

export const SECRET_RULES = [
  { id: 'sec-provider-key', label: 'provider API key', source: '\\bsk-[A-Za-z0-9_-]{16,}\\b', flags: 'gi' },
  { id: 'sec-stripe-live', label: 'Stripe key', source: '\\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\\b', flags: 'g' },
  { id: 'sec-npm-token', label: 'npm token', source: '\\bnpm_[A-Za-z0-9]{20,}\\b', flags: 'g' },
  { id: 'sec-hf-token', label: 'Hugging Face token', source: '\\bhf_[A-Za-z0-9]{20,}\\b', flags: 'g' },
  { id: 'sec-github-token', label: 'GitHub token', source: '\\bgh[pors]_[A-Za-z0-9_]{16,}\\b', flags: 'g' },
  { id: 'sec-github-pat', label: 'GitHub token', source: '\\bgithub_pat_[A-Za-z0-9_]{16,}\\b', flags: 'g' },
  { id: 'sec-google-key', label: 'Google API key', source: '\\bAIza[A-Za-z0-9_-]{16,}\\b', flags: 'g' },
  { id: 'sec-slack-token', label: 'Slack token', source: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b', flags: 'g' },
  { id: 'sec-aws-key', label: 'AWS access key', source: '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b', flags: 'g' },
  { id: 'sec-private-key', label: 'private key', source: '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----', flags: 'g' },
];

/** 秘密占位样本降级（canonical-placeholder）：命中的【匹配文本】含这些特征时 CRITICAL -> WARNING。 */
const PLACEHOLDER_HINTS = [
  /x{8,}/i,
  /your|example|placeholder|dummy|fake|sample|changeme|replace[_-]?me|redacted/i,
  /^<.*>$/,
  // 顺序测试值（上游测试常见假键，如 sk-0123456789abcdef）
  /(?:0123456789|1234567890|abcdefgh)/i,
];

/* ---------------- PII（sanitizer Step2 + DSH 手机号增量） ---------------- */

export const PII_RULES = [
  { id: 'pii-email-consumer', label: 'personal email (consumer provider)', severity: 'critical',
    source: '[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|protonmail|icloud)\\.(com|net|org)', flags: 'gi',
    // 已知占位邮箱（如 user@gmail.com 示例位）按占位样本口径降级
    placeholder: /^user@|^name@|^email@|^your[a-z._-]*@/i },
  { id: 'pii-phone-cn', label: 'CN mobile number', severity: 'critical',
    source: '(?<![0-9A-Za-z])1[3-9]\\d{9}(?![0-9A-Za-z])', flags: 'g',
    // 中国移动官方示例号 13800138000：恒降级 WARNING（canonical-placeholder）
    whitelist: (m) => m === '13800138000' },
];

/* ---------------- 内网地址（loopback 白名单恒 WARNING；其余内网 IP 上下文分级） ---------------- */

export const IP_RULES = [
  { id: 'net-loopback', label: 'loopback address (documented local proxy whitelist)', severity: 'warning', alwaysWarning: true,
    source: '(?<![\\d.])(?:127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})(?![\\d.])', flags: 'g' },
  { id: 'net-private', label: 'private/internal IPv4', severity: 'critical',
    source: '(?<![\\d.])(?:192\\.168\\.\\d{1,3}\\.\\d{1,3}|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})(?![\\d.])', flags: 'g' },
];

/* ---------------- 内部引用（sanitizer Step3 + DSH 本机用户名增量） ---------------- */

export const INTERNAL_RULES = [
  { id: 'int-win-home', label: 'Windows home path', severity: 'critical',
    source: '(?<![A-Za-z0-9])[Cc]:[\\\\/]+Users[\\\\/]+[A-Za-z][A-Za-z0-9_-]*', flags: 'g' },
  { id: 'int-nix-home', label: 'Linux home path', severity: 'critical',
    source: '/home/(?!user/)[a-z][a-z0-9_-]*/', flags: 'g' }, // ECC：/home/user/ 豁免
  { id: 'int-mac-home', label: 'macOS home path', severity: 'critical',
    source: '(?<![A-Za-z:])\\/Users\\/[A-Za-z][A-Za-z0-9_-]*\\/', flags: 'g' },
  { id: 'int-secrets-ref', label: '.secrets reference', severity: 'critical',
    source: '\\.secrets[\\\\/]|source\\s+~\\/\\.secrets', flags: 'g' },
  { id: 'int-ssh-string', label: 'SSH connection string', severity: 'critical',
    source: '\\bssh\\s+[a-z][a-z0-9_-]*@[0-9.]+', flags: 'gi' },
  // 本机用户名（运行时注入，见 resolveLocalUser）；优先级最低，与家目录重叠时被 span 去重吸收
  { id: 'int-username', label: 'local username', severity: 'critical', dynamic: true },
];

/**
 * 文档面降级口径（DSH 适配，报告须注明）：
 * 内部路径/本机用户名/内网 IP/.secrets 文本引用命中在纯文档文件（.md/.markdown/.mdx/.txt/.rst/.adoc）
 * 降级为 WARNING（人工复核）；在可执行/配置面保持 CRITICAL。
 * 依据：任务书「正则误报配 PASS-WITH-WARNINGS 中间档与人工复核口径说明」——
 * 文档行文引用本机路径/规则模式属常见误报源，但仍是披露，须人工过目，不得静默放行。
 * （.secrets 的目录存在性另由 dg-secrets-dir 危险文件规则兜底，不受本降级影响。）
 */
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc']);
const INTERNAL_DOC_DOWNGRADE = new Set(['int-win-home', 'int-nix-home', 'int-mac-home', 'int-username', 'net-private', 'int-secrets-ref']);

/* ---------------- 危险文件（sanitizer Step4；凭证类 CRITICAL / 产物类 WARNING） ---------------- */

export const DANGEROUS_FILE_RULES = [
  { id: 'dg-env', klass: 'credential', severity: 'critical', label: '.env variant', file: /^\.env(\.|$)/i, exempt: /\.env\.(example|sample|template)$/i },
  { id: 'dg-keyfile', klass: 'credential', severity: 'critical', label: 'key/cert file', file: /\.(pem|key|p12|pfx|jks)$/i },
  { id: 'dg-credentials-json', klass: 'credential', severity: 'critical', label: 'credentials json', file: /^(credentials|service-account.*)\.json$/i },
  { id: 'dg-ssh-key', klass: 'credential', severity: 'critical', label: 'SSH private key', file: /^id_(rsa|ed25519|ecdsa)(\..+)?$/i, exempt: /\.pub$/i },
  { id: 'dg-secrets-dir', klass: 'credential', severity: 'critical', label: 'secrets directory', dir: /^(\.secrets|secrets)$/i },
  { id: 'dg-claude-settings', klass: 'credential', severity: 'critical', label: '.claude/settings.json', relfile: /^\.claude\/settings\.json$/i },
  { id: 'dg-sourcemap', klass: 'artifact', severity: 'warning', label: 'source map', file: /\.map$/i },
  { id: 'dg-artifact-dir', klass: 'artifact', severity: 'warning', label: 'build artifact directory', dir: /^(__pycache__|\.venv|venv)$/i },
];

/** 组织者钉死的默认忽略目录（静默跳过，统计留痕；覆盖 ECC 危险清单中的 node_modules/sessions 项，见报告 §6）。 */
export const DEFAULT_IGNORE_DIRS = ['node_modules', '.git', 'sessions', 'agent-out'];

/* ---------------- 工具函数 ---------------- */

const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, '?');
const toRel = (p) => p.split('\\').join('/');

/** 极简 glob（同 crgate 风格）：** 跨段、* 段内、? 单字符、尾随 / 等价目录前缀。 */
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
  return new RegExp('^' + re + '$', 'i');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 本机用户名运行时解析（避免工具自身入库泄名）。 */
export function resolveLocalUser() {
  const envUser = process.env.USERNAME || process.env.USER;
  if (envUser && /^[A-Za-z0-9_-]{2,}$/.test(envUser)) return envUser;
  try {
    const info = userInfo({ encoding: 'utf8' });
    if (info.username && /^[A-Za-z0-9_-]{2,}$/.test(info.username)) return info.username;
  } catch { /* sandbox-restricted; fall through */ }
  return null;
}

/** 掩码：报告自身不落明文（sanitizer:191 永不全量显示）。短匹配只留前 3 字符——
 *  防止掩码文本本身（如 ycwan...）在后续重扫时再次命中规则（v1.0.3）。 */
function maskMatch(m) {
  if (m.length <= 6) return m.slice(0, 3) + '...';
  return m.slice(0, 6) + '...';
}

function makeSnippet(line, spans) {
  // 按命中区间替换为掩码，行截断 160 字符；零长 span 直接丢弃（空匹配无掩码语义）
  let out = '';
  let pos = 0;
  for (const sp of spans.sort((a, b) => a.start - b.start)) {
    if (sp.end <= sp.start || sp.start < pos) continue;
    out += line.slice(pos, sp.start) + maskMatch(line.slice(sp.start, sp.end));
    pos = sp.end;
  }
  out += line.slice(pos);
  out = out.trim();
  return out.length > 160 ? out.slice(0, 157) + '...' : out;
}

/* ---------------- git 访问（fd-stdio，沙箱安全；同 crgate.mjs 模式） ---------------- */

let tmpSeq = 0;
function runGit(repoDir, args) {
  const tag = `${process.pid}-${Date.now()}-${tmpSeq++}`;
  const outPath = join(tmpdir(), `pubscan-out-${tag}.txt`);
  const errPath = join(tmpdir(), `pubscan-err-${tag}.txt`);
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

function scanHistory(repoDir, opts, findings, skipped) {
  const count = runGit(repoDir, ['rev-list', '--count', 'HEAD']);
  if (count.code !== 0) {
    skipped.push({ item: 'git-history', reason: `git rev-list failed: ${count.stderr.trim().slice(0, 120)}`, rerun: 'git -C <repo> rev-list --count HEAD' });
    return;
  }
  const commits = parseInt(count.stdout.trim(), 10) || 0;
  if (commits > 1) {
    findings.push({
      id: findings.length + 1, category: 'git-history', severity: opts.strictSingleCommit ? 'critical' : 'warning',
      rule: 'git-multi-commit', file: '(git)', line: 0,
      snippet: `commit count = ${commits}`, reason: opts.strictSingleCommit
        ? 'ECC sanitizer Step6: release fork must be a single initial commit (--strict-single-commit)'
        : 'multi-commit history; single-initial-commit rule (ECC Step6) enforced at skill stage 6 for release forks',
    });
  }
  const cap = Math.min(opts.maxHistoryCommits, commits);
  const log = runGit(repoDir, ['log', '-p', '-n', String(cap)]);
  if (log.code !== 0) {
    skipped.push({ item: 'git-history-patch', reason: `git log -p failed: ${log.stderr.trim().slice(0, 120)}`, rerun: 'git -C <repo> log -p -n 50' });
    return;
  }
  // v1.0.4 自豁免（git-history 面）：扫描器自身源码/自测文件合法携带规则字面量与合成
  // fixture 样本，history diff 里的这些行按文件上下文豁免（与工作区面的 isSelf 同口径）。
  // 文件上下文来自 diff 头 +++ b/<path>；豁免计数进 stats.selfExempt 保持诚实留痕。
  const selfRel = new Set();
  try {
    const selfAbsDir = dirname(fileURLToPath(import.meta.url));
    const relDir = relative(resolve(repoDir), selfAbsDir).replace(/\\/g, '/');
    if (relDir && !relDir.startsWith('..')) {
      selfRel.add((relDir + '/publish-scan.mjs').toLowerCase());
      selfRel.add((relDir + '/publish-scan.test.mjs').toLowerCase());
    }
  } catch { /* non-file URL */ }
  let selfExemptLines = 0;
  const lines = log.stdout.split('\n');
  let hash = '';
  let curFile = '';
  for (let i = 0; i < lines.length; i++) {
    const cm = /^commit ([0-9a-f]{7,40})/.exec(lines[i]);
    if (cm) hash = cm[1].slice(0, 12);
    const fm = /^\+\+\+ b\/(.+)$/.exec(lines[i]);
    if (fm) curFile = fm[1].trim().toLowerCase();
    if (selfRel.size > 0 && selfRel.has(curFile)) {
      // 该行属于扫描器自身文件：内容为规则定义/fixture 样本，跳过但计数留痕
      if (/^\+/.test(lines[i]) && lines[i].length > 1) selfExemptLines++;
      continue;
    }
    for (const rule of SECRET_RULES) {
      const re = new RegExp(rule.source, rule.flags.replace('g', '') + 'g');
      let mm;
      while ((mm = re.exec(lines[i])) !== null) {
        // v1.0.5 口径统一：history 面同享文件面的 canonical-placeholder 降级
        // （顺序测试值/x{8,}/your/example/... → WARNING），避免文档里讲解占位样本
        // 的文本（如 ECC sanitizer 原文举例 sk-0123456789abcdef）在 history 面误报 CRITICAL。
        const isPlaceholder = PLACEHOLDER_HINTS.some((h) => h.test(mm[0]));
        findings.push({
          id: findings.length + 1, category: 'git-history',
          severity: isPlaceholder ? 'warning' : 'critical',
          rule: rule.id,
          file: `git-history:${hash}`, line: i + 1, snippet: maskMatch(mm[0]),
          reason: `secret-like pattern in history (${rule.label})` + (isPlaceholder ? ' [canonical-placeholder downgrade]' : ''),
        });
        if (re.lastIndex === mm.index) re.lastIndex++;
      }
    }
  }
  if (selfExemptLines > 0) {
    skipped.push({
      item: 'git-history-self-exempt',
      reason: `scanner's own files (rules/fixtures) in history: ${selfExemptLines} added lines exempted by file context`,
      rerun: 'inspect git log -p -- tools/publish-scan.mjs tools/publish-scan.test.mjs manually',
    });
  }
}

/* ---------------- provenance 豁免清单 ---------------- */

function loadAllowlist(allowPath) {
  if (!allowPath) return [];
  if (!existsSync(allowPath)) throw new Error(`allowlist not found: ${allowPath}`);
  const raw = JSON.parse(readFileSync(allowPath, 'utf8'));
  const waivers = raw.waivers || [];
  if (!Array.isArray(waivers)) throw new Error('allowlist.waivers must be an array');
  for (const w of waivers) {
    if (!w.id || !w.glob || !w.reason) throw new Error('each waiver requires { id, glob, reason } (documented provenance)');
  }
  return waivers.map((w) => ({ ...w, re: globToRegex(w.glob) }));
}

/* ---------------- 主扫描 ---------------- */

export function scanRepo(rootDir, opts = {}) {
  const root = resolve(rootDir);
  if (!existsSync(root)) throw new Error(`repo not found: ${root}`);
  const t0 = Date.now();
  const user = opts.user !== undefined ? opts.user : resolveLocalUser();
  const maxFiles = opts.maxFiles ?? 20000;
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  const excludeRes = (opts.excludeGlobs || []).map(globToRegex);
  const extraIgnores = new Set(opts.extraIgnoreDirs || []);
  const waivers = loadAllowlist(opts.allowPath);
  const skipped = [];
  const findings = [];
  const stats = {
    filesScanned: 0, ignoredDirEntries: 0, skippedBinary: 0, skippedLarge: 0,
    truncated: false, elapsedMs: 0, maxFilesCap: maxFiles,
  };
  let sawEnvExample = false;
  let sawPlainEnv = false;
  let overflowFiles = 0;
  let overflowFindings = 0;

  const pushFinding = (f) => {
    if (findings.length >= 5000) { overflowFindings++; return; }
    findings.push({ id: findings.length + 1, ...f });
  };

  // 动态规则：本机用户名
  const dynamicInternal = [];
  if (user) {
    dynamicInternal.push({
      id: 'int-username', label: `local username (${user})`, severity: 'critical',
      re: new RegExp('(?<![A-Za-z0-9])' + escapeRe(user) + '(?![A-Za-z0-9])', 'gi'),
    });
  } else {
    skipped.push({ item: 'int-username', reason: 'local username unresolved (no USERNAME/USER env)', rerun: 'node publish-scan.mjs --repo <dir> --user <name>' });
  }

  const contentRules = [];
  for (const r of SECRET_RULES) contentRules.push({ ...r, category: 'secrets', prio: 0, base: 'critical' });
  for (const r of PII_RULES) contentRules.push({ ...r, category: 'pii', prio: 1, base: r.severity });
  for (const r of IP_RULES) contentRules.push({ ...r, category: 'internal', prio: 3, base: r.severity });
  for (const r of INTERNAL_RULES) {
    if (r.dynamic) continue;
    contentRules.push({ ...r, category: 'internal', prio: 2, base: r.severity });
  }
  for (const r of dynamicInternal) contentRules.push({ ...r, category: 'internal', prio: 2, base: 'critical' });

  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...extraIgnores]);

  // git-aware 发布面判定（v1.0.1 适配）：发布前脱敏的本义是「查会随 push 出去的内容」。
  // 对位于 git 仓库内的文件，用 git ls-files 建 tracked 集合：untracked/ignored 文件的
  // 内部路径家族命中降级 WARNING（not-git-tracked, outside publish surface——仍列示，人工复核）；
  // tracked 文件保持 CRITICAL（push 放行门语义不变，--strict-tracked 可关本降级）。
  // 非 git 目录无信息，保守不降级。tracked 集合按仓库根懒加载缓存；git 失败视为无信息。
  const strictTracked = !!opts.strictTracked;
  const repoCache = new Map();
  const trackedRepos = new Set();
  function getTracked(repoRoot) {
    if (repoCache.has(repoRoot)) return repoCache.get(repoRoot);
    const r = runGit(repoRoot, ['ls-files', '-z']);
    let set = null;
    if (r.code === 0) set = new Set(r.stdout.split('\0').filter(Boolean));
    repoCache.set(repoRoot, set);
    if (set) trackedRepos.add(toRel(repoRoot).replace(/\\/g, '/'));
    return set;
  }

  // 扫描器自豁免（标准做法，显式留痕）：① 本工具与其自测文件携带规则字面量与 fixture
  // 样本；② --allow 豁免清单的 reason 文本会引用被豁免的模式字面量；③ --out 报告 JSON
  // 自身携带 user 元数据与掩码片段。扫描自己的产物只会命中自己——按绝对路径精确豁免。
  let selfDir = null;
  try { selfDir = dirname(fileURLToPath(import.meta.url)); } catch { /* non-file URL */ }
  const selfFiles = new Set(
    selfDir ? ['publish-scan.mjs', 'publish-scan.test.mjs'].map((f) => join(selfDir, f).toLowerCase()) : [],
  );
  if (opts.allowPath) selfFiles.add(resolve(opts.allowPath).toLowerCase());
  if (opts.outPath) selfFiles.add(resolve(opts.outPath).toLowerCase());
  const isSelf = (absPath) => selfFiles.has(absPath.toLowerCase());

  const isDoc = (rel) => DOC_EXTS.has(extname(rel).toLowerCase());
  const isExcluded = (rel) => excludeRes.some((re) => re.test(rel));
  const highEntropyScope = (rel) => {
    const b = basename(rel).toLowerCase();
    return b.startsWith('.env') || /\.(ini|cfg|conf)$/.test(b) || /^docker-compose.*\.ya?ml$/.test(b);
  };

  function scanFile(absPath, rel, untracked) {
    let buf;
    try { buf = readFileSync(absPath); } catch (e) {
      skipped.push({ item: `read:${rel}`, reason: `read failed: ${e.message.slice(0, 80)}`, rerun: 'check file permissions' });
      return;
    }
    if (buf.length > maxFileBytes) { stats.skippedLarge++; return; }
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) { stats.skippedBinary++; return; }
    const bname = basename(rel).toLowerCase();
    const text = buf.toString('utf8');
    const docCtx = isDoc(rel);
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;
      const hits = [];
      for (const rule of contentRules) {
        // 动态规则携带预编译 RegExp，静态规则携带 source/flags——统一在此逐行新建实例，
        // 既兼容两种来源，又避免 /g 的 lastIndex 状态跨行/跨文件泄漏
        const re = rule.re instanceof RegExp
          ? new RegExp(rule.re.source, rule.re.flags)
          : new RegExp(rule.source, rule.flags);
        let m;
        while ((m = re.exec(line)) !== null) {
          const matched = m[0];
          let severity = rule.base;
          let reason = rule.label;
          if (rule.category === 'secrets' && PLACEHOLDER_HINTS.some((h) => h.test(matched))) {
            severity = 'warning'; reason += ' [canonical-placeholder downgrade]';
          }
          if (rule.id === 'pii-email-consumer' && rule.placeholder && rule.placeholder.test(matched)) {
            severity = 'warning'; reason += ' [canonical-placeholder downgrade]';
          }
          if (rule.id === 'pii-phone-cn' && rule.whitelist && rule.whitelist(matched)) {
            severity = 'warning'; reason += ' [canonical-placeholder downgrade]';
          }
          if (rule.alwaysWarning) { severity = 'warning'; reason += ' [documented loopback proxy whitelist]'; }
          // 降级两通道（v1.0.2）：文档面降级只限内部路径/用户名/内网IP/.secrets文本引用；
          // untracked 降级适用全部内容类规则（secrets/pii/internal/net）——发布面判定对家族一致，
          // dangerous-files（文件级存在性）与 git-history 不参与（ECC 偏执条款保持）。
          const docEligible = INTERNAL_DOC_DOWNGRADE.has(rule.id) && docCtx;
          const untrackedEligible = untracked && !strictTracked;
          if (severity === 'critical' && (docEligible || untrackedEligible)) {
            severity = 'warning';
            reason += docEligible ? ' [docs-context manual review]' : ' [not git-tracked, outside publish surface (manual review)]';
          }
          hits.push({ start: m.index, end: m.index + matched.length, severity, reason, ruleId: rule.id, category: rule.category, prio: rule.prio });
          if (re.lastIndex === m.index) re.lastIndex++;
          if (hits.length > 50) break;
        }
        if (hits.length > 50) break;
      }
      // 高熵配置启发式（sanitizer Step1 heuristic，WARNING）
      if (highEntropyScope(rel) && !/^\s*#/.test(line)) {
        const he = /^[A-Z_][A-Z0-9_]*=['"]?[A-Za-z0-9+/=_-]{32,}['"]?\s*$/.exec(line.trim());
        if (he) hits.push({ start: 0, end: line.length, severity: 'warning', reason: 'high-entropy config value [manual review]', ruleId: 'cfg-high-entropy', category: 'config', prio: 4 });
      }
      // docker-compose 硬编码 env（Step5，WARNING）
      if (/^docker-compose.*\.ya?ml$/i.test(basename(rel))) {
        const hc = /^\s*(?:-\s*)?([A-Z][A-Z0-9_]{2,})\s*[:=]\s*(\S.*)$/.exec(line);
        if (hc && !/^\$\{/.test(hc[2]) && hc[2] !== 'null') {
          hits.push({ start: 0, end: line.length, severity: 'warning', reason: `hardcoded env value in compose (${hc[1]}) [manual review]`, ruleId: 'cfg-hardcoded-env', category: 'config', prio: 4 });
        }
      }
      if (!hits.length) continue;
      // span 去重：同区间只留优先级最高的一条（secrets > pii > internal > net > heuristic）
      hits.sort((a, b) => (a.start - b.start) || (a.prio - b.prio) || (b.end - a.end));
      let prevEnd = -1;
      const kept = [];
      for (const h of hits) {
        if (h.start < prevEnd) continue;
        kept.push(h); prevEnd = h.end;
      }
      // 掩码纪律（v1.0.2 修复）：对本行【全部】命中 span 掩码——被去重丢弃的命中
      // 若不掩码，其明文会随 kept 命中的 snippet 泄漏（S7 真实跑取证抓出）。
      const lineSnippet = makeSnippet(line, hits);
      for (const h of kept) {
        pushFinding({
          category: h.category, severity: h.severity, rule: h.ruleId,
          file: toRel(rel), line: li + 1, snippet: lineSnippet, reason: h.reason,
        });
      }
    }
  }

  function walk(dir, relBase, repoRoot, repoRelBase) {
    if (stats.truncated) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) {
      skipped.push({ item: `dir:${toRel(relBase) || '.'}`, reason: `readdir failed: ${e.message.slice(0, 80)}`, rerun: 'check dir permissions' });
      return;
    }
    for (const ent of entries) {
      if (stats.truncated) return;
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (isExcluded(rel)) { stats.ignoredDirEntries++; continue; }
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) { stats.ignoredDirEntries++; continue; }
        const dgDir = DANGEROUS_FILE_RULES.find((r) => r.dir && r.dir.test(ent.name));
        if (dgDir) {
          pushFinding({ category: 'dangerous-files', severity: dgDir.severity, rule: dgDir.id, file: toRel(rel) + '/', line: 0, snippet: '', reason: dgDir.label + (dgDir.klass === 'credential' ? '' : ' [artifact-class]') });
          continue; // 秘密目录/产物目录不再下钻
        }
        const absSub = join(dir, ent.name);
        // 进入含 .git 的目录即切换仓库根（tracked 判定以此为界）
        const subIsRepo = existsSync(join(absSub, '.git'));
        const subRepo = subIsRepo ? absSub : repoRoot;
        const subRepoRel = subIsRepo ? '' : (repoRelBase ? repoRelBase + '/' + ent.name : ent.name);
        walk(absSub, rel, subRepo, subRepoRel);
      } else if (ent.isFile()) {
        if (stats.filesScanned >= maxFiles) { stats.truncated = true; overflowFiles++; return; }
        const absFile = join(dir, ent.name);
        if (isSelf(absFile)) { stats.selfExempt = (stats.selfExempt || 0) + 1; continue; }
        stats.filesScanned++;
        let untracked = false;
        if (repoRoot) {
          const tracked = getTracked(repoRoot);
          if (tracked) untracked = !tracked.has(repoRelBase ? repoRelBase + '/' + ent.name : ent.name);
        }
        if (toRel(rel) === '.env.example') sawEnvExample = true;
        const dgFile = DANGEROUS_FILE_RULES.find((r) => r.file && r.file.test(ent.name) && !(r.exempt && r.exempt.test(ent.name)));
        const dgRel = DANGEROUS_FILE_RULES.find((r) => r.relfile && r.relfile.test(toRel(rel)));
        const dg = dgFile || dgRel;
        if (dg) {
          pushFinding({ category: 'dangerous-files', severity: dg.severity, rule: dg.id, file: toRel(rel), line: 0, snippet: '', reason: dg.label + (dg.klass === 'credential' ? '' : ' [artifact-class]') });
          if (dg.id === 'dg-env' && dgFile) sawPlainEnv = true;
        }
        if (dg && dg.klass === 'credential') continue; // 凭证文件内容不回读（防报告泄密），存在即记
        scanFile(absFile, rel, untracked);
      }
    }
  }

  walk(root, '', existsSync(join(root, '.git')) ? root : null, '');

  // Step5 配置完整性：有 .env 无 .env.example -> WARNING
  if (sawPlainEnv && !sawEnvExample) {
    pushFinding({ category: 'config', severity: 'warning', rule: 'cfg-env-example-missing', file: '(root)', line: 0, snippet: '', reason: '.env present but .env.example missing (Step5)' });
  }

  // git 历史（显式开启）
  const isGitRepo = existsSync(join(root, '.git'));
  if (opts.gitHistory) {
    if (!isGitRepo) {
      skipped.push({ item: 'git-history', reason: 'target is not a git repository', rerun: 'node publish-scan.mjs --repo <git-dir> --git-history' });
    } else {
      scanHistory(root, opts, findings, skipped);
    }
  } else {
    skipped.push({
      item: 'git-history',
      reason: opts.gitHistory === false && isGitRepo ? '--git-history not requested (target has .git)' : 'target is not a git repository / flag off',
      rerun: 'node publish-scan.mjs --repo <dir> --git-history',
    });
  }
  // agent 级检查：env 变量覆盖率（Step5 双向比对）
  skipped.push({ item: 'cfg-env-var-coverage', reason: 'agent-level check (code env vars vs .env.example), not machine-checkable here', rerun: 'run skill opensource-sanitize Step5 manually' });

  // provenance 豁免（文档化）
  let waived = 0;
  for (const f of findings) {
    const w = waivers.find((x) => x.id === f.rule && x.re.test(f.file));
    if (w) { f.status = 'waived'; f.waiveReason = w.reason; waived++; }
  }

  stats.elapsedMs = Date.now() - t0;
  stats.gitTrackedRepos = trackedRepos.size;
  const active = findings.filter((f) => f.status !== 'waived');
  const critical = active.filter((f) => f.severity === 'critical');
  const warnings = active.filter((f) => f.severity === 'warning');
  const verdict = critical.length > 0 ? 'FAIL' : (warnings.length > 0 ? 'PASS-WITH-WARNINGS' : 'PASS');
  return {
    tool: 'publish-scan', version: VERSION, schema: SCHEMA,
    target: root, generatedAt: new Date().toISOString(),
    options: {
      user: user || null, maxFiles, maxFileBytes,
      excludeGlobs: opts.excludeGlobs || [], extraIgnoreDirs: opts.extraIgnoreDirs || [],
      ignoreDirs: [...ignoreDirs], allowPath: opts.allowPath || null,
      gitHistory: !!opts.gitHistory, strictSingleCommit: !!opts.strictSingleCommit,
      strictTracked,
    },
    stats: { ...stats, overflowFiles, overflowFindings },
    counts: { critical: critical.length, warning: warnings.length, waived, total: findings.length },
    verdict,
    verdictReason: critical.length > 0
      ? `single CRITICAL = FAIL (ECC opensource-sanitizer.md:196), critical=${critical.length}`
      : (warnings.length > 0 ? `no CRITICAL; ${warnings.length} warning(s) need manual review` : 'clean'),
    findings, skipped,
  };
}

export function verdictOf(report) { return report.verdict; }

/* ---------------- CLI ---------------- */

function printSummary(r) {
  const o = (s) => ascii(s);
  const out = [];
  out.push(`[PUBLISH-SCAN] v${r.version} target=${o(r.target)}`);
  out.push(`[STATS] files=${r.stats.filesScanned} ignored-dir-entries=${r.stats.ignoredDirEntries} binary-skip=${r.stats.skippedBinary} large-skip=${r.stats.skippedLarge} truncated=${r.stats.truncated} git-repos=${r.stats.gitTrackedRepos || 0} elapsedMs=${r.stats.elapsedMs}`);
  if (r.stats.truncated) out.push(`[WARN] MAX-FILES CAP REACHED (${r.stats.maxFilesCap}) - evidence incomplete, raise --max-files and re-run`);
  for (const cat of ['secrets', 'pii', 'internal', 'dangerous-files', 'config', 'git-history']) {
    const c = r.findings.filter((f) => f.category === cat);
    const crit = c.filter((f) => f.severity === 'critical' && f.status !== 'waived').length;
    const warn = c.filter((f) => f.severity === 'warning' && f.status !== 'waived').length;
    const waiv = c.filter((f) => f.status === 'waived').length;
    out.push(`[${cat.toUpperCase().replace(/-/g, '_')}] critical=${crit} warning=${warn} waived=${waiv}`);
    for (const f of c.slice(0, 30)) {
      out.push(`  ${f.severity === 'critical' ? '[C]' : '[W]'} ${f.rule} ${o(f.file)}:${f.line} "${o(f.snippet)}" (${o(f.reason)})${f.status === 'waived' ? ' WAIVED' : ''}`);
    }
    if (c.length > 30) out.push(`  ... ${c.length - 30} more (see JSON)`);
  }
  for (const s of r.skipped) out.push(`[SKIPPED] ${o(s.item)}: ${o(s.reason)} | rerun: ${o(s.rerun)}`);
  out.push(`[VERDICT] ${r.verdict} (critical=${r.counts.critical} warning=${r.counts.warning} waived=${r.counts.waived}) - ${o(r.verdictReason)}`);
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = { excludeGlobs: [], extraIgnoreDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`); return argv[++i]; };
    if (a === '--repo') opts.repo = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--json') opts.json = true;
    else if (a === '--max-files') opts.maxFiles = parseInt(next(), 10);
    else if (a === '--max-file-kb') opts.maxFileBytes = parseInt(next(), 10) * 1024;
    else if (a === '--exclude') opts.excludeGlobs.push(next());
    else if (a === '--extra-ignore') opts.extraIgnoreDirs.push(next());
    else if (a === '--allow') opts.allowPath = next();
    else if (a === '--git-history') opts.gitHistory = true;
    else if (a === '--max-history-commits') opts.maxHistoryCommits = parseInt(next(), 10);
    else if (a === '--strict-single-commit') opts.strictSingleCommit = true;
    else if (a === '--strict-tracked') opts.strictTracked = true;
    else if (a === '--user') opts.user = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.repo) throw new Error('usage: node publish-scan.mjs --repo <dir> [options]  (see header comment)');
  return opts;
}

export function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`[FAIL] ${ascii(e.message)}\n`);
    return 2;
  }
  let report;
  try { report = scanRepo(opts.repo, { ...opts, outPath: opts.out }); } catch (e) {
    process.stderr.write(`[FAIL] ${ascii(e.message)}\n`);
    return 2;
  }
  process.stdout.write(printSummary(report) + '\n');
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`[OK] JSON report -> ${ascii(resolve(opts.out))}\n`);
  }
  return report.verdict === 'FAIL' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
