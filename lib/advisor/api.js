/**
 * advisor HTTP 端点（契约 §2）。
 *
 * `webServer.register({kind:'exact', path:'/plugins/dsh-agents/advisor', handler})`，
 * 防护与形态照抄同仓 `lib/http-config.js`：回环地址 + Origin 同源双重防护、
 * JSON 出入参、body 上限 8KB、非法形状 400 + `{error}`。
 *
 * - **GET** → 契约 §2 的状态载荷（enabled/provider/model/modelSource/
 *   catalog/runtime/records）。records 按 createdAt 倒序、最多
 *   advisorPersistLimit 条；
 * - **PATCH** `{enabled?, provider?, model?}` → 非法形状 400（未知键、空
 *   字符串、provider/model 单给其一），双给则置 modelSource='config'，
 *   写盘落 `<advisorDataDir>/config.json`（**不扩展宿主 settings schema**）；
 * - **POST** `{action:'review', sessionId}` → 手动触发一次评审，恒 200
 *   （失败以 `{ok:false, reason}` 表达，不抛错）。
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

/**
 * 校验 PATCH 形状（契约 §2：未知键 / 空串 / 单给其一 → 抛错）。
 * @param {object} patch
 * @returns {{enabled?: boolean, provider?: string, model?: string}} 规范化补丁
 */
export function normalizeAdvisorPatch(patch) {
  const allowed = new Set(['enabled', 'provider', 'model'])
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new Error('patch 需要至少一个键：enabled / provider / model')
  const out = {}
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`未知键 "${key}"（合法键：enabled / provider / model）`)
  }
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
  /** GET/PATCH 共用的状态载荷（契约 §2）。 */
  async function statePayload() {
    let catalog = {}
    if (typeof loadCatalog === 'function') {
      try { catalog = (await loadCatalog()) ?? {} } catch { catalog = {} }
    }
    const snapshot = ctrl.snapshot()
    return {
      ok: true,
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
      jsonResponse(res, 200, await statePayload())
      return
    }
    if (req.method === 'PATCH') {
      try {
        const patch = normalizeAdvisorPatch(await readJson(req))
        ctrl.patchConfig(patch)
        jsonResponse(res, 200, await statePayload())
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
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId === '') {
        jsonResponse(res, 400, { error: 'sessionId 必须是非空字符串' })
        return
      }
      // 手动触发恒 200：失败用 reason 表达（契约 §2）
      const result = ctrl.triggerReview(sessionId)
      jsonResponse(res, 200, result.ok ? { ok: true, triggered: true } : { ok: false, reason: result.reason })
      return
    }
    jsonResponse(res, 405, { error: 'method not allowed' })
  }
}