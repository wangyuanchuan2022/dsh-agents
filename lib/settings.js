/**
 * dsh-agents 设置接线——三档模型路由的运行时配置（Web 设置页「插件」页可编辑）。
 *
 * 两代宿主形态（2026-09-28 实证，宿主 0.1.7-rc.2）：
 *  - 旧宿主（<= 0.1.0-rc.x）：`settings.register(ns, schema, {base})` 返回命名空间
 *    作用域（scope.get/update/replace），用户层覆盖单独存放。
 *  - 新宿主（0.1.7+）：settings 换成 **loader entry 配置表单**（SettingsForms 只暴露
 *    configure/describe/update/replace/mutate），`register` 已移除；档位值就是 entry
 *    `dsh-agents` 的 `config.tiers`（默认在 bundle 的 cordis.patch.yml，设置页改动落
 *    profile patch），读取走 `describe()`、写入走 `update()`/`mutate()`。settings.yaml
 *    也被宿主改成「导入 profile 后重命名为 *.imported」的 legacy 文档。
 *    ⚠️ describe() 会跳过「没有 Config schema」或「schema 里没有任何 volatile 字段」的
 *    entry（dsh-settings/lib/index.js:416-419 的 volatileForm 规则）——所以 entry 模块
 *    必须导出 {@link CONFIG_SCHEMA}（见 lib/index.js 的 `Config`），三档必须标 volatile。
 *
 * 本模块把两代收敛成同一个 tiersApi（getTable / hasScope / writeTiers / resetAll …），
 * 三个工具与 HTTP 端点（lib/http-config.js）共用；能力缺失时降级为「只读 cordis
 * 配置」并如实回报 hasScope()=false，绝不让整条链路抛错。
 *
 * 依赖 @deepseek-ai/schemastery（静态导入：它是 package.json 声明的硬依赖，
 * 与插件同装在 node_modules；测试与 boot-schema-check 会在装前抓住解析问题）。
 * @module settings
 */
import Schema from '@deepseek-ai/schemastery'
import { TIERS } from './roles.js'
import { resolveTierTable } from './routing.js'

/** settings 命名空间 = loader entry id（设置页里的 dsh-agents 页 key，与 lib/client.js 保持一致）。 */
export const SETTINGS_NS = 'dsh-agents'

function route(label) {
  return Schema.object({
    provider: Schema.string().required().description(`${label} 的 provider 路由 id`),
    model: Schema.string().required().description(`${label} 的模型 id（须在该 provider 目录中存在）`),
  }).description(label)
}

/** 非必填版本的 route（entry Config 用：允许用户只覆盖部分档位，缺的走 resolveTierTable 默认）。 */
function routeLoose(label) {
  return Schema.object({
    provider: Schema.string().description(`${label} 的 provider 路由 id`),
    model: Schema.string().description(`${label} 的模型 id（须在该 provider 目录中存在）`),
  }).description(label)
}

/**
 * tiers 设置 schema（旧宿主 register 路径用；宿主 describe() 会把它 toJSON 后下发
 * 设置页——只可用声明式构造器，禁止字符串回调）。
 */
export const TIERS_SCHEMA = Schema.object({
  tiers: Schema.object({
    LOW: route('LOW 档（检索/定位/文档/批量转录等窄任务）'),
    MEDIUM: route('MEDIUM 档（实现/调试/测试/设计/QA/提交等主力工作）'),
    HIGH: route('HIGH 档（需求分析/规划/架构/评审等长链条推理）'),
  }).description('三档模型路由：改完即时生效，无需重启'),
})

/**
 * 标 volatile：宿主 dsh-settings 的 volatileForm 只把 `schema.meta.volatile` 为真的
 * 字段放进设置表单，也只有这样的 entry 会被 describe() 回报。新版 schemastery 提供
 * `.volatile()`，而本插件解析到的是 3.18.2（该版本尚无此方法）——所以这里两者都支持：
 * 有方法就用方法，否则直接写 `meta.volatile`（meta 可写，toJSON 也会带上该标记）。
 * 标记失败只告警不抛错——插件必须能加载，大不了该字段不进设置表单。
 * @param {object} schema - schemastery schema。
 * @returns {object} 同一个 schema（便于链式书写）。
 */
function markVolatile(schema) {
  try {
    if (typeof schema?.volatile === 'function') return schema.volatile()
    if (schema?.meta && typeof schema.meta === 'object') {
      schema.meta.volatile = true
      if (schema.meta.volatile === true) return schema
    }
  } catch { /* 落到下面的告警 */ }
  console.error('[dsh-agents] schemastery 不支持 volatile 标记——该字段不会进设置表单（档位会退化为只读 cordis 配置）')
  return schema
}

/** Config schema 里的档位路由（非必填：允许只覆盖部分档位）。 */
function tierRoute(label) {
  return markVolatile(routeLoose(label))
}

/**
 * entry Config schema（lib/index.js 以 `export const Config` 暴露给宿主）：
 * - 三档 tiers 与两个开关标 volatile——宿主只把 volatile 字段放进设置表单，
 *   也只会把 volatile 字段回报进 describe().value（我们的读写面就吃这个值）；
 * - 其余字段是普通配置，但**必须全部声明**：schemastery 按 schema 归一配置，
 *   漏声明会让 roleOverrides / allowSpawn 之类的值在 loader 解析后丢失。
 */
export const CONFIG_SCHEMA = Schema.object({
  tiers: Schema.object({
    LOW: tierRoute('LOW 档（检索/定位/文档/批量转录等窄任务）'),
    MEDIUM: tierRoute('MEDIUM 档（实现/调试/测试/设计/QA/提交等主力工作）'),
    HIGH: tierRoute('HIGH 档（需求分析/规划/架构/评审等长链条推理）'),
  }).description('三档模型路由：改完即时生效，无需重启'),
  roleOverrides: Schema.dict(routeLoose('按角色覆盖档位')).description('角色 id → 档位路由（可选）'),
  defaultPreset: Schema.string().description('角色会话的 Agent 预设 id（缺省 = DSH 默认预设）'),
  clarifyMode: markVolatile(Schema.union(['interactive', 'autonomous']).description('任务书澄清模式缺省值')),
  agentOutSubdir: Schema.string().description('未显式给 evidencePath 时产出落 <cwd>/<子目录>/<角色id>-<时间戳>.md'),
  allowSpawn: markVolatile(Schema.boolean().description('false = 禁用 agent_spawn（agent_roles/agent_taskbook 仍可用）')),
})

// fail-loud：三档必须真的标上 volatile，否则宿主 describe() 会跳过本 entry，
// 设置卡会静默退化成「只读 cordis 配置」（写再多也没人回报）。
for (const tier of ['LOW', 'MEDIUM', 'HIGH']) {
  if (CONFIG_SCHEMA.dict?.tiers?.dict?.[tier]?.meta?.volatile !== true) {
    console.error(`[dsh-agents] Config.${tier} 未能标 volatile——设置卡将退化为只读`)
  }
}

/** JSON 安全字符串化（来源对比用；不可序列化返回 null）。 */
function safeJson(value) {
  try { return JSON.stringify(value ?? {}) } catch { return null }
}

/** 写入冲突（宿主 SettingsConflictError 的稳定 code）时用最新 revision 重试一次。 */
const CONFLICT_CODE = 'SETTINGS_CONFLICT'

/**
 * 创建三工具 + HTTP 端点共用的档位 API，并接上宿主 settings 服务（两代形态自适应）。
 *
 * @param {object} ctx - cordis 上下文（settings 为可选服务：ctx.inject 等挂载）
 * @param {object} baseTiers - 合成基底（bundle patch 的 config.tiers，已解析内置默认）
 * @returns {{getTable: Function, getScope: Function, hasScope: Function,
 *            getBase: Function, sourcesOf: Function,
 *            writeTiers: Function, resetAll: Function}}
 */
export function createTiersApi(ctx, baseTiers) {
  /** 旧宿主：register 作用域。 */
  let scope = null
  /** 新宿主：SettingsForms 服务本体。 */
  let forms = null
  try {
    // 对照 dsh-settings 的两代接线：服务可能晚于本插件挂载，必须用 ctx.inject 等
    // 'settings' 就绪后再接（效应挂在调用方 fiber 上，插件卸载随之清理）。
    ctx.inject?.(['settings'], (sctx) => {
      const settings = sctx.settings ?? null
      if (typeof settings?.register === 'function') {
        scope = settings.register(SETTINGS_NS, TIERS_SCHEMA, { base: { tiers: baseTiers } })
        return
      }
      if (typeof settings?.describe === 'function' && typeof settings?.update === 'function') {
        forms = settings
        // 新宿主没有 register：档位由 entry config 承载。本插件自带设置卡
        // （lib/client.js 注册 settings.plugins.tab），抑制宿主为同一 entry
        // 自动生成的表单页，避免同一命名空间出现两套编辑面。
        try {
          settings.configure?.({ auto: false }, sctx.fiber)
        } catch (e) {
          console.error('[dsh-agents] settings.configure(auto:false) 失败（会多出一个自动页，功能不受影响）：', e?.message ?? e)
        }
        return
      }
      console.error('[dsh-agents] settings 服务已挂载但没有可用的读写面（register / describe+update 均缺失）——设置卡将显示不可用')
    })
  } catch (e) {
    console.error('[dsh-agents] settings 接线失败，三档配置回落 cordis：', e?.message ?? e)
  }

  const available = () => scope !== null || forms !== null

  /** 新宿主：取本插件 entry 的 live 配置描述符（value + revision）。 */
  const formsEntry = () => {
    if (!forms) return undefined
    try {
      const list = forms.describe()
      return Array.isArray(list) ? list.find((d) => d?.ns === SETTINGS_NS) : undefined
    } catch (e) {
      console.error('[dsh-agents] settings describe() 失败，按未覆盖处理：', e?.message ?? e)
      return undefined
    }
  }

  /** 新宿主：entry config 里的 tiers（缺失 = 未覆盖）。 */
  const formsTiers = () => {
    const value = formsEntry()?.value
    const tiers = value && typeof value === 'object' ? value.tiers : undefined
    return tiers && typeof tiers === 'object' ? tiers : undefined
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
      } else if (forms) {
        const viaEntry = formsTiers()
        if (viaEntry) return resolveTierTable(viaEntry)
      }
      return baseTiers
    },
    getScope: () => scope,
    hasScope: available,
    /** 合成基底（bundle patch 的 config.tiers，已解析内置默认）。 */
    getBase: () => baseTiers,
    /**
     * 写入档位（部分档位合并；新宿主落 profile patch 的 entry config，即时生效）。
     * @param {object} patchTiers - 形如 { HIGH: { provider, model } }。
     * @returns {Promise<void>}
     */
    writeTiers: async (patchTiers) => {
      if (scope) {
        if (typeof scope.update !== 'function') throw new Error('当前 settings 服务不支持写入档位')
        await scope.update({ tiers: patchTiers })
        return
      }
      if (forms) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const entry = formsEntry()
          const current = entry?.value && typeof entry.value === 'object' && entry.value.tiers && typeof entry.value.tiers === 'object'
            ? entry.value.tiers
            : {}
          try {
            await forms.update(SETTINGS_NS, { tiers: { ...current, ...patchTiers } }, entry?.revision)
            return
          } catch (e) {
            if (attempt === 1 || e?.code !== CONFLICT_CODE) throw e
          }
        }
        return
      }
      throw new Error('设置服务不可用：档位写入需宿主 settings 服务（重启 DSH 后可用）')
    },
    /** 清除全部档位覆盖，回落 bundle patch 的 config.tiers / 内置默认。 */
    resetAll: async () => {
      if (scope) {
        if (typeof scope.replace !== 'function') throw new Error('当前 settings 服务不支持 resetAll')
        await scope.replace({}) // 宿主契约：scope.replace(section)，ns 已闭包绑定
        return
      }
      if (forms) {
        if (typeof forms.mutate !== 'function') throw new Error('当前 settings 服务不支持 resetAll')
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await forms.mutate(SETTINGS_NS, [{ op: 'unset', path: ['tiers'] }], formsEntry()?.revision)
            return
          } catch (e) {
            if (attempt === 1 || e?.code !== CONFLICT_CODE) throw e
          }
        }
        return
      }
      throw new Error('设置服务不可用：档位写入需宿主 settings 服务（重启 DSH 后可用）')
    },
    /** 各档位当前生效来源（设置（用户层覆盖）/ cordis 配置基底 / cordis 配置 / 内置默认）。 */
    sourcesOf: (table) => {
      const out = {}
      for (const tier of TIERS) {
        if (!available()) {
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
