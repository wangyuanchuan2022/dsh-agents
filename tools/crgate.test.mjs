/**
 * crgate 直跑测试套件（node crgate.test.mjs 直跑；禁用 node:test runner——
 * 其内部以命名管道捕获子进程输出，在 DSH 沙箱必 EPERM）。
 * 退出码：0=全绿；1=有失败。逐项打印 PASS/FAIL，fail-loud。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hashFields, globToRegex, selectFiles, parseFindings, anchorFindings, validateLedger } from './crgate.mjs';

let passed = 0; let failed = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  [PASS] ' + name); }
  else { failed++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  [FAIL] ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
let seq = 0;
function tmpdirUnique() { const d = join(tmpdir(), 'crgate-test-' + Date.now() + '-' + (seq++)); mkdirSync(d, { recursive: true }); return d; }

function runGit(dir, args) {
  const tag = process.pid + '-' + Date.now() + '-' + (seq++);
  const outP = join(tmpdir(), 'crgt-o-' + tag); const errP = join(tmpdir(), 'crgt-e-' + tag);
  const ofd = openSync(outP, 'w'); const efd = openSync(errP, 'w');
  try {
    const r = spawnSync('git', args, { cwd: dir, stdio: ['ignore', ofd, efd] });
    return { code: r.status, stdout: existsSync(outP) ? readFileSync(outP, 'utf8') : '', stderr: existsSync(errP) ? readFileSync(errP, 'utf8') : '' };
  } finally { closeSync(ofd); closeSync(efd); rmSync(outP, { force: true }); rmSync(errP, { force: true }); }
}
function git(dir, ...args) {
  const r = runGit(dir, args);
  if (r.code !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout;
}

/* ============ 1. hashFields（OCR 长度前缀防碰撞回归） ============ */
section('hashFields');
ok('A1a 长度前缀防碰撞：["ab",""] != ["a","b"]', hashFields(['ab', '']) !== hashFields(['a', 'b']));
ok('A1b 确定性：同输入同输出', hashFields(['x', 'y']) === hashFields(['x', 'y']));
ok('A1c 16 位大写十六进制', /^[0-9A-F]{16}$/.test(hashFields(['a'])));

/* ============ 2. globToRegex ============ */
section('globToRegex');
ok('A2a node_modules/** 匹配深层', globToRegex('node_modules/**').test('node_modules/a/b.js'));
ok('A2b node_modules/** 不误匹配兄弟', !globToRegex('node_modules/**').test('node_modules_like/x.js'));
ok('A2c *.min.js 段内星号', globToRegex('*.min.js').test('x.min.js') && !globToRegex('*.min.js').test('a/x.min.js'));
ok('A2d 尾随斜杠等价目录前缀', globToRegex('docs/').test('docs/a.md') && globToRegex('docs/').test('docs/x/y.md'));
ok('A2e ? 单字符', globToRegex('file?.ts').test('file1.ts') && !globToRegex('file?.ts').test('file12.ts'));
ok('A2f 精确文件名', globToRegex('package-lock.json').test('package-lock.json') && !globToRegex('package-lock.json').test('subpackage-lock.json'));

/* ============ 3. selectFiles 闸门优先级链 ============ */
section('selectFiles（OCR selection.go 闸序）');
const mk = (path, o = {}) => ({ path, status: o.status ?? 'M', insertions: o.ins ?? 10, deletions: o.del ?? 2, binary: !!o.binary });
const E = (p, reason) => reason;
{
  const d = selectFiles([
    mk('.env'), mk('.env.local'), mk('server.key'), mk('src/a.ts'), mk('logo.png', { binary: true }),
    mk('gone.ts', { status: 'D' }), mk('huge.ts', { ins: 9999 }), mk('x.dat'),
    mk('node_modules/pkg/index.js'), mk('vendor/lib.noext'),
  ], { exclude: 'src/a.ts', include: 'vendor/**', maxLines: 3000 });
  const by = new Map(d.map((x) => [x.path, x.exclude_reason]));
  ok('A3a secret 闸先于用户 exclude（.env 不能被 exclude 规则认领）', by.get('.env') === 'secret-path', by.get('.env'));
  ok('A3b secret 闸先于 include 意图（server.key）', by.get('server.key') === 'secret-path', by.get('server.key'));
  ok('A3c 用户 exclude 生效（src/a.ts）', by.get('src/a.ts') === 'user-excluded', by.get('src/a.ts'));
  ok('A3d 二进制识别（logo.png）', by.get('logo.png') === 'binary', by.get('logo.png'));
  ok('A3e 删除文件', by.get('gone.ts') === 'deleted', by.get('gone.ts'));
  ok('A3f 超大 diff（too-large）', by.get('huge.ts') === 'too-large', by.get('huge.ts'));
  ok('A3g 扩展名不在白名单（x.dat）', by.get('x.dat') === 'extension-not-allowed', by.get('x.dat'));
  ok('A3h 默认路径排除（node_modules）', by.get('node_modules/pkg/index.js') === 'default-excluded', by.get('node_modules/pkg/index.js'));
  ok('A3i include 可放行白名单外与默认路径（vendor/lib.noext）', by.get('vendor/lib.noext') === '', by.get('vendor/lib.noext'));
  // include 翻不了秘密闸
  const d2 = selectFiles([mk('.env')], { include: '.env', exclude: '' });
  ok('A3j include 放行不了 secret（.env 仍被拦）', d2[0].exclude_reason === 'secret-path', d2[0].exclude_reason);
}

/* ============ 4. parseFindings ============ */
section('parseFindings');
{
  const md = [
    '### 问题', '位置: src/api/client.ts:42', '问题: key 泄漏', '证据: `const API_KEY = "sk-1"`', '严重度: CRITICAL', '置信度: HIGH', '',
    '### 问题', '位置: src/b.ts:7', '问题: 无证据行', '严重度: MEDIUM', '',
    '### 问题', '位置: src/c.ts:100', '问题: 坏严重度', '证据: `let x = 1`', '严重度: 重大',
  ].join('\n');
  const fs2 = parseFindings(md);
  ok('A4a 抽出 3 条', fs2.length === 3, String(fs2.length));
  ok('A4b 第一条路径行号/证据/严重度', fs2[0].claim_path === 'src/api/client.ts' && fs2[0].claim_line === 42 && fs2[0].evidence === 'const API_KEY = "sk-1"' && fs2[0].severity === 'CRITICAL');
  ok('A4c 无证据行 → evidence undefined', fs2[1].evidence === undefined);
  ok('A4d 非枚举严重度 → UNKNOWN', fs2[2].severity === 'UNKNOWN', String(fs2[2].severity));
}

/* ============ 5. anchorFindings（三级定位链，真实文件 fixture） ============ */
section('anchorFindings');
{
  const repo = tmpdirUnique();
  const uniq = 'const RETRY_BACKOFF_MS = 86400000;';
  const shared = 'function validateInput(payload) { return payload != null; }';
  writeFileSync(join(repo, 'a.go'), Array.from({ length: 11 }, (_, i) => `// pad ${i}`).join('\n') + '\n' + 'fmt.Println("anchor-target-line-12")\n' + uniq + '\n');
  writeFileSync(join(repo, 'b.go'), shared + '\n');
  writeFileSync(join(repo, 'helper.go'), shared + '\n// helper only\n');
  writeFileSync(join(repo, 'unique.go'), uniq.replace('86400000', '3600000') + '\n');
  const scope = ['a.go', 'b.go', 'helper.go', 'unique.go'];
  const findings = [
    { claim_path: 'a.go', claim_line: 12, evidence: 'anchor-target-line-12', severity: 'HIGH' },            // anchored
    { claim_path: 'a.go', claim_line: 2, evidence: uniq, severity: 'MEDIUM' },                              // drifted（在文件内但行号远）
    { claim_path: 'a.go', claim_line: 30, evidence: shared, severity: 'HIGH' },                             // ambiguous（b+helper 两处）
    { claim_path: 'b.go', claim_line: 5, evidence: uniq.replace('86400000', '3600000'), severity: 'CRITICAL' }, // refiled（唯一定位 unique.go）
    { claim_path: 'b.go', claim_line: 9, evidence: 'TotallyAbsentSnippet();', severity: 'LOW' },            // unanchored
    { claim_path: 'b.go', claim_line: 1, severity: 'LOW' },                                                 // no-evidence
  ];
  const res = anchorFindings(findings, repo, scope);
  const v = (i) => res[i].verdict;
  ok('A5a 同文件逐字命中 → anchored', v(0) === 'anchored', v(0));
  ok('A5b 文件内但行号远 → drifted', v(1) === 'drifted', v(1));
  ok('A5c 跨文件多处命中 → ambiguous（拒绝二选一）', v(2) === 'ambiguous', v(2));
  ok('A5d 跨文件唯一命中 → refiled', v(3) === 'refiled', v(3) + ' ' + res[3].detail);
  ok('A5e 全不命中 → unanchored', v(4) === 'unanchored', v(4));
  ok('A5f 无证据行 → no-evidence', v(5) === 'no-evidence', v(5));
  rmSync(repo, { recursive: true, force: true });
}

/* ============ 6. validateLedger（OCR manifest 闭世界校验） ============ */
section('validateLedger');
{
  const spec = { reviewable_files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] };
  const okAll = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'reviewed' }] });
  ok('A6a 全 reviewed → complete', okAll.terminal === 'complete' && okAll.errors.length === 0, JSON.stringify(okAll.errors));
  const partial = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'skipped', reason: 'generated-or-binary' }, { path: 'c.ts', status: 'reviewed' }] });
  ok('A6b 有理由 skipped → partial + 封闭枚举通过', partial.terminal === 'partial' && partial.errors.length === 0, JSON.stringify(partial.errors));
  const missing = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }] });
  ok('A6c 缺项 sweep → failed(unknown) + 结构错误', missing.terminal === 'failed' && missing.counts.failed_unknown === 2 && missing.errors.some((e) => e.startsWith('missing ledger entry')));
  const noReason = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'skipped' }] });
  ok('A6d skipped 无理由 → 报错（waived/blocked 同规）', noReason.errors.some((e) => e.includes('lacks reason')));
  const badReason = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'skipped', reason: '不想看' }] });
  ok('A6e skipped 理由不在封闭枚举 → 报错', badReason.errors.some((e) => e.includes('not in closed enum')), JSON.stringify(badReason.errors));
  const badStatus = validateLedger(spec, { items: [{ path: 'a.ts', status: 'maybe' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'reviewed' }] });
  ok('A6f 未知状态 → 报错', badStatus.errors.some((e) => e.includes('unknown status')));
  const dup = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'reviewed' }] });
  ok('A6g 重复条目 → 报错', dup.errors.some((e) => e.includes('duplicate')));
  const outside = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'reviewed' }, { path: 'zz.ts', status: 'reviewed' }] });
  ok('A6h 账含分母外路径 → 报错（闭世界）', outside.errors.some((e) => e.includes('outside frozen spec')));
  const waived = validateLedger(spec, { items: [{ path: 'a.ts', status: 'reviewed' }, { path: 'b.ts', status: 'reviewed' }, { path: 'c.ts', status: 'waived', reason: '用户指示：本轮不查 c' }] });
  ok('A6i waived 带理由 → partial（不失败）', waived.terminal === 'partial' && waived.errors.length === 0, JSON.stringify(waived.errors));
}

/* ============ 7. freeze 端到端（真实 git 仓库集成） ============ */
section('freeze（集成）');
{
  const repo = tmpdirUnique();
  git(repo, 'init');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  writeFileSync(join(repo, 'src.ts'), 'let a = 1;\n');
  writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'x', 'i.js'), 'junk\n');
  writeFileSync(join(repo, 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');
  // 第二轮改动：改 src.ts + 改 .env + 改 node_modules 内文件 + 改二进制 + 新增未跟踪 new.py
  writeFileSync(join(repo, 'src.ts'), 'let a = 2;\nlet b = 3;\n');
  writeFileSync(join(repo, '.env'), 'SECRET=2\n');
  writeFileSync(join(repo, 'node_modules', 'x', 'i.js'), 'junk-2\n');
  writeFileSync(join(repo, 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x03]));
  writeFileSync(join(repo, 'new.py'), 'print(1)\n');
  const specPath = join(repo, 'spec.json');
  const toolPath = fileURLToPath(new URL('./crgate.mjs', import.meta.url));
  // fd-stdio 捕获子进程输出（沙箱内命名管道 spawn 必 EPERM——已实证边界）
  const outP = join(tmpdir(), 'crgt-freeze-out-' + Date.now()); const errP = join(tmpdir(), 'crgt-freeze-err-' + Date.now());
  const ofd = openSync(outP, 'w'); const efd = openSync(errP, 'w');
  let r;
  try { r = spawnSync(process.execPath, [toolPath, 'freeze', '--repo', repo, '--out', specPath], { stdio: ['ignore', ofd, efd] }); }
  finally { closeSync(ofd); closeSync(efd); }
  const childOut = existsSync(outP) ? readFileSync(outP, 'utf8') : '';
  const childErr = existsSync(errP) ? readFileSync(errP, 'utf8') : '';
  rmSync(outP, { force: true }); rmSync(errP, { force: true });
  ok('A7a freeze 子命令 exit 0', r.status === 0, `status=${r.status} err=${childErr.slice(0, 300)}`);
  if (r.status === 0 && existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    ok('A7b schema/版本字段', spec.schema_version === '1' && !!spec.crgate_version);
    ok('A7c head_sha 非空 40 位', /^[0-9a-f]{40}$/.test(spec.head_sha));
    const rev = spec.reviewable_files.map((e) => e.path).sort();
    ok('A7d 改动与未跟踪入选（new.py workspace 模式）', rev.includes('src.ts') && rev.includes('new.py'), JSON.stringify(rev));
    const exc = new Map(spec.excluded_files.map((e) => [e.path, e.exclude_reason]));
    ok('A7e .env 被秘密闸拦截', exc.get('.env') === 'secret-path', exc.get('.env'));
    ok('A7f 二进制识别（blob.png）', exc.get('blob.png') === 'binary', exc.get('blob.png'));
    ok('A7g node_modules 被默认路径闸拦截', exc.get('node_modules/x/i.js') === 'default-excluded', exc.get('node_modules/x/i.js'));
    ok('A7h 身份字段齐（selection_hash/spec_sha）', /^[0-9a-f]{16}$/.test(spec.selection_hash) && /^[0-9a-f]{16}$/.test(spec.spec_sha));
    ok('A7i spec_sha = 内容哈希（去自身与时间戳）', spec.spec_sha === createHash('sha256').update(JSON.stringify({ ...spec, spec_sha: undefined, generated_at: undefined })).digest('hex').slice(0, 16));
  } else {
    for (const n of ['A7b', 'A7c', 'A7d', 'A7e', 'A7f', 'A7g', 'A7h', 'A7i']) ok(n + '（前置失败跳过）', false, 'freeze failed');
  }
  rmSync(repo, { recursive: true, force: true });
}

/* ============ 8. freeze --all（scan 模式：陌生仓库/非 git 目录） ============ */
section('freeze --all（scan）');
{
  const dir = tmpdirUnique();
  writeFileSync(join(dir, 'app.py'), 'def f():\n    return 1\n');
  writeFileSync(join(dir, 'lib.ts'), 'const x = 1;\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01]));
  mkdirSync(join(dir, 'node_modules', 'y'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'y', 'i.js'), 'junk\n');
  writeFileSync(join(dir, 'huge.py'), Array.from({ length: 4000 }, (_, i) => '# line ' + i).join('\n'));
  const specPath = join(dir, 'spec.json');
  const toolPath = fileURLToPath(new URL('./crgate.mjs', import.meta.url));
  const outP = join(tmpdir(), 'crgt-scan-out-' + Date.now()); const errP = join(tmpdir(), 'crgt-scan-err-' + Date.now());
  const ofd = openSync(outP, 'w'); const efd = openSync(errP, 'w');
  let r;
  try { r = spawnSync(process.execPath, [toolPath, 'freeze', '--repo', dir, '--all', '--out', specPath], { stdio: ['ignore', ofd, efd] }); }
  finally { closeSync(ofd); closeSync(efd); }
  const childErr = existsSync(errP) ? readFileSync(errP, 'utf8') : '';
  rmSync(outP, { force: true }); rmSync(errP, { force: true });
  ok('A8a scan 子命令 exit 0（非 git 目录）', r.status === 0, childErr.slice(0, 300));
  if (r.status === 0 && existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    ok('A8b mode=scan', spec.mode === 'scan', spec.mode);
    ok('A8c head_sha 为空（无 git）', spec.head_sha === '', spec.head_sha);
    const rev = spec.reviewable_files.map((e) => e.path).sort();
    ok('A8d 全量入选 app.py + lib.ts', rev.includes('app.py') && rev.includes('lib.ts'), JSON.stringify(rev));
    const exc = new Map(spec.excluded_files.map((e) => [e.path, e.exclude_reason]));
    ok('A8e .env 秘密闸', exc.get('.env') === 'secret-path', exc.get('.env'));
    ok('A8f blob.bin 二进制闸', exc.get('blob.bin') === 'binary', exc.get('blob.bin'));
    ok('A8g node_modules 默认路径闸', exc.get('node_modules/y/i.js') === 'default-excluded', exc.get('node_modules/y/i.js'));
    ok('A8h huge.py 超限闸（4000 行 > 3000）', exc.get('huge.py') === 'too-large', exc.get('huge.py'));
  } else {
    for (const n of ['A8b', 'A8c', 'A8d', 'A8e', 'A8f', 'A8g', 'A8h']) ok(n + '（前置失败跳过）', false, 'scan freeze failed');
  }
  rmSync(dir, { recursive: true, force: true });
}

/* ============ 9. freeze --commit 与 range 的 merge-base 语义 ============ */
section('freeze --commit / merge-base');
{
  const repo = tmpdirUnique();
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'f0.py'), 'f0 = 0\n');
  writeFileSync(join(repo, 'shared.py'), 'v = 1\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'c0');
  const shaC0 = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'checkout', '-b', 'feat');
  writeFileSync(join(repo, 'feat.py'), 'feat = 1\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feat work');
  const shaFeat = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'checkout', 'main');
  writeFileSync(join(repo, 'mainfile.py'), 'main_only = 1\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'm1');
  const toolPath = fileURLToPath(new URL('./crgate.mjs', import.meta.url));
  function freezeCli(extraArgs, outName) {
    const specPath = join(repo, outName);
    const outP = join(tmpdir(), 'crgt-c-out-' + Date.now() + Math.random()); const errP = join(tmpdir(), 'crgt-c-err-' + Date.now() + Math.random());
    const ofd = openSync(outP, 'w'); const efd = openSync(errP, 'w');
    let r;
    try { r = spawnSync(process.execPath, [toolPath, 'freeze', '--repo', repo, ...extraArgs, '--out', specPath], { stdio: ['ignore', ofd, efd] }); }
    finally { closeSync(ofd); closeSync(efd); }
    const err = existsSync(errP) ? readFileSync(errP, 'utf8') : '';
    rmSync(outP, { force: true }); rmSync(errP, { force: true });
    return { r, specPath, err };
  }
  // ① 单提交：feat 提交只含 feat.txt，身份=被审提交
  {
    const { r, specPath, err } = freezeCli(['--commit', shaFeat], 'spec-commit.json');
    ok('A9a --commit exit 0', r.status === 0, err.slice(0, 200));
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    ok('A9b mode=commit 且 head_sha=被审提交', spec.mode === 'commit' && spec.head_sha === shaFeat, spec.mode + ' ' + spec.head_sha.slice(0, 8));
    const rev = spec.reviewable_files.map((e) => e.path);
    ok('A9c 单提交范围=feat.py（不含 mainfile）', rev.length === 1 && rev[0] === 'feat.py', JSON.stringify(rev));
  }
  // ② 根提交：vs 空树，全部文件为新增
  {
    const { r, specPath, err } = freezeCli(['--commit', shaC0], 'spec-root.json');
    ok('A9d 根提交 --commit exit 0', r.status === 0, err.slice(0, 200));
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const rev = spec.reviewable_files.map((e) => e.path).sort();
    ok('A9e 根提交范围=f0+shared（vs 空树）', rev.includes('f0.py') && rev.includes('shared.py'), JSON.stringify(rev));
  }
  // ③ range merge-base：审 feat 不得把 main 侧的 mainfile 算进来
  {
    const { r, specPath, err } = freezeCli(['--from', 'main', '--to', 'feat'], 'spec-range.json');
    ok('A9f range exit 0', r.status === 0, err.slice(0, 200));
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const all = spec.reviewable_files.map((e) => e.path).concat(spec.excluded_files.map((e) => e.path));
    ok('A9g merge-base 语义：含 feat.py', all.includes('feat.py'), JSON.stringify(all));
    ok('A9h merge-base 语义：不含 main 侧 mainfile.py', !all.includes('mainfile.py'), JSON.stringify(all));
  }
  rmSync(repo, { recursive: true, force: true });
}

/* ============ 10. anchor --at（历史快照定位） ============ */
section('anchor --at');
{
  const repo = tmpdirUnique();
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'm.py'), 'OLD_SNIPPET = 1\nNEW_LINE = 2\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'c1');
  const shaC1 = git(repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'm.py'), 'NEW_LINE = 2\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'c2');
  const findings = [{ claim_path: 'm.py', claim_line: 1, evidence: 'OLD_SNIPPET = 1', severity: 'HIGH' }];
  const res1 = anchorFindings(findings, repo, ['m.py']);
  ok('A10a 工作区对照：历史片段（已被删）unanchored', res1[0].verdict === 'unanchored', res1[0].verdict);
  const res2 = anchorFindings(findings, repo, ['m.py'], shaC1);
  ok('A10b --at 历史快照：anchored', res2[0].verdict === 'anchored', res2[0].verdict);
  rmSync(repo, { recursive: true, force: true });
}

/* ============ 收尾 ============ */
console.log(`\n==== crgate selftest: ${passed} passed / ${failed} failed ====`);
if (failures.length) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
