/**
 * advisor HTTP 端点（契约 §2）。
 *
 * `webServer.register({kind:'exact', path:'/plugins/dsh-agents/advisor', handler})`，
 * 防护与形态照抄同仓 `lib/http-config.js`：回环地址 + Origin 同源双重防护、
 * JSON 出入参、body 上限 8KB、非法形状 400 + `{error}`。
 *
 * - **GET** `?sessionId=` → 契约 §2 的状态载荷（enabled/provider/model/modelSource/
 *   catalog/runtime/records），**全部只属于该会话**。sessionId 缺失/形状非法 400；
 *   会话不存在或不活跃 **404**，且该分支**在任何快照计算之前返回**、响应体
 *   **不含 catalog/records/runtime/provider/model 任一键**（F-14 / AC-21）。
 *   records **按会话过滤**、按 createdAt 倒序、最多 advisorPersistLimit 条；
 * - **PATCH** `{sessionId, enabled?, provider?, model?}` → sessionId 必填；
 *   非法形状 400（未知键、空字符串、provider/model 单给其一）；会话不活跃
 *   **404 且零写盘**（校验必须在写之前）。双给 provider/model 即采用该会话手动
 *   指定的模型（`modelSource:'session'`），写盘落
 *   `<advisorDataDir>/sessions/<base64url(sessionId)>.json`
 *   （**不扩展宿主 settings schema**）；
 * - **POST** `{action:'review', sessionId}` → 手动触发一次评审，**恒 200**
 *   （失败以 `{ok:false, reason}` 表达，不抛错）。进入评审前先做活跃校验，
 *   失败 reason='no-session'，**不消耗额度**；会话在但未配模型 reason='unset'。
 *
 * **残余风险（如实声明，勿在文档里淡化）**：宿主 webServer 的 WebRoute 只有
 * kind/path/handler，**没有鉴权钩子**，handler 拿的是裸 IncomingMessage。因此
 * 本端点能挡住「不存在/已 dispose 的 sessionId」，**挡不住**「同机另一页面修改
 * 他人活跃会话的配置」。会话存活校验是 liveness check，**不是 authorization**。
 *
 * @module dsh-agents/advisor/api
 */

/** 端点路径（契约 §2；客户端半须与此保持一致）。 */
export const ADVISOR_ENDPOINT = '/plugins/dsh-agents/advisor'

const BODY_MAX_BYTES = 8192

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 读 JSON body（有上限；非法形状抛错 → 400）。 */
async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > BODY_MAX_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body must be a JSON object')
  }
  return value
}

/** sessionId 长度上限（契约 §2：超长即 400）。 */
export const SESSION_ID_MAX = 200

/**
 * sessionId 形状校验（契约 §2 / AC-06 / AC-07）——**GET / PATCH / POST 三处共用
 * 这一个函数**（判据 B20）。
 *
 * 三份各写一遍的判据迟早会各自漂移，而「哪条路径更宽松」正是越权写入的入口。
 * 边界分工：形状非法一律 **400**（客户端发错了）；形状合法但会话不存在/不活跃
 * 才 **404**（GET/PATCH）或恒 200 + `ok:false`（POST）。
 *
 * 路径字符在**形状层**直接拒收（AC-06），不依赖 store 的 base64url 兜底：
 * 兜底是最后一道防线，不是判据本身。
 *
 * @param {unknown} value - 未规范化的 sessionId
 * @returns {string} trim 后的 sessionId
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') throw new Error('sessionId 必须是非空字符串')
  const id = value.trim()
  if (id === '') throw new Error('sessionId 不能是空字符串')
  if (id.length > SESSION_ID_MAX) throw new Error(`sessionId 超过 ${SESSION_ID_MAX} 字符上限`)
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('sessionId 不得包含路径分隔符（/ \\）或 ..')
  }
  return id
}

/**
 * 从 `req.url` 的 query 里取 sessionId（GET）。
 *
 * **不做 URL 解析**：直接切 `?` 之后的原始 query 交给 URLSearchParams。
 * 理由**不是**「URL 会把 `..` 吃掉」——实测 `new URL(raw, base)` 只对 path 做
 * 点段消解，`?sessionId=a/../b` 的 query 部分原样保留；真正会踩的是
 * `new URL('相对路径')` 直接抛 Invalid URL。写错这个理由，后人会照着它
 * 「修回」new URL，然后踩上真正的坑。
 *
 * `req.url` 缺失 → **fail-closed 抛错**（B7）。真机不可达（宿主把同一个 req
 * 对象交给 handler，见 dsh-host-webserver/lib/index.js:232-235），只有假宿主
 * 能构造，因此不计入端到端覆盖——但仍必须是 400 而不是崩溃。
 *
 * @param {object} req - 原始请求
 * @returns {string|null} 未携带时为 null（由调用方转 400）
 */
function readSessionIdFromQuery(req) {
  const raw = req?.url
  if (typeof raw !== 'string') throw new Error('无法读取请求 URL（sessionId 缺失）')
  const at = raw.indexOf('?')
  if (at === -1) return null
  return new URLSearchParams(raw.slice(at + 1)).get('sessionId')
}

/**
 * 校验 PATCH 形状（契约 §2：sessionId 必填 / 未知键 / 空串 / 单给其一 → 抛错）。
 * @param {object} patch
 * @returns {{sessionId: string, enabled?: boolean, provider?: string, model?: string}} 规范化补丁
 */
export function normalizeAdvisorPatch(patch) {
  const allowed = new Set(['sessionId', 'enabled', 'provider', 'model'])
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new Error('patch 需要至少一个键：sessionId / enabled / provider / model')
  const out = {}
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`未知键 "${key}"（合法键：sessionId / enabled / provider / model）`)
  }
  if (patch.sessionId === undefined) throw new Error('patch 缺少 sessionId（端点不再有「无会话」的落点）')
  out.sessionId = normalizeSessionId(patch.sessionId)
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    out.enabled = patch.enabled
  }
  const hasProvider = patch.provider !== undefined
  const hasModel = patch.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('provider 与 model 必须成对给出（单给其一非法）')
  }
  if (hasProvider) {
    const provider = typeof patch.provider === 'string' ? patch.provider.trim() : ''
    const model = typeof patch.model === 'string' ? patch.model.trim() : ''
    if (provider === '') throw new Error('provider 不能是空字符串')
    if (model === '') throw new Error('model 不能是空字符串')
    if (provider.length > 200 || model.length > 200) throw new Error('provider/model 过长')
    out.provider = provider
    out.model = model
  }
  return out
}

/**
 * 创建 advisor 端点处理器。
 * @param {object} input
 * @param {object} input.ctrl - lib/advisor/index.js 的控制器
 * @param {() => Promise<Record<string, string[]>>} [input.loadCatalog] - provider→模型目录
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createAdvisorHandler({ ctrl, loadCatalog }) {
  /** 活跃校验：ctrl 未暴露该钩子时一律 fail-closed（AC-20）。 */
  const isActive = (sessionId) => (
    typeof ctrl?.isActiveSession === 'function' && ctrl.isActiveSession(sessionId) === true
  )

  /** GET/PATCH 共用的状态载荷（契约 §2）——**只含该会话**的配置与记录。 */
  async function statePayload(sessionId) {
    let catalog = {}
    if (typeof loadCatalog === 'function') {
      try { catalog = (await loadCatalog()) ?? {} } catch { catalog = {} }
    }
    const snapshot = ctrl.snapshot(sessionId)
    return {
      ok: true,
      // E-2 金丝雀（2026-10-19）：宿主「已重启」≠「加载了新代码」——GET 载荷带构建标记，
      // 重启后一眼判版本（本仓教训：文件就位 ≠ 宿主会加载，加载链路要实跑闭环）。
      build: 'dsh-agents 2026-10-19/e170a76+E-2',
      enabled: snapshot.enabled,
      provider: snapshot.provider,
      model: snapshot.model,
      modelSource: snapshot.modelSource,
      catalog,
      runtime: snapshot.runtime,
      records: snapshot.records,
    }
  }

  return async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    const origin = req.headers?.origin
    if (origin) {
      let originHost
      try { originHost = new URL(origin).host } catch { /* 落到下面的 403 */ }
      if (!originHost || originHost !== req.headers.host) {
        jsonResponse(res, 403, { error: 'origin mismatch' })
        return
      }
    }
    if (req.method === 'GET') {
      let sessionId
      try {
        sessionId = normalizeSessionId(readSessionIdFromQuery(req))
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      // Q-1 / F-14：活跃校验与 404 响应**都在任何快照计算与模型目录读取之前**。
      // 404 响应体只有一个通用 error——不得回显任何 catalog/records/runtime/
      // provider/model 键，也不得回显请求里那个 sessionId 的配置内容。
      if (!isActive(sessionId)) {
        jsonResponse(res, 404, { error: 'session not found' })
        return
      }
      jsonResponse(res, 200, await statePayload(sessionId))
      return
    }
    if (req.method === 'PATCH') {
      let patch
      try {
        patch = normalizeAdvisorPatch(await readJson(req))
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      // 活跃校验必须在写盘之前：B14/B18 要求 404 + 目标文件零变化。
      if (!isActive(patch.sessionId)) {
        jsonResponse(res, 404, { error: 'session not found' })
        return
      }
      try {
        const configPatch = {}
        if (patch.enabled !== undefined) configPatch.enabled = patch.enabled
        if (patch.provider !== undefined) {
          configPatch.provider = patch.provider
          configPatch.model = patch.model
        }
        ctrl.patchConfig(patch.sessionId, configPatch)
        jsonResponse(res, 200, await statePayload(patch.sessionId))
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (req.method === 'POST') {
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (body.action !== 'review') {
        jsonResponse(res, 400, { error: `未知 action "${String(body.action ?? '')}"（当前只支持 review）` })
        return
      }
      let sessionId
      try {
        sessionId = normalizeSessionId(body.sessionId)
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      // 手动触发恒 200：失败用 reason 表达（契约 §2）。活跃校验在
      // ctrl.triggerReview 内部（Q-3），失败 reason='no-session' 且不消耗额度。
      const result = ctrl.triggerReview(sessionId)
      jsonResponse(res, 200, result.ok ? { ok: true, triggered: true } : { ok: false, reason: result.reason })
      return
    }
    jsonResponse(res, 405, { error: 'method not allowed' })
  }
}