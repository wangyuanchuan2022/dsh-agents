/**
 * context/project-status.js —— **项目全景文档层**（项目台账的静态正本）。
 *
 * ## 存在理由
 *
 * advisor 的可见面里真人消息只占 1.02% 字符（实测，见
 * `agent-out/advisor-global-vision-research.md`），`tool/call` 与 `tool/result`
 * 全部被 role 白名单滤掉 ⇒ 它**不知道项目在做什么、到哪了**。
 * 而 AC-62 门又让「继续 / 下一步做什么」这类消息**完全不触发仓库检索**
 * （实测 7/12 条）——恰恰是最需要全局视野的时刻。
 *
 * 本层读取仓库内**单一固定文件** `docs/PROJECT-STATUS.md`，作为每轮都注入的
 * 「项目全景」段。它是**单文件精确路径读取**，不是递归遍历 / 子进程 / AST /
 * 大文件读取 ⇒ **不构成 AC-62 所定义的「昂贵仓库分析」**，可在门之前装配。
 *
 * ## 与决策保护层的分工（不重叠）
 *
 * | 文件 | 回答的问题 | 装配层 |
 * |---|---|---|
 * | 决策正本（路径见 `context/decisions.js` 的单一来源常量） | 「有哪些**不可违反**的约束」 | 决策保护（Base Context 内） |
 * | 本层正本（{@link PROJECT_STATUS_REL_PATH}） | 「这项目**要干什么、到哪了、下一步**」 | 本层（项目全景） |
 *
 * > 决策正本的路径字面量**只允许出现在 `context/decisions.js`**（AC-6① 的
 * > 唯一性机检在 `tests/advisor.test.mjs`）——本模块因此不在注释里复述它。
 * ## 两条硬纪律
 *
 * 1. **不可用必须显式**（承 AC-4）：文件不存在 / 读不到 / 为空 ⇒ 该段标注「不可用」，
 *    **绝不静默省略**，也绝不无中生有。
 * 2. **行数上限 = 100**（{@link PROJECT_STATUS_MAX_LINES}）：与 ACI `read_file` 的
 *    输出上限（`aci/observation.js` 的 `MAX_TOOL_OUTPUT_LINES`）**同口径**——
 *    这是「advisor 自己也能读到同样内容」的一致性要求，不是任意选的数字。
 *    超限时尾部截断并**显式标注**，不静默丢内容。
 *
 * ## 只读
 *
 * 读面由调用方注入（`readText(rel)`，与 `context/decisions.js` 同一注入风格）；
 * 本模块不 import 任何 fs、不含任何写 API。
 *
 * @module dsh-agents/advisor/context/project-status
 */

/** 项目全景文档的仓库内相对路径（**单一来源**，与维护侧约定一致）。 */
export const PROJECT_STATUS_REL_PATH = 'docs/PROJECT-STATUS.md'

/**
 * 行数上限（与 `aci/observation.js` 的 `MAX_TOOL_OUTPUT_LINES` 同值同义）。
 *
 * 为什么必须是 100：advisor 自己用 `read_file` 读这个文件时也只能拿到 100 行。
 * 若注入面给出 200 行而工具面只能读 100 行，advisor 对「同一份文档」会有两个
 * 不一致的认知——这是比「少给 100 行」更坏的状态。
 */
export const PROJECT_STATUS_MAX_LINES = 100

/** 「不可用」标注前缀（AC-4 逐字同源）。 */
export const UNAVAILABLE_MARK = '不可用'

/** 段标题（注入文本里的可断言锚）。 */
export const PROJECT_STATUS_TITLE = '### 项目全景（Project Status）'

/**
 * 读取项目全景文档（**只读**；文件不可用 ⇒ `available:false` + 原因，绝不无中生有）。
 *
 * @param {{readText?:(rel:string)=>{text:string}, relPath?:string}} [input]
 * @returns {{available:boolean, reason:string|null, text:string, bytes:number,
 *            relPath:string, lineCount:number, truncated:boolean, droppedLines:number}}
 */
export function loadProjectStatus(input = {}) {
  const relPath = typeof input.relPath === 'string' && input.relPath !== ''
    ? input.relPath
    : PROJECT_STATUS_REL_PATH
  const empty = {
    available: false, reason: null, text: '', bytes: 0, relPath,
    lineCount: 0, truncated: false, droppedLines: 0,
  }
  if (typeof input.readText !== 'function') {
    return { ...empty, reason: '未注入只读读面（readText）' }
  }
  let text
  try {
    text = String(input.readText(relPath)?.text ?? '')
  } catch (error) {
    return { ...empty, reason: `文件不可用（${error?.code ?? error?.name ?? 'read-failed'}）` }
  }
  // 行切分与裁剪口径：CRLF → LF、去尾部空行（与 ACI read_file 的
  // `formatToolObservation` 同源——同一个文件在两个面必须给出同样的行）
  //
  // ⚠️ 「空文件」判据必须用**整串 trim**，不能只看「单行且为空」：
  // 纯空白内容（如 `'   \n\n  '`）切出来是多行、每行都不为 `''` 但全无内容，
  // 会被旧判据误判成「已加载 N 行」——空文件被伪装成有内容，正是 AC-4
  // 「不可用必须显式」要防的静默形态（PS-1③ 实测抓出）。
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized.trim() === '') {
    return { ...empty, reason: '文件存在但内容为空（纯空白）' }
  }
  const lines = normalized.split('\n')
  // 去掉尾部纯空白行（不仅去末尾换行）——否则尾部缩进空行会虚增 lineCount
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  const truncated = lines.length > PROJECT_STATUS_MAX_LINES
  const kept = truncated ? lines.slice(0, PROJECT_STATUS_MAX_LINES) : lines
  const droppedLines = truncated ? lines.length - PROJECT_STATUS_MAX_LINES : 0
  const body = truncated
    ? `${kept.join('\n')}\n…[项目全景已截断：还有 ${droppedLines} 行未注入（上限 ${PROJECT_STATUS_MAX_LINES} 行，与 read_file 同口径）]`
    : kept.join('\n')
  return {
    available: true,
    reason: null,
    text: body,
    bytes: Buffer.byteLength(body, 'utf8'),
    relPath,
    lineCount: kept.length,
    truncated,
    droppedLines,
  }
}

/**
 * 渲染项目全景段（不可用 ⇒ 显式标注，不静默省略）。
 *
 * @param {ReturnType<typeof loadProjectStatus>} loaded
 * @returns {string} 空串仅当 `loaded` 为 null/undefined（调用方根本没装配本层）
 */
export function renderProjectStatus(loaded) {
  if (loaded === undefined || loaded === null) return ''
  const head = [
    PROJECT_STATUS_TITLE,
    `- 来源：仓库内单一文件 \`${loaded.relPath ?? PROJECT_STATUS_REL_PATH}\`（只读；由主会话每批次关账时维护）`,
    `- 用途：这份是项目**要干什么 / 现在到哪 / 下一步做什么**的正本；评审方向性问题先对齐它`,
  ]
  if (loaded.available !== true) {
    return [...head, `- 【${UNAVAILABLE_MARK}】${loaded.reason ?? '未加载'}`].join('\n')
  }
  const meta = [`${loaded.lineCount} 行`, `${loaded.bytes} 字节`]
  if (loaded.truncated) meta.push(`**已截断**（丢 ${loaded.droppedLines} 行）`)
  return [...head, `- 状态：已加载（${meta.join(' / ')}）`, '', loaded.text].join('\n')
}
