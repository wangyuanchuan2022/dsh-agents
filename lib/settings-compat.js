/**
 * dsh-agents — 宿主 settings 服务的跨版本读取兼容层。
 *
 * 背景（2026-09-28 实证，宿主 0.1.7-rc.2）：宿主把 settings 从「命名空间注册表」
 * 换成 loader entry 配置表单——@deepseek-ai/dsh-settings 只暴露 configure/describe/
 * update/replace/mutate，旧宿主（0.1.0-rc.x）的 `get(ns)` 已移除。插件里任何
 * `settings.get(ns)` 都会抛 "settings.get is not a function"：轻则 provider 目录解析
 * 失败（设置卡下拉为空、agent_roles 体检报「provider 不在目录中」），重则整条链路 400。
 *
 * 本模块把两代收敛成一个取值函数；读不到一律返回 undefined（调用方按「未配置」跳过），
 * 绝不抛错。与 dsh-memory-evolve/lib/settings-compat.js 是同一份实现的两个副本
 * （两个插件是独立包，不互相依赖）。
 * @module settings-compat
 */

/**
 * describe() 结果按 ns 建索引（一次遍历多处取值；旧宿主没有 describe 时返回空表）。
 * @param {object} settings - ctx.settings（或 root 解析出的 settings 服务）。
 * @returns {Map<string, unknown>} ns → 该 entry 的有效配置值。
 */
export function settingsEntryIndex(settings) {
  const map = new Map()
  if (!settings || typeof settings.describe !== 'function') return map
  try {
    const list = settings.describe()
    if (!Array.isArray(list)) return map
    for (const descriptor of list) {
      if (descriptor && typeof descriptor.ns === 'string') map.set(descriptor.ns, descriptor.value)
    }
  } catch {
    /* 降级：空索引（调用方按「未配置」处理） */
  }
  return map
}

/**
 * 读某个 entry 命名空间的有效配置值：旧宿主走 get(ns)，新宿主走 describe()。
 * @param {object} settings - ctx.settings（或 root 解析出的 settings 服务）。
 * @param {string} ns - loader entry id（新宿主 descriptor.ns；旧宿主命名空间名）。
 * @returns {unknown} 有效配置值，或 undefined（服务缺失／未配置／读取失败）。
 */
export function readSettingsEntry(settings, ns) {
  if (!settings || typeof ns !== 'string' || ns.length === 0) return undefined
  if (typeof settings.get === 'function') {
    try { return settings.get(ns) } catch { return undefined }
  }
  return settingsEntryIndex(settings).get(ns)
}

/**
 * 生成「ns → 值」读取器（循环里按 provider 逐个取值时用）：两代形态自适应，
 * 新宿主的 describe() 只建一次索引。
 * @param {object} settings - ctx.settings（或 root 解析出的 settings 服务）。
 * @returns {(ns: string) => unknown} 读取器（永不抛错）。
 */
export function settingsValueReader(settings) {
  if (!settings) return () => undefined
  if (typeof settings.get === 'function') {
    return (ns) => {
      try { return settings.get(ns) } catch { return undefined }
    }
  }
  if (typeof settings.describe !== 'function') return () => undefined
  let index = null
  return (ns) => {
    if (index === null) index = settingsEntryIndex(settings)
    return index.get(ns)
  }
}
