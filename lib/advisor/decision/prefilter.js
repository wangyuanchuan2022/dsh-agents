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
 *   不可漏评一次）；只有「没有任何代码相关信号」的纯寒暄/确认才拦；
 * - **拦截留痕含 reason**（AC-21）：返回 `{decision, reason, signals, triggerSource}`。
 *
 * ## 三态可观测（AC-19）
 *
 * | 态 | `screened` | `decision` | 场景 |
 * |---|---|---|---|
 * | `not-screened`（未过预筛） | `false` | `pass` | 触发源不是用户消息（assistant stepped / 手动补评） |
 * | `prefilter-blocked`（预筛拦截） | `true` | `block` | 命中保守拦截，**不调模型** |
 * | `prefilter-passed`（过预筛） | `true` | `pass` | 进评审；「评审过但 notes:[]」是评审之后的事（第三态由 records 面表达） |
 *
 * ## G-13 标记
 *
 * 技术缺省（计划 §6 G-13）= **只对用户消息预筛**；assistant turn 末的 stepped 触发
 * **不过预筛**。G-13 已升级为「须产品提问」，本步按缺省实现并**保留 `triggerSource`
 * 可观测**，使翻转（改为全触发点预筛）只需改一行配置而不必重做观测面。
 * 【待产品复核 G-13】
 *
 * ## G-12 边界（硬约束）
 *
 * **不得**提供 bypass 开关：本模块不读任何配置键，也没有 `enabled` 形参。
 * 唯一「不过预筛」的路径是**触发源本身不是用户消息**（含手动补评，见 AC-21）。
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
 * 纯确认 / 寒暄的**精确归一词**（去空白与常见标点后比对）。
 *
 * 只收「说话人显然没有提出工作请求」的词；任何不确定的说法都**不进**这张表
 * （保守方向：不确定 ⇒ 放行 ⇒ 多评一次）。
 */
export const ACK_ONLY_WORDS = Object.freeze([
  '谢谢', '多谢', '感谢', '好的', '好', '行', '收到', '嗯', '恩', '继续', '明白', '了解',
  '知道了', '稍等', '哈哈', '呵呵', '在吗', '好的谢谢', '辛苦了', 'ok', 'okay', 'thanks', 'thankyou',
])

/**
 * **纯寒暄 / 闲聊词表**（拦截判据的**唯一**依据）。
 *
 * ⚠️ 设计方向是**不对称**的（这一点决定本模块是否可用）：
 * - 误拦（把真工作拦掉）= **漏评**，代价高；
 * - 漏拦（把寒暄放过去）= 多评一次，代价低。
 *
 * ⇒ 本模块**不做「无代码信号就拦」**（那会误伤「做 X」「u1」「hi」这类
 * 简短但真实的工作消息），而是只有当消息**命中下面这张显式词表**、
 * 且**没有任何代码相关白名单信号**时才拦。表外的一切一律放行。
 */
export const CHATTER_WORDS = Object.freeze([
  '谢谢', '多谢', '感谢', '辛苦了', '好的', '好吧', '好了', '收到', '明白', '了解', '知道了',
  '嗯', '恩', '继续', '哈哈', '呵呵', '在吗', '稍等', '没事', '没问题',
  '早上好', '早安', '中午好', '下午好', '晚上好', '晚安', '你好', '您好', 'hi', 'hello', 'hey',
  '天气', '午饭', '晚饭', '早饭', '吃什么', '咖啡', '奶茶', '周末', '好玩', '推荐', '无聊', '休息',
])

/**
 * 保守白名单：**命中任一即放行**。
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
 * 纯寒暄/闲聊判定（**拦截判据**）：归一后命中 ACK 精表或 CHATTER 词表。
 *
 * @param {string} text
 * @returns {{chatter:boolean, word:string|null}}
 */
export function isChatter(text) {
  const normalized = normalizeForAck(text)
  if (normalized === '') return { chatter: true, word: '(空)' }
  for (const word of ACK_ONLY_WORDS) {
    if (normalized === normalizeForAck(word)) return { chatter: true, word }
  }
  for (const word of CHATTER_WORDS) {
    if (normalized.includes(normalizeForAck(word))) return { chatter: true, word }
  }
  return { chatter: false, word: null }
}

/**
 * 三态判定（**本模块唯一判定入口**；`classifyMessage` 是它的语义化包装）。
 *
 * 判据顺序（每一跳都是**保守方向**）：
 * 1. 触发源不是用户消息 ⇒ 不过预筛（G-13 技术缺省）；
 * 2. 命中代码相关白名单 ⇒ 放行；
 * 3. 长文本 ⇒ 放行（防长文里恰好没有信号词被误拦）；
 * 4. **命中寒暄/闲聊词表** ⇒ 拦截（AC-17/AC-62）；
 * 5. 其余一律**放行**（不确定 ⇒ 多评一次，绝不漏评）。
 *
 * @param {{text:string, role?:'user'|'assistant'|string, trigger?:string}} input
 * @returns {{screening:string, decision:'pass'|'block', screened:boolean,
 *            triggerSource:string, reason:string, signals:Array<{kind:string,note:string}>}}
 */
export function screen(input = {}) {
  const raw = String(input.text ?? '')
  // 只看**最后说话的人**那段（框架标签是 advisor 的拼色板，不是对话内容）
  const tail = tailMessage(raw)
  const text = tail.text
  const triggerSource = typeof input.trigger === 'string' && input.trigger !== ''
    ? input.trigger
    : (tail.role === 'assistant' || input.role === 'assistant' ? TRIGGER_ASSISTANT : TRIGGER_USER)
  const signals = matchedSignals(text)

  // 触发源不是用户消息 ⇒ **不过预筛**（G-13 技术缺省）：不拦、也不计为「测过」。
  if (triggerSource !== TRIGGER_USER) {
    return {
      screening: SCREEN_NOT_SCREENED,
      decision: PRE_FILTER_PASS,
      screened: false,
      triggerSource,
      reason: `触发源=${triggerSource} 不过预筛（G-13 技术缺省【待产品复核】）`,
      signals,
    }
  }
  if (signals.length > 0) {
    return {
      screening: SCREEN_PASSED,
      decision: PRE_FILTER_PASS,
      screened: true,
      triggerSource,
      reason: `命中保守白名单（${signals.map((s) => s.kind).join('/')}）⇒ 放行`,
      signals,
    }
  }
  if (text.length >= LONG_MESSAGE_CHARS) {
    return {
      screening: SCREEN_PASSED,
      decision: PRE_FILTER_PASS,
      screened: true,
      triggerSource,
      reason: `长文本（${text.length} ≥ ${LONG_MESSAGE_CHARS} 字符）⇒ 保守放行`,
      signals,
    }
  }
  const chatter = isChatter(text)
  if (chatter.chatter) {
    return {
      screening: SCREEN_BLOCKED,
      decision: PRE_FILTER_BLOCK,
      screened: true,
      triggerSource,
      reason: `纯寒暄/闲聊（命中词表 "${chatter.word}"）且未命中任何代码相关白名单 ⇒ 拦截（不发起评审；G-12：无 bypass 开关）`,
      signals,
    }
  }
  return {
    screening: SCREEN_PASSED,
    decision: PRE_FILTER_PASS,
    screened: true,
    triggerSource,
    reason: '未命中寒暄/闲聊词表 ⇒ 保守放行（不确定则多评一次，绝不漏评）',
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
 * 预筛样本集（AC-17 的 fixture 清单：阴性 ≥5 / 阳性 ≥3）。
 *
 * **写死在代码里**（不临时挑选），供测试与后续 AC-64 采集复用。
 */
export const PREFILTER_SAMPLES = Object.freeze({
  negative: Object.freeze([
    '谢谢', '好的', '收到', '嗯', '继续',
    '辛苦了，早点休息', '哈哈', 'ok', '明白了',
  ]),
  positive: Object.freeze([
    '帮我修复 lib/advisor/runtime.js 里 buildMessages 的报错',
    '```\nnpm test\n```\n这个输出是什么意思？',
    '这个函数为什么要先判 finishReason 再解析正文？',
    '把 advisorMaxMessages 默认值从 60 改成 80',
    'session/event 的 turn/end 为什么没触发评审？',
  ]),
  /** AC-62 的普通聊天 fixture（问候 / 闲聊 / 与代码无关问答）。 */
  plainChat: Object.freeze([
    '早上好',
    '今天天气不错',
    '你觉得咖啡好喝吗',
    '午饭吃什么好呢',
    '周末有什么推荐的活动吗',
  ]),
})
