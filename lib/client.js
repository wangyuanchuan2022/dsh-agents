window.__ModuleLoader__.load({ id: 'dsh-agents', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const { useState, useEffect, useRef } = React
  const CONFIG_ENDPOINT = '/plugins/dsh-agents/config'

  const cardStyle = {
    listStyle: 'none', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12,
    padding: 16, background: 'var(--surface-color, transparent)', display: 'grid', gap: 14,
  }
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20 }
  const inputStyle = { minWidth: 160, maxWidth: 280, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', color: 'inherit' }
  const btnStyle = { padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }
  const badgeStyle = { fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--border-color, #d8d8d8)', opacity: 0.8 }
  const TIER_HINTS = {
    LOW: '检索/定位/文档/批量转录等窄任务（快而便宜）',
    MEDIUM: '实现/调试/测试/设计/QA/提交等主力工作',
    HIGH: '需求分析/规划/架构/评审等长链条推理',
  }
  const TIERS = ['LOW', 'MEDIUM', 'HIGH']

  function Field({ label, hint, children }) {
    return React.createElement('label', { style: rowStyle },
      React.createElement('span', null,
        React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, label),
        React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, hint),
      ),
      children,
    )
  }

  /** 主题判定：DSH 暗色主题在 body 上标 data-ds-dark-theme（与工作台同源判定）。 */
  function isDarkTheme() {
    try { return document.body?.hasAttribute('data-ds-dark-theme') === true } catch { return false }
  }

  /** 下拉：选项来自目录；当前值不在目录中时置顶保留（不静默丢值）。
   *  ⚠️ 必须显式给底色/字色 + color-scheme：原生 select 在暗色页面上
   *  transparent 底 + inherit 字会白底白字（2026-09-12 用户实测）。 */
  function Picker({ value, options, disabled, onChange }) {
    const dark = isDarkTheme()
    const bg = dark ? '#2b2b31' : '#ffffff'
    const fg = dark ? '#e6e6e6' : '#1a1a1a'
    const style = { ...inputStyle, backgroundColor: bg, color: fg, colorScheme: dark ? 'dark' : 'light' }
    const optStyle = { backgroundColor: bg, color: fg }
    const list = Array.isArray(options) ? options.slice() : []
    if (value !== '' && value !== undefined && !list.includes(value)) list.unshift(value)
    return React.createElement('select', {
      value, disabled, style,
      onChange: (e) => onChange(e.target.value),
    },
    list.map((opt) => React.createElement('option', { key: opt, value: opt, style: optStyle }, opt)),
    )
  }

  function TierEditor({ tier, current, base, source, catalog, disabled, onSave, onReset }) {
    const [draft, setDraft] = useState({ provider: current.provider ?? '', model: current.model ?? '' })
    useEffect(() => { setDraft({ provider: current.provider ?? '', model: current.model ?? '' }) }, [current.provider, current.model])
    const dirty = String(draft.provider) !== String(current.provider ?? '') || String(draft.model) !== String(current.model ?? '')
    const overridden = source === '设置（用户层覆盖）'
    const providerOptions = Object.keys(catalog ?? {}).sort()
    const modelOptions = catalog?.[draft.provider] ?? []
    const usePicker = providerOptions.length > 0
    const changeProvider = (next) => setDraft((d) => ({
      provider: next,
      model: (catalog?.[next] ?? []).includes(d.model) ? d.model : ((catalog?.[next] ?? [])[0] ?? ''),
    }))
    return React.createElement('div', { style: { display: 'grid', gap: 8, padding: '10px 12px', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 8 } },
      React.createElement('div', { style: rowStyle },
        React.createElement('span', { style: { fontWeight: 600 } }, tier),
        React.createElement('span', { style: { ...badgeStyle, opacity: overridden ? 1 : 0.65 } },
          dirty ? '有未保存修改' : source),
      ),
      React.createElement('small', { style: { opacity: 0.65 } }, TIER_HINTS[tier]),
      usePicker
        ? React.createElement(Field, { label: 'provider', hint: '与输入框模型选择同源的 provider 目录' },
            React.createElement(Picker, {
              value: draft.provider, options: providerOptions, disabled,
              onChange: changeProvider,
            }))
        : React.createElement(Field, { label: 'provider', hint: '（模型目录不可读，回退手填）provider 路由 id' },
            React.createElement('input', {
              value: draft.provider, disabled, style: inputStyle, spellCheck: false,
              placeholder: (base.provider ?? '') || 'provider',
              onChange: (e) => setDraft((d) => ({ ...d, provider: e.target.value })),
            })),
      usePicker
        ? React.createElement(Field, { label: 'model', hint: `该 provider 下的模型（目录 ${modelOptions.length} 个）` },
            React.createElement(Picker, {
              value: draft.model, options: modelOptions, disabled,
              onChange: (next) => setDraft((d) => ({ ...d, model: next })),
            }))
        : React.createElement(Field, { label: 'model', hint: '模型 id（须在该 provider 目录中存在）' },
            React.createElement('input', {
              value: draft.model, disabled, style: inputStyle, spellCheck: false,
              placeholder: (base.model ?? '') || 'model',
              onChange: (e) => setDraft((d) => ({ ...d, model: e.target.value })),
            })),
      React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        React.createElement('button', {
          style: btnStyle, disabled: disabled || !dirty,
          onClick: () => setDraft({ provider: current.provider ?? '', model: current.model ?? '' }),
        }, '放弃修改'),
        React.createElement('button', {
          style: { ...btnStyle, opacity: disabled || !dirty ? 0.6 : 1 }, disabled: disabled || !dirty,
          onClick: () => void onSave(tier, draft.provider, draft.model),
        }, '保存'),
        React.createElement('button', {
          style: btnStyle, disabled: disabled || !overridden,
          title: '清除该档的用户层覆盖，回落 cordis 配置基底',
          onClick: () => void onReset(tier),
        }, '恢复基底'),
      ),
    )
  }

  function AgentsCard() {
    const [status, setStatus] = useState('loading')
    const [state, setState] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const seq = useRef(0)
    const writable = status === 'ready' && !busy

    const load = async () => {
      const mySeq = ++seq.current
      try {
        const response = await fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
        if (!response.ok) throw new Error(`settings request failed: ${response.status}`)
        const next = await response.json()
        if (seq.current === mySeq) { setState(next); setStatus('ready'); setError('') }
      } catch {
        if (seq.current === mySeq) setStatus('unavailable')
      }
    }
    useEffect(() => { void load(); return () => { seq.current += 1 } }, [])

    const send = async (patch) => {
      const mySeq = ++seq.current
      setBusy(true)
      try {
        const response = await fetch(CONFIG_ENDPOINT, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `settings write failed: ${response.status}`)
        if (seq.current === mySeq) { setState(body); setStatus('ready'); setError('') }
      } catch (e) {
        if (seq.current === mySeq) setError(e?.message ?? String(e))
      } finally {
        if (seq.current === mySeq) setBusy(false)
      }
    }
    const saveTier = (tier, provider, model) => void send({ tier, provider, model })
    const resetTier = (tier) => void send({ reset: tier })
    const resetAll = () => {
      if (window.confirm('清除全部三档的用户层覆盖，回落 cordis 配置基底 / 内置默认？')) void send({ resetAll: true })
    }

    return React.createElement('li', { style: cardStyle, 'data-testid': 'dsh-agents-settings' },
      React.createElement('div', null,
        React.createElement('strong', { style: { fontSize: 16 } }, 'Agents 三档模型路由'),
        React.createElement('p', { style: { margin: '5px 0 0', opacity: 0.72 } },
          '23 个专职角色按 LOW/MEDIUM/HIGH 档位钉死模型；下拉选项与输入框模型选择同源，改完即时生效，无需重启。'),
      ),
      status === 'unavailable'
        ? React.createElement('span', { role: 'status' },
            '设置服务不可用：dsh-agents 尚未连上宿主 settings 服务（请确认插件已随 DSH 加载，档位暂由 cordis 配置生效）。')
        : status === 'loading'
        ? React.createElement('span', null, '正在读取设置…')
        : React.createElement(React.Fragment, null,
            state?.settingsAvailable === false
              ? React.createElement('span', { role: 'status', style: { opacity: 0.8 } },
                  'settings 服务未挂接：当前仅 cordis 配置生效，编辑不可用。')
              : null,
            TIERS.map((tier) => React.createElement(TierEditor, {
              key: tier, tier,
              current: state?.tiers?.[tier] ?? {},
              base: state?.base?.[tier] ?? {},
              source: state?.sources?.[tier] ?? '',
              catalog: state?.catalog ?? {},
              disabled: !writable || state?.settingsAvailable === false,
              onSave: saveTier, onReset: resetTier,
            })),
            React.createElement('div', { style: { ...rowStyle, justifyContent: 'flex-end' } },
              React.createElement('button', { style: btnStyle, disabled: !writable, onClick: resetAll }, '全部重置'),
            ),
            busy ? React.createElement('small', { role: 'status' }, '正在保存…') : null,
            error ? React.createElement('small', { role: 'alert', style: { color: '#c0392b' } }, `保存失败：${error}`) : null,
          ),
    )
  }

  // ───────────────────────────────────────────────────────────────────────
  // advisor 右侧停靠面板（契约见 docs/advisor-contract.md 第 2/3/4 节）。
  // 数据面只认 /plugins/dsh-agents/advisor 一个端点（服务端另一席实现）；
  // 端点缺席（404/网络错）时面板显示可读降级提示，绝不把异常抛进宿主渲染树。
  // ───────────────────────────────────────────────────────────────────────
  const ADVISOR_ENDPOINT = '/plugins/dsh-agents/advisor'
  const ADVISOR_TOP_KEY = 'dsh-agents.advisor.capsuleTop'
  const ADVISOR_TOP_DEFAULT = 42
  const ADVISOR_TOP_MIN = 2
  const ADVISOR_TOP_MAX = 95
  const ADVISOR_PANEL_WIDTH = 380
  const ADVISOR_POLL_MS = 20000
  const SEVERITY_ORDER = ['blocker', 'concern', 'nit', 'info']
  const SEVERITY_META = {
    blocker: { label: '阻断', light: '#c0392b', dark: '#ff8787' },
    concern: { label: '关注', light: '#b06000', dark: '#ffc078' },
    nit: { label: '小疵', light: '#1c6fa8', dark: '#74c0fc' },
    info: { label: '提示', light: '#5c6470', dark: '#adb5bd' },
  }
  const RUNTIME_LABEL = { disabled: '已关闭', idle: '空闲', reviewing: '评审中', error: '异常' }
  const REVIEW_REASON = {
    disabled: '本会话的 advisor 未启用，先在顶部打开开关',
    unset: '本会话未指定评审模型（无任何兜底路由）',
    busy: '上一轮评审还没结束',
    'no-session': '宿主未解析出可评审的会话',
  }
  const OUTCOME_LABEL = { steer: '实时打断', inject: '注入下一回合', recorded: '仅记录', dropped: '未投递' }

  function severityTone(dark, severity) {
    const meta = SEVERITY_META[severity] ?? SEVERITY_META.info
    return dark ? meta.dark : meta.light
  }

  function severityLabel(severity) {
    return (SEVERITY_META[severity] ?? SEVERITY_META.info).label
  }

  /** 记录按严重度排序，blocker 最重 → info 最轻（契约第 4 节）。 */
  function sortRecords(records) {
    const rank = (r) => {
      const i = SEVERITY_ORDER.indexOf(r?.severity)
      return i === -1 ? SEVERITY_ORDER.length : i
    }
    return records.slice().sort((a, b) => {
      const bySeverity = rank(a) - rank(b)
      if (bySeverity !== 0) return bySeverity
      return (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0)
    })
  }

  function readStoredTop() {
    try {
      const raw = window.localStorage.getItem(ADVISOR_TOP_KEY)
      const parsed = Number.parseFloat(raw ?? '')
      if (!Number.isFinite(parsed)) return ADVISOR_TOP_DEFAULT
      return Math.min(ADVISOR_TOP_MAX, Math.max(ADVISOR_TOP_MIN, parsed))
    } catch { return ADVISOR_TOP_DEFAULT }
  }

  function writeStoredTop(top) {
    try {
      window.localStorage.setItem(ADVISOR_TOP_KEY, String(Math.round(top * 10) / 10))
    } catch { /* 隐私模式/配额满：位置本次会话内有效即可 */ }
  }

  function formatTime(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return '—'
    const d = new Date(n)
    const pad = (v) => String(v).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function errorText(e) {
    const message = e?.message ?? String(e)
    return message === 'Failed to fetch' ? '无法连接 DSH 服务（网络中断或端点尚未注册）' : message
  }

  /** advisor 数据面：端点常量 + 三个请求器。组件只通过 inject() 拿到这份面，
   *  请求器不碰 React state —— 状态由 useAdvisorState 统一持有，避免两处真值。
   *
   *  **三个请求器都必须带 sessionId**（契约 §2，U2）：端点不再有「无会话」的
   *  配置落点，缺 sessionId 一律 400；缺会话则 404 / `ok:false`。 */
  function createAdvisorApi() {
    async function request(method, url, body) {
      const init = { method, cache: 'no-store' }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await fetch(url, init)
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const failure = new Error(payload?.error ?? `advisor ${method} failed: ${response.status}`)
        failure.status = response.status
        failure.payload = payload
        throw failure
      }
      return payload
    }
    return {
      endpoint: ADVISOR_ENDPOINT,
      get: (sessionId) => request('GET', `${ADVISOR_ENDPOINT}?sessionId=${encodeURIComponent(sessionId ?? '')}`),
      // sessionId 随 body 下发；provider/model 必须成对（契约第 2 节 PATCH 段）
      patch: (sessionId, body) => request('PATCH', ADVISOR_ENDPOINT, { sessionId, ...(body ?? {}) }),
      review: (sessionId) => request('POST', ADVISOR_ENDPOINT, { action: 'review', sessionId }),
    }
  }

  /** advisor 面板状态：首屏加载 + 手动动作 + 面板打开时的低频轮询。
   *  seq 防陈旧回写；inflight 计数让并发请求下 busy 不被提前清掉。
   *  @param {object} api - createAdvisorApi 产物
   *  @param {string|null} sessionId - 宿主给的本会话 id（面板绑的就是它） */
  function useAdvisorState(api, sessionId) {
    const [status, setStatus] = useState('loading')
    const [state, setState] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const seq = useRef(0)
    const inflight = useRef(0)
    const reloadRef = useRef(null)

    const begin = () => { inflight.current += 1; setBusy(true) }
    const end = () => {
      inflight.current -= 1
      if (inflight.current <= 0) { inflight.current = 0; setBusy(false) }
    }

    const reload = async () => {
      const my = ++seq.current
      try {
        const next = await api.get(sessionId)
        if (seq.current === my) { setState(next); setStatus('ready'); setError('') }
      } catch (e) {
        if (seq.current === my) { setStatus('unavailable'); setError(errorText(e)) }
      }
    }
    reloadRef.current = reload

    useEffect(() => { void reload(); return () => { seq.current += 1 } }, [])
    useEffect(() => {
      const timer = window.setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        void reloadRef.current?.()
      }, ADVISOR_POLL_MS)
      return () => window.clearInterval(timer)
    }, [])

    const patch = async (body) => {
      begin(); setNotice('')
      const my = ++seq.current
      try {
        const next = await api.patch(sessionId, body)
        if (seq.current === my) { setState(next); setStatus('ready'); setError('') }
      } catch (e) {
        if (seq.current === my) setError(errorText(e))
      } finally { end() }
    }

    const review = async (sessionId) => {
      begin(); setNotice('')
      const my = ++seq.current
      try {
        const payload = await api.review(sessionId)
        if (seq.current === my) {
          setStatus('ready')
          setNotice(payload?.ok
            ? (payload.triggered ? '已触发一次评审（结果稍后出现在下方记录）' : `未触发：${REVIEW_REASON[payload.reason] ?? payload.reason ?? '未知原因'}`)
            : `评审请求未受理：${payload?.reason ?? 'unknown'}`)
        }
      } catch (e) {
        if (seq.current === my) setError(errorText(e))
      } finally {
        end()
        void reloadRef.current?.()
      }
    }

    return { status, state, busy, error, notice, reload, patch, review }
  }

  /** advisor 右侧面板本体（宽度固定、贴右、高度受视口约束、内部滚动）。 */
  function AdvisorPanel({ dark, ui, sessionId, onClose }) {
    const { status, state, busy, error, notice, reload, patch, review } = ui
    const [draft, setDraft] = useState(null)

    const currentProvider = state?.provider ?? ''
    const currentModel = state?.model ?? ''
    useEffect(() => {
      if (state == null) return
      setDraft({ provider: state.provider ?? '', model: state.model ?? '' })
    }, [state?.provider, state?.model])

    const enabled = state?.enabled === true
    // U2：开关是**本会话**的开关，且开启必须同时有本会话的模型（服务端
    // assertSessionPairing 会 400）。前端先拦一道，别让用户点了才吃报错。
    const hasModel = currentProvider !== '' && currentModel !== ''
    const runtime = state?.runtime ?? {}
    const runtimeStatus = typeof runtime.status === 'string' ? runtime.status : 'disabled'
    const catalog = (state?.catalog && typeof state.catalog === 'object') ? state.catalog : {}
    const providerOptions = Object.keys(catalog).sort()
    const modelOptions = Array.isArray(catalog[draft?.provider]) ? catalog[draft.provider] : []
    const dirty = draft != null && (draft.provider !== currentProvider || draft.model !== currentModel)
    const records = sortRecords(Array.isArray(state?.records) ? state.records : [])
    const actionable = records.filter((r) => r?.severity === 'blocker' || r?.severity === 'concern').length

    const bg = dark ? '#1f1f24' : '#ffffff'
    const fg = dark ? '#e8e8ea' : '#1a1a1a'
    const muted = dark ? '#9a9aa2' : '#5c6470'
    const line = dark ? '#3a3a42' : '#dcdce0'
    const field = dark ? '#26262c' : '#f6f6f8'

    const panelStyle = {
      position: 'fixed', top: 10, right: 10, bottom: 10, width: ADVISOR_PANEL_WIDTH,
      maxWidth: 'calc(100vw - 20px)', zIndex: 2147482999,
      display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
      boxSizing: 'border-box', overflow: 'hidden',
      borderRadius: 12, border: `1px solid ${line}`, background: bg, color: fg,
      boxShadow: '0 12px 36px rgba(0,0,0,0.28)',
      colorScheme: dark ? 'dark' : 'light',
    }
    const sectionStyle = {
      display: 'grid', gap: 8, padding: '9px 10px',
      border: `1px solid ${line}`, borderRadius: 8, background: field,
    }
    const chipStyle = (color) => ({
      fontSize: 11, padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap',
      color, border: `1px solid ${color}`, fontWeight: 600,
    })

    const degraded = (
      React.createElement('div', { style: { ...sectionStyle, gap: 6 } },
        React.createElement('strong', { style: { fontSize: 13 } }, 'advisor 服务未就绪'),
        React.createElement('span', { style: { fontSize: 12, color: muted, lineHeight: 1.5 } },
          '读不到 ',
          React.createElement('code', null, ADVISOR_ENDPOINT),
          error ? `（${error}）` : '。',
          '面板其余功能需服务端端点注册后可用；宿主页不受影响。'),
        React.createElement('div', null,
          React.createElement('button', { style: btnStyle, disabled: busy, onClick: () => void reload() }, '重试连接'),
        ),
      )
    )

    const statusBar = (
      React.createElement('div', { style: sectionStyle },
        React.createElement('div', { style: rowStyle },
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: status === 'ready' && hasModel ? 'pointer' : 'not-allowed' } },
            React.createElement('input', {
              type: 'checkbox', checked: enabled, disabled: status !== 'ready' || busy || !hasModel,
              title: hasModel ? '仅对本会话生效' : '请先在下方为本会话选择评审模型（开启必须同时指定模型）',
              onChange: (e) => void patch({ enabled: e.target.checked }),
            }),
            React.createElement('span', { style: { fontWeight: 600 } }, '为本会话启用'),
          ),
          React.createElement('span', { style: { ...chipStyle(runtimeStatus === 'error' ? severityTone(dark, 'blocker') : runtimeStatus === 'reviewing' ? severityTone(dark, 'concern') : muted) } },
            `运行：${RUNTIME_LABEL[runtimeStatus] ?? runtimeStatus}`),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          React.createElement('button', {
            style: { ...btnStyle, opacity: status === 'ready' && !busy && sessionId ? 1 : 0.55 },
            disabled: status !== 'ready' || busy || !sessionId,
            title: sessionId ? `评审当前会话 ${sessionId}` : '宿主未提供 sessionId',
            onClick: () => void review(sessionId),
          }, '立即评审一次'),
          React.createElement('button', { style: btnStyle, disabled: busy, onClick: () => void reload() }, '刷新'),
          runtime.queue ? React.createElement('small', { style: { color: muted } }, `队列 ${runtime.queue}`) : null,
          runtime.lastAt ? React.createElement('small', { style: { color: muted } }, `上次 ${formatTime(runtime.lastAt)}`) : null,
        ),
        status === 'loading' ? React.createElement('small', { role: 'status', style: { color: muted } }, '正在读取 advisor 状态…') : null,
        notice ? React.createElement('small', { role: 'status', style: { color: muted } }, notice) : null,
        error && status !== 'unavailable'
          ? React.createElement('small', { role: 'alert', style: { color: severityTone(dark, 'blocker') } }, `操作失败：${error}`)
          : null,
        runtime.status === 'error' && runtime.error
          ? React.createElement('small', { role: 'alert', style: { color: severityTone(dark, 'concern') } }, `运行异常：${runtime.error}`)
          : null,
      )
    )

    const modelSection = (
      React.createElement('div', { style: sectionStyle },
        React.createElement('div', { style: { ...rowStyle, justifyContent: 'flex-start' } },
          React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, '评审模型'),
          React.createElement('span', { style: { ...chipStyle(dark ? '#74c0fc' : '#1c6fa8') } },
            `来源：${state?.modelSource === 'session' ? '本会话手动指定' : '未指定（该会话不评审）'}`),
          state?.modelSource === 'unset'
            ? React.createElement('span', { style: { fontSize: 12, color: muted } }, '评审模型无任何兜底路由：先在下方选定 provider 与 model 才能开启本会话的 advisor')
            : null,
        ),
        React.createElement(Field, { label: 'provider', hint: providerOptions.length ? 'provider 路由 id（与输入框模型选择同源）' : '（模型目录不可读）provider 路由 id' },
          React.createElement(Picker, {
            value: draft?.provider ?? '', options: providerOptions, disabled: status !== 'ready' || busy,
            onChange: (next) => setDraft((d) => ({
              provider: next,
              model: (Array.isArray(catalog[next]) ? catalog[next] : []).includes(d?.model)
                ? d.model : ((Array.isArray(catalog[next]) ? catalog[next] : [])[0] ?? ''),
            })),
          })),
        React.createElement(Field, { label: 'model', hint: modelOptions.length ? `该 provider 下的模型（目录 ${modelOptions.length} 个）` : '（当前 provider 无目录，手填）' },
          React.createElement(Picker, {
            value: draft?.model ?? '', options: modelOptions, disabled: status !== 'ready' || busy,
            onChange: (next) => setDraft((d) => ({ provider: d?.provider ?? '', model: next })),
          })),
        React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' } },
          React.createElement('small', { style: { color: muted } },
            currentProvider ? `生效中：${currentProvider} / ${currentModel || '—'}` : '生效中：—（服务端未解析出模型）'),
          React.createElement('button', {
            style: { ...btnStyle, opacity: dirty && status === 'ready' && !busy ? 1 : 0.55 },
            disabled: !dirty || status !== 'ready' || busy,
            onClick: () => void patch({ provider: draft.provider, model: draft.model }),
          }, '保存模型'),
        ),
      )
    )

    const recordList = records.length === 0
      ? React.createElement('div', { style: { ...sectionStyle, textAlign: 'center', color: muted, fontSize: 12, padding: '18px 10px' } },
          status === 'ready' ? '暂无评审记录：启用后每次评审产出的意见会按严重度排在这里。' : '记录将在连接成功后显示。')
      : React.createElement('div', { style: { display: 'grid', gap: 8, overflowY: 'auto', flex: '1 1 auto', minHeight: 0, paddingRight: 2 } },
          records.map((record) => React.createElement('div', {
            key: record?.id ?? `${record?.createdAt}-${record?.text}`,
            style: {
              display: 'grid', gap: 5, padding: '8px 10px', borderRadius: 8,
              border: '1px solid ' + line, borderLeft: '3px solid ' + severityTone(dark, record?.severity),
              background: field,
            },
          },
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              React.createElement('span', { style: chipStyle(severityTone(dark, record?.severity)) }, severityLabel(record?.severity)),
              React.createElement('small', { style: { color: muted } }, formatTime(record?.createdAt)),
              record?.outcome
                ? React.createElement('small', { style: { color: muted } }, `投递：${OUTCOME_LABEL[record.outcome] ?? record.outcome}`)
                : null,
            ),
            React.createElement('div', { style: { fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              record?.text ?? '（空意见）'),
            record?.sessionName
              ? React.createElement('small', { style: { color: muted } }, `会话：${record.sessionName}`)
              : null,
          )))

    return React.createElement('div', { style: panelStyle, 'data-testid': 'dsh-agents-advisor-panel' },
      React.createElement('div', { style: { ...rowStyle, flexWrap: 'wrap', gap: 8 } },
        React.createElement('strong', { style: { fontSize: 14 } }, 'Advisor 顾问'),
        React.createElement('span', { style: { ...chipStyle(muted), fontWeight: 400 } }, `记录 ${records.length}`),
        actionable ? React.createElement('span', { style: chipStyle(severityTone(dark, 'blocker')) }, `需处理 ${actionable}`) : null,
        React.createElement('button', {
          style: { ...btnStyle, marginLeft: 'auto', padding: '2px 10px' },
          onClick: onClose, title: '收起面板（也可点右侧胶囊重新打开）',
        }, '收起'),
      ),
      status === 'unavailable' ? degraded : null,
      status === 'unavailable' ? null : statusBar,
      status === 'unavailable' ? null : modelSection,
      status === 'unavailable' ? null : recordList,
    )
  }

  /** 贴右边缘的胶囊：纵向可拖，纵向位置按视口百分比持久化到 localStorage。 */
  function AdvisorCapsule({ dark, top, topRef, open, pending, onToggle, applyTop, persistTop }) {
    const drag = useRef({ active: false, moved: false, startY: 0, startTop: 0 })

    const onPointerDown = (e) => {
      if (typeof e.button === 'number' && e.button !== 0) return
      drag.current = { active: true, moved: false, startY: e.clientY, startTop: topRef.current }
      try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* 无捕获能力时退回普通事件流 */ }
    }
    const onPointerMove = (e) => {
      if (!drag.current.active) return
      const deltaY = e.clientY - drag.current.startY
      if (!drag.current.moved && Math.abs(deltaY) < 4) return
      drag.current.moved = true
      const viewport = Math.max(1, window.innerHeight || 1)
      applyTop(((drag.current.startTop * viewport) + deltaY) / viewport * 100)
    }
    const finishDrag = (e) => {
      if (!drag.current.active) return
      drag.current.active = false
      try { e.currentTarget?.releasePointerCapture?.(e.pointerId) } catch { /* 同上 */ }
      if (drag.current.moved) persistTop(topRef.current)
    }
    const onClick = () => {
      // 刚拖过就不当成点击：否则每次拖动都会顺带开合一次面板
      if (drag.current.moved) { drag.current.moved = false; return }
      onToggle()
    }
    const onKeyDown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onToggle()
    }

    const bg = dark ? (open ? '#2f2f38' : '#26262c') : (open ? '#eef1f7' : '#f6f6f8')
    const fg = dark ? '#e8e8ea' : '#1a1a1a'
    const line = dark ? '#3a3a42' : '#dcdce0'

    return React.createElement('div', {
      role: 'button', tabIndex: 0,
      title: 'Advisor 顾问面板：点击开合，拖动可上下移动',
      'aria-expanded': open,
      'data-testid': 'dsh-agents-advisor-capsule',
      onPointerDown, onPointerMove, onPointerUp: finishDrag, onPointerCancel: finishDrag,
      onClick, onKeyDown,
      style: {
        position: 'fixed', right: 0, top: `${top}%`, transform: 'translateY(-50%)',
        zIndex: 2147483000, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '16px 6px', borderRadius: '10px 0 0 10px',
        border: `1px solid ${line}`, borderRight: 'none',
        background: bg, color: fg,
        fontSize: 12, letterSpacing: 1, lineHeight: 1,
        writingMode: 'vertical-rl', cursor: 'grab', touchAction: 'none',
        userSelect: 'none', boxShadow: open ? '0 4px 16px rgba(0,0,0,0.3)' : '0 2px 10px rgba(0,0,0,0.18)',
      },
    },
      React.createElement('span', null, 'ADVISOR'),
      pending > 0
        ? React.createElement('span', {
            style: {
              fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
              background: severityTone(dark, 'blocker'), color: dark ? '#1f1f24' : '#ffffff',
            },
          }, String(pending))
        : null,
    )
  }

  /** 挂到 document.body 的 portal：面板脱离会话子树的 containing block。 */
  let reactDom = null
  function renderPortal(children) {
    if (reactDom === null) {
      try { reactDom = require('react-dom') ?? false } catch { reactDom = false }
    }
    const createPortal = reactDom?.createPortal
    if (typeof createPortal !== 'function' || typeof document === 'undefined' || !document.body) {
      // react-dom 缺席时的降级：面板自身已是 position:fixed，这里只补一层不吃指针的壳
      return React.createElement('div', { style: { position: 'fixed', inset: 0, pointerEvents: 'none' } }, children)
    }
    return createPortal(children, document.body)
  }

  /** slot 注册的组件：拿 props.sessionId（session 作用域标准件）+ inject() 的数据面。 */
  function AdvisorDock({ sessionId, advisor }) {
    const dark = isDarkTheme()
    const [open, setOpen] = useState(false)
    const [top, setTop] = useState(readStoredTop)
    const topRef = useRef(top)
    topRef.current = top
    // 面板绑定的是**本会话**：先定下 sessionId 再建 hook，状态层才能把它
    // 注入到 GET / PATCH（端点已强制要求 sessionId，缺了就是 400）。
    const boundSessionId = typeof sessionId === 'string' && sessionId
      ? sessionId
      : (typeof advisor?.boundSessionId === 'string' ? advisor.boundSessionId : null)
    const ui = useAdvisorState(advisor, boundSessionId)
    const records = Array.isArray(ui.state?.records) ? ui.state.records : []
    const pending = records.filter((r) => r?.severity === 'blocker' || r?.severity === 'concern').length

    const applyTop = (next) => {
      const clamped = Math.min(ADVISOR_TOP_MAX, Math.max(ADVISOR_TOP_MIN, next))
      topRef.current = clamped
      setTop(clamped)
    }
    const persistTop = (next) => writeStoredTop(next)

    useEffect(() => {
      if (!open) return undefined
      const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [open])

    if (!advisor || typeof advisor.get !== 'function') {
      return React.createElement('span', { role: 'status', style: { fontSize: 12, opacity: 0.7 } }, 'advisor 数据面未注入')
    }

    return React.createElement(React.Fragment, null,
      React.createElement(AdvisorCapsule, {
        dark, top, topRef, open, pending,
        onToggle: () => setOpen((v) => !v),
        applyTop, persistTop,
      }),
      open
        ? renderPortal(React.createElement(AdvisorPanel, {
            dark, ui, sessionId: boundSessionId, onClose: () => setOpen(false),
          }))
        : null,
    )
  }

  function apply(ctx) {
    // The card is decorative to the rest of the plugin: if the slot contract
    // ever changes, fail this card quietly instead of failing the whole
    // WebUI load (same guard discipline as the dafeiyu reference; the guard
    // must live INSIDE the inject callback because DSH may invoke it
    // asynchronously).
    const registerCard = () => {
      try {
        // 宿主 0.1.7 起设置页的插件区槽位是 settings.plugins.tab（旧
        // settings.plugin.item 已不存在）：每个注册项 = 「插件」页里的一行 tab，
        // id 用于把该行与本卡片对应，label 供行标题使用（2026-09-28 实证）。
        ctx.slots.register({
          name: 'settings.plugins.tab', id: 'dsh-agents', order: 50,
          label: () => 'Agents 三档模型路由',
          inject: () => ({}),
        }, AgentsCard)
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-agents] failed to register settings card:', error)
        }
      }
    }
    try {
      ctx.slots.inject('settings.plugins.tab', registerCard)
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-agents] failed to inject settings slot:', error)
      }
    }

    // advisor 面板：挂在会话头部动作区（宿主 dsh-client-ui-conversation 以
    // renderSlot("conversation.session.header.actions", {}) 渲染该 list 槽位）。
    // 注册范式照 jobs/lib/client.js:610；该槽位 scope='session'，宿主既把
    // sessionId 放进标准 props、也作为 inject() 的第一个位置参数传入，这里两条都收。
    const advisorApi = createAdvisorApi()
    const registerAdvisor = () => {
      try {
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-agents-advisor',
          order: 80,
          inject: (boundSessionId) => ({
            advisor: { ...advisorApi, boundSessionId: typeof boundSessionId === 'string' ? boundSessionId : null },
          }),
        }, AdvisorDock)
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-agents] failed to register advisor slot:', error)
        }
      }
    }
    try {
      ctx.slots.inject('conversation.session.header.actions', registerAdvisor)
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-agents] failed to inject advisor slot:', error)
      }
    }
  }

  module.exports = {
    name: 'dsh-agents-client',
    inject: ['slots'],
    apply,
  }
  return module.exports
} })
