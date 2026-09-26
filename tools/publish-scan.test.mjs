#!/usr/bin/env node
/**
 * publish-scan.test.mjs -- publish-scan 的注入必红负向自测（直跑式，零依赖）
 *
 * 纪律依据：
 *   - 只验证「好文件过门」的闸门是半成品：本文件用自建临时 fixture 逐条断言
 *     「坏输入必被拦」（变异体全红），最后对干净目录断言 PASS（好文件过门）。
 *   - 断言鉴别力条款：T-multi 用一个含 >=4 类元素的输入，断言发现覆盖 >=5 个规则 id、
 *     >=4 个类别——单模式实现不可能通过该断言（串接 vs 取首个不可分辨的问题由此排除）。
 *   - fixture 收尾自清（finally + 存在性断言），不留垃圾。
 *   - 输出全 ASCII（Windows GBK 控制台安全）。
 *
 * 运行：node publish-scan.test.mjs   （退出码 0=全绿，1=有红）
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanRepo } from './publish-scan.mjs';

let passed = 0;
let failed = 0;
const failures = [];
const skippedTests = [];

function check(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`[OK]   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}\n`); }
}

function fx(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

// 临时根：沙箱内 mkdtemp 类 0700 目录不可用，用 mkdirSync 默认权限 + 唯一名；tmpdir 不可写则回退工具目录旁
const unique = `pubscan-fix-${process.pid}-${Date.now()}`;
let ROOT;
try { ROOT = join(tmpdir(), unique); mkdirSync(ROOT); }
catch {
  ROOT = join(dirname(fileURLToPath(import.meta.url)), '.tmp-fixtures-' + unique);
  mkdirSync(ROOT, { recursive: true });
}

// 动态构造本机用户名字面量，fixture 与断言不硬编码具体用户名
const USER = process.env.USERNAME || process.env.USER || 'testuser';
const winPath = (name) => 'C:\\Users\\' + name;

try {
  /* ---- T1 干净目录必须 PASS（好文件过门） ---- */
  {
    const d = join(ROOT, 'clean');
    fx(d, 'README.md', '# demo\n\nJust a benign readme.\n');
    fx(d, 'app.js', "export const hello = (name) => `hi ${name}`;\n");
    const r = scanRepo(d, { user: USER });
    check('T1 clean dir verdict PASS', r.verdict === 'PASS', `got ${r.verdict}`);
    check('T1 zero critical', r.counts.critical === 0, `got ${r.counts.critical}`);
    check('T1 zero warning', r.counts.warning === 0, `got ${r.counts.warning}`);
  }

  /* ---- T2 假 .env 变异体必红（危险文件凭证类 + 缺 .env.example） ---- */
  {
    const d = join(ROOT, 'v-env');
    fx(d, 'src/.env', 'DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod\n');
    const r = scanRepo(d, { user: USER });
    check('T2 fake .env verdict FAIL', r.verdict === 'FAIL', `got ${r.verdict}`);
    const rules = new Set(r.findings.map((f) => f.rule));
    check('T2 dg-env fires', rules.has('dg-env'), `rules=${[...rules].join(',')}`);
    check('T2 dg-env is credential-critical', r.findings.some((f) => f.rule === 'dg-env' && f.severity === 'critical'));
    check('T2 cfg-env-example-missing fires', rules.has('cfg-env-example-missing'));
  }

  /* ---- T3 假内网 IP（代码面）变异体必红 ---- */
  {
    const d = join(ROOT, 'v-ip');
    fx(d, 'net.js', "const LAN_HOST = '192.168.1.50';\nexport const addr = LAN_HOST;\n");
    const r = scanRepo(d, { user: USER });
    check('T3 private IP in code verdict FAIL', r.verdict === 'FAIL', `got ${r.verdict}`);
    check('T3 net-private critical fires', r.findings.some((f) => f.rule === 'net-private' && f.severity === 'critical'));
  }

  /* ---- T4 假 PEM 私钥块（内容）+ .pem 文件（存在）双变异体必红 ---- */
  {
    const d = join(ROOT, 'v-pem');
    fx(d, 'key.txt', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK placeholder body\n-----END RSA PRIVATE KEY-----\n');
    fx(d, 'server.pem', '-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n');
    const r = scanRepo(d, { user: USER });
    check('T4 PEM fixtures verdict FAIL', r.verdict === 'FAIL', `got ${r.verdict}`);
    check('T4 sec-private-key fires', r.findings.some((f) => f.rule === 'sec-private-key'));
    check('T4 dg-keyfile fires', r.findings.some((f) => f.rule === 'dg-keyfile'));
    // 凭证文件内容不回读：server.pem 不得进 content findings
    check('T4 credential file content not re-read', !r.findings.some((f) => f.file === 'server.pem' && f.category === 'secrets'));
  }

  /* ---- T5 假本机路径/用户名（代码面 CRITICAL；文档面降级 WARNING） ---- */
  {
    const d = join(ROOT, 'v-user');
    fx(d, 'paths.mjs', `const CACHE = "${winPath(USER)}\\cache";\nexport const owner = "${USER}";\n`);
    const r = scanRepo(d, { user: USER });
    check('T5 local path/username in code verdict FAIL', r.verdict === 'FAIL', `got ${r.verdict}`);
    const rules = new Set(r.findings.filter((f) => f.severity === 'critical').map((f) => f.rule));
    check('T5 win-home or username critical', rules.has('int-win-home') && rules.has('int-username'), `rules=${[...rules].join(',')}`);

    const d2 = join(ROOT, 'v-user-doc');
    fx(d2, 'setup.md', `Run the tool from ${winPath(USER)} before publishing.\n`);
    const r2 = scanRepo(d2, { user: USER });
    check('T5 same leak in docs = PASS-WITH-WARNINGS (middle tier)', r2.verdict === 'PASS-WITH-WARNINGS', `got ${r2.verdict}`);
    check('T5 docs downgrade keeps manual-review warning', r2.findings.some((f) => f.severity === 'warning' && /docs-context/.test(f.reason)));
  }

  /* ---- T6 占位样本降级（占位密钥不 FAIL，降 WARNING） ---- */
  {
    const d = join(ROOT, 'v-placeholder');
    fx(d, 'doc.md', 'Example config: OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx\n');
    fx(d, 'seq.md', 'upstream test fixture key: sk-0123456789abcdef\n');
    const r = scanRepo(d, { user: USER });
    check('T6 placeholder key not FAIL', r.verdict !== 'FAIL', `got ${r.verdict}`);
    const f = r.findings.find((x) => x.rule === 'sec-provider-key' && x.file === 'doc.md');
    check('T6 placeholder downgraded to warning', f && f.severity === 'warning' && /canonical-placeholder/.test(f.reason), JSON.stringify(f && f.reason));
    const s = r.findings.find((x) => x.rule === 'sec-provider-key' && x.file === 'seq.md');
    check('T6 sequential test value downgraded to warning', s && s.severity === 'warning' && /canonical-placeholder/.test(s.reason), JSON.stringify(s && s.reason));
  }

  /* ---- T7 回环白名单恒 WARNING + provenance 豁免可 PASS ---- */
  {
    const d = join(ROOT, 'v-loopback');
    fx(d, 'cfg.json', '{ "proxy": "http://127.0.0.1:7897" }\n');
    const r = scanRepo(d, { user: USER });
    check('T7 loopback = PASS-WITH-WARNINGS', r.verdict === 'PASS-WITH-WARNINGS', `got ${r.verdict}`);
    check('T7 net-loopback warning with whitelist reason', r.findings.some((f) => f.rule === 'net-loopback' && /loopback proxy whitelist/.test(f.reason)));

    const allow = join(d, '.publish-scan-allow.json');
    fx(d, '.publish-scan-allow.json', JSON.stringify({ waivers: [{ id: 'net-loopback', glob: 'cfg.json', reason: 'documented local proxy default' }] }, null, 2));
    const r2 = scanRepo(d, { user: USER, allowPath: allow });
    check('T7 documented waiver restores PASS', r2.verdict === 'PASS', `got ${r2.verdict}`);
    check('T7 waived finding still listed', r2.counts.waived === 1);
  }

  /* ---- T8 多元素输入断言（鉴别力核心：>=4 类元素 -> >=5 规则 id、>=4 类别） ---- */
  {
    const d = join(ROOT, 'v-multi');
    fx(d, '.env', 'TOKEN=aaaaaaaaaaaaaaaaaaaa\n');
    fx(d, 'net.js', "export const gw = '10.0.0.7';\n");
    fx(d, 'key.txt', '-----BEGIN EC PRIVATE KEY-----\nfake body\n-----END EC PRIVATE KEY-----\n');
    fx(d, 'paths.js', `export const home = '${winPath(USER)}';\n`);
    fx(d, 'contacts.md', 'mail me at someone@gmail.com\n');
    fx(d, 'phone.txt', 'call 13912345678 now\n');
    const r = scanRepo(d, { user: USER });
    check('T8 multi-element verdict FAIL', r.verdict === 'FAIL', `got ${r.verdict}`);
    const ruleIds = new Set(r.findings.map((f) => f.rule));
    const cats = new Set(r.findings.map((f) => f.category));
    check('T8 >=5 distinct rule ids', ruleIds.size >= 5, `got ${ruleIds.size}: ${[...ruleIds].join(',')}`);
    check('T8 >=4 distinct categories', cats.size >= 4, `got ${cats.size}: ${[...cats].join(',')}`);
    for (const must of ['dg-env', 'net-private', 'sec-private-key', 'int-win-home', 'pii-email-consumer', 'pii-phone-cn']) {
      check(`T8 contains ${must}`, ruleIds.has(must));
    }
  }

  /* ---- T9 maxFiles 截断必须响亮 ---- */
  {
    const d = join(ROOT, 'v-trunc');
    for (let i = 0; i < 5; i++) fx(d, `f${i}.txt`, `file number ${i}\n`);
    const r = scanRepo(d, { user: USER, maxFiles: 3 });
    check('T9 truncation flagged', r.stats.truncated === true);
    check('T9 scanned exactly cap', r.stats.filesScanned === 3, `got ${r.stats.filesScanned}`);
  }

  /* ---- T10 掩码纪律：秘密命中不得全量落报告（含同行多命中——span 去重丢弃的命中也要掩码） ---- */
  {
    const d = join(ROOT, 'v-mask');
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const token2 = 'ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA654321';
    fx(d, 'leak.js', `const t = '${token}';\nconst pair = { a: '${token}', b: '${token2}' };\n`);
    const r = scanRepo(d, { user: USER });
    const f = r.findings.find((x) => x.rule === 'sec-github-token');
    check('T10 github token caught', !!f);
    check('T10 snippet masked (no full token anywhere in report)', f && !JSON.stringify(r.findings).includes(token) && !JSON.stringify(r.findings).includes(token2), 'full token leaked into report');
    check('T10 snippet carries ellipsis', f && f.snippet.includes('...'));
  }

  /* ---- T11 用户名不可解析时诚实 skip（不得静默） ---- */
  {
    const d = join(ROOT, 'clean');
    const r = scanRepo(d, { user: null });
    check('T11 unresolved username -> skipped entry', r.skipped.some((s) => s.item === 'int-username' && s.rerun));
  }

  /* ---- T12 git-history 默认关闭 -> skipped 留痕（可复跑） ---- */
  {
    const d = join(ROOT, 'clean');
    const r = scanRepo(d, { user: USER });
    check('T12 git-history skipped entry with rerun', r.skipped.some((s) => s.item === 'git-history' && s.rerun));
  }

  /* ---- T14 git-aware 发布面判定：untracked 降级 WARNING / tracked 保持 CRITICAL / --strict-tracked 恢复 ---- */
  {
    const d = join(ROOT, 'v-git');
    fx(d, 'tracked.js', `const p = '${winPath(USER)}';\n`);
    fx(d, 'untracked.js', `const p = '${winPath(USER)}';\n`);
    // 沙箱内建 git 仓（spawn stdio:'ignore' 是合法通道）；不可用则诚实 skip 留痕
    let ok = true;
    try {
      let g = spawnSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
      if (g.status !== 0) ok = false;
      if (ok) {
        g = spawnSync('git', ['add', 'tracked.js'], { cwd: d, stdio: 'ignore' });
        if (g.status !== 0) ok = false;
      }
    } catch { ok = false; }
    if (!ok) {
      process.stdout.write('[SKIP] T14 git-aware downgrade: git init/add unavailable in sandbox; branch exercised by real-run instead\n');
      skippedTests.push('T14-git-aware (sandbox git init unavailable; verified via real workspace run)');
    } else {
      const r = scanRepo(d, { user: USER });
      check('T14 tracked file keeps CRITICAL', r.findings.some((f) => f.file === 'tracked.js' && f.severity === 'critical'), JSON.stringify(r.findings.map((f) => [f.file, f.severity, f.reason])));
      check('T14 untracked file downgraded to WARNING with reason', r.findings.some((f) => f.file === 'untracked.js' && f.severity === 'warning' && /not git-tracked/.test(f.reason)));
      const rs = scanRepo(d, { user: USER, strictTracked: true });
      check('T14 --strict-tracked restores CRITICAL on untracked', rs.findings.some((f) => f.file === 'untracked.js' && f.severity === 'critical'));
    }

    // T14b：untracked 降级覆盖 PII 家族（发布面判定对内容类规则一致）
    {
      const d = join(ROOT, 'v-git-pii');
      fx(d, 'tracked-pii.js', "export const contact = 'someone@gmail.com';\n");
      fx(d, 'untracked-pii.js', "export const contact = 'someone@gmail.com';\n");
      let ok = true;
      try {
        let g = spawnSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
        if (g.status !== 0) ok = false;
        if (ok) { g = spawnSync('git', ['add', 'tracked-pii.js'], { cwd: d, stdio: 'ignore' }); if (g.status !== 0) ok = false; }
      } catch { ok = false; }
      if (!ok) {
        process.stdout.write('[SKIP] T14b untracked PII downgrade: git unavailable\n');
        skippedTests.push('T14b-untracked-pii (sandbox git init unavailable)');
      } else {
        const r = scanRepo(d, { user: USER });
        check('T14b tracked PII keeps CRITICAL', r.findings.some((f) => f.file === 'tracked-pii.js' && f.severity === 'critical'));
        check('T14b untracked PII downgraded to WARNING', r.findings.some((f) => f.file === 'untracked-pii.js' && f.severity === 'warning' && /not git-tracked/.test(f.reason)));
      }
    }
  }
  /* ---- T15 扫描器产物自豁免：--allow/--out 指向扫描范围内的文件时按绝对路径豁免 ---- */
  {
    const d = join(ROOT, 'v-self');
    fx(d, 'readme.md', '# clean\n');
    const allowFile = join(d, 'allow.json');
    fx(d, 'allow.json', JSON.stringify({ waivers: [{ id: 'net-loopback', glob: 'readme.md', reason: 'documented waiver quoting 192.168.1.50 stub value in prose' }] }));
    const outFile = join(d, 'out.json');
    fx(d, 'out.json', '{"user": "scanreport", "note": "report artifact"}');
    const r = scanRepo(d, { user: USER, allowPath: allowFile, outPath: outFile });
    check('T15 allow/out artifacts self-exempted', r.findings.length === 0, JSON.stringify(r.findings.map((f) => [f.file, f.rule])));
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

/* ---- T13 自清核验 ---- */
check('T13 fixture temp dir removed', !existsSync(ROOT));

process.stdout.write(`\n[SELFTEST] passed=${passed} failed=${failed} skipped=${skippedTests.length}\n`);
if (skippedTests.length) process.stdout.write(`[SELFTEST] skipped: ${skippedTests.join('; ')}\n`);
if (failed > 0) {
  process.stdout.write(`[SELFTEST] failing: ${failures.join('; ')}\n`);
  process.exit(1);
}
process.exit(0);
