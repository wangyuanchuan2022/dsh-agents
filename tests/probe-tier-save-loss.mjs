/**
 * 探针：「保存某一档 → 另外两档是否掉回配置基底」的可判定判据。
 *
 * 两种模式：
 *   ① 离线（默认）：用忠实假宿主（复刻 dsh-settings/dsh-config-editor 的写语义）
 *      驱动真实的 createTiersApi → 打印三档前后值。修复前：另两档被陈旧层打回
 *      memory 值；修复后：保留 user 层值。
 *   ② 活体（--live）：打真实端点 POST/PATCH /plugins/dsh-agents/config，幂等保存
 *      某一档（写入值 = 该档当前值），看另外两档的实时值 + sources。
 *      用法：node tests/probe-tier-save-loss.mjs --live [tier]
 *      ⚠️ 活体模式会真写 profile patch（幂等值 → 内容应不变）；请自行先记录
 *      cordis.patch.yml 的 SHA256 以证明净零。
 *
 * 直跑（沙箱内 node 子进程 pipe 捕获会 EPERM，故不 spawn）：
 *   node tests/probe-tier-save-loss.mjs
 *   node tests/probe-tier-save-loss.mjs --live HIGH
 */
import { createTiersApi } from '../lib/settings.js'
import { resolveTierTable } from '../lib/routing.js'

// ── 忠实假宿主：复刻 0.1.7 真实写语义（与 tests/run.mjs 的 hostTierFake 同源） ──
export function hostTierFake({ memory, patch = {} } = {}) {
  const clone = (v) => JSON.parse(JSON.stringify(v))
  let revision = 1
  let memorySnapshot = clone({ tiers: memory }) // loader 内存快照：写盘后不刷新
  let patchLayer = clone(patch) // profile patch 覆盖层：每次 describe 从磁盘重读
  const calls = { update: [] }
  const deepMerge = (under, over) => {
    if (under === null || typeof under !== 'object' || Array.isArray(under)) return over
    if (over === null || typeof over !== 'object' || Array.isArray(over)) return over
    const out = { ...under }
    for (const [key, value] of Object.entries(over)) {
      Object.defineProperty(out, key, {
        value: Object.hasOwn(out, key) ? deepMerge(out[key], value) : value,
        enumerable: true, configurable: true, writable: true,
      })
    }
    return out
  }
  return {
    calls,
    setPatchLayer: (next) => { patchLayer = clone(next); revision += 1 },
    patchLayer: () => clone(patchLayer),
    describe: () => [{
      ns: 'dsh-agents', autoGenerate: false, schema: null, applies: 'live', revision,
      value: clone(memorySnapshot),
      user: clone(patchLayer),
    }],
    configure: () => () => {},
    update: async (ns, input, expectedRevision) => {
      calls.update.push({ ns, input, expectedRevision })
      if (ns !== 'dsh-agents') throw new Error(`unexpected ns ${ns}`)
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        const e = new Error('settings conflict'); e.code = 'SETTINGS_CONFLICT'; throw e
      }
      patchLayer = deepMerge(memorySnapshot, input)
      revision += 1
    },
    mutate: async () => { throw new Error('hostTierFake.mutate 未实现') },
  }
}

const MEMORY = {
  LOW: { provider: 'mem-low', model: 'mem-low-m' },
  MEDIUM: { provider: 'mem-med', model: 'mem-med-m' },
  HIGH: { provider: 'mem-high', model: 'mem-high-m' },
}
const PATCH = {
  LOW: { provider: 'user-low', model: 'user-low-m' },
  MEDIUM: { provider: 'user-med', model: 'user-med-m' },
  HIGH: { provider: 'user-high', model: 'user-high-m' },
}

/** 最小 cordis ctx（只喂 createTiersApi 需要的 inject/settings）。 */
function fakeCtx(overrides = {}) {
  const ctx = {
    effect: (fn) => { fn() },
    inject: (deps, cb) => { if (deps.every((d) => ctx[d] !== undefined)) cb(ctx) },
    get: (name) => overrides[name],
  }
  Object.assign(ctx, overrides)
  return ctx
}

const short = (t) => Object.fromEntries(Object.entries(t ?? {}).map(([k, v]) => [k, v?.model]))

async function offline() {
  // ⚠️ patch 参数 = profile patch 的 **entry config 层**（形如 {tiers:{…}}），不是裸 tiers 映射。
  //    传错形状（裸 tiers）会让 entry.user.tiers === undefined，静默退化成「无用户层」，
  //    于是回归锁测不出任何东西——这正是 harness plumbing 必须自证的原因（见下面 selfCheck）。
  const settings = hostTierFake({ memory: MEMORY, patch: { tiers: PATCH } })
  const selfCheck = settings.describe()[0]
  if (selfCheck.user?.tiers?.MEDIUM?.model !== 'user-med-m' || selfCheck.value?.tiers?.MEDIUM?.model !== 'mem-med-m') {
    console.error('❌ 假宿主 plumbing 自检失败：entry.user/entry.value 形状不对，本探针结论无效')
    return 3
  }
  const tiersApi = createTiersApi(fakeCtx({ settings }), resolveTierTable(MEMORY))
  console.log('== 离线探针（忠实假宿主）==')
  console.log('plumbing 自检 : value.tiers.MEDIUM=%s / user.tiers.MEDIUM=%s ✅',
    selfCheck.value.tiers.MEDIUM.model, selfCheck.user.tiers.MEDIUM.model)
  console.log('base(memory) :', JSON.stringify(short(MEMORY)))
  console.log('patch(user)  :', JSON.stringify(short(settings.patchLayer().tiers)))
  console.log('getTable()   :', JSON.stringify(short(tiersApi.getTable())))
  await tiersApi.writeTiers({ LOW: { provider: 'new-low', model: 'new-low-m' } })
  const after = settings.patchLayer().tiers
  console.log('写 LOW 之后   :', JSON.stringify(short(after)))
  console.log('update 载荷   :', JSON.stringify(settings.calls.update.at(-1)?.input?.tiers))
  const kept = after.MEDIUM.model === 'user-med-m' && after.HIGH.model === 'user-high-m'
  console.log(`判定：写单档后另两档用户层值 ${kept ? '保留 2/2 ✅ PASS' : '丢失 ❌ FAIL'}`)
  console.log('  LOW   :', after.LOW.model, '(期望 new-low-m)')
  console.log('  MEDIUM:', after.MEDIUM.model, '(期望 user-med-m)')
  console.log('  HIGH  :', after.HIGH.model, '(期望 user-high-m)')
  return kept ? 0 : 1
}

async function live(tierName) {
  const endpoint = 'http://127.0.0.1:3080/plugins/dsh-agents/config'
  console.log('== 活体探针 ==', endpoint)
  const before = await (await fetch(endpoint, { cache: 'no-store' })).json()
  console.log('保存前 tiers  :', JSON.stringify(short(before.tiers)))
  console.log('保存前 sources:', JSON.stringify(before.sources))
  const cur = before.tiers?.[tierName]
  if (!cur) { console.error(`未知档位 ${tierName}`); return 2 }
  const t0 = Date.now()
  const res = await fetch(endpoint, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: tierName, provider: cur.provider, model: cur.model }), // 幂等：写回该档当前值
  })
  const ms = Date.now() - t0
  const body = await res.json()
  console.log(`PATCH {tier:${tierName}} 幂等保存 HTTP ${res.status} 用时 ${ms} ms`)
  console.log('保存后 tiers  :', JSON.stringify(short(body.tiers)))
  console.log('保存后 sources:', JSON.stringify(body.sources))
  const others = ['LOW', 'MEDIUM', 'HIGH'].filter((t) => t !== tierName)
  const lost = others.filter((t) => JSON.stringify(before.tiers[t]) !== JSON.stringify(body.tiers[t]))
  console.log(`判定：另两档 ${lost.length === 0 ? '均未被改动 ✅ PASS' : `被改动 ${lost.join(',')} ❌ FAIL`}`)
  return lost.length === 0 ? 0 : 1
}

const args = process.argv.slice(2)
const code = args.includes('--live') ? await live(args.find((a) => ['LOW', 'MEDIUM', 'HIGH'].includes(a)) ?? 'HIGH') : await offline()
process.exit(code)
