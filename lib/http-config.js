/**
 * dsh-agents 设置卡数据端点——浏览器半（lib/client.js）读写的同源配置面。
 *
 * 照 dsh-dafeiyu 的生产模式：webServer.register({kind:'exact', path, handler})
 * 挂一个 GET/PATCH JSON 端点；回环地址 + Origin 同源双重防护；PATCH 只收
 * 白名单形状（改某档 / 复位某档 / 全部复位），写入走宿主 settings 服务
 * （与 agent_roles set/reset、Web 设置卡同源），返回写后最新全量状态。
 * @module http-config
 */
import { normalizeTier } from './roles.js'

/** 设置卡数据端点路径（与 lib/client.js 的 CONFIG_ENDPOINT 保持一致）。 */
export const CONFIG_ENDPOINT = '/plugins/dsh-agents/config'

const MAX_FIELD_LEN = 200

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

async function readPatch(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 8192) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('patch must be an object')
  return value
}

/** 校验 route 二元组（非空字符串、限长）。 */
function readRoute(provider, model) {
  const p = String(provider ?? '').trim()
  const m = String(model ?? '').trim()
  if (p === '' || m === '') throw new Error('provider 与 model 都必须是非空字符串')
  if (p.length > MAX_FIELD_LEN || m.length > MAX_FIELD_LEN) throw new Error('provider/model 过长')
  return { provider: p, model: m }
}

/**
 * 创建设置卡端点处理器。
 * @param {object} input
 * @param {object} input.tiersApi - lib/settings.js 的 createTiersApi 产物
 * @param {() => Promise<Record<string, string[]>>} [input.loadCatalog] - 取
 *   provider→模型 id 目录（与 GUI 模型选择框同源：llm.listConfigurableProviders()）
 * @param {() => object} [input.diag] - 服务解析诊断（随 GET 下发，排障用）
 * @returns {(req:object, res:object) => Promise<void>}
 */
export function createConfigHandler({ tiersApi, loadCatalog, diag }) {
  /** GET/PATCH 响应的统一状态载荷。 */
  async function statePayload() {
    const tiers = tiersApi.getTable()
    let catalog = {}
    if (typeof loadCatalog === 'function') {
      try { catalog = (await loadCatalog()) ?? {} } catch { catalog = {} }
    }
    return {
      ok: true,
      settingsAvailable: tiersApi.hasScope(),
      tiers,
      base: tiersApi.getBase(),
      sources: tiersApi.sourcesOf(tiers),
      catalog,
      ...(typeof diag === 'function' ? { diag: diag() } : {}),
    }
  }

  /** 把一帧 PATCH 应用到 settings 用户层（非法形状大声抛错 → 400）。 */
  async function applyPatch(patch) {
    // 可写性由 tiersApi 统一判定（旧宿主 register 作用域 / 新宿主 entry 配置表单）。
    if (typeof tiersApi.hasScope === 'function' && tiersApi.hasScope() !== true) {
      throw new Error('设置服务不可用：档位写入需宿主 settings 服务（重启 DSH 后可用）')
    }
    if (patch.resetAll === true) {
      await tiersApi.resetAll() // 清除全部用户层覆盖，回落 bundle patch 的 config.tiers
      return
    }
    if (patch.reset !== undefined) {
      const tier = normalizeTier(patch.reset)
      if (tier === null) throw new Error(`未知档位 "${String(patch.reset)}"（合法值：LOW / MEDIUM / HIGH）`)
      const base = tiersApi.getBase()?.[tier]
      if (!base) throw new Error(`档位 ${tier} 没有可回退的合成基底`)
      await tiersApi.writeTiers({ [tier]: { provider: base.provider, model: base.model } })
      return
    }
    if (patch.tier !== undefined) {
      const tier = normalizeTier(patch.tier)
      if (tier === null) throw new Error(`未知档位 "${String(patch.tier)}"（合法值：LOW / MEDIUM / HIGH）`)
      const route = readRoute(patch.provider, patch.model)
      await tiersApi.writeTiers({ [tier]: route })
      return
    }
    throw new Error('patch 需要之一：{tier,provider,model} / {reset:档位} / {resetAll:true}')
  }

  return async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    const origin = req.headers?.origin
    if (origin) {
      let originHost
      try { originHost = new URL(origin).host } catch {}
      if (!originHost || originHost !== req.headers.host) {
        jsonResponse(res, 403, { error: 'origin mismatch' })
        return
      }
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, await statePayload())
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      await applyPatch(await readPatch(req))
      jsonResponse(res, 200, await statePayload())
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
