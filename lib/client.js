/**
 * dsh-memory-core —— 客户端面板（Web UI 半边）。
 *
 * 交付形态与 DSH 约定一致（**无需构建**：手写 CJS 信封 + `require` 白名单模块）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * **样式与交互都沿用 dsh-memory-evolve 的记忆 Tab**：同一套 `--dsw-alias-*` 设计令牌与
 * 同样的信息架构 ——
 *   子 Tab 行（功能：待确认 / 提示词 ‖ 文件页签：五轨）
 *   → ⚠️ 结构化提示行 + 当前项目工作目录行
 *   → 工具栏（美观视图 / 纯文本视图 + 搜索框 + 计数分页）
 *   → 条目卡片（时间徽标 + 轨道/分支标签 + 正文 + 操作：编辑 / 置顶 / 归档）
 * 面板在会话 Tab 内 `max-height: 62vh` 内部滚动，深浅色主题自动跟随。
 *
 * 数据面走宿主路由 `/memory-core/api/*`；项目轨的作用域由宿主按 sessionId / cwd 反查。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-core',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/memory-core/api'
    const TRACKS = ['user', 'memory', 'key', 'project', 'daily']
    const POLL_MS = 30000
    const PAGE_SIZE = 40
    const STYLE_ID = 'dsh-memory-core-styles'

    /** 文件页签：五轨（项目轨的作用域由宿主按会话解析）。 */
    const FILE_TABS = [
      { key: 'memory', title: '长期记忆', track: 'memory' },
      { key: 'user', title: '用户档案', track: 'user' },
      { key: 'key', title: '项目关键记忆', track: 'key' },
      { key: 'project', title: '项目日志', track: 'project' },
      { key: 'daily', title: '每日日志', track: 'daily' },
      { key: 'archived-user', title: '归档用户', track: 'user', status: 'archived' },
      { key: 'archived-memory', title: '归档记忆', track: 'memory', status: 'archived' },
      { key: 'rules', title: '全局规则', kind: 'rules' },
    ]

    const CSS = `
.memcore-panel { height: 100%; max-height: 62vh; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; overflow: hidden; padding: 10px 20px 14px; font-family: var(--dsw-font-family, inherit); color: var(--dsw-alias-label-primary); }
.memcore-notice { padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
.memcore-notice-ok { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); }
.memcore-notice-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border: 1px solid var(--dsw-alias-state-error-secondary); }
.memcore-file-tabs { flex: none; position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-base, transparent); display: flex; align-items: center; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 2px; margin-bottom: 6px; }
.memcore-file-tab { appearance: none; height: 32px; padding: 0 12px; border: none; border-radius: 6px 6px 0 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; display: inline-flex; align-items: center; gap: 6px; }
.memcore-file-tab:hover:not(.memcore-file-tab-active) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.memcore-file-tab-active, .memcore-file-tab-active:hover { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
.memcore-feature-count { min-width: 16px; padding: 0 5px; border-radius: 8px; background: var(--dsw-alias-state-error-primary); color: #fff; font-size: 10px; line-height: 16px; font-weight: 600; text-align: center; }
.memcore-tab-sep { width: 1px; height: 18px; margin: 0 6px; background: var(--dsw-alias-border-l3); flex: none; }
.memcore-warning { margin: 0 0 2px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }
.memcore-cwd { margin: 0 0 4px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.memcore-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 2px; }
.memcore-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; overflow: hidden; }
.memcore-seg button { appearance: none; height: 26px; padding: 0 10px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.memcore-seg button + button { border-left: 1px solid var(--dsw-alias-border-l3); }
.memcore-seg button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.memcore-seg button.memcore-seg-active { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
.memcore-search { flex: 1 1 220px; min-width: 160px; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.memcore-count { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.memcore-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.memcore-entries { display: flex; flex-direction: column; gap: 8px; }
.memcore-entry { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.memcore-entry-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.memcore-entry-text { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.memcore-entry-ops { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.memcore-badge { flex: none; padding: 1px 8px; border-radius: 9px; font-size: 10px; line-height: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.memcore-badge-user { color: var(--dsw-static-purple-5, #8b5cf6); background: color-mix(in srgb, var(--dsw-static-purple-5, #8b5cf6) 16%, transparent); }
.memcore-badge-memory { color: var(--dsw-static-blue-5, #3b82f6); background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 16%, transparent); }
.memcore-badge-key { color: var(--dsw-static-green-5, #10b981); background: color-mix(in srgb, var(--dsw-static-green-5, #10b981) 16%, transparent); }
.memcore-badge-project { color: var(--dsw-static-amber-5, #f59e0b); background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 16%, transparent); }
.memcore-badge-daily { color: var(--dsw-static-neutral-5, #6b7280); background: color-mix(in srgb, var(--dsw-static-neutral-5, #6b7280) 16%, transparent); }
.memcore-badge-ro { border: 1px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-tertiary); }
.memcore-badge-pin { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary); }
.memcore-btn { display: inline-flex; align-items: center; justify-content: center; height: 26px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
.memcore-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.memcore-btn:disabled { opacity: 0.5; cursor: default; }
.memcore-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); font-weight: 600; }
.memcore-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.memcore-btn-danger { color: var(--dsw-alias-state-error-primary); }
.memcore-btn-danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.memcore-btn-ghost { color: var(--dsw-alias-label-secondary); }
.memcore-select { height: 26px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.memcore-edit { display: flex; flex-direction: column; gap: 6px; }
.memcore-edit textarea { width: 100%; min-height: 84px; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 1.6; resize: vertical; }
.memcore-edit-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.memcore-pre { margin: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-mono, ui-monospace, Menlo, monospace); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 46vh; overflow-y: auto; }
.memcore-empty, .memcore-muted { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    async function api(path, options) {
      const opts = options || {}
      const res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'content-type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch (e) {
        return { ok: false, message: text.slice(0, 200) }
      }
    }

    const trackClass = (track) => (TRACKS.indexOf(track) >= 0 ? 'memcore-badge-' + track : '')
    const Badge = (props) => h('span', { className: ['memcore-badge', trackClass(props.track), props.cls || ''].filter(Boolean).join(' ') }, props.children)
    const Btn = (props) => {
      const rest = Object.assign({}, props)
      delete rest.kind
      return h('button', Object.assign({ type: 'button', className: ['memcore-btn', props.kind ? 'memcore-btn-' + props.kind : ''].filter(Boolean).join(' ') }, rest))
    }
    const stamp = (ms) => {
      if (!ms) return ''
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function MemoryView(props) {
      const tab = props.tab
      const sessionId = props.sessionId
      const st = React.useState
      const [entries, setEntries] = st(null)
      const [mode, setMode] = st('pretty')
      const [query, setQuery] = st('')
      const [page, setPage] = st(0)
      const [editing, setEditing] = st(null)
      const [draft, setDraft] = st('')

      const [err, setErr] = st(null)
      const load = React.useCallback(async () => {
        const params = new URLSearchParams({ track: tab.track, limit: '200', full: '1' })
        if (tab.status) params.set('status', tab.status)
        if (sessionId) params.set('sessionId', sessionId)
        try {
          const res = await api('/memory?' + params.toString())
          if (res && res.ok === false) throw new Error(res.message || '接口返回失败')
          setErr(null)
          setEntries(res.entries || [])
          if (res.projectCwd) props.onCwd(res.projectCwd)
        } catch (e) {
          setErr('加载失败：' + (e && e.message ? e.message : String(e)) + '（宿主路由 /memory-core/api 是否可达？）')
          setEntries([])
        }
      }, [tab.track, tab.status, sessionId])

      React.useEffect(() => {
        setEntries(null)
        setMode('pretty')
        setQuery('')
        setPage(0)
        setEditing(null)
        void load()
      }, [load])

      const act = async (fn, okText) => {
        props.setBusy(true)
        try {
          const res = await fn()
          props.onNotice(res && res.ok === false ? { kind: 'error', text: '失败：' + (res.message || '未知错误') } : { kind: 'ok', text: okText })
          await load()
        } catch (e) {
          props.onNotice({ kind: 'error', text: '失败：' + e.message })
        } finally {
          props.setBusy(false)
        }
      }

      const q = query.trim()
      const filtered = entries === null ? null : q ? entries.filter((e) => ((e.content || e.snippet) + ' ' + (e.kind || '') + ' ' + (e.gitBranch || '') + ' ' + (e.day || '')).indexOf(q) >= 0) : entries
      const pageCount = filtered === null ? 1 : Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
      const safePage = Math.min(page, pageCount - 1)
      const pageEntries = filtered === null ? null : filtered.slice().reverse().slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

      const toolbar = h('div', { className: 'memcore-toolbar' },
        h('div', { className: 'memcore-seg', role: 'group' },
          h('button', { type: 'button', className: mode === 'pretty' ? 'memcore-seg-active' : '', onClick: () => setMode('pretty') }, '美观视图'),
          h('button', { type: 'button', className: mode === 'raw' ? 'memcore-seg-active' : '', onClick: () => setMode('raw') }, '纯文本视图')),
        h('input', { className: 'memcore-search', placeholder: '搜索内容、时间或标签…', value: query, onChange: (e) => { setQuery(e.target.value); setPage(0) } }),
        h('span', { className: 'memcore-count' }, filtered === null ? '加载中…' : filtered.length + ' 条 · 第 ' + (safePage + 1) + '/' + pageCount + ' 页'))

      if (err) return h('div', { className: 'memcore-entries' }, toolbar, h('div', { className: 'memcore-notice memcore-notice-error' }, err),
        h(Btn, { onClick: () => { setEntries(null); setErr(null); void load() } }, '重试'))
      if (filtered === null) return h('div', { className: 'memcore-entries' }, toolbar, h('div', { className: 'memcore-muted' }, '加载中…'))
      if (filtered.length === 0) {
        const emptyText = tab.status === 'archived'
          ? '该归档轨为空。手动归档或演化衰减下来的条目会落在这里，卡片上可点「恢复」放回正向轨。'
          : '该轨道暂无条目。'
        return h('div', { className: 'memcore-entries' }, toolbar, h('div', { className: 'memcore-empty' }, emptyText))
      }

      const body = mode === 'raw'
        ? h('pre', { className: 'memcore-pre' }, pageEntries.map((e) => stamp(e.createdAt) + ' [id: ' + e.id + ']' + (e.gitBranch ? ' [git ' + e.gitBranch + ']' : '') + '\n' + (e.content || e.snippet)).join('\n\n§\n\n'))
        : pageEntries.map((entry) => h('div', { key: entry.id, className: 'memcore-entry' },
            h('div', { className: 'memcore-entry-head' },
              h(Badge, null, stamp(entry.createdAt)),
              h(Badge, { track: entry.track }, entry.track + '/' + (entry.kind || '-')),
              entry.day ? h(Badge, null, entry.day) : null,
              entry.gitBranch ? h(Badge, null, 'git ' + entry.gitBranch) : null,
              entry.pinned ? h(Badge, { cls: 'memcore-badge-pin' }, '置顶') : null,
              h(Badge, { cls: 'memcore-badge-ro' }, 'v' + entry.version),
              h('span', { className: 'memcore-entry-ops' }, h(Badge, { cls: 'memcore-badge-ro' }, entry.id))),
            editing === entry.id
              ? h('div', { className: 'memcore-edit' },
                  h('textarea', { value: draft, onChange: (e) => setDraft(e.target.value) }),
                  h('div', { className: 'memcore-entry-head' },
                    h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => act(() => api('/memory/update', { method: 'POST', body: { id: entry.id, content: draft } }), '已保存（旧版本已留档）').then(() => setEditing(null)) }, '保存'),
                    h(Btn, { disabled: props.busy, onClick: () => setEditing(null) }, '取消'),
                    h('span', { className: 'memcore-edit-hint' }, '保存后 version+1，旧版本进历史；下一轮注入即生效')))
              : h('div', { className: 'memcore-entry-text' }, entry.content || entry.snippet),
            editing === entry.id ? null : h('div', { className: 'memcore-entry-head' },
              h('span', { className: 'memcore-entry-ops' },
                h(Btn, { disabled: props.busy, onClick: () => { setEditing(entry.id); setDraft(entry.content || entry.snippet) } }, '编辑'),
                h(Btn, { disabled: props.busy, onClick: () => act(() => api('/memory/update', { method: 'POST', body: { id: entry.id, action: entry.pinned ? 'unpin' : 'pin' } }), entry.pinned ? '已取消置顶' : '已置顶') }, entry.pinned ? '取消置顶' : '置顶'),
                entry.status === 'archived'
                  ? h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => act(() => api('/memory/update', { method: 'POST', body: { id: entry.id, action: 'restore' } }), '已恢复（回到正向轨）') }, '恢复')
                  : h(Btn, { kind: 'ghost', disabled: props.busy, onClick: () => act(() => api('/memory/update', { method: 'POST', body: { id: entry.id, action: 'archive' } }), '已归档（可在归档轨找回）') }, '归档')))))

      return h('div', { className: 'memcore-entries' }, toolbar, body,
        pageCount > 1 ? h('div', { className: 'memcore-toolbar' },
          h(Btn, { disabled: safePage <= 0, onClick: () => setPage(safePage - 1) }, '上一页'),
          h(Btn, { disabled: safePage >= pageCount - 1, onClick: () => setPage(safePage + 1) }, '下一页')) : null)
    }

    function QueueView(props) {
      const st = React.useState
      const [items, setItems] = st([])
      const load = async () => setItems((await api('/suggestions?status=pending')).entries || [])
      React.useEffect(() => { void load() }, [])
      const act = async (fn, okText) => {
        props.setBusy(true)
        try {
          const res = await fn()
          props.onNotice(res && res.ok === false ? { kind: 'error', text: '失败：' + (res.message || '未知错误') } : { kind: 'ok', text: okText })
          await load()
          props.onChanged && props.onChanged()
        } catch (e) {
          props.onNotice({ kind: 'error', text: '失败：' + e.message })
        } finally {
          props.setBusy(false)
        }
      }
      if (items.length === 0) return h('div', { className: 'memcore-empty' }, '队列为空。会话结束后会自动提取，产出先进这里；采纳后才会注入上下文。')
      return h('div', { className: 'memcore-entries' }, items.map((item) => h('div', { key: item.id, className: 'memcore-entry' },
        h('div', { className: 'memcore-entry-head' }, h(Badge, { track: item.track }, (item.kind || 'memory') + ' · ' + (item.track || item.target || '-')), h(Badge, { cls: 'memcore-badge-ro' }, item.id)),
        h('div', { className: 'memcore-entry-text' }, item.content || '(无内容)'),
        h('div', { className: 'memcore-entry-head' },
          h('select', { className: 'memcore-select', defaultValue: item.track || 'memory', onChange: (e) => { item.__track = e.target.value } }, TRACKS.map((t) => h('option', { key: t, value: t }, t))),
          h('span', { className: 'memcore-entry-ops' },
            h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => act(() => api('/suggestions/approve', { method: 'POST', body: { id: item.id, overrides: { track: item.__track || item.track } } }), '已采纳') }, '采纳（可改轨）'),
            h(Btn, { disabled: props.busy, onClick: () => act(() => api('/suggestions/reject', { method: 'POST', body: { id: item.id } }), '已拒绝') }, '拒绝'),
            h(Btn, { kind: 'ghost', disabled: props.busy, onClick: () => act(() => api('/suggestions/archive', { method: 'POST', body: { id: item.id } }), '已归档') }, '归档'))))))
    }

    function PromptsView(props) {
      const st = React.useState
      const [prompts, setPrompts] = st([])
      const [active, setActive] = st([])
      const load = async () => {
        setPrompts((await api('/prompts?enabled=1')).entries || [])
        setActive((await api('/prompts/active')).entries || [])
      }
      React.useEffect(() => { void load() }, [])
      const act = async (fn, okText) => {
        props.setBusy(true)
        try {
          const res = await fn()
          props.onNotice(res && res.ok === false ? { kind: 'error', text: '失败：' + (res.message || '未知错误') } : { kind: 'ok', text: okText })
          await load()
          props.onChanged && props.onChanged()
        } catch (e) {
          props.onNotice({ kind: 'error', text: '失败：' + e.message })
        } finally {
          props.setBusy(false)
        }
      }
      const injected = {}
      active.forEach((i) => { if (i.prompt_id) injected[i.prompt_id] = true })
      return h('div', { className: 'memcore-entries' },
        active.length > 0 ? h('div', { className: 'memcore-entry' },
          h('div', { className: 'memcore-entry-head' }, h(Badge, null, '注入中'), h(Badge, { cls: 'memcore-badge-ro' }, active.length + ' 条')),
          active.map((i) => h('div', { key: i.id, className: 'memcore-entry-head' },
            h(Badge, { cls: 'memcore-badge-pin' }, i.title),
            h('span', { className: 'memcore-count' }, (i.rounds_left === null ? '持续' : '剩 ' + i.rounds_left + ' 次') + ' · 每 ' + i.every + ' 回合 · ' + (i.session_id ? '本会话' : '全局'))))) : null,
        prompts.length === 0
          ? h('div', { className: 'memcore-empty' }, '库里没有启用的提示词。')
          : prompts.map((p) => h('div', { key: p.id, className: 'memcore-entry' },
              h('div', { className: 'memcore-entry-head' },
                h('span', { className: 'memcore-entry-text', style: { fontWeight: 600 } }, p.name),
                h(Badge, null, p.category || '-'),
                injected[p.id] ? h(Badge, { cls: 'memcore-badge-pin' }, '注入中') : null,
                h('span', { className: 'memcore-entry-ops' }, h('span', { className: 'memcore-count' }, '用 ' + (p.uses || 0) + ' 次'))),
              p.summary ? h('div', { className: 'memcore-muted' }, p.summary) : null,
              h('div', { className: 'memcore-entry-head' },
                h('span', { className: 'memcore-entry-ops' },
                  h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => act(() => api('/prompts/inject', { method: 'POST', body: { id: p.id, rounds: 1, every: 1 } }), '已注入「' + p.name + '」一次') }, '注入一次'),
                  h(Btn, { disabled: props.busy, onClick: () => act(() => api('/prompts/inject', { method: 'POST', body: { id: p.id, rounds: 0, every: 1 } }), '「' + p.name + '」持续注入中') }, '持续注入'),
                  h(Btn, { kind: 'danger', disabled: props.busy, onClick: () => act(() => api('/prompts/stop', { method: 'POST', body: { id: p.id } }), '已停止注入') }, '停止'))))))
    }

    /** 待办：智能视图（默认只给需要关注的）+ 全部；行内改状态。 */
    function TodosView(props) {
      const st = React.useState
      const [rows, setRows] = st([])
      const [reminder, setReminder] = st(null)
      const [all, setAll] = st(false)
      const load = async () => {
        const q = new URLSearchParams({ all: all ? '1' : '0' })
        if (props.sessionId) q.set('sessionId', props.sessionId)
        if (props.cwd) q.set('cwd', props.cwd)
        const res = await api('/todos?' + q.toString())
        setRows(res.entries || [])
        setReminder(res.reminder || null)
      }
      React.useEffect(() => { void load() }, [all])
      const act = async (fn, okText) => {
        props.setBusy(true)
        try {
          const res = await fn()
          props.onNotice(res && res.ok === false ? { kind: 'error', text: '失败：' + (res.message || '未知错误') } : { kind: 'ok', text: okText })
          await load()
        } catch (e) {
          props.onNotice({ kind: 'error', text: '失败：' + e.message })
        } finally {
          props.setBusy(false)
        }
      }
      const today = new Date().toISOString().slice(0, 10)
      return h('div', { className: 'memcore-entries' },
        h('div', { className: 'memcore-toolbar' },
          h('div', { className: 'memcore-seg', role: 'group' },
            h('button', { type: 'button', className: all ? '' : 'memcore-seg-active', onClick: () => setAll(false) }, '需要关注'),
            h('button', { type: 'button', className: all ? 'memcore-seg-active' : '', onClick: () => setAll(true) }, '全部')),
          h('span', { className: 'memcore-count' }, reminder || (rows.length ? rows.length + ' 条' : '暂无待办'))),
        rows.length === 0
          ? h('div', { className: 'memcore-empty' }, all ? '没有待办。' : '没有需要关注的待办（逾期 / 今日到期 / 本项目 / 重要紧急）。')
          : rows.map((t) => h('div', { key: t.id, className: 'memcore-entry' },
              h('div', { className: 'memcore-entry-head' },
                h(Badge, { track: t.track }, t.track + (t.quadrant ? ' · ' + t.quadrant : '')),
                t.due ? h(Badge, { cls: t.due < today ? 'memcore-badge-pin' : '' }, 'due ' + t.due) : null,
                t.day ? h(Badge, null, t.day) : null,
                t.status !== 'pending' ? h(Badge, { cls: 'memcore-badge-ro' }, t.status) : null,
                h('span', { className: 'memcore-entry-ops' }, h(Badge, { cls: 'memcore-badge-ro' }, t.id))),
              h('div', { className: 'memcore-entry-text' }, t.content),
              h('div', { className: 'memcore-entry-head' },
                h('span', { className: 'memcore-entry-ops' },
                  h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => act(() => api('/todos/update', { method: 'POST', body: { id: t.id, action: 'done' } }), '已完成') }, '完成'),
                  t.status === 'pending' ? h(Btn, { disabled: props.busy, onClick: () => act(() => api('/todos/update', { method: 'POST', body: { id: t.id, status: 'doing' } }), '标记进行中') }, '进行中') : null,
                  h(Btn, { kind: 'danger', disabled: props.busy, onClick: () => act(() => api('/todos/update', { method: 'POST', body: { id: t.id, action: 'remove' } }), '已删除') }, '删除'))))))
    }

    /** 技能：文件是真相，面板只做索引浏览与启停（写官方 frontmatter）。 */
    function SkillsView(props) {
      const st = React.useState
      const [rows, setRows] = st([])
      const [query, setQuery] = st('')
      const load = async () => setRows((await api('/skills')).entries || [])
      React.useEffect(() => { void load() }, [])
      const act = async (fn, okText) => {
        props.setBusy(true)
        try {
          const res = await fn()
          props.onNotice(res && res.ok === false ? { kind: 'error', text: '失败：' + (res.message || '未知错误') } : { kind: 'ok', text: okText })
          await load()
        } catch (e) {
          props.onNotice({ kind: 'error', text: '失败：' + e.message })
        } finally {
          props.setBusy(false)
        }
      }
      const q = query.trim()
      const list = q ? rows.filter((r) => ((r.name || '') + ' ' + (r.description || '')).indexOf(q) >= 0) : rows
      return h('div', { className: 'memcore-entries' },
        h('div', { className: 'memcore-toolbar' },
          h('input', { className: 'memcore-search', placeholder: '搜索技能名或说明…', value: query, onChange: (e) => setQuery(e.target.value) }),
          h('span', { className: 'memcore-count' }, list.filter((r) => r.enabled).length + ' 启用 / ' + list.length + ' 共')),
        list.length === 0
          ? h('div', { className: 'memcore-empty' }, '没有匹配的技能。')
          : list.map((sk) => h('div', { key: sk.name, className: 'memcore-entry' },
              h('div', { className: 'memcore-entry-head' },
                h('span', { className: 'memcore-entry-text', style: { fontWeight: 600 } }, sk.name),
                h(Badge, null, sk.source),
                sk.enabled ? null : h(Badge, { cls: 'memcore-badge-ro' }, '已禁用'),
                h('span', { className: 'memcore-entry-ops' }, h('span', { className: 'memcore-count' }, Math.round((sk.bytes || 0) / 1024) + ' KB'))),
              sk.description ? h('div', { className: 'memcore-muted' }, sk.description) : null,
              h('div', { className: 'memcore-entry-head' },
                h('span', { className: 'memcore-entry-ops' },
                  sk.enabled
                    ? h(Btn, { kind: 'danger', disabled: props.busy, onClick: () => act(() => api('/skills/update', { method: 'POST', body: { name: sk.name, action: 'disable' } }), '已禁用（写 frontmatter）') }, '禁用')
                    : h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => act(() => api('/skills/update', { method: 'POST', body: { name: sk.name, action: 'enable' } }), '已启用') }, '启用'))))))
    }

    /** 全局规则：只读展示 DSH 用户级 AGENTS.md（每个会话都会读到它）。 */
    function RulesView() {
      const st = React.useState
      const [doc, setDoc] = st(null)
      const [err, setErr] = st(null)
      const [query, setQuery] = st('')
      React.useEffect(() => {
        api('/agents').then((r) => setDoc(r)).catch((e) => setErr(e.message))
      }, [])
      const q = query.trim()
      const lines = doc && doc.content ? doc.content.split('\n') : []
      const shown = q ? lines.filter((l) => l.indexOf(q) >= 0) : lines
      return h('div', { className: 'memcore-entries' },
        h('div', { className: 'memcore-toolbar' },
          h(Badge, { cls: 'memcore-badge-ro' }, '只读'),
          h('input', { className: 'memcore-search', placeholder: '搜索规则内容…', value: query, onChange: (e) => setQuery(e.target.value) }),
          h('span', { className: 'memcore-count' }, doc ? (doc.exists ? Math.round(doc.bytes / 1024 * 10) / 10 + ' KB · ' + lines.length + ' 行' : '文件不存在') : '加载中…')),
        doc && doc.exists ? h('div', { className: 'memcore-muted' }, '路径：' + doc.path + '（每个会话都会注入；编辑请用系统编辑器或让模型改文件）') : null,
        err ? h('div', { className: 'memcore-notice memcore-notice-error' }, '加载失败：' + err) : null,
        doc === null
          ? h('div', { className: 'memcore-muted' }, '加载中…')
          : !doc.exists
            ? h('div', { className: 'memcore-empty' }, '还没有全局规则文件：' + doc.path)
            : h('pre', { className: 'memcore-pre' }, shown.length ? shown.join('\n') : '（无匹配行）'))
    }

    function MemoryPanel(props) {
      const st = React.useState
      const [feature, setFeature] = st(null)
      const [activeKey, setActiveKey] = st('memory')
      const [counts, setCounts] = st({ queue: 0, prompts: 0, todos: 0, skills: 0 })
      const [notice, setNotice] = st(null)
      const [busy, setBusy] = st(false)
      const [cwd, setCwd] = st(null)

      const pollCounts = React.useCallback(async () => {
        const badge = await api('/badge')
        const pending = await api('/suggestions?status=pending')
        const todos = await api('/todos')
        const skills = await api('/skills')
        setCounts({
          queue: (pending.entries || []).length,
          prompts: badge.prompts || 0,
          todos: (todos.entries || []).length,
          skills: (skills.entries || []).filter((x) => x.enabled).length,
        })
      }, [])

      React.useEffect(() => { ensureStyles(); void pollCounts() }, [pollCounts])

      const tab = FILE_TABS.filter((t) => t.key === activeKey)[0] || FILE_TABS[0]
      const featureTab = (key, title) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': feature === key,
        className: feature === key ? 'memcore-file-tab memcore-file-tab-active' : 'memcore-file-tab',
        onClick: () => setFeature(feature === key ? null : key),
      }, title, counts[key] > 0 ? h('span', { className: 'memcore-feature-count' }, counts[key]) : null)

      return h('div', { className: 'memcore-panel' },
        notice ? h('div', { className: 'memcore-notice memcore-notice-' + notice.kind }, notice.text) : null,
        h('div', { className: 'memcore-file-tabs', role: 'tablist' },
          featureTab('queue', '待确认'),
          featureTab('todos', '待办'),
          featureTab('skills', '技能'),
          featureTab('prompts', '提示词'),
          h('span', { className: 'memcore-tab-sep', role: 'presentation' }),
          FILE_TABS.map((t) => h('button', {
            key: t.key, type: 'button', role: 'tab',
            'aria-selected': feature === null && t.key === activeKey,
            className: feature === null && t.key === activeKey ? 'memcore-file-tab memcore-file-tab-active' : 'memcore-file-tab',
            onClick: () => { setActiveKey(t.key); setFeature(null) },
          }, t.title))),
        h('p', { className: 'memcore-warning' }, '⚠️ 记忆存于本机 SQLite（事实源）；面板编辑走宿主 API，手改 Markdown 快照不会回灌，请用「编辑」或 mem_update 工具。'),
        cwd ? h('p', { className: 'memcore-cwd' }, '当前会话工作目录：' + cwd) : null,
        h(
          'div',
          { className: 'memcore-body' },
          feature === 'queue'
            ? h(QueueView, { onNotice: setNotice, busy, setBusy, onChanged: pollCounts })
            : feature === 'todos'
              ? h(TodosView, { onNotice: setNotice, busy, setBusy, cwd, sessionId: props.sessionId })
              : feature === 'skills'
                ? h(SkillsView, { onNotice: setNotice, busy, setBusy })
                : feature === 'prompts'
                  ? h(PromptsView, { onNotice: setNotice, busy, setBusy, onChanged: pollCounts })
                  : tab.kind === 'rules'
                  ? h(RulesView, null)
                  : h(MemoryView, { tab, sessionId: props.sessionId, onNotice: setNotice, busy, setBusy, onCwd: setCwd }),
        ),
      )
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      ensureStyles()
      let badge = { suggestions: 0, prompts: 0 }
      let disposeRegistration
      let timer

      const currentSessionId = () => {
        try {
          return (ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot().current) || null
        } catch (e) {
          return null
        }
      }

      const register = () => {
        if (disposeRegistration) disposeRegistration()
        disposeRegistration = ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'memory-hub',
          order: 15,
          label: () => {
            const n = (badge.suggestions || 0) + (badge.prompts || 0)
            return n > 0 ? '🔴 记忆核心 (' + n + ')' : '记忆核心'
          },
        }, () => h(MemoryPanel, { sessionId: currentSessionId() })))
      }

      const poll = async () => {
        try {
          const next = await api('/badge')
          const changed = (next.suggestions || 0) !== (badge.suggestions || 0) || (next.prompts || 0) !== (badge.prompts || 0)
          badge = next
          if (changed) register()
        } catch (e) { /* 宿主路由不可用时静默 */ }
      }

      register()
      void poll()
      timer = setInterval(() => void poll(), POLL_MS)
      ctx.effect(() => () => { clearInterval(timer); if (disposeRegistration) disposeRegistration() }, 'dsh-memory-core: memory tab')
    }

    return { inject, apply }
  },
})
