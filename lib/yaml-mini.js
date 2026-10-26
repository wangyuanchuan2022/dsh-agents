/**
 * 最小 YAML 子集解析器（R3-B1 PhaseB 磁盘预设装载器专用，用户裁决选项③）。
 *
 * **诚实边界（不做通用 YAML）**：只覆盖本仓预设实际用到的构造——
 *   - 顶层 map 或 sequence；嵌套 map / 嵌套 sequence；
 *   - 标量：单引号字符串（'' 转义）、true/false、整数、其余按普通字符串；
 *   - 全行注释（# 开头）与空行。
 * 超子集构造一律 fail-fast 并列明（flow 风格 {} []、双引号、多行标量 | >、锚点
 * & * 、标签 !、TAB 缩进、行内注释）——不猜、不静默截断。
 *
 * @module dsh-agents/yaml-mini
 */

/** 解析失败（含位置与原因）。调用方按 fail-fast 语义处理。 */
export class YamlMiniError extends Error {
  constructor(message, { line, snippet } = {}) {
    super(line === undefined ? message : `${message}（第 ${line} 行${snippet ? `：${snippet}` : ''}）`)
    this.name = 'YamlMiniError'
    this.line = line
  }
}

/** 缩进宽度（TAB 直接 fail-fast——YAML 禁 TAB，子集不装懂）。 */
function indentOf(line, no) {
  const match = /^[ ]*/.exec(line)
  const width = match[0].length
  if (line[width] === '\t') throw new YamlMiniError('TAB 缩进不在子集内（YAML 禁 TAB，请用空格）', { line: no + 1, snippet: line.trim() })
  return width
}

/** 剥全行注释与空行，产 [{no, indent, text}]。行内 # 不支持（留在标量里原样解析）。 */
function logicalLines(text) {
  const out = []
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/[\{\}\[\]]/.test(trimmed)) {
      throw new YamlMiniError('flow 风格（{…} / […]）不在子集内', { line: index + 1, snippet: trimmed })
    }
    if (/^-\s*"/.test(trimmed) || /^"/.test(trimmed)) {
      throw new YamlMiniError('双引号标量不在子集内（请用单引号或裸标量）', { line: index + 1, snippet: trimmed })
    }
    if (/[|>]\s*$/.test(raw) || /^\s*[-\w"']+:\s*[|>]/.test(raw)) {
      throw new YamlMiniError('多行标量（| / >）不在子集内', { line: index + 1, snippet: trimmed })
    }
    if (/&\w|^-\s*&|\*\w/.test(trimmed)) {
      throw new YamlMiniError('锚点/引用（& *）不在子集内', { line: index + 1, snippet: trimmed })
    }
    if (/^\s*-\s+!|:\s+!/.test(raw) || /!\w/.test(trimmed)) {
      throw new YamlMiniError('YAML 标签（!…）不在子集内', { line: index + 1, snippet: trimmed })
    }
    out.push({ no: index + 1, indent: indentOf(raw, index), text: trimmed })
  }
  return out
}

/** 标量解析：单引号 → 字符串（'' 转义）；双引号 → fail-fast；true/false → boolean；整数 → number；其余 → 字符串。 */
export function parseScalar(raw) {
  const text = String(raw).trim()
  if (text.startsWith('"')) throw new YamlMiniError(`双引号标量不在子集内（请用单引号或裸标量）：${text}`)
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlMiniError(`单引号标量未闭合：${text}`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  return text
}

/** 把 logicalLines[i..] 解析为 JSON 值（map / sequence / 标量），返回 [value, nextIndex]。 */
function parseBlock(lines, i, indent) {
  if (i >= lines.length) return [null, i]
  const first = lines[i]
  if (first.indent < indent) return [null, i]
  if (first.text.startsWith('- ') || first.text === '-') return parseSequence(lines, i, first.indent)
  return parseMapping(lines, i, first.indent)
}

function parseSequence(lines, i, indent) {
  const out = []
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const no = lines[i].no
    const itemText = lines[i].text === '-' ? '' : lines[i].text.slice(2)
    if (itemText === '') {
      // 整行仅 "-"：item 内容在更深缩进的后续行
      i += 1
      if (i < lines.length && lines[i].indent > indent) {
        const [item, next] = parseBlock(lines, i, lines[i].indent)
        out.push(item)
        i = next
      } else {
        out.push(null)
      }
      continue
    }
    if (itemText.includes(':')) {
      // "- key: value" 形态：合成一个虚拟行让 mapping 解析器处理，缩进取 key 的真实列
      const keyIndent = indent + 2
      const synthetic = { no, indent: keyIndent, text: itemText }
      const rest = []
      let j = i + 1
      while (j < lines.length && lines[j].indent > indent) { rest.push(lines[j]); j += 1 }
      const [item] = parseMapping([synthetic, ...rest], 0, keyIndent)
      out.push(item)
      i = j
      continue
    }
    out.push(parseScalar(itemText))
    i += 1
  }
  return [out, i]
}

function parseMapping(lines, i, indent) {
  const out = {}
  while (i < lines.length && lines[i].indent === indent) {
    const { no, text } = lines[i]
    const colon = text.indexOf(':')
    if (colon <= 0) {
      throw new YamlMiniError(`期望 "key: value" 行，实得「${text}」`, { line: no })
    }
    const key = parseScalar(text.slice(0, colon))
    if (typeof key !== 'string') throw new YamlMiniError(`map 键必须是标量：${text}`, { line: no })
    const valueRaw = text.slice(colon + 1).trim()
    if (valueRaw === '') {
      // 嵌套块：取更深缩进的连续行
      i += 1
      if (i < lines.length && lines[i].indent > indent) {
        const childIndent = lines[i].indent
        const [value, next] = parseBlock(lines, i, childIndent)
        out[key] = value
        i = next
      } else {
        out[key] = null
      }
      continue
    }
    out[key] = parseScalar(valueRaw)
    i += 1
  }
  return [out, i]
}

/**
 * 解析 YAML 子集文本为 JSON 值。任何超子集构造抛 YamlMiniError（fail-fast，含行号）。
 * @param {string} text
 * @returns {object|Array|null}
 */
export function parseYamlMini(text) {
  const lines = logicalLines(text)
  if (lines.length === 0) return null
  const [value] = parseBlock(lines, 0, lines[0].indent)
  return value
}
