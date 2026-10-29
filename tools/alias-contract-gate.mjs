#!/usr/bin/env node
/**
 * tools/alias-contract-gate.mjs — B6 档位别名契约字节级闸门（A1–A6 + `--selftest`）。
 *
 * 解决的问题（设计正本 `agent-out/opt-b5b6b7-design.md` 节 2；上游教训原文
 * `agent-out/routing-suite-full-read.md:84`）：档位别名在**四处**各有一份表述——
 * ① `lib/roles.js` 的 `TIER_ALIASES` / `TIERS` / `normalizeTier()`；
 * ② 每个角色的 `tier` 与 `omcModel` 两字段；③ `personas/<id>.md` 的 `omc_model:`；
 * ④ README 等文档里的别名表述。任一处漂移都不会被既有测试发现（routing-suite 的
 * 「4 对字节漂移 + 文档自述保持同步」就是同构事故）。
 *
 * 门规则（逐条对齐设计节 2）：
 *   A1 双向一致：契约映射表每行 `TIER_ALIASES[alias] === target` 且
 *      `normalizeTier(alias) === target`；三个规范档名自身 `normalizeTier(tier) === tier`；
 *      契约别名集合 == `TIER_ALIASES` 键集合；`TIERS` 值域集合 == `TIER_ALIASES` 值域集合。
 *      另含闸门自洽：闸门建模的 normalize 必须与 `lib/roles.js` 导出的真实函数逐键一致
 *      （防「闸门自说自话」——门自己写一套规则、被检对象另一套）。
 *   A2 角色字段一致：每角色 `normalizeTier(omcModel) === tier`，**或**该 id 在契约
 *      「例外登记表」且该行理由非空；例外表出现 `lib/roles.js` 不存在的 id ⇒ 红（防陈旧例外）；
 *      例外行的 tier/omcModel 列必须与当前角色字段逐字相等 ⇒ 否则红（防例外描述过期）；
 *      例外登记在「实际已相等」的角色上 ⇒ 红（冗余例外同样陈旧）。
 *   A3 人格一致：`personas/<id>.md` 的 `omc_model:` 值逐字等于角色 `omcModel`；
 *      23/23 全查，缺文件/缺字段 ⇒ 红。
 *   A4 文档表述一致：README 的「LOW / MEDIUM / HIGH ← haiku / sonnet / opus」型表述与契约同向，
 *      且 README 必须有一处「别名 haiku/sonnet/opus」集合声明；文档面（README +
 *      ARCHITECTURE + docs/*.md，排除本契约自身与 CHANGELOG）出现未登记别名（如 gpt/opus4）⇒ 红。
 *   A5 契约指纹：`docs/alias-contract.md` 的「一、别名映射表」+「二、例外登记表」两节正文
 *      sha256 前 8 位大写必须等于 `tests/fixtures/alias-contract.sha256.json`；
 *      fixture 缺失/JSON 非法/字段不符 ⇒ fail-closed 红（改契约必须同步改 fixture）。
 *   A6 零命中防护：解析出的别名条数 / 角色条数 / 人格条数 / README 别名表述条数为 0 ⇒ 红
 *      （「没查到」绝不当「没问题」）。
 *
 * 用法：
 *   node tools/alias-contract-gate.mjs                # 正常跑：A1–A6 全绿 exit 0，任一红 exit 1
 *   node tools/alias-contract-gate.mjs --selftest     # 变异自测：6 变异体 + 原样对照，全达预期 exit 0
 *   node tools/alias-contract-gate.mjs --print-hashes # 只打印两节正文 sha256（改契约后取新值）
 *
 * 退出码：0 全绿（含 selftest 全部达预期）；1 有门红 / 解析 fail-closed / selftest 未达预期；
 * 2 用法错误（未知参数）。
 *
 * 零新依赖（node:fs / node:path / node:crypto / node:url）；不 spawn、不联网、不写盘
 * （`--print-hashes` 只打印，不落盘——fixture 由人显式写入，保证「改契约必须同步改 fixture」是
 * 一个需要人做动作的显式步骤）。分类为纯函数 `classify()`（内存输入 → 判定），
 * selftest 即在内存里构造变异体，绝不改真实文件。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 仓根绝对路径。 */
export const ROOT = fileURLToPath(new URL('../', import.meta.url))

// ── 契约常量（改口径必须同步本脚本 + docs/alias-contract.md）─────────────────

/** 契约文件与 fixture 的仓内相对路径。 */
export const CONTRACT_PATH = 'docs/alias-contract.md'
export const FIXTURE_PATH = 'tests/fixtures/alias-contract.sha256.json'

/** 两节指纹的 fixture 键名（顺序即报错列举顺序）。 */
export const HASH_KEYS = Object.freeze(['aliasMappingTable', 'exceptionRegistry'])

/** 指纹口径：sha256 前 8 位十六进制大写（与 b2-help-archive fixture 同形态）。 */
export const DIGEST = Object.freeze({ algorithm: 'sha256', digestPrefix: 8, digestCase: 'upper' })

/** 文档面（A4）：README + ARCHITECTURE + docs/*.md；排除本契约自身与 CHANGELOG（历史不改写）。 */
export const DOC_FILES = Object.freeze(['README.md', 'ARCHITECTURE.md'])
export const DOC_EXCLUDE = Object.freeze([CONTRACT_PATH, 'CHANGELOG.md'])

/** 非本仓 Claude 家族的「外来别名」词根（文档里出现即视为未登记别名，如 gpt / gemini）。 */
export const FOREIGN_ALIAS_ROOTS = Object.freeze(['gpt', 'chatgpt', 'gemini', 'llama', 'qwen', 'grok', 'mistral', 'kimi'])

/** 解析 fail-closed 异常（结构不对 ⇒ 相关门红，绝不当「差不多」继续）。 */
export class GateParseError extends Error {}

// ── 契约解析（正本 → 结构化；fail-closed）────────────────────────────────────

const ALIAS_HEADING = /^##\s*一、别名映射表/
const EXC_HEADING = /^##\s*二、例外登记表/

/** 拆一行 markdown 表格（非表格行返回 null）。 */
function splitTableRow(line) {
  const s = line.trim()
  if (!s.startsWith('|')) return null
  const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  return cells
}

/** 表格分隔行（| --- | :---: |）。 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

/** 去掉单元格的 markdown 反引号包裹。 */
function stripTicks(value) {
  return String(value).replace(/^`+/, '').replace(/`+$/, '').trim()
}

/**
 * 解析契约正本：抽出「一、别名映射表」与「二、例外登记表」两节正文 + 表格行。
 * @param {string} text 契约全文
 * @returns {{sections:{aliasMappingTable:string,exceptionRegistry:string},
 *            aliasRows:Array<{alias:string,target:string,note:string}>,
 *            exceptionRows:Array<{id:string,tier:string,omcModel:string,reason:string,basis:string}>}}
 */
export function parseContract(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new GateParseError('契约正文为空或非字符串')
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const findHeading = (re) => lines.findIndex((l) => re.test(l))
  const aliasIdx = findHeading(ALIAS_HEADING)
  const excIdx = findHeading(EXC_HEADING)
  if (aliasIdx < 0) throw new GateParseError(`契约缺「一、别名映射表」节（期望标题匹配 ${ALIAS_HEADING}）`)
  if (excIdx < 0) throw new GateParseError(`契约缺「二、例外登记表」节（期望标题匹配 ${EXC_HEADING}）`)
  if (excIdx < aliasIdx) throw new GateParseError('契约节序错：「二、例外登记表」在「一、别名映射表」之前')

  /** 取某节正文（标题行之后 → 下一个二级标题之前；去尾部空行）。 */
  const sectionBody = (startIdx) => {
    const body = []
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break
      body.push(lines[i])
    }
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    return body.join('\n')
  }

  /** 取某节内的数据行（跳过表头行与分隔行）。 */
  const tableRows = (startIdx) => {
    const rows = []
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break
      const cells = splitTableRow(lines[i])
      if (cells === null) continue
      if (isSeparatorRow(cells)) continue
      rows.push(cells)
    }
    // 第一行是表头（含「别名」「角色 id」等中文表头）；按首行是否含表头关键词剔除更稳。
    return rows.filter((cells) => !/^(别名|角色\s*id)$/.test(stripTicks(cells[0])))
  }

  const aliasRows = tableRows(aliasIdx).map((cells, i) => {
    if (cells.length < 3) throw new GateParseError(`别名映射表第 ${i + 1} 行不足 3 列（实得 ${cells.length}）`)
    const alias = stripTicks(cells[0])
    const target = stripTicks(cells[1])
    if (!/^[a-z][a-z0-9]*$/.test(alias)) throw new GateParseError(`别名映射表第 ${i + 1} 行别名形状非法：${JSON.stringify(cells[0])}`)
    if (!/^[A-Z][A-Z0-9]*$/.test(target)) throw new GateParseError(`别名映射表第 ${i + 1} 行目标档位形状非法：${JSON.stringify(cells[1])}`)
    return { alias, target, note: cells[2] }
  })

  const exceptionRows = tableRows(excIdx).map((cells, i) => {
    if (cells.length < 5) throw new GateParseError(`例外登记表第 ${i + 1} 行不足 5 列（实得 ${cells.length}）`)
    const id = stripTicks(cells[0])
    const tier = stripTicks(cells[1])
    const omcModel = stripTicks(cells[2])
    if (id === '') throw new GateParseError(`例外登记表第 ${i + 1} 行角色 id 为空`)
    return { id, tier, omcModel, reason: cells[3], basis: cells[4] }
  })

  return {
    sections: { aliasMappingTable: sectionBody(aliasIdx), exceptionRegistry: sectionBody(excIdx) },
    aliasRows,
    exceptionRows,
  }
}

// ── 指纹（A5）────────────────────────────────────────────────────────────────

/**
 * 两节正文的指纹（sha256 前 8 位大写）。
 * 归一化口径（与 docs/alias-contract.md 节 3.1 逐字一致）：CRLF→LF；去该节尾部空行；
 * 其余字符（含空白/标点）逐字计入。
 * @param {string} text 契约全文
 * @returns {{aliasMappingTable:string,exceptionRegistry:string}}
 */
export function hashSections(text) {
  const parsed = parseContract(text)
  const out = {}
  for (const key of HASH_KEYS) {
    const body = parsed.sections[key]
    out[key] = createHash(DIGEST.algorithm).update(body, 'utf8').digest('hex').slice(0, DIGEST.digestPrefix).toUpperCase()
  }
  return out
}

/**
 * 校验 fixture 形状（fail-closed）：缺失/JSON 非法/字段不符 ⇒ 抛 GateParseError。
 * @param {unknown} fixture
 * @returns {{aliasMappingTable:string,exceptionRegistry:string}}
 */
export function validateFixture(fixture) {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new GateParseError('fixture 缺失或不是 JSON 对象')
  }
  if (fixture.algorithm !== DIGEST.algorithm) throw new GateParseError(`fixture.algorithm 必须为 "${DIGEST.algorithm}"（实得 ${JSON.stringify(fixture.algorithm)}）`)
  if (fixture.digestPrefix !== DIGEST.digestPrefix) throw new GateParseError(`fixture.digestPrefix 必须为 ${DIGEST.digestPrefix}（实得 ${JSON.stringify(fixture.digestPrefix)}）`)
  if (fixture.digestCase !== DIGEST.digestCase) throw new GateParseError(`fixture.digestCase 必须为 "${DIGEST.digestCase}"（实得 ${JSON.stringify(fixture.digestCase)}）`)
  const out = {}
  for (const key of HASH_KEYS) {
    const v = fixture[key]
    if (typeof v !== 'string' || !/^[0-9A-F]{8}$/.test(v)) {
      throw new GateParseError(`fixture.${key} 必须为 8 位大写十六进制串（实得 ${JSON.stringify(v)}）`)
    }
    out[key] = v
  }
  return out
}

// ── 文档面解析（A4）────────────────────────────────────────────────────────────

/** 别名样 token 正则：本仓家族（haiku/sonnet/opus）+ 外来家族（gpt/gemini/...），允许数字/点/横线后缀。 */
function aliasLikeRe() {
  const roots = ['haiku', 'sonnet', 'opus', ...FOREIGN_ALIAS_ROOTS].join('|')
  return new RegExp(`\\b(${roots})([0-9]+(?:[.-][0-9a-z]+)*)?\\b`, 'gi')
}

/**
 * 解析 README 的「档位列表 ← 别名列表」表述（A4-1）。
 * @param {string} text README 全文
 * @returns {Array<{line:number,tiers:string[],aliases:string[]}>}
 */
export function parseArrowStatements(text) {
  const out = []
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf('←')
    if (arrow < 0) continue
    const left = lines[i].slice(0, arrow)
    const right = lines[i].slice(arrow + 1)
    const tierRun = left.match(/(?:[A-Z]{2,})(?:\s*\/\s*[A-Z]{2,})+/)
    const aliasRun = right.match(/(?:[a-z][a-z0-9]*)(?:\s*\/\s*[a-z][a-z0-9]*)+/)
    if (tierRun === null || aliasRun === null) continue
    out.push({
      line: i + 1,
      tiers: tierRun[0].split('/').map((s) => s.trim()),
      aliases: aliasRun[0].split('/').map((s) => s.trim()),
    })
  }
  return out
}

/**
 * 解析 README 的「别名 `haiku`/`sonnet`/`opus` 同义」型集合声明（A4-2）。
 * @param {string} text README 全文
 * @param {Set<string>} knownAliasLike 允许出现在声明里的别名样词
 * @returns {Array<{line:number,aliases:string[]}>}
 */
export function parseAliasDeclarations(text, knownAliasLike) {
  const out = []
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('别名')) continue
    const tokens = [...lines[i].matchAll(/`([A-Za-z][A-Za-z0-9._-]*)`/g)]
      .map((m) => m[1].toLowerCase())
      .filter((t) => knownAliasLike.has(t))
    if (tokens.length === 0) continue
    out.push({ line: i + 1, aliases: [...new Set(tokens)] })
  }
  return out
}

/**
 * 扫描文档面的别名样 token（A4-3）。
 * @param {Array<{path:string,text:string}>} docs
 * @returns {Array<{path:string,line:number,token:string}>}
 */
export function scanAliasTokens(docs) {
  const re = aliasLikeRe()
  const out = []
  for (const doc of docs) {
    const lines = String(doc.text).replace(/\r\n?/g, '\n').split('\n')
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(lines[i])) !== null) {
        out.push({ path: doc.path, line: i + 1, token: m[0].toLowerCase() })
      }
    }
  }
  return out
}

// ── 人格 frontmatter（A3）─────────────────────────────────────────────────────

/**
 * 从人格正文抽 `omc_model:` 值（frontmatter 内，首个匹配）。
 * @param {string|null} text
 * @returns {string|null} 未命中返回 null
 */
export function extractOmcModel(text) {
  if (typeof text !== 'string' || text === '') return null
  const m = text.match(/^omc_model:[ \t]*([^\r\n]*)$/m)
  if (m === null) return null
  return m[1].trim()
}

// ── 纯函数分类器（门判定；不读盘/不看时钟/不写盘）────────────────────────────

const isStr = (v) => typeof v === 'string'

/**
 * 在内存输入上跑 A1–A6。
 * @param {{
 *   aliases: Record<string,string>, tiers: string[], normalizeTier: (raw:unknown)=>string|null,
 *   roles: Array<{id:string,tier:string,omcModel:string}>,
 *   personaTexts: Record<string,string|null>,
 *   contractText: string, fixture: unknown,
 *   docs: Array<{path:string,text:string}>,
 * }} input
 * @returns {{pass:boolean, gates:Array<{id:string,name:string,pass:boolean,detail:string}>,
 *            gateMap:Record<string,{id:string,name:string,pass:boolean,detail:string}>,
 *            counts:object, parsed:object}}
 */
export function classify(input) {
  const gates = []
  const push = (id, name, pass, detail) => gates.push({ id, name, pass, detail })

  const aliases = input.aliases && typeof input.aliases === 'object' && !Array.isArray(input.aliases) ? input.aliases : {}
  const tiers = Array.isArray(input.tiers) ? input.tiers.filter(isStr) : []
  const roles = Array.isArray(input.roles) ? input.roles : []
  const personaTexts = input.personaTexts && typeof input.personaTexts === 'object' ? input.personaTexts : {}
  const docs = Array.isArray(input.docs) ? input.docs : []

  // 闸门建模的 normalize（与真实函数同一语义：trim + 小写 → 查表）
  const modeledNormalize = (raw) => {
    const key = String(raw ?? '').trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : null
  }

  // ── 契约解析（fail-closed：解析失败 ⇒ 依赖它的 A1/A2/A5/A6 全红）───────────
  let contract = null
  let contractErr = null
  try {
    contract = parseContract(input.contractText)
  } catch (e) {
    contractErr = e
  }

  // ── A1 双向一致 ────────────────────────────────────────────────────────────
  if (contractErr) {
    push('A1', '双向一致（契约表 ↔ TIER_ALIASES ↔ normalizeTier ↔ TIERS）', false, `契约解析 fail-closed：${contractErr.message}`)
  } else if (contract.aliasRows.length === 0) {
    push('A1', '双向一致（契约表 ↔ TIER_ALIASES ↔ normalizeTier ↔ TIERS）', false, '别名映射表解析出 0 行（fail-closed，见 A6）')
  } else {
    const problems = []
    const contractAliasSet = new Set(contract.aliasRows.map((r) => r.alias))
    const codeAliasSet = new Set(Object.keys(aliases))
    for (const row of contract.aliasRows) {
      if (!Object.prototype.hasOwnProperty.call(aliases, row.alias)) {
        problems.push(`契约别名 ${row.alias} 不在 TIER_ALIASES`)
        continue
      }
      if (aliases[row.alias] !== row.target) problems.push(`TIER_ALIASES[${row.alias}]=${JSON.stringify(aliases[row.alias])} ≠ 契约目标 ${row.target}`)
      const normalized = modeledNormalize(row.alias)
      if (normalized !== row.target) problems.push(`normalizeTier(${row.alias})=${JSON.stringify(normalized)} ≠ 契约目标 ${row.target}`)
    }
    for (const key of codeAliasSet) {
      if (!contractAliasSet.has(key)) problems.push(`TIER_ALIASES 有别名 ${key} 未登记进契约映射表`)
    }
    // 三个规范档名自身必须自映射
    for (const tier of tiers) {
      const got = modeledNormalize(tier)
      if (got !== tier) problems.push(`normalizeTier(${tier})=${JSON.stringify(got)} ≠ ${tier}（规范档名必须自映射）`)
    }
    // 规范档名必须作为别名键存在（双向闭合）
    for (const tier of tiers) {
      if (!Object.prototype.hasOwnProperty.call(aliases, tier.toLowerCase())) problems.push(`TIER_ALIASES 缺规范档名键 ${tier.toLowerCase()}`)
    }
    // TIERS 与 TIER_ALIASES 值域集合相等
    const tierSet = new Set(tiers)
    const valueSet = new Set(Object.values(aliases))
    const missingInAliases = [...tierSet].filter((t) => !valueSet.has(t))
    const extraInAliases = [...valueSet].filter((t) => !tierSet.has(t))
    if (missingInAliases.length > 0) problems.push(`TIER_ALIASES 值域缺档位：${missingInAliases.join(',')}`)
    if (extraInAliases.length > 0) problems.push(`TIER_ALIASES 值域多档位：${extraInAliases.join(',')}`)
    // 闸门自洽：建模 normalize 必须与真实 normalizeTier 逐键一致（防闸门自说自话）
    if (typeof input.normalizeTier === 'function') {
      for (const key of codeAliasSet) {
        const real = input.normalizeTier(key)
        const modeled = modeledNormalize(key)
        if (real !== modeled) problems.push(`闸门建模 normalizeTier(${key})=${JSON.stringify(modeled)} ≠ lib 真实 ${JSON.stringify(real)}`)
      }
      const sentinel = '__alias_contract_gate_sentinel__'
      if (input.normalizeTier(sentinel) !== null) problems.push('lib normalizeTier 对未知输入未返回 null（闸门建模前提失效）')
    }
    push('A1', '双向一致（契约表 ↔ TIER_ALIASES ↔ normalizeTier ↔ TIERS）', problems.length === 0,
      problems.length === 0
        ? `别名 ${contract.aliasRows.length} 条双向闭合；TIERS 值域 ${tiers.join('/')} == TIER_ALIASES 值域`
        : problems.join('；'))
  }

  // ── A2 角色字段一致 ────────────────────────────────────────────────────────
  if (contractErr) {
    push('A2', '角色字段一致（normalizeTier(omcModel)===tier 或已登记例外）', false, `契约解析 fail-closed：${contractErr.message}`)
  } else if (roles.length === 0) {
    push('A2', '角色字段一致（normalizeTier(omcModel)===tier 或已登记例外）', false, '角色解析出 0 条（fail-closed，见 A6）')
  } else {
    const problems = []
    const roleById = new Map(roles.map((r) => [r.id, r]))
    const excById = new Map()
    for (const row of contract.exceptionRows) {
      if (excById.has(row.id)) problems.push(`例外表角色 ${row.id} 重复登记`)
      excById.set(row.id, row)
      if (!roleById.has(row.id)) problems.push(`例外表登记了 lib/roles.js 不存在的角色 ${row.id}（陈旧例外）`)
    }
    for (const role of roles) {
      const normalized = modeledNormalize(role.omcModel)
      const row = excById.get(role.id)
      if (normalized === role.tier) {
        if (row !== undefined) problems.push(`例外表登记了实际已一致的角色 ${role.id}（冗余例外：normalizeTier(${role.omcModel})=${normalized}===tier，应删除该行）`)
        continue
      }
      if (row === undefined) {
        problems.push(`角色 ${role.id}：normalizeTier(${role.omcModel})=${JSON.stringify(normalized)} ≠ tier=${role.tier}，且未登记例外`)
        continue
      }
      if (String(row.reason).trim() === '') problems.push(`例外 ${role.id}：理由为空（例外必须写明裁决理由）`)
      if (row.tier !== role.tier) problems.push(`例外 ${role.id}：登记 tier=${row.tier} ≠ 当前 ${role.tier}`)
      if (row.omcModel !== role.omcModel) problems.push(`例外 ${role.id}：登记 omcModel=${row.omcModel} ≠ 当前 ${role.omcModel}`)
    }
    push('A2', '角色字段一致（normalizeTier(omcModel)===tier 或已登记例外）', problems.length === 0,
      problems.length === 0
        ? `角色 ${roles.length} 条；例外 ${contract.exceptionRows.length} 条（${contract.exceptionRows.map((r) => r.id).join(', ') || '无'}），理由均非空且与当前字段一致`
        : problems.join('；'))
  }

  // ── A3 人格文件一致 ────────────────────────────────────────────────────────
  if (roles.length === 0) {
    push('A3', '人格一致（personas/<id>.md 的 omc_model 逐字等于 omcModel）', false, '角色解析出 0 条（fail-closed，见 A6）')
  } else {
    const problems = []
    let checked = 0
    for (const role of roles) {
      const text = personaTexts[role.id]
      if (text === null || text === undefined) {
        problems.push(`personas/${role.id}.md 缺失`)
        continue
      }
      const value = extractOmcModel(text)
      if (value === null) {
        problems.push(`personas/${role.id}.md 缺 omc_model 字段`)
        continue
      }
      checked++
      if (value !== role.omcModel) problems.push(`personas/${role.id}.md omc_model=${JSON.stringify(value)} ≠ 角色 omcModel=${JSON.stringify(role.omcModel)}`)
    }
    push('A3', '人格一致（personas/<id>.md 的 omc_model 逐字等于 omcModel）', problems.length === 0,
      problems.length === 0 ? `${checked}/${roles.length} 人格文件逐字一致` : problems.join('；'))
  }

  // ── A4 文档表述一致 ────────────────────────────────────────────────────────
  const familyAliases = Object.keys(aliases).filter((k) => !tiers.some((t) => t.toLowerCase() === k))
  const registered = new Set([...Object.keys(aliases), ...tiers, ...tiers.map((t) => t.toLowerCase())])
  const readme = docs.find((d) => d.path === 'README.md') ?? null
  const problemsA4 = []
  let arrowCount = 0
  let declCount = 0
  if (readme === null) {
    problemsA4.push('文档面缺 README.md（fail-closed）')
  } else {
    const arrows = parseArrowStatements(readme.text)
    arrowCount = arrows.length
    if (arrows.length === 0) problemsA4.push('README 解析出 0 条「档位 ← 别名」表述（fail-closed）')
    for (const stmt of arrows) {
      if (stmt.tiers.length !== stmt.aliases.length) {
        problemsA4.push(`README:${stmt.line} 档位列表 ${stmt.tiers.length} 项 ≠ 别名列表 ${stmt.aliases.length} 项`)
        continue
      }
      for (let i = 0; i < stmt.aliases.length; i++) {
        const normalized = modeledNormalize(stmt.aliases[i])
        if (normalized !== stmt.tiers[i]) problemsA4.push(`README:${stmt.line} 表述 ${stmt.aliases[i]} → ${stmt.tiers[i]}，但契约是 ${JSON.stringify(normalized)}`)
      }
      const stmtTierSet = [...new Set(stmt.tiers)].sort().join(',')
      const stmtAliasSet = [...new Set(stmt.aliases)].sort().join(',')
      const wantTierSet = [...tiers].sort().join(',')
      const wantAliasSet = [...familyAliases].sort().join(',')
      if (stmtTierSet !== wantTierSet) problemsA4.push(`README:${stmt.line} 档位集合 {${stmtTierSet}} ≠ TIERS {${wantTierSet}}`)
      if (stmtAliasSet !== wantAliasSet) problemsA4.push(`README:${stmt.line} 别名集合 {${stmtAliasSet}} ≠ 契约家族别名 {${wantAliasSet}}`)
    }
    const knownAliasLike = new Set([...Object.keys(aliases), ...familyAliases, ...FOREIGN_ALIAS_ROOTS])
    const decls = parseAliasDeclarations(readme.text, knownAliasLike)
    declCount = decls.length
    if (decls.length === 0) problemsA4.push('README 解析出 0 条「别名 …」集合声明（fail-closed）')
    for (const decl of decls) {
      const got = [...new Set(decl.aliases)].sort().join(',')
      const want = [...familyAliases].sort().join(',')
      if (got !== want) problemsA4.push(`README:${decl.line} 别名声明 {${got}} ≠ 契约家族别名 {${want}}`)
    }
    // 未登记别名（文档面全扫）
    for (const hit of scanAliasTokens(docs)) {
      if (!registered.has(hit.token)) problemsA4.push(`${hit.path}:${hit.line} 出现未登记别名 ${JSON.stringify(hit.token)}（契约别名集合 {${[...Object.keys(aliases)].join(',')}}）`)
    }
  }
  push('A4', '文档表述一致（README 表述 + 文档面未登记别名）', problemsA4.length === 0,
    problemsA4.length === 0
      ? `README「档位←别名」表述 ${arrowCount} 条、别名声明 ${declCount} 条与契约同向；文档面未登记别名 0 处`
      : problemsA4.join('；'))

  // ── A5 契约指纹 ────────────────────────────────────────────────────────────
  let fixture = null
  let fixtureErr = null
  try {
    fixture = validateFixture(input.fixture)
  } catch (e) {
    fixtureErr = e
  }
  let actual = null
  if (contractErr) {
    push('A5', '契约指纹（两节正文 sha256 == fixture）', false, `契约解析 fail-closed：${contractErr.message}`)
  } else if (fixtureErr) {
    push('A5', '契约指纹（两节正文 sha256 == fixture）', false, `fixture fail-closed：${fixtureErr.message}（${FIXTURE_PATH}）`)
  } else {
    try {
      actual = hashSections(input.contractText)
    } catch (e) {
      push('A5', '契约指纹（两节正文 sha256 == fixture）', false, `指纹计算 fail-closed：${e.message}`)
    }
    if (actual !== null) {
      const problems = HASH_KEYS.filter((k) => actual[k] !== fixture[k]).map((k) => `${k}：实测 ${actual[k]} ≠ fixture ${fixture[k]}`)
      push('A5', '契约指纹（两节正文 sha256 == fixture）', problems.length === 0,
        problems.length === 0
          ? `${HASH_KEYS.map((k) => `${k}=${actual[k]}`).join(' / ')} ✓（改契约必须同步改 fixture）`
          : `${problems.join('；')} ← 契约正文改了但 fixture 没改（或反之），按 docs/alias-contract.md 节 3.2 重取指纹`)
    }
  }

  // ── A6 零命中防护 ──────────────────────────────────────────────────────────
  {
    const counts = {
      aliasRows: contract === null ? 0 : contract.aliasRows.length,
      aliases: Object.keys(aliases).length,
      roles: roles.length,
      personas: roles.filter((r) => extractOmcModel(personaTexts[r.id]) !== null).length,
      exceptions: contract === null ? 0 : contract.exceptionRows.length,
      readmeStatements: arrowCount + declCount,
    }
    const zeros = []
    if (counts.aliasRows === 0) zeros.push('契约别名映射表 0 行')
    if (counts.aliases === 0) zeros.push('TIER_ALIASES 0 条')
    if (counts.roles === 0) zeros.push('角色 0 条')
    if (counts.personas === 0) zeros.push('人格 omc_model 0 条')
    if (counts.readmeStatements === 0) zeros.push('README 别名表述 0 条')
    push('A6', '零命中防护（别名/角色/人格/README 表述均 > 0）', zeros.length === 0,
      zeros.length === 0
        ? `别名表 ${counts.aliasRows} 行 / TIER_ALIASES ${counts.aliases} 键 / 角色 ${counts.roles} / 人格 ${counts.personas} / 例外 ${counts.exceptions} / README 表述 ${counts.readmeStatements}`
        : `零命中 fail-closed：${zeros.join('；')}`)
  }

  const gateMap = Object.fromEntries(gates.map((g) => [g.id, g]))
  const counts = {
    aliasRows: contract === null ? 0 : contract.aliasRows.length,
    aliases: Object.keys(aliases).length,
    roles: roles.length,
    personas: roles.filter((r) => extractOmcModel(personaTexts[r.id]) !== null).length,
    exceptions: contract === null ? 0 : contract.exceptionRows.length,
    readmeStatements: arrowCount + declCount,
  }
  return {
    pass: gates.every((g) => g.pass),
    gates,
    gateMap,
    counts,
    parsed: { contract, contractErr, fixture, fixtureErr, actual },
  }
}

// ── 基线加载（真实文件 → classify 输入；fail-closed）──────────────────────────

/**
 * 从仓库读入 classify 输入。
 * @param {{root?:string}} [opts]
 * @returns {Promise<object>}
 */
export async function loadBaseline({ root = ROOT } = {}) {
  const abs = (rel) => join(root, rel)
  const readText = (rel, label) => {
    try {
      return readFileSync(abs(rel), 'utf8')
    } catch (e) {
      throw new GateParseError(`${label} 读取失败（${rel}）：${e.message}`)
    }
  }

  const { TIER_ALIASES, TIERS, ROLES, normalizeTier } = await import(new URL('../lib/roles.js', import.meta.url).href)
  if (!Array.isArray(ROLES) || ROLES.length === 0) throw new GateParseError('lib/roles.js 的 ROLES 为空或非数组（fail-closed）')

  const contractText = readText(CONTRACT_PATH, '契约正本')

  let fixture = null
  try {
    fixture = JSON.parse(readFileSync(abs(FIXTURE_PATH), 'utf8'))
  } catch (e) {
    fixture = null // 缺失/非法 ⇒ A5 fail-closed 红（不在这里抛，避免掩盖其它门读数）
  }

  // 人格文件（缺文件 → null，A3 红）
  const personaDir = abs('personas')
  let personaFiles = []
  try {
    personaFiles = readdirSync(personaDir).filter((f) => f.endsWith('.md'))
  } catch (e) {
    personaFiles = []
  }
  const personaTexts = {}
  for (const file of personaFiles) {
    const id = file.slice(0, -'.md'.length)
    try {
      personaTexts[id] = readFileSync(join(personaDir, file), 'utf8')
    } catch (e) {
      personaTexts[id] = null
    }
  }
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(personaTexts, role.id)) personaTexts[role.id] = null
  }

  // 文档面（README + ARCHITECTURE + docs/*.md，排除本契约与 CHANGELOG）
  const docs = []
  for (const rel of DOC_FILES) docs.push({ path: rel, text: readText(rel, '文档面') })
  const docsDir = abs('docs')
  let docFiles = []
  try {
    docFiles = readdirSync(docsDir).filter((f) => f.endsWith('.md'))
  } catch (e) {
    throw new GateParseError(`docs/ 目录读取失败：${e.message}`)
  }
  for (const file of docFiles.sort()) {
    const rel = `docs/${file}`
    if (DOC_EXCLUDE.includes(rel)) continue
    docs.push({ path: rel, text: readFileSync(join(docsDir, file), 'utf8') })
  }

  return {
    aliases: TIER_ALIASES,
    tiers: TIERS,
    normalizeTier,
    roles: ROLES.map((r) => ({ id: r.id, tier: r.tier, omcModel: r.omcModel })),
    personaTexts,
    contractText,
    fixture,
    docs,
  }
}

// ── 输出渲染 ─────────────────────────────────────────────────────────────────

function formatGates(result) {
  return result.gates.map((g) => `  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id} ${g.name} —— ${g.detail}`)
}

// ── selftest（内存变异；断言鉴别力：变异体与断言类别一一对应）──────────────────

/** 深拷贝 JSON 形状输入。 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 变异 2 用：把例外表首行的「理由」列清空（只改文本，内存里）。 */
function blankFirstExceptionReason(text) {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => /^\|\s*`?harness-optimizer`?\s*\|/.test(l))
  if (idx < 0) throw new Error('变异体构造失败：找不到 harness-optimizer 例外行')
  const cells = lines[idx].split('|')
  cells[4] = ' ' // 0=行首空段 1=id 2=tier 3=omcModel 4=理由
  lines[idx] = cells.join('|')
  return lines.join('\n')
}

/** 变异 5 用：在「二、例外登记表」标题前插入一行正文（改正文不动 fixture）。 */
function appendLineToAliasSection(text) {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => EXC_HEADING.test(l))
  if (idx < 0) throw new Error('变异体构造失败：找不到「二、例外登记表」标题')
  lines.splice(idx, 0, '- 变异体注入行：改契约正文但不动 fixture（内存构造，不写盘）。')
  return lines.join('\n')
}

/** 由别名表重建「建模 normalize」函数（模拟 lib 代码被改后的真实函数）。 */
function modeledNormalizeOf(aliases) {
  return (raw) => {
    const key = String(raw ?? '').trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : null
  }
}

/**
 * 注入必红自测：6 个变异体各自精确变红（断言**红门集合完全相等**，不是「至少一个红」），
 * 原样基线全绿。变异体全部在内存构造，不写盘、不改真实文件。
 * @param {{root?:string}} [opts]
 * @returns {Promise<{pass:number,total:number,rows:Array<{name:string,ok:boolean,detail:string}>}>}
 */
export async function selftest({ root = ROOT } = {}) {
  const rows = []
  let base
  try {
    base = await loadBaseline({ root })
  } catch (e) {
    return {
      pass: 0,
      total: 7,
      rows: [{ name: '基线加载', ok: false, detail: `loadBaseline 抛错（selftest 无法进行）：${e.message}` }],
    }
  }

  const run = (name, input, expectedRed) => {
    let result
    try {
      result = classify(input)
    } catch (e) {
      rows.push({ name, ok: false, detail: `classify 抛错（应返回结构化判定）：${e.message}` })
      return
    }
    const red = result.gates.filter((g) => !g.pass).map((g) => g.id).sort()
    const want = [...expectedRed].sort()
    const detail = result.gates.map((g) => `${g.id}=${g.pass ? '绿' : '红'}`).join(' ')
    const ok = red.length === want.length && red.every((id, i) => id === want[i])
    rows.push({ name, ok, detail: `${detail}${ok ? '' : ` ← 期望红 [${want.join(',') || '无'}]，实得 [${red.join(',') || '无'}]`}` })
  }

  // 0) 原样：A1–A6 全绿
  run('原样基线（磁盘真实文件）', base, [])

  // 1) MUT-A1：TIER_ALIASES 里 opus 改指 MEDIUM ⇒ A1 红（契约表 opus→HIGH 与代码不符）。
  //    级联红 A2 / A4 是**语义必然、非误伤**：A2 的 6 个 opus 角色（analyst/planner/architect/
  //    code-reviewer/security-reviewer/critic…）与 2 条例外都按 normalizeTier 判定，别名换向
  //    后不再对齐；A4 的 README「opus → HIGH」表述同理与改后 normalizeTier 冲突。
  //    变异体只动一个变量（别名目标），红门集合按真实级联如实断言——断言「恰好这些门红」
  //    比「至少一个红」鉴别力强（漏红与多红都会被抓）。
  {
    const input = cloneJson(base)
    input.aliases = { ...input.aliases, opus: 'MEDIUM' }
    input.normalizeTier = modeledNormalizeOf(input.aliases)
    run('MUT-A1 TIER_ALIASES.opus → MEDIUM（级联 A2/A4）', input, ['A1', 'A2', 'A4'])
  }

  // 2) MUT-A2：删掉一个例外表的理由 ⇒ A2 红（fixture 用变异文本现算，隔离 A5 干扰）
  {
    const input = cloneJson(base)
    input.contractText = blankFirstExceptionReason(input.contractText)
    input.fixture = { ...cloneJson(base.fixture), ...hashSections(input.contractText) }
    run('MUT-A2 例外表理由清空（harness-optimizer）', input, ['A2'])
  }

  // 3) MUT-A3：某人格 omc_model 改成 opus ⇒ A3 红
  {
    const input = cloneJson(base)
    const text = input.personaTexts.executor
    if (typeof text !== 'string') throw new Error('变异体构造失败：executor 人格正文缺失')
    input.personaTexts.executor = text.replace(/^omc_model:[ \t]*.*$/m, 'omc_model: opus')
    run('MUT-A3 personas/executor.md omc_model → opus', input, ['A3'])
  }

  // 4) MUT-A4：文档里塞一个未登记别名（opus4 + gpt）⇒ A4 红
  {
    const input = cloneJson(base)
    input.docs = input.docs.map((d) => (d.path === 'README.md'
      ? { ...d, text: `${d.text}\n\n变异体注入：未登记别名 \`opus4\` 与 \`gpt\`。\n` }
      : d))
    run('MUT-A4 README 塞未登记别名 opus4/gpt', input, ['A4'])
  }

  // 5) MUT-A5：改契约正文但不动 fixture ⇒ A5 红
  {
    const input = cloneJson(base)
    input.contractText = appendLineToAliasSection(input.contractText)
    run('MUT-A5 改契约正文不动 fixture', input, ['A5'])
  }

  // 6) MUT-A6：TIER_ALIASES 删空 ⇒ A6 红（零命中）；A1/A2/A4 连坐红（别名宇宙空了，
  //    契约表与文档表述都失去参照）——这是 fail-closed 语义，非误伤。
  {
    const input = cloneJson(base)
    input.aliases = {}
    input.normalizeTier = modeledNormalizeOf({})
    run('MUT-A6 TIER_ALIASES 删空', input, ['A1', 'A2', 'A4', 'A6'])
  }

  const failed = rows.filter((r) => !r.ok)
  return { pass: rows.length - failed.length, total: rows.length, rows }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function runSelftest(opts) {
  const st = await selftest(opts)
  console.log('== alias-contract-gate --selftest（注入必红；变异体内存构造，不写盘）==')
  for (const row of st.rows) console.log(`[selftest] ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  —— ${row.detail}`)
  console.log(`[selftest] ${st.pass}/${st.total} PASS`)
  if (st.pass !== st.total) {
    console.error('[selftest] FAIL — 变异体未达预期，门判据退化')
    process.exitCode = 1
  }
}

async function runPrintHashes(opts) {
  const { contractText } = await loadBaseline(opts)
  const hashes = hashSections(contractText)
  console.log(`== ${CONTRACT_PATH} 两节正文指纹（sha256 前 ${DIGEST.digestPrefix} 位大写）==`)
  for (const key of HASH_KEYS) console.log(`${key} = ${hashes[key]}`)
  console.log(`[提示] 把上面两值写进 ${FIXTURE_PATH} 后复跑本闸门；禁止只改 fixture 不改契约。`)
}

function parseArgs(argv) {
  const opts = { selftest: false, printHashes: false }
  for (const a of argv) {
    if (a === '--selftest') opts.selftest = true
    else if (a === '--print-hashes') opts.printHashes = true
    else {
      console.error(`[用法错误] 未知参数 ${a}`)
      console.error('用法: node tools/alias-contract-gate.mjs [--selftest | --print-hashes]')
      process.exitCode = 2
      return null
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts === null) return
  if (opts.selftest) {
    await runSelftest(opts)
    return
  }
  if (opts.printHashes) {
    try {
      await runPrintHashes(opts)
    } catch (e) {
      console.error(`[fail-closed] ${e.message}`)
      process.exitCode = 1
    }
    return
  }

  let input
  try {
    input = await loadBaseline()
  } catch (e) {
    console.error(`[fail-closed] 基线加载失败：${e.message}`)
    process.exitCode = 1
    return
  }
  const result = classify(input)
  console.log('== alias-contract-gate（档位别名契约：A1–A6）==')
  for (const line of formatGates(result)) console.log(line)
  console.log(`  [读数] ${JSON.stringify(result.counts)}`)
  console.log(`[RESULT] ${result.pass ? 'PASS — A1–A6 全绿' : 'FAIL — 存在门红'}`)
  if (!result.pass) process.exitCode = 1
}

// import guard（供测试/工具复用 `classify` / `selftest` 时不整场跑 CLI）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
