/** 重启后核验（非破坏版）：引导图条目 + client.js 分发 + 端点 GET/PATCH。
 * 写路径测试只动 MEDIUM，结束时恢复测试前原值——绝不再 resetAll 清用户配置。 */
import http from 'node:http'

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port: 3080, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (r) => { let d = ''; r.on('data', (c) => { d += c }); r.on('end', () => resolve({ status: r.statusCode, body: d })) },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

let failed = 0
const check = (ok, label, detail = '') => { console.log((ok ? '[OK] ' : '[FAIL] ') + label + (detail ? ' | ' + detail : '')); if (!ok) failed += 1 }

// ① 引导图条目
const root = await request('GET', '/')
const entry = root.body.match(/\{"id":"dsh-agents"[^\}]*\}/)
check(root.status === 200 && entry !== null, '① 引导图含 dsh-agents 条目', entry ? entry[0] : '未找到')

// ② client.js 分发
const client = await request('GET', '/plugins/dsh-agents/client.js?rev=post-restart')
check(client.status === 200 && client.body.startsWith("window.__ModuleLoader__.load({ id: 'dsh-agents'"), '② /plugins/dsh-agents/client.js 分发正常', `status=${client.status} bytes=${client.body.length}`)

// ③ 设置卡端点 GET
const cfg = await request('GET', '/plugins/dsh-agents/config')
let cfgBody = {}
try { cfgBody = JSON.parse(cfg.body) } catch {}
check(cfg.status === 200 && cfgBody.tiers?.MEDIUM?.provider !== undefined, '③ 端点 GET 返回档位表', `status=${cfg.status} MEDIUM=${JSON.stringify(cfgBody.tiers?.MEDIUM)}`)
check(cfgBody.settingsAvailable === true, '④ settings 命名空间已挂接', `settingsAvailable=${cfgBody.settingsAvailable}`)
check(cfgBody.sources !== undefined && Object.keys(cfgBody.sources).length === 3, '⑤ 来源标注齐全', JSON.stringify(cfgBody.sources))
const catKeys = Object.keys(cfgBody.catalog ?? {})
check(catKeys.length > 0, '⑥ 模型目录非空（下拉数据源）', `providers=${catKeys.length}: ${catKeys.slice(0, 10).join(', ')}`)
console.log('   diag:', JSON.stringify(cfgBody.diag ?? {}))

// ⑦ 写路径活体：只动 MEDIUM → 读回 → 恢复原值（不 resetAll）
const before = cfgBody.tiers?.MEDIUM ?? { provider: '', model: '' }
const patch = await request('PATCH', '/plugins/dsh-agents/config', { tier: 'MEDIUM', provider: 'verify-prov', model: 'verify-model' })
let patchBody = {}
try { patchBody = JSON.parse(patch.body) } catch {}
check(patch.status === 200 && patchBody.tiers?.MEDIUM?.provider === 'verify-prov', '⑦ PATCH 改档写入并回读', `status=${patch.status} MEDIUM=${JSON.stringify(patchBody.tiers?.MEDIUM)}`)
const after = await request('GET', '/plugins/dsh-agents/config')
const afterBody = JSON.parse(after.body)
check(afterBody.tiers?.MEDIUM?.provider === 'verify-prov' && afterBody.sources?.MEDIUM === '设置（用户层覆盖）', '⑧ GET 复读一致且来源=用户层覆盖', `sources.MEDIUM=${afterBody.sources?.MEDIUM}`)
const restore = await request('PATCH', '/plugins/dsh-agents/config', { tier: 'MEDIUM', provider: before.provider, model: before.model })
const restoreBody = JSON.parse(restore.body)
check(restore.status === 200 && restoreBody.tiers?.MEDIUM?.provider === before.provider, '⑨ 已恢复测试前原值（非破坏清理）', `MEDIUM=${JSON.stringify(restoreBody.tiers?.MEDIUM)}`)

console.log(failed === 0 ? 'POST-RESTART VERIFY: ALL PASS' : `POST-RESTART VERIFY: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
