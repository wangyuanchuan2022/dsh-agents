/**
 * decision/prefilter.js —— **纯本地规则**预筛（零 `llm.stream`、零 token）。
 *
 * ## 存在理由（AC-17 / AC-18 / AC-62）
 *
 * 「该不该发起这次评审」是**规则问题**，不是模型问题：
 * 用户发「谢谢」「好的」时发起一次评审 = 白烧一次调用；而判「是不是寒暄」
 * 若交给模型，则**每轮多一次调用**，与 AC-18（阴性路径零调用零 token）正面冲突
 * （§5 裁决 5 的存在理由）。故本模块：
 *
 * - **纯本地规则**：只做字符串匹配，无 IO、无网络、无子进程；
 * - **保守白名单**（G-12）：**命中任一代码相关信号 ⇒ 一律放行**（宁可多评一次，
 *   不可漏评一次）；
 * - **拦截判据 = 整串纯确认**（`ACK_EXACT` 归一后 `===`）+（仅用户档）整串无信息形态。
 *   ⚠️ **绝不用子串包含**：中文里「推荐/周末/天气」这类词嵌在正常句子里是常态，
 *   子串匹配会把 `'周末把这个 PR 合了'` 这种真工作消息拦掉（P0-1 实锤）。
 * - **拦截留痕含 reason**（AC-21）：返回 `{decision, reason, signals, triggerSource, tier}`。
 *
 * ## 三态可观测（AC-19）
 *
 * | 态 | `screened` | `decision` | 场景 |
 * |---|---|---|---|
 * | `not-screened`（未过预筛） | `false` | `pass` | 手动补评 / **触发源不可判定**（fail-open） |
 * | `prefilter-blocked`（预筛拦截） | `true` | `block` | 整串纯确认（或用户档的无信息形态），**不调模型** |
 * | `prefilter-passed`（过预筛） | `true` | `pass` | 进评审；「评审过但 notes:[]」是评审之后的事（第三态由 records 面表达） |
 *
 * ## G-13 —— **产品已裁决（2026-10-09）：分级**
 *
 * > 产品原话选择：**用户消息走完整预筛；assistant（主 agent 自主连续行动）走更宽松规则，
 * > 只挡「纯 ACK / 无信息量」，其余照常评审。**
 *
 * 依据：兼顾费用与「主 agent 在错误路上连续走」的干预能力。本模块按 `tier` 分档实现：
 * `user` = 完整（ACK + 无信息形态）；`assistant` = 更宽松（**只挡整串纯 ACK**）；
 * `unknown`（无可判定来源）= fail-open 放行。**不得**再写「assistant 不过预筛」。
 *
 * ## G-12 边界（硬约束）
 *
 * **不得**提供 bypass 开关：本模块不读任何配置键，也没有 `enabled` 形参。
 *
 * @module dsh-agents/advisor/decision/prefilter
 */

/** 预筛判定：放行。 */
export const PRE_FILTER_PASS = 'pass'
/** 预筛判定：拦截。 */
export const PRE_FILTER_BLOCK = 'block'

/** 三态标记（AC-19）。 */
export const SCREEN_NOT_SCREENED = 'not-screened'
export const SCREEN_BLOCKED = 'prefilter-blocked'
export const SCREEN_PASSED = 'prefilter-passed'

/** 触发源（AC-19/AC-21 的可观测口径）。 */
export const TRIGGER_USER = 'user-message'
export const TRIGGER_ASSISTANT = 'assistant-stepped'
export const TRIGGER_MANUAL = 'manual-post'

/**
 * **纯确认（ACK）精确表** —— 拦截判据的**唯一依据**，且判据是**整串相等**
 * （归一化后 `===`），**绝不是子串包含**。
 *
 * ## 为什么必须是整串相等（P0-1 修复，code-reviewer 2026-10-09 实锤）
 *
 * 首版用的是「归一后**子串包含**多义词表」，里面有 `推荐`/`周末`/`咖啡`/`休息`/`天气`…
 * 于是把**真实工作消息**拦掉了：
 *
 * ```
 * '昨天推荐的那个库是不是有问题'  → BLOCK   ← 真工作，误拦（= 漏评）
 * '周末把这个 PR 合了'            → BLOCK   ← 真工作，误拦（= 漏评）
 * ```
 *
 * 中文里「推荐/周末/天气」这类词**嵌在正常句子里**是常态，子串匹配必然误伤。
 * 而本题的代价是**不对称**的：误拦 = 漏评（代价高），漏拦 = 多评一次（代价低）。
 * ⇒ 判据收敛为「整条消息**就是**一句无信息量的确认」。
 *
 * 归一化会去掉空白与常见中英标点（见 `normalizeForAck`），故 `谢谢！` / `好的。` 同样命中。
 */
export const ACK_EXACT = Object.freeze([
  '谢谢', '多谢', '感谢', '谢谢啦', '好的', '好的谢谢', '好吧', '好了', '好', '行', '收到',
  '嗯', '恩', '继续', '明白', '明白了', '了解', '了解了', '知道了', '辛苦了', '哈哈', '呵呵',
  '在吗', '稍等', '没事', '没问题', 'ok', 'okay', 'k', 'thanks', 'thankyou', 'thx',
])

/**
 * **仅用户档**追加的「无信息形态」（G-13：用户档 = 完整预筛，assistant 档更宽松）。
 *
 * 只收**纯语气词 / 纯重复单字 / 纯标点**这类**没有任何语义内容**的形态——
 * 判据同样是**整串**（`^…$`），不涉及任何多义词。
 */
export const NO_INFO_FORMS = Object.freeze([
  /^[嗯恩哦噢啊哈呀唉呃喵呜]+$/u,
  /^(.)\1+$/u,
  /^[\s\p{P}\p{S}]+$/u,
])

/**
 * 预筛分档（G-13 产品裁决 2026-10-09：**分级**）。
 *
 * | 档 | 触发源 | 规则 |
 * |---|---|---|
 * | `user` | 用户消息 | **完整预筛**：白名单/长文放行；整串 ACK 或纯语气词 ⇒ 拦 |
 * | `assistant` | assistant（主 agent 自主连续行动） | **更宽松**：只挡**整串纯 ACK**，其余照常评审 |
 * | `unknown` | 触发源不可判定（无 trigger 且无框架标签） | **fail-open**（P2 修复：宁可多评一次，绝不误拦） |
 */
export const TIER_USER = 'user'
export const TIER_ASSISTANT = 'assistant'
export const TIER_UNKNOWN = 'unknown'

/** 保守白名单：**命中任一即放行**。
 *
 * 分组只为可读与可断言；判定时是「或」关系。
 */
export const CONSERVATIVE_SIGNALS = Object.freeze([
  { kind: 'code-block', re: /```|~~~/, note: '代码块' },
  { kind: 'file-path', re: /(?:^|[\s"'`(（])(?:[\w.@-]+\/)+[\w.@-]+/, note: '带目录的文件路径' },
  { kind: 'file-ext', re: /\b[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|json|jsonl|md|yml|yaml|toml|py|go|rs|java|kt|rb|php|cs|cpp|h|sh|bash|cmd|ps1|mjs|css|scss|html|sql|env)\b/i, note: '带扩展名的文件' },
  { kind: 'command', re: /\b(?:npm|npx|pnpm|yarn|node|deno|bun|git|pip|pip3|python|pytest|make|cargo|go|docker|kubectl|gh|curl|rg|grep|jest|vitest|tsc|eslint)\b/i, note: '命令/工具名' },
  { kind: 'stack-trace', re: /\b(?:Error|TypeError|ReferenceError|SyntaxError|Exception|Traceback|ERR_[A-Z_]+|EPERM|EACCES|ENOENT|ECONNREFUSED|permission denied)\b/, note: '报错/异常特征' },
  { kind: 'verb-zh', re: /(实现|修改|改成|改一下|修复|重构|新增|添加|加个|加上|删除|移除|迁移|升级|部署|发布|回滚|评审|审查|检查|排查|定位|调试|报错|失败|崩|挂|异常|测试|断言|覆盖率|优化|性能|重构|为什么|怎么|如何|能不能|可不可以|帮我|看下|看一下|设计|方案|架构|接口|函数|类|模块|配置|日志|参数|文档|契约|字段|类型|并发|缓存|依赖)/, note: '中文关键动词/技术名词' },
  { kind: 'verb-en', re: /\b(?:implement|fix|refactor|rename|remove|delete|add|update|change|review|check|debug|error|bug|fail|test|assert|coverage|optimi[sz]e|performance|design|architecture|interface|function|class|module|config|log|param|docs?|contract|field|type|concurren|async|cache|dependency)\b/i, note: '英文关键动词/技术名词' },
  { kind: 'question-tech', re: /(?:为什么|为何|怎么|如何).{0,40}(?:这么|这样|那样|慢|快|错|坏|不对|报错|失败)/, note: '技术性追问' },
])

/**
 * 长文本豁免：超过该长度的消息视为「用户显然在描述一件工作」。
 * 方向仍是保守（放行），只防「长文里恰好没有信号词」被误拦。
 */
export const LONG_MESSAGE_CHARS = 400

/** 归一化：去空白 + 去常见中英标点（仅用于 ACK 表比对）。 */
export function normalizeForAck(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[。，、！？!?,.;:：；~～"'“”‘’()（）[\]【】]/g, '')
    .toLowerCase()
}

/** observer 渲染可见面时用的框架标签（拼色板，不是对话内容）。 */
const USER_TAG = '用户对Agent说'
const AGENT_TAG = 'Agent对用户说'

/**
 * 取出**最后一个发言块**（谁最后说话 + 他说了什么）。
 *
 * 为什么必须只看尾部：渲染面里可能同时有用户与助手的多段内容；把整段拿去判
 * 「是不是寒暄」会把「用户说『做 X』、助手回『好了』」这种**真对话**误判成寒暄
 * （既有用例里就有这种 fixture）。触发源与预筛判据都必须锚在**最后说话的人**上。
 *
 * @param {string} text - 渲染面（或任意文本；无框架标签时原样返回）
 * @returns {{role:'user'|'assistant'|null, text:string}}
 */
export function tailMessage(text) {
  const src = String(text ?? '')
  const userRe = new RegExp(`<${USER_TAG}>([\\s\\S]*?)</${USER_TAG}>`, 'g')
  const agentRe = new RegExp(`<${AGENT_TAG}>([\\s\\S]*?)</${AGENT_TAG}>`, 'g')
  const users = [...src.matchAll(userRe)]
  const agents = [...src.matchAll(agentRe)]
  const lastUser = users.length > 0 ? users[users.length - 1].index : -1
  const lastAgent = agents.length > 0 ? agents[agents.length - 1].index : -1
  if (lastUser < 0 && lastAgent < 0) return { role: null, text: src }
  return lastUser > lastAgent
    ? { role: 'user', text: users[users.length - 1][1] }
    : { role: 'assistant', text: agents[agents.length - 1][1] }
}

/**
 * 命中的保守信号清单。
 * @param {string} text
 * @returns {Array<{kind:string, note:string}>}
 */
export function matchedSignals(text) {
  const src = String(text ?? '')
  return CONSERVATIVE_SIGNALS.filter((s) => s.re.test(src)).map((s) => ({ kind: s.kind, note: s.note }))
}

/**
 * **整串**是否为纯确认（P0-1：`===` 相等，绝不 `includes`）。
 *
 * @param {string} text
 * @returns {{ack:boolean, word:string|null}}
 */
export function isPureAck(text) {
  const normalized = normalizeForAck(text)
  if (normalized === '') return { ack: true, word: '(空)' }
  for (const word of ACK_EXACT) {
    if (normalized === normalizeForAck(word)) return { ack: true, word }
  }
  return { ack: false, word: null }
}

/** **整串**是否为「无信息形态」（仅用户档使用）。 */
export function isNoInformation(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { noise: true, form: '(空)' }
  for (const re of NO_INFO_FORMS) {
    if (re.test(raw)) return { noise: true, form: String(re) }
  }
  return { noise: false, form: null }
}

/**
 * 判定分档（G-13）：触发源优先；缺 trigger 时按**实际来源**（框架标签）推；
 * 两者都判不出 ⇒ `unknown`（**fail-open**，P2 修复）。
 *
 * @param {{trigger?:string, role?:string}} input
 * @param {{role:'user'|'assistant'|null}} tail
 * @returns {{tier:string, triggerSource:string}}
 */
export function resolveTier(input, tail) {
  const trigger = typeof input.trigger === 'string' && input.trigger !== '' ? input.trigger : null
  if (trigger === TRIGGER_MANUAL) return { tier: TIER_UNKNOWN, triggerSource: TRIGGER_MANUAL }
  if (trigger === TRIGGER_USER) return { tier: TIER_USER, triggerSource: TRIGGER_USER }
  if (trigger === TRIGGER_ASSISTANT || trigger === 'assistant') return { tier: TIER_ASSISTANT, triggerSource: TRIGGER_ASSISTANT }
  // 缺 trigger：**按实际来源**判定（不得假定成用户消息）
  if (tail?.role === 'assistant') return { tier: TIER_ASSISTANT, triggerSource: TRIGGER_ASSISTANT }
  if (tail?.role === 'user') return { tier: TIER_USER, triggerSource: TRIGGER_USER }
  if (input.role === 'assistant') return { tier: TIER_ASSISTANT, triggerSource: TRIGGER_ASSISTANT }
  if (input.role === 'user') return { tier: TIER_USER, triggerSource: TRIGGER_USER }
  // 来源不可判定 ⇒ fail-open（宁可多评一次，绝不误拦）
  return { tier: TIER_UNKNOWN, triggerSource: 'undetermined' }
}

/**
 * 整轮可见面的**裸文本**（剥掉 advisor 的框架标签，把各段拼起来）。
 *
 * 用途：assistant 档的「纯 ACK」判定要求**整轮面**就是一句确认——只要这一轮里
 * 还有别的内容（例如同一增量里带了用户的正文、或 agent 的实质产出），
 * 就说明这轮显然在做事 ⇒ **必须评审**（G-13 的干预能力正是在这种时候最值钱）。
 *
 * @param {string} text
 * @returns {string}
 */
export function surfaceText(text) {
  const src = String(text ?? '')
  const re = new RegExp(`<${USER_TAG}>([\\s\\S]*?)</${USER_TAG}>|<${AGENT_TAG}>([\\s\\S]*?)</${AGENT_TAG}>`, 'g')
  const blocks = [...src.matchAll(re)]
  if (blocks.length === 0) return src
  return blocks.map((m) => m[1] ?? m[2] ?? '').join('\n')
}

/**
 * 三态判定（**本模块唯一判定入口**；`classifyMessage` 是它的语义化包装）。
 *
 * 判据顺序（每一跳都是**保守方向**）：
 * 1. 分档（G-13）：`unknown` / 手动补评 ⇒ **不过预筛**（fail-open，不拦）；
 * 2. 命中代码相关白名单 ⇒ 放行；
 * 3. 长文本 ⇒ 放行；
 * 4. **整串纯 ACK** ⇒ 拦（两档都拦）；（用户档）**整串无信息形态** ⇒ 拦（assistant 档不拦）；
 * 5. 其余一律**放行**（不确定 ⇒ 多评一次，绝不漏评）。
 *
 * @param {{text:string, role?:'user'|'assistant'|string, trigger?:string}} input
 * @returns {{screening:string, decision:'pass'|'block', screened:boolean, tier:string,
 *            triggerSource:string, reason:string, signals:Array<{kind:string,note:string}>}}
 */
export function screen(input = {}) {
  const raw = String(input.text ?? '')
  // 只看**最后说话的人**那段（框架标签是 advisor 的拼色板，不是对话内容）
  const tail = tailMessage(raw)
  const text = tail.text
  const { tier, triggerSource } = resolveTier(input, tail)
  const signals = matchedSignals(text)

  // ① 分档不可判定 / 手动补评 ⇒ 不过预筛（**fail-open**：缺信息时放行，绝不拒绝评审）
  if (tier === TIER_UNKNOWN) {
    return {
      screening: SCREEN_NOT_SCREENED,
      decision: PRE_FILTER_PASS,
      screened: false,
      tier,
      triggerSource,
      reason: triggerSource === TRIGGER_MANUAL
        ? '手动补评（人明确要求评审）⇒ 不过预筛'
        : '触发源不可判定 ⇒ fail-open 放行（P2：缺省**不得**假定为用户消息）',
      signals,
    }
  }
  // ② 白名单 / 长文本 ⇒ 放行（两档相同）
  if (signals.length > 0) {
    return {
      screening: SCREEN_PASSED, decision: PRE_FILTER_PASS, screened: true, tier, triggerSource,
      reason: `命中保守白名单（${signals.map((s) => s.kind).join('/')}）⇒ 放行`,
      signals,
    }
  }
  if (text.length >= LONG_MESSAGE_CHARS) {
    return {
      screening: SCREEN_PASSED, decision: PRE_FILTER_PASS, screened: true, tier, triggerSource,
      reason: `长文本（${text.length} ≥ ${LONG_MESSAGE_CHARS} 字符）⇒ 保守放行`,
      signals,
    }
  }
  // ③ 整串纯 ACK ⇒ 拦。
  //    · 用户档：**尾部那段**是纯确认即拦（AC-17 的核心：用户只回一句「谢谢」）；
  //    · assistant 档（G-13 更宽松）：要求**整轮可见面**都是纯确认才拦——同一轮里
  //      只要还有别的内容，就说明 agent 在做实事 ⇒ 照常评审（干预能力优先）。
  const pureAck = isPureAck(text)
  if (pureAck.ack) {
    const wholeAck = tier !== TIER_ASSISTANT || isPureAck(surfaceText(raw)).ack
    if (wholeAck) {
      return {
        screening: SCREEN_BLOCKED, decision: PRE_FILTER_BLOCK, screened: true, tier, triggerSource,
        reason: `整串即纯确认（"${pureAck.word}"${tier === TIER_ASSISTANT ? '，且整轮面无其它内容' : ''}）⇒ 拦截（不发起评审；G-12：无 bypass 开关）`,
        signals,
      }
    }
  }
  // ④ 无信息形态 ⇒ **仅用户档**拦（assistant 档 G-13 更宽松）
  if (tier === TIER_USER) {
    const noise = isNoInformation(text)
    if (noise.noise) {
      return {
        screening: SCREEN_BLOCKED, decision: PRE_FILTER_BLOCK, screened: true, tier, triggerSource,
        reason: `整串为无信息形态（${noise.form}）⇒ 拦截（仅用户档；G-13 分级）`,
        signals,
      }
    }
  }
  return {
    screening: SCREEN_PASSED, decision: PRE_FILTER_PASS, screened: true, tier, triggerSource,
    reason: `未命中整串 ACK/无信息形态 ⇒ 保守放行（档=${tier}；不确定则多评一次，绝不漏评）`,
    signals,
  }
}

/** 语义化包装（`screen` 的同义入口，供既有风格调用）。 */
export function classifyMessage(input = {}) {
  return screen(input)
}

/**
 * 本轮**是否值得做昂贵仓库分析**（AC-62）。
 *
 * 口径与预筛同源但**判据独立**：AC-17/18 断「不调用模型」，本函数断
 * 「**即使调用模型也不做昂贵仓库分析**」——昂贵 = 递归遍历 / 子进程 / AST / 大文件读取。
 * 未命中白名单（普通聊天）⇒ `false`，调用方**必须零检索零子进程**。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function shouldRunRepoAnalysis(text) {
  const src = String(text ?? '')
  if (matchedSignals(src).length > 0) return true
  return src.length >= LONG_MESSAGE_CHARS
}

/**
 * 预筛样本集（AC-17 的 fixture 清单：阴性 ≥5 / 阳性 ≥3；**含 near-miss 反例**）。
 *
 * **写死在代码里**（不临时挑选），供测试与后续 AC-64 采集复用。
 *
 * ## near-miss 反例（P0-1 修复的核心，code-reviewer 关键指摘）
 *
 * 首版样本**全是无歧义样本、无 near-miss 反例** ⇒ 「16/16 GREEN」并不能证明
 * 「方向成立」。故样本集必须显式包含**看起来像寒暄、实际是工作**的句子：
 * 它们**必须 PASS**（不拦），否则就是「误拦 = 漏评」的实锤。
 */
export const PREFILTER_SAMPLES = Object.freeze({
  /** 阴性（必须**拦**）：整串就是一句无信息量的确认。 */
  negative: Object.freeze([
    '谢谢', '好的', '收到', '嗯', '继续', '明白了', '哈哈', 'ok',
  ]),
  /** 阳性（必须**放行**）：含代码信号的真实工作消息。 */
  positive: Object.freeze([
    '帮我修复 lib/advisor/runtime.js 里 buildMessages 的报错',
    '```\nnpm test\n```\n这个输出是什么意思？',
    '这个函数为什么要先判 finishReason 再解析正文？',
    '把 advisorMaxMessages 默认值从 60 改成 80',
    'session/event 的 turn/end 为什么没触发评审？',
  ]),
  /**
   * **near-miss 反例**（必须**放行**）：看着像寒暄/闲聊词，实为工作消息。
   * 这三条正是首版子串匹配误拦的样本（code-reviewer 实锤）。
   */
  nearMiss: Object.freeze([
    '昨天推荐的那个库是不是有问题',
    '周末把这个 PR 合了',
    '这个方案你觉得推荐吗',
  ]),
  /** AC-62 的普通聊天 fixture（问候 / 闲聊 / 与代码无关问答）——**不做昂贵分析**，但不要求被预筛拦。 */
  plainChat: Object.freeze([
    '早上好',
    '今天天气不错',
    '你觉得咖啡好喝吗',
    '午饭吃什么好呢',
    '周末有什么推荐的活动吗',
  ]),
})
