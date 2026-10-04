/**
 * 启动前校验，两道门：
 *
 *  1. **schema 兼容门**（2026-09-12 tierSources 事故的永久验收门）：用宿主
 *     dsh-tools 的 assertSupportedJsonSchema（真实校验器）验证三个工具的
 *     parameters + output.schema，提前抓住「能过单测但炸 profile boot」的问题。
 *  2. **A16b boot 层不变量**（F-3）：**把 cordis.patch.yml 的
 *     `advisorEnabled: false` 那一行删掉后，插件仍能 boot**——证明
 *     「删 yml 的行是安全的」这条结论本身有判据。
 *     不得只测 `resolveAdvisorConfig` 不抛错：那只覆盖「键在场」这一半；
 *     另一半（键缺席 → 走真实 apply 路径）正是本门覆盖的。
 *     阴性对照（A16c）= 从 ALLOWED_KEYS 移除该键 → 同一个 apply() 必须炸，
 *     已在交付报告里以变异体实测记录。
 *
 * 两条门都走**真实 apply 入口**（lib/index.js），不是直接调内部函数。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
// 宿主全局 DSH 安装位置运行时解析（APPDATA 环境变量），不落用户名字面量
const hostModules = join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules')
const dshToolsUrl = pathToFileURL(join(hostModules, '@deepseek-ai/dsh-tools/lib/index.js')).href
const { assertSupportedJsonSchema } = await import(dshToolsUrl)
// cordis.patch.yml 的解析用宿主自带的 yaml（与 DSH 读同一份配置的解析器）
const YAML = createRequire(join(hostModules, 'no-such-file.js'))('yaml')
const m = await import('../lib/index.js')
const { ADVISOR_DATA_DIR_ENV } = await import('../lib/advisor/index.js')

const EXPECTED_TOOLS = ['agent_roles', 'agent_taskbook', 'agent_spawn']

/** 每次 boot 探针一份全新 ctx（apply 会往 ctx.tools 上注册工具）。 */
function freshCtx() {
  const tools = new Map()
  return {
    tools: { register: (d) => { tools.set(d.name, d) } },
    agents: {},
    effect: (f) => f(),
    get: () => undefined,
    registered: tools,
  }
}

let failed = 0
const fail = (message) => { failed += 1; console.log(`[FAIL] ${message}`) }
const ok = (message) => { console.log(`[OK] ${message}`) }

const check = (label, fn) => {
  try {
    fn()
    ok(label)
  } catch (e) {
    fail(`${label}: ${e?.message ?? e}`)
  }
}

// ── 物理隔离：apply() 会构造 advisor store（并 mkdir 数据目录）──
// 不隔离就会在真实用户数据目录 ~/.dsh/plugins-data/dsh-agents/advisor 上留痕，
// 冒烟/门禁不得触碰生产状态（同 tests/advisor.test.mjs 的 dataDir 组纪律）。
const isolatedDir = mkdtempSync(join(tmpdir(), 'boot-schema-check-'))
const prevDataDir = process.env[ADVISOR_DATA_DIR_ENV]
process.env[ADVISOR_DATA_DIR_ENV] = isolatedDir

/** 走真实 apply 入口，返回 { booted, tools, error }。 */
function boot(config) {
  const ctx = freshCtx()
  try {
    m.apply(ctx, config)
    return { booted: true, tools: [...ctx.registered.keys()], descriptors: ctx.registered, error: null }
  } catch (e) {
    return { booted: false, tools: [], descriptors: new Map(), error: e?.message ?? String(e) }
  }
}

try {
  // ── 门 1：schema 兼容（随包默认档位表，与历史行为一致）──────────────────
  {
    const r = boot({ tiers: { LOW: { provider: 'deepseek', model: 'deepseek-flash' }, MEDIUM: { provider: 'glm-pro', model: 'glm-5.3-flash' }, HIGH: { provider: 'deepseek', model: 'deepseek-v4-pro' } } })
    if (!r.booted) fail(`apply(默认档位表) 抛错: ${r.error}`)
    for (const [name, def] of r.descriptors) {
      for (const [label, schema] of [['parameters', def.parameters], ['output.schema', def.output?.schema]]) {
        try {
          assertSupportedJsonSchema(schema)
          ok(`${name} ${label}`)
        } catch (e) {
          fail(`${name} ${label}: ${e.message}`)
        }
      }
    }
    check('三个工具全部注册', () => {
      const missing = EXPECTED_TOOLS.filter((n) => !r.tools.includes(n))
      if (missing.length > 0) throw new Error(`缺少 ${missing.join(',')}（实得 ${r.tools.join(',') || '空'}）`)
    })
  }

  // ── 门 2：A16b —— 删掉 cordis.patch.yml 的 advisorEnabled 行后仍能 boot ──
  const ymlText = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // cordis.patch.yml 的根是数组（`- insert:` 列表），插件配置在第 0 项的 insert[0]
  const configOf = (text) => {
    const doc = YAML.parse(text)
    const list = Array.isArray(doc) ? doc : [doc]
    const entry = list.find((item) => item?.insert?.some?.((e) => e?.id === 'dsh-agents'))
    if (entry === undefined) throw new Error('cordis.patch.yml 里找不到 dsh-agents 的 insert 块')
    return entry.insert[0].config
  }
  const shipped = configOf(ymlText)
  const stripped = configOf(ymlText.split('\n').filter((line) => !/^\s*advisorEnabled\s*:/.test(line)).join('\n'))

  check('阳性对照：随包 cordis.patch.yml 确实带 advisorEnabled: false', () => {
    if (shipped.advisorEnabled !== false) throw new Error(`实得 ${JSON.stringify(shipped.advisorEnabled)}（本门会变成空门）`)
  })
  check('阳性对照：该行被真实删除（删行后 advisorEnabled 不在配置里）', () => {
    if ('advisorEnabled' in stripped) throw new Error('删行没有生效，本门测不到键缺席那一半')
  })
  check('A16b：删掉 advisorEnabled 那一行后插件仍能 boot（真实 apply 路径）', () => {
    const r = boot(stripped)
    if (!r.booted) throw new Error(`apply 抛错: ${r.error}`)
    const missing = EXPECTED_TOOLS.filter((n) => !r.tools.includes(n))
    if (missing.length > 0) throw new Error(`工具未注册齐全：缺 ${missing.join(',')}`)
  })
  check('A16b 对照组：带该行（随包原样）同样能 boot', () => {
    const r = boot(shipped)
    if (!r.booted) throw new Error(`apply 抛错: ${r.error}`)
  })
} finally {
  if (prevDataDir === undefined) delete process.env[ADVISOR_DATA_DIR_ENV]
  else process.env[ADVISOR_DATA_DIR_ENV] = prevDataDir
  rmSync(isolatedDir, { recursive: true, force: true })
}

console.log(failed === 0 ? 'BOOT SCHEMA CHECK: ALL PASS' : `BOOT SCHEMA CHECK: ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
