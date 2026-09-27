/**
 * 启动前校验：用宿主 dsh-tools 的 assertSupportedJsonSchema（真实校验器）
 * 验证三个工具的 parameters + output.schema，提前抓住「能过单测但炸 profile
 * boot」的 schema 兼容性问题（2026-09-12 tierSources 事故的永久验收门）。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
// 宿主全局 DSH 安装位置运行时解析（APPDATA 环境变量），不落用户名字面量
const dshToolsUrl = pathToFileURL(join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href
const { assertSupportedJsonSchema } = await import(dshToolsUrl)
const m = await import('../lib/index.js')

const tools = new Map()
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d) } },
  agents: {},
  effect: (f) => f(),
  get: () => undefined,
}
m.apply(ctx, {
  tiers: {
    LOW: { provider: 'deepseek', model: 'deepseek-flash' },
    MEDIUM: { provider: 'glm-pro', model: 'glm-5.3-flash' },
    HIGH: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  },
})

let failed = 0
for (const [name, def] of tools) {
  for (const [label, schema] of [['parameters', def.parameters], ['output.schema', def.output?.schema]]) {
    try {
      assertSupportedJsonSchema(schema)
      console.log(`[OK] ${name} ${label}`)
    } catch (e) {
      failed += 1
      console.log(`[FAIL] ${name} ${label}: ${e.message}`)
    }
  }
}
console.log(failed === 0 ? 'BOOT SCHEMA CHECK: ALL PASS' : `BOOT SCHEMA CHECK: ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
