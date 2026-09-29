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
  }

  module.exports = {
    name: 'dsh-agents-client',
    inject: ['slots'],
    apply,
  }
  return module.exports
} })
