/**
 * 磁盘预设装载器（R3-B1 PhaseB，用户裁决选项③：独立插件自制挂载，不依赖宿主
 * agentPresets registry——registry 是 AgentPreset loader entry 注册制，不认
 * ~/.dsh/.agent-presets 磁盘用户预设，Phase B 彩排实证两套清单不一致）。
 *
 * 三层职责：
 *   1. listDiskPresets(root)——磁盘预设 id 清单（目录扫描，listPresets 用户根同源）；
 *   2. loadDiskPreset(root, id)——读 preset.yml（元数据）+ agent.cordis.yml（组件
 *      清单），经 lib/yaml-mini.js 最小子集解析；**超子集键/未知键 fail-fast 列明**
 *      （诚实边界，不静默跳过）；目录存在即权威——损坏响亮失败，不回落宿主；
 *   3. mountDiskPreset(agentCtx, rows, deps)——组件级挂载契约（从宿主组件包导出
 *      形态逆向，注册名实测见各锚）：
 *        - `export {apply, inject, name, Config}` 插件形（dsh-persona / dsh-tool-pwsh /
 *          dsh-tool-fs / dsh-tool-str-replace-editor / dsh-command-compact）：
 *          优先 agentCtx.plugin（cordis 完整生命周期），缺失时 apply 直挂（降级声明）；
 *        - default class 服务形（dsh-compaction-basic 等）：agentCtx.plugin(class)；
 *        - `cordis:group` 行：v1 **拍平**挂载子组件到同一 ctx——isolate 隔离语义
 *          未复刻，显式声明偏差（deviations 返回值）；
 *        - 其余形态（import 失败 / 无 apply 且 default 非构造器）：**fail-fast 列名**。
 *
 * @module dsh-agents/disk-presets
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseYamlMini } from './yaml-mini.js'
import { detectHostVersion } from './toolscope-roster.js'

/** 预设目录里装载器消费的文件名（宿主用户预设目录约定）。 */
export const DISK_PRESET_META_FILE = 'preset.yml'
export const DISK_PRESET_COMPOSITION_FILE = 'agent.cordis.yml'

/** preset.yml 子集：已知键（超集 fail-fast 列名）。 */
const META_KNOWN_KEYS = new Set(['name', 'description', 'order'])

/** agent.cordis.yml 行子集：已知键（超集 fail-fast 列名）。 */
const ROW_KNOWN_KEYS = new Set(['id', 'name', 'group', 'isolate', 'config'])

/**
 * 组件包导入（双路链）：动态 import 的裸名从**本模块位置**向上解析——dev checkout
 * 树里没有宿主组件包（它们住在宿主 node_modules），直 import 必失败（第三轮彩排
 * 实证）。第二路：经宿主包根 createRequire.resolve 转文件 URL 再 import（宿主包根
 * 用 M11 detectHostVersion 同款探测：模块向上走查 + APPDATA npm 全局前缀候选）。
 * 依赖注入（deps.importer）优先，测试喂假组件。
 */
let hostRequireCache = null
function hostComponentRequire() {
  if (hostRequireCache !== null) return hostRequireCache
  const detected = detectHostVersion({})
  if (!detected?.via) return null
  hostRequireCache = createRequire(detected.via)
  return hostRequireCache
}

/** 默认组件导入器（双路链；失败消息列明两路线索供 fail-fast 取用）。 */
export async function importComponent(name) {
  try {
    return await import(name)
  } catch (directError) {
    const req = hostComponentRequire()
    if (req === null) {
      throw new Error(`组件 "${name}" 直 import 失败且宿主包根不可探测（${directError?.message ?? directError}）`)
    }
    let entry
    try {
      entry = req.resolve(name)
    } catch {
      // exports 只开 import 条件时 require.resolve 会拒——回落 package.json main 解析
      const pkgJsonPath = req.resolve(`${name}/package.json`)
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      entry = join(dirname(pkgJsonPath), pkg.main ?? 'index.js')
    }
    return import(pathToFileURL(entry).href)
  }
}

/** 磁盘预设 id 清单（目录扫描；root 不存在 = 空，不报错）。 */
export function listDiskPresets(root) {
  const dir = String(root ?? '')
  if (dir === '' || !existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 递归校验组件行（已知键 + 形状；嵌套 group 的 config 同规则）。 */
function validateRows(rows, at, errors) {
  if (!Array.isArray(rows)) {
    errors.push(`${at} 必须是组件行清单`)
    return
  }
  for (const [index, row] of rows.entries()) {
    const label = `${at} 第 ${index + 1} 行`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${label} 不是组件行（应为 map）`)
      continue
    }
    const unknown = Object.keys(row).filter((k) => !ROW_KNOWN_KEYS.has(k))
    if (unknown.length > 0) errors.push(`${label} 未知键（子集外）：${unknown.join(', ')}`)
    if (typeof row.name !== 'string' || row.name === '') errors.push(`${label} 缺 name（组件包名）`)
    if (row.group !== undefined && row.group !== true) errors.push(`${label} 的 group 只支持 true`)
    if (row.group === true) {
      if (!Array.isArray(row.config)) errors.push(`${label}（group）的 config 必须是子组件行清单`)
      else validateRows(row.config, `${label}.config`, errors)
    }
    if (row.isolate !== undefined && (row.isolate === null || typeof row.isolate !== 'object' || Array.isArray(row.isolate))) {
      errors.push(`${label} 的 isolate 必须是键值 map`)
    }
  }
}

/**
 * 装载一个磁盘预设（root/<id>/）。目录存在即权威：任何解析/校验失败抛错
 * （调用方 fail-fast 中止 spawn），**不静默回落宿主 registry**。
 * @param {string} root - 用户预设根目录（~/.dsh/.agent-presets 同构）
 * @param {string} id - 预设 id（目录名）
 * @returns {{id: string, dir: string, meta: object, rows: Array<object>}}
 */
export function loadDiskPreset(root, id) {
  const dir = join(String(root ?? ''), id)
  const readYaml = (file, label) => {
    const path = join(dir, file)
    if (!existsSync(path)) throw new Error(`磁盘预设 "${id}" 缺 ${label}（${path}）`)
    try {
      return parseYamlMini(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`磁盘预设 "${id}" 的 ${label} 解析失败（子集外构造）：${error.message}`)
    }
  }
  const metaRaw = readYaml(DISK_PRESET_META_FILE, DISK_PRESET_META_FILE)
  if (metaRaw === null || typeof metaRaw !== 'object' || Array.isArray(metaRaw)) {
    throw new Error(`磁盘预设 "${id}" 的 ${DISK_PRESET_META_FILE} 必须是键值 map`)
  }
  const unknownMeta = Object.keys(metaRaw).filter((k) => !META_KNOWN_KEYS.has(k))
  if (unknownMeta.length > 0) {
    throw new Error(`磁盘预设 "${id}" 的 ${DISK_PRESET_META_FILE} 未知键（子集外）：${unknownMeta.join(', ')}`)
  }
  const rowsRaw = readYaml(DISK_PRESET_COMPOSITION_FILE, DISK_PRESET_COMPOSITION_FILE)
  const errors = []
  validateRows(rowsRaw, `磁盘预设 "${id}" 组件清单`, errors)
  if (errors.length > 0) throw new Error(`磁盘预设 "${id}" 组件清单校验失败（fail-fast）：\n- ${errors.join('\n- ')}`)
  return {
    id,
    dir,
    meta: {
      name: typeof metaRaw.name === 'string' ? metaRaw.name : null,
      description: typeof metaRaw.description === 'string' ? metaRaw.description : null,
      order: typeof metaRaw.order === 'number' ? metaRaw.order : null,
    },
    rows: rowsRaw ?? [],
  }
}

/**
 * 组件级挂载契约（从宿主组件包导出形态逆向；形态判定见模块头注）。
 * @param {object} agentCtx - agents.create setup 回调注入的会话上下文
 * @param {Array<object>} rows - 装载器产出的组件行
 * @param {{importer?: (name: string) => Promise<object>, logger?: object}} [deps]
 *   importer 可注入（测试用假组件；缺省动态 import——插件与宿主组件同住 node_modules 树）
 * @returns {Promise<{mounted: string[], deviations: string[]}>}
 */
export async function mountDiskPreset(agentCtx, rows, deps = {}) {
  const imported = deps.importer ?? ((name) => importComponent(name))
  const mounted = []
  const deviations = []
  const mountRows = async (ctx, list, at) => {
    for (const [index, row] of list.entries()) {
      const label = `${at} 第 ${index + 1} 行（${row.name}）`
      if (row.name === 'cordis:group') {
        deviations.push(`${label}：cordis:group v1 拍平挂载子组件到同一上下文（isolate 隔离语义未复刻，显式声明偏差）`)
        await mountRows(ctx, Array.isArray(row.config) ? row.config : [], `${label}.config`)
        continue
      }
      let mod
      try {
        mod = await imported(row.name)
      } catch (error) {
        throw new Error(`组件 "${row.name}" 导入失败（fail-fast）：${error?.message ?? error}`)
      }
      // 形态判定：class/default 构造器（服务形）优先，其次含 apply 的插件模块命名空间。
      const isCtor = typeof mod === 'function' || typeof mod?.default === 'function'
      const plugin = isCtor ? (typeof mod === 'function' ? mod : mod.default) : (typeof mod?.apply === 'function' ? mod : null)
      if (plugin === null) {
        throw new Error(`组件 "${row.name}" 形态不在挂载契约内（无 apply 导出且 default 非构造器）——fail-fast 列名`)
      }
      try {
        if (typeof ctx?.plugin === 'function') {
          await ctx.plugin(plugin, row.config)
        } else if (typeof plugin.apply === 'function') {
          plugin.apply(ctx, row.config ?? {})
          deviations.push(`组件 "${row.name}"：agentCtx 无 plugin 面，apply 直挂（inject 未走宿主装载器，降级声明）`)
        } else {
          throw new Error('agentCtx 无 plugin 面且组件为 class 服务形（无法直挂）')
        }
      } catch (error) {
        throw new Error(`组件 "${row.name}" 挂载抛错（fail-fast）：${error?.message ?? error}`)
      }
      mounted.push(row.name)
    }
  }
  await mountRows(agentCtx, Array.isArray(rows) ? rows : [], '组件清单')
  return { mounted, deviations }
}
