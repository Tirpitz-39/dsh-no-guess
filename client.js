/* global window, fetch */
/**
 * 不猜 / dsh-no-guess — 浏览器半侧。
 *
 * 1) conversation.input.left：输入框旁的「不猜」开关（全局）
 * 2) settings.section：完整设置（开关 / 超时 / 每轮最多拦几次）
 *
 * Host 半负责拦截；这里只负责把开关摆出来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-no-guess',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-no-guess'

    const tokens = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      secondary: 'var(--dsw-alias-label-secondary, currentColor)',
      caption: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, currentColor))',
      border: 'var(--dsw-alias-border-l2, var(--dsw-alias-border-l3, rgba(127,127,127,.35)))',
      borderStrong: 'var(--dsw-alias-border-l3, rgba(127,127,127,.45))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
      cardFill: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-interactive-bg-secondary, transparent))',
      cardStroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1, transparent))',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      success: 'var(--dsw-alias-state-success-primary, #2ea043)',
      radiusMd: 'var(--dsw-radius-md, 8px)',
      radiusLg: 'var(--dsw-radius-xl, 12px)',
    }

    const styles = {
      page: { maxWidth: 720, color: tokens.text, display: 'flex', flexDirection: 'column', gap: 12 },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
      intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: tokens.caption },
      card: {
        border: '0.5px solid ' + tokens.cardStroke,
        background: tokens.cardFill,
        borderRadius: tokens.radiusLg,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      row: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flexWrap: 'wrap' },
      rowText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 160px' },
      label: { fontSize: 14, lineHeight: '22px', fontWeight: 400 },
      hint: { fontSize: 12, lineHeight: '18px', color: tokens.caption },
      input: {
        boxSizing: 'border-box',
        height: 30,
        padding: '0 8px',
        borderRadius: tokens.radiusMd,
        border: '0.5px solid ' + tokens.border,
        background: 'transparent',
        color: tokens.text,
        font: 'inherit',
        fontSize: 13,
        width: 90,
      },
    }

    function knobStyle(on) {
      return {
        position: 'absolute',
        top: 3,
        left: on ? 21 : 3,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#ffffff',
        transition: 'left .12s ease',
        boxShadow: '0 1px 2px rgba(0,0,0,.35)',
      }
    }
    function switchStyle(on) {
      return {
        position: 'relative',
        width: 40,
        height: 22,
        padding: 0,
        border: 'none',
        borderRadius: 11,
        cursor: 'pointer',
        background: on ? tokens.accent : tokens.borderStrong,
        transition: 'background .12s ease',
        flexShrink: 0,
      }
    }
    function Toggle({ checked, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          onClick: () => onChange(!checked),
          style: switchStyle(checked),
        },
        h('span', { style: knobStyle(checked) }),
      )
    }
    function Row({ label, hint, children }) {
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowText },
          h('div', { style: styles.label }, label),
          hint ? h('div', { style: styles.hint }, hint) : null,
        ),
        children ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' } }, children) : null,
      )
    }

    // ---- shared config store ----
    // Both slots (composer button + settings page) read the same config; one
    // poller keeps them in sync instead of each component polling on its own.
    let sharedConfig = null
    let pollTimer = null
    const listeners = new Set()

    function notify() {
      for (const fn of listeners) {
        try {
          fn(sharedConfig)
        } catch {}
      }
    }

    function refresh() {
      fetch(API + '/config', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (data && data.config) {
            sharedConfig = data.config
            notify()
          }
        })
        .catch(() => {})
    }

    function ensurePolling() {
      if (pollTimer !== null) return
      refresh()
      pollTimer = setInterval(refresh, 3000)
    }

    function stopPollingIfUnused() {
      if (listeners.size === 0 && pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    function saveConfig(patch) {
      return fetch(API + '/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (data && data.config) {
            sharedConfig = data.config
            notify()
          }
          return data
        })
        .catch(() => null)
    }

    function useConfig() {
      const [config, setConfig] = React.useState(sharedConfig)
      React.useEffect(() => {
        const apply = (next) => setConfig(next)
        listeners.add(apply)
        if (sharedConfig) setConfig(sharedConfig)
        ensurePolling()
        return () => {
          listeners.delete(apply)
          stopPollingIfUnused()
        }
      }, [])
      return [config || sharedConfig]
    }

    // Numeric field: keeps a local draft while typing and commits on blur/Enter,
    // so every keystroke does not hit the config endpoint.
    function NumberField({ value, onCommit, min, max }) {
      const editing = React.useRef(false)
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => {
        if (!editing.current) setDraft(String(value))
      }, [value])
      const commit = () => {
        editing.current = false
        const n = Number(draft)
        if (Number.isFinite(n) && n !== Number(value)) onCommit(n)
        else setDraft(String(value))
      }
      return h('input', {
        type: 'number',
        min,
        max,
        value: draft,
        style: styles.input,
        onFocus: () => {
          editing.current = true
        },
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        },
      })
    }

    // ---- 输入框旁的开关 ----

    function Quick() {
      const [config] = useConfig()
      const enabled = !config || config.enabled !== false
      const toggle = () => {
        saveConfig({ enabled: !enabled })
      }
      return h(
        'button',
        {
          type: 'button',
          title: '不猜：话说不清楚时不瞎猜，先问你',
          onClick: toggle,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            borderRadius: tokens.radiusMd,
            border: '0.5px solid ' + (enabled ? tokens.borderStrong : 'transparent'),
            background: 'transparent',
            color: enabled ? tokens.text : tokens.caption,
            font: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        h('span', {
          style: {
            width: 7,
            height: 7,
            borderRadius: '50%',
            display: 'inline-block',
            background: enabled ? tokens.accent : tokens.borderStrong,
          },
        }),
        h('span', null, '不猜'),
        h('span', { style: { color: tokens.caption, fontSize: 11 } }, enabled ? '开' : '关'),
      )
    }

    // ---- 设置页 ----

    function SettingsPage() {
      const [config] = useConfig()
      const [status, setStatus] = React.useState('')
      const cfg = config || {}
      const enabled = cfg.enabled !== false
      const save = (patch) => {
        setStatus('保存中…')
        saveConfig(patch).then((data) => {
          setStatus(data ? '已保存' : '保存失败')
          setTimeout(() => setStatus(''), 1500)
        })
      }
      return h(
        'div',
        { style: styles.page },
        h('h2', { style: styles.title }, '不猜'),
        h(
          'p',
          { style: styles.intro },
          '你那句话说不清楚时，模型不许猜着做：先被拦下来，用提问工具问清「要干什么 + 要怎么干」（目标/交付物/范围、方式/约束/验收），问完停住等回答。' +
            '纯规则判断，零模型调用。被拦一次后如果 10 分钟没回，会按最小假设继续并在回答里写明假设。',
        ),
        h(
          'div',
          { style: styles.card },
          h(Row, {
            label: '启用「不猜」',
            hint: '关闭后完全不拦，和原生行为一致。',
            children: h(Toggle, { checked: enabled, onChange: (next) => save({ enabled: next }) }),
          }),
          h(Row, {
            label: '没回复多久后按最小假设继续',
            hint: '单位分钟，1–120。默认 10。',
            children: h(NumberField, {
              value: cfg.timeoutMinutes ?? 10,
              min: 1,
              max: 120,
              onCommit: (n) => save({ timeoutMinutes: n }),
            }),
          }),
          h(Row, {
            label: '每轮最多拦几次',
            hint: '默认 2。拦满后放行，宁少拦不卡死。',
            children: h(NumberField, {
              value: cfg.maxBlocksPerTurn ?? 2,
              min: 1,
              max: 10,
              onCommit: (n) => save({ maxBlocksPerTurn: n }),
            }),
          }),
          h(Row, {
            label: '主触发：思考链',
            hint: '默认开。模型思考里出现「我猜用户 / 不确定用户 / 不知道用户要」这类话时拦下——不管你那句话字面清不清楚。',
            children: h(Toggle, { checked: cfg.thinkingGate !== false, onChange: (next) => save({ thinkingGate: next }) }),
          }),
          h(Row, {
            label: '兜底：字面规则（默认关）',
            hint: '开了以后：短消息 + 指代/疑问 + 无动作词也拦。误伤较多，建议只在需要时开。',
            children: h(Toggle, { checked: cfg.ruleGate === true, onChange: (next) => save({ ruleGate: next }) }),
          }),
          h(Row, {
            label: '多短算「说不清」',
            hint: '消息字数上限，默认 40。',
            children: h(NumberField, {
              value: cfg.vagueMaxLength ?? 40,
              min: 10,
              max: 200,
              onCommit: (n) => save({ vagueMaxLength: n }),
            }),
          }),
          h(Row, {
            label: '模型判断（未完善，花钱）',
            hint: '默认关。开了以后：规则没判出「说不清」时，再调一次模型判断需求是否缺信息或自相矛盾。注意：判断器只看单条消息、没有对话上下文，会偏严（实测把「测一下吧」判成缺信息）；每次判断花少量 token。思考链已经够准，这个当备用。',
            children: h(Toggle, { checked: cfg.modelGate === true, onChange: (next) => save({ modelGate: next }) }),
          }),
          h(Row, {
            label: '日志记录对话内容（默认关）',
            hint: '默认 ask-first.log 只记 sid / turn / 工具名，不写你说的话，也不写模型思考片段。开了方便排查误拦，但日志里会含对话内容。',
            children: h(Toggle, { checked: cfg.logUserText === true, onChange: (next) => save({ logUserText: next }) }),
          }),
        ),
        h(
          'p',
          { style: styles.hint },
          '判断规则：短消息 + 含「这个/那个/各个/哪些/刚才…」这类指代或疑问，且没有动作动词 → 视为说不清。' +
            '「继续 / 好 / 1」这类回执不拦。子代理、定时任务、无人应答的会话一律放行。',
        ),
        status ? h('p', { style: styles.hint }, status) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'dsh-no-guess-quick', order: 14, inject: () => ({}) },
            Quick,
          ),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-no-guess', order: 62, label: () => '不猜', inject: () => ({}) },
            SettingsPage,
          ),
        )
      },
    }
  },
})
