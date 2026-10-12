/**
 * aci/observation.js —— ACI 工具输出的**观察格式**（S3 / 计划 §2 S3 写面）。
 *
 * 三条规则（SWE-agent ACI 边界的本仓落地，GATE 0 报告「工具声明即契约」）：
 * 1. **专用 viewer 行数上限**：任何工具输出最多 {@link MAX_TOOL_OUTPUT_LINES} 行，
 *    超限截断并带**显式截断标记**（不存在「静默截断」形态）；
 * 2. **空输出显式文案**：空串/纯空白的工具输出替换为 {@link EMPTY_TOOL_OUTPUT}——
 *    「读到但没有」必须可见，不得伪装成静默成功；
 * 3. **错误显式文案**：工具被拒/失败时返回结构化的单行错误（含 code），喂回模型
 *    的是显式 `isError` 结果——模型能从错误里学到边界，而不是把拒绝当「没命中」。
 *
 * 本模块**零落盘、零子进程、零 llm**——纯文本整形。
 *
 * @module dsh-agents/advisor/aci/observation
 */

/** 单个工具输出的行数上限（SWE-agent 专用 viewer 100 行的同源取值）。 */
export const MAX_TOOL_OUTPUT_LINES = 100

/** 截断标记（显式：模型看得见「后面还有」，不得假装看全了）。 */
export const TRUNCATION_MARKER = (hidden) => `…[已截断：还有 ${hidden} 行未显示]`

/** 空输出的显式文案（G-17 同源纪律：显式标注，不静默省略）。 */
export const EMPTY_TOOL_OUTPUT = '（工具返回空输出：目标存在但内容为空）'

/**
 * 把工具原始输出整形成观察文本：行数上限 + 显式截断 + 空输出显式文案。
 *
 * @param {string} raw - 工具原始输出
 * @param {{maxLines?:number}} [options]
 * @returns {{text:string, lines:number, truncated:boolean}}
 */
export function formatToolObservation(raw, options = {}) {
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0
    ? options.maxLines : MAX_TOOL_OUTPUT_LINES
  const text = typeof raw === 'string' ? raw : ''
  if (text.trim() === '') {
    return { text: EMPTY_TOOL_OUTPUT, lines: 1, truncated: false }
  }
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  if (lines.length <= maxLines) {
    return { text: lines.join('\n'), lines: lines.length, truncated: false }
  }
  const kept = lines.slice(0, maxLines)
  kept.push(TRUNCATION_MARKER(lines.length - maxLines))
  return { text: kept.join('\n'), lines: maxLines + 1, truncated: true }
}

/**
 * 工具错误的显式观察文本（喂回模型，带 code 供模型分辨边界类）。
 * @param {{code:string, message:string}} input
 */
export function formatToolError({ code, message }) {
  return `（工具调用被拒绝：code=${code}；${String(message ?? '').slice(0, 200)}）`
}

/**
 * 工具调用参数解析失败的显式观察文本。
 * @param {string} detail
 */
export function formatBadArguments(detail) {
  return `（工具调用参数不合法：${String(detail ?? '').slice(0, 200)}）`
}
