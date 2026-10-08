/**
 * context/decisions.js —— `docs/DECISIONS.md` 决策保护层（AC-6 / AC-59，落地 G-3）。
 *
 * ## 三问的唯一答案（契约须逐字采纳；本模块即实现方）
 *
 * | 问 | 答案 |
 * |---|---|
 * | **来源** | 仓库内**单一文件** `docs/DECISIONS.md`（随仓库只读面进入；**不存在 ⇒ 该层显式标注「不可用」，不得无中生有**） |
 * | **格式** | 每条目**六字段**：`ID` / `状态`（`active`·`superseded`·`rejected`）/ `决策或约束正文` / `理由` / `否决记录` / `所属阶段` |
 * | **维护者** | **用户与主 agent**（通过正常 commit 维护）；**advisor 只读**（受 S1a 判据 13 的写操作禁令约束，本模块只用只读读面） |
 *
 * ## 文件格式（六字段的落地形态；`docs/DECISIONS.md` 尚不存在，故本格式在此**冻结**）
 *
 * ```md
 * ## D-012 · active · 已确认决策
 * - 决策或约束正文：session 配置按会话分文件存
 * - 理由：避免与全局配置互踩
 * - 否决记录：—
 * - 所属阶段：S2
 * ```
 *
 * - 标题行 = `ID · 状态 · 类别`；正文行 = `- 字段名：值`；
 * - **类别**由「状态 + 正文的首个方括号标签」推出（保持**六字段**不变，不加第七字段）：
 *   `[约束]`→不可违反约束、`[技术债]`→已知技术债、`[阶段目标]`→当前阶段目标；
 *   `rejected` → 已否决方案；其余 `active` → 已确认决策；
 * - 缺字段 / 状态非法 / 类别无法判定 ⇒ 该条进 `errors`（**不静默丢弃**，但不阻断其它条目）。
 *
 * ## 只读
 *
 * 读面由调用方注入（`readText(rel)`，通常是 S1a 的 `path-policy`），本模块
 * **不 import 任何 fs**、不含任何写 API（S1a 判据 13 的门在扫全树）。
 *
 * @module dsh-agents/advisor/context/decisions
 */

/** DECISIONS 的仓库内相对路径（G-3：单一来源）。 */
export const DECISIONS_REL_PATH = 'docs/DECISIONS.md'

/** 六字段（逐字，供契约与测试对账）。 */
export const DECISION_FIELDS = Object.freeze(['ID', '状态', '决策或约束正文', '理由', '否决记录', '所属阶段'])

/** 三种状态（AC-59：含 `rejected` 一态）。 */
export const DECISION_STATES = Object.freeze(['active', 'superseded', 'rejected'])

/** 五类上下文（AC-59 要求五条可区分断言）。 */
export const DECISION_CLASSES = Object.freeze([
  '已确认决策', '不可违反约束', '已知技术债', '已否决方案', '当前阶段目标',
])

/** 「不可用」标注的**逐字前缀**（AC-4：任一层不可用必须显式标注，不静默省略）。 */
export const UNAVAILABLE_MARK = '不可用'

/** 未实现项的**审定面措辞**（不得写成现在时）。 */
export const L3_NOT_IMPLEMENTED_NOTE = '设计意向（未实现，登记增强批次 B4）'

/** 正文里的类别标签 → 五类之一。 */
const CLASS_TAGS = Object.freeze([
  { tag: '[约束]', klass: '不可违反约束' },
  { tag: '[技术债]', klass: '已知技术债' },
  { tag: '[阶段目标]', klass: '当前阶段目标' },
])

/**
 * 解析 DECISIONS 文本 → 条目 + 解析错误（**不静默**）。
 *
 * @param {string} text
 * @returns {{entries:Array<object>, errors:Array<{line:number, reason:string}>}}
 */
export function parseDecisions(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const entries = []
  const errors = []
  let current = null
  const flush = () => {
    if (current === null) return
    // `ID` / `状态` 来自标题行，**不在** `fields` 里——缺字段判定只能看四个正文字段，
    // 否则每条都会被误判成「缺 ID/状态」（首版实测踩过）。
    const bodyFields = DECISION_FIELDS.filter((f) => f !== 'ID' && f !== '状态')
    const missing = bodyFields.filter((f) => !(f in current.fields))
    if (missing.length > 0) {
      errors.push({ line: current.line, reason: `条目 ${current.id ?? '(无 ID)'} 缺字段：${missing.join('/')}` })
    } else {
      const body = current.fields['决策或约束正文']
      const tagHit = CLASS_TAGS.find((t) => body.includes(t.tag))
      const klass = current.state === 'rejected' ? '已否决方案' : (tagHit?.klass ?? '已确认决策')
      entries.push({
        id: current.id,
        state: current.state,
        klass,
        text: body.replace(/\[(约束|技术债|阶段目标)\]\s*/, '').trim(),
        reason: current.fields['理由'].trim(),
        rejected: current.fields['否决记录'].trim(),
        phase: current.fields['所属阶段'].trim(),
        line: current.line,
      })
    }
    current = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const heading = raw.match(/^##\s+(.+?)\s*$/)
    if (heading !== null) {
      flush()
      const parts = heading[1].split(/\s*[·|]\s*/)
      const id = parts[0]?.trim() ?? ''
      const state = parts[1]?.trim() ?? ''
      const klassFromHeading = parts[2]?.trim() ?? ''
      if (!/^[A-Z]+-\d+$/.test(id)) {
        errors.push({ line: i + 1, reason: `ID 形态非法（应为 <字母>-<数字>，如 D-012）："${id}"` })
        continue
      }
      if (!DECISION_STATES.includes(state)) {
        errors.push({ line: i + 1, reason: `状态非法（合法：${DECISION_STATES.join('/')}）："${state}"` })
        continue
      }
      if (klassFromHeading !== '' && !DECISION_CLASSES.includes(klassFromHeading)) {
        errors.push({ line: i + 1, reason: `类别非法（合法：${DECISION_CLASSES.join('/')}）："${klassFromHeading}"` })
        continue
      }
      current = { line: i + 1, id, state, fields: {} }
      continue
    }
    const field = raw.match(/^-\s*([^：:]+)[：:]\s*(.*)$/)
    if (field !== null && current !== null) {
      const name = field[1].trim()
      if (DECISION_FIELDS.includes(name)) current.fields[name] = field[2]
      else errors.push({ line: i + 1, reason: `未知字段 "${name}"（合法六字段：${DECISION_FIELDS.join('/')}）` })
    }
  }
  flush()
  return { entries, errors }
}

/**
 * 读取并解析 DECISIONS（**只读**；文件不存在/读不到 ⇒ `available:false` + 原因，绝不无中生有）。
 *
 * @param {{readText:(rel:string)=>{text:string}, relPath?:string, readError?:string|null}} input
 * @returns {{available:boolean, reason:string|null, entries:Array<object>, errors:Array<object>,
 *            relPath:string, bytes:number, byClass:object}}
 */
export function loadDecisions(input = {}) {
  const relPath = typeof input.relPath === 'string' && input.relPath !== '' ? input.relPath : DECISIONS_REL_PATH
  if (input.readError !== undefined && input.readError !== null) {
    return { available: false, reason: `读取失败：${input.readError}`, entries: [], errors: [], relPath, bytes: 0, byClass: {} }
  }
  if (typeof input.readText !== 'function') {
    return { available: false, reason: '未注入只读读面（readText）', entries: [], errors: [], relPath, bytes: 0, byClass: {} }
  }
  let text
  try {
    text = String(input.readText(relPath).text ?? '')
  } catch (error) {
    return { available: false, reason: `文件不可用（${error?.code ?? error?.name ?? 'read-failed'}）`, entries: [], errors: [], relPath, bytes: 0, byClass: {} }
  }
  const { entries, errors } = parseDecisions(text)
  if (entries.length === 0) {
    return {
      available: false,
      reason: `文件存在但无有效条目（解析错误 ${errors.length} 条）`,
      entries, errors, relPath, bytes: Buffer.byteLength(text, 'utf8'), byClass: {},
    }
  }
  const byClass = {}
  for (const k of DECISION_CLASSES) byClass[k] = entries.filter((e) => e.klass === k)
  return { available: true, reason: null, entries, errors, relPath, bytes: Buffer.byteLength(text, 'utf8'), byClass }
}

/**
 * 渲染决策保护层（五类 + 来源/格式/维护者三问；不可用 ⇒ 显式标注）。
 *
 * @param {ReturnType<typeof loadDecisions>} loaded
 * @returns {string}
 */
export function renderDecisions(loaded) {
  const head = [
    '### 决策保护（来源 / 格式 / 维护者**唯一声明**）',
    `- 来源：仓库内单一文件 \`${loaded?.relPath ?? DECISIONS_REL_PATH}\`（只读；不存在则该层标注「${UNAVAILABLE_MARK}」）`,
    `- 格式：每条目六字段 —— ${DECISION_FIELDS.join(' / ')}；状态三态 —— ${DECISION_STATES.join(' / ')}`,
    '- 维护者：用户与主 agent（通过正常 commit 维护）；advisor **只读**，不得写入',
  ]
  if (loaded === undefined || loaded === null || loaded.available !== true) {
    return [...head, `- 【${UNAVAILABLE_MARK}】${loaded?.reason ?? '未加载'}`].join('\n')
  }
  const out = [...head, `- 已加载 ${loaded.entries.length} 条（解析错误 ${loaded.errors.length} 条）`]
  for (const klass of DECISION_CLASSES) {
    const rows = loaded.byClass[klass] ?? []
    out.push(`#### ${klass}（${rows.length}）`)
    if (rows.length === 0) { out.push('- （无）'); continue }
    for (const row of rows) {
      out.push(`- ${row.id} [${row.state}] ${row.text}（理由：${row.reason}；所属阶段：${row.phase}）`)
    }
  }
  return out.join('\n')
}
