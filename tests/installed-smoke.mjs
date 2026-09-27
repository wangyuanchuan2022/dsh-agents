/**
 * dsh-agents 安装副本烟测：从 profile node_modules 路径 import（经 junction
 * realpath 解析到工作区插件目录），验证：
 *   ① 三工具注册（DSH 工具契约）；
 *   ② settings 命名空间注册（ctx.inject(['settings']) 标准接线）+ set 流程；
 *   ③ 设置卡 HTTP 端点（ctx.inject(['webServer']) 注册 + GET/PATCH 直调）。
 */
import url from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
// 安装副本位置运行时解析（家目录动态取），不落用户名字面量
const installed = url.pathToFileURL(join(homedir(), '.dsh/profiles/web/node_modules/dsh-agents/lib/index.js')).href
const m = await import(installed)
console.log('[OK] import name=' + m.name + ' inject=' + JSON.stringify(m.inject))

let registered = null
const fakeSettings = {
  register: (ns, schema, opts = {}) => {
    registered = { ns, schemaType: typeof schema, base: JSON.stringify(opts.base ?? {}) }
    let user = {}
    const dm = (b, u) => { const o = { ...(b ?? {}) }; for (const [k, v] of Object.entries(u ?? {})) { o[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? dm(o[k], v) : v } return o }
    return {
      get: () => dm(opts.base ?? {}, user),
      // ⚠️ 宿主真契约：scope.update(patch)/scope.replace(section)，ns 已闭包绑定
      update: async (p) => { user = dm(user, p) },
      replace: async (s) => { user = s ?? {} },
    }
  },
}
const tools = new Map()
const httpRoutes = []
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d) } },
  agents: {},
  effect: (f) => f(),
  inject: (deps, cb) => { if (deps.every((d) => ctx[d] !== undefined)) cb(ctx) },
  settings: fakeSettings,
  webServer: { register: (route) => { httpRoutes.push(route); return () => {} } },
  get: (n) => ctx[n],
}
await m.apply(ctx, {
  tiers: {
    LOW: { provider: 'deepseek', model: 'deepseek-flash' },
    MEDIUM: { provider: 'glm-pro', model: 'glm-5.3-flash' },
    HIGH: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  },
})
console.log('[OK] tools: ' + [...tools.keys()].join(', '))
if (!registered) { console.log('[FAIL] settings 未注册'); process.exit(1) }
console.log('[OK] settings 注册 ns=' + registered.ns + ' schema=' + registered.schemaType + ' base=' + registered.base)

// ── 设置卡端点（ctx.inject(['webServer']) 应已注册 exact 路由） ────────────
const route = httpRoutes.find((r) => r.kind === 'exact' && String(r.path).includes('dsh-agents'))
if (!route || typeof route.handler !== 'function') { console.log('[FAIL] 设置卡端点未注册，routes=' + JSON.stringify(httpRoutes)); process.exit(1) }
console.log('[OK] 设置卡端点已注册: ' + route.path)

function fakeRes() {
  const res = { statusCode: 0, headers: null, bodyText: '' }
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h }
  res.end = (p) => { res.bodyText = p }
  res.json = () => JSON.parse(res.bodyText)
  return res
}
function fakeReq(method, bodyObj) {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]
  return {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
}
const getRes = fakeRes()
await route.handler(fakeReq('GET'), getRes)
if (getRes.statusCode !== 200 || getRes.json().tiers?.MEDIUM?.provider !== 'glm-pro') {
  console.log('[FAIL] 端点 GET: ' + getRes.statusCode + ' ' + getRes.bodyText.slice(0, 200)); process.exit(1)
}
console.log('[OK] 端点 GET: ' + getRes.bodyText.slice(0, 140) + '…')

const roles = tools.get('agent_roles')
const before = await roles.execute({ action: 'tiers' })
console.log('[OK] tiers.MEDIUM=' + JSON.stringify(before.tiers.MEDIUM) + ' 来源=' + before.tierSources.MEDIUM)
const set = await roles.execute({ action: 'set', tier: 'MEDIUM', provider: 'test-prov', model: 'test-model' })
if (!set.ok || set.tiers.MEDIUM.provider !== 'test-prov') { console.log('[FAIL] set 流程: ' + JSON.stringify(set).slice(0, 300)); process.exit(1) }
console.log('[OK] set 即时生效: ' + JSON.stringify(set.tiers.MEDIUM) + ' 来源=' + set.tierSources.MEDIUM)

// 端点与工具同源：工具 set 后端点 GET 应读到同一个值
const getRes2 = fakeRes()
await route.handler(fakeReq('GET'), getRes2)
if (getRes2.json().tiers.MEDIUM.provider !== 'test-prov') { console.log('[FAIL] 端点与工具不同源: ' + getRes2.bodyText.slice(0, 200)); process.exit(1) }
console.log('[OK] 端点/工具同源: ' + getRes2.json().tiers.MEDIUM.provider)

// 端点 PATCH 改档 → 工具 tiers 也要读到
const patchRes = fakeRes()
await route.handler(fakeReq('PATCH', { tier: 'HIGH', provider: 'patch-prov', model: 'patch-model' }), patchRes)
if (patchRes.statusCode !== 200) { console.log('[FAIL] 端点 PATCH: ' + patchRes.statusCode + ' ' + patchRes.bodyText.slice(0, 200)); process.exit(1) }
const after = await roles.execute({ action: 'tiers' })
if (after.tiers.HIGH.provider !== 'patch-prov') { console.log('[FAIL] PATCH 未反映到工具: ' + JSON.stringify(after.tiers.HIGH)); process.exit(1) }
console.log('[OK] 端点 PATCH→工具可见: HIGH=' + JSON.stringify(after.tiers.HIGH) + ' 来源=' + after.tierSources.HIGH)

const reset = await roles.execute({ action: 'reset' })
if (!reset.ok || reset.tiers.MEDIUM.provider !== 'glm-pro') { console.log('[FAIL] reset: ' + JSON.stringify(reset).slice(0, 300)); process.exit(1) }
console.log('[OK] reset 回落: ' + JSON.stringify(reset.tiers.MEDIUM))
console.log('SMOKE ALL PASS')
