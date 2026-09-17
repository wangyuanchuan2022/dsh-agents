/**
 * dsh-agents 设置接线——三档模型路由的运行时配置（Web 设置页「插件」卡片可编辑）。
 *
 * 服务端职责（对照 dsh-dafeiyu 0.1.6 生产实现 + 宿主 @deepseek-ai/dsh-settings
 * 自带的 installSettingsSection 标准接线写法）：
 *  ① 在宿主 settings 服务注册命名空间 'dsh-agents'：schema 声明三档 tiers；
 *     base = cordis.patch.yml 的 config.tiers（合成基底），用户在设置页改的值
 *     落 user 层；解析顺序 = schema 默认 < base(合成配置) < user(用户手改)。
 *     ⚠️ 设置卡能否出现取决于「命名空间已注册（服务端）× 卡片已注册（浏览器
 *     端 lib/client.js，key=同一命名空间）」的交集——缺一半都不渲染。
 *     2026-09-12「没有设置卡」事故的根因：只有服务端一半 + 用 ctx.get('settings')
 *     字符串取服务拿不到（cordis 要用 ctx.inject(['settings'], cb) 等挂载），
 *     双重静默降级。
 *  ② createTiersApi：三个工具与 HTTP 端点（lib/http-config.js）共用的档位
 *     读取/写入面。每次调用现取 settings 解析值——设置页改完即时生效，无需重启。
 *
 * 依赖 @deepseek-ai/schemastery（静态导入：它是 package.json 声明的硬依赖，
 * 与插件同装在 node_modules；测试与 boot-schema-check 会在装前抓住解析问题）。
 * @module settings
 */
import Schema from '@deepseek-ai/schemastery'
import { TIERS } from './roles.js'
import { resolveTierTable } from './routing.js'

/** settings 命名空间（设置页里的 dsh-agents 卡片 key，与 lib/client.js 保持一致）。 */
export const SETTINGS_NS = 'dsh-agents'

function route(label) {
  return Schema.object({
    provider: Schema.string().required().description(`${label} 的 provider 路由 id`),
    model: Schema.string().required().description(`${label} 的模型 id（须在该 provider 目录中存在）`),
  }).description(label)
}

/**
 * tiers 设置 schema（宿主 describe() 会把它 toJSON 后下发设置页——只可用声明式
 * 构造器，禁止字符串回调）。
 */
export const TIERS_SCHEMA = Schema.object({
  tiers: Schema.object({
    LOW: route('LOW 档（检索/定位/文档/批量转录等窄任务）'),
    MEDIUM: route('MEDIUM 档（实现/调试/测试/设计/QA/提交等主力工作）'),
    HIGH: route('HIGH 档（需求分析/规划/架构/评审等长链条推理）'),
  }).description('三档模型路由：改完即时生效，无需重启'),
})

/** JSON 安全字符串化（来源对比用；不可序列化返回 null）。 */
function safeJson(value) {
  try { return JSON.stringify(value ?? {}) } catch { return null }
}

/**
 * 创建三工具 + HTTP 端点共用的档位 API，并用宿主标准方式接上 settings 服务。
 *
 * @param {object} ctx - cordis 上下文（settings 为可选服务：ctx.inject 等挂载）
 * @param {object} baseTiers - 合成基底（resolveConfig 出的全量档位表）
 * @returns {{getTable: Function, getScope: Function, hasScope: Function,
 *            getBase: Function, sourcesOf: Function}}
 */
export function createTiersApi(ctx, baseTiers) {
  let scope = null
  try {
    // 对照 dsh-settings 的 installSettingsSection：服务可能晚于本插件挂载，
    // 必须用 ctx.inject 等 'settings' 就绪后再 register（注册效应挂在调用方
    // fiber 上，插件卸载时命名空间随之移除）。
    ctx.inject?.(['settings'], (sctx) => {
      scope = sctx.settings?.register?.(SETTINGS_NS, TIERS_SCHEMA, { base: { tiers: baseTiers } }) ?? null
      if (scope === null) {
        console.error('[dsh-agents] settings 服务已挂载但 register 不可用——设置卡将显示不可用')
      }
    })
  } catch (e) {
    console.error('[dsh-agents] settings 接线失败，三档配置回落 cordis：', e?.message ?? e)
  }
  return {
    /** 当前生效档位表（settings 解析值 > cordis 配置 > 内置默认），每次现取。 */
    getTable: () => {
      if (scope) {
        try {
          const viaSettings = scope.get()?.tiers
          if (viaSettings) return resolveTierTable(viaSettings)
        } catch (e) {
          console.error('[dsh-agents] settings 档位表读取失败，回落 cordis 配置：', e?.message ?? e)
        }
      }
      return baseTiers
    },
    getScope: () => scope,
    hasScope: () => scope !== null,
    /** 合成基底（cordis.patch.yml 的 config.tiers，已解析内置默认）。 */
    getBase: () => baseTiers,
    /** 各档位当前生效来源（设置（用户层覆盖）/ cordis 配置基底 / cordis 配置 / 内置默认）。 */
    sourcesOf: (table) => {
      const out = {}
      for (const tier of TIERS) {
        if (!scope) {
          out[tier] = baseTiers?.[tier] ? 'cordis 配置' : '内置默认'
          continue
        }
        const eff = safeJson(table[tier])
        const base = safeJson(baseTiers?.[tier])
        out[tier] = eff !== null && base !== null && eff !== base
          ? '设置（用户层覆盖）'
          : (baseTiers?.[tier] ? 'cordis 配置基底' : '内置默认')
      }
      return out
    },
  }
}
