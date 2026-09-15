/**
 * 模型可见的工具面（M1：`mem_search` / `mem_get` / `mem_diag` / `mem_status`）。
 *
 * 注册成**原始 JSON Schema 定义**（不走 `defineTool`），因为：
 *   1. 本插件零依赖、不 import `@deepseek-ai/dsh-tools`，避免版本漂移与安装期依赖解析；
 *   2. 注册契约（dsh 0.1.5-rc.1 `tools.register`）只强制 `output { schema, render }`
 *      + `name/description/parameters/execute`，原始 JSON Schema 完全够用。
 *
 * 工具描述里写死读侧纪律：**接到任务先 `mem_search`**（项目日志与 daily 默认不在
 * 上下文里），这是"现成工具想不起来用"的直接对策（设计 §5.6）。
 */
import { projectHash } from './paths.js'

/** 把命中列表渲染成模型可读文本（卡片：id + 轨 + 通道 + 摘要）。 */
export function renderHits(hits, { showChannels = true } = {}) {
  if (hits.length === 0) return '（无命中）'
  return hits
    .map((h) => {
      const chans = showChannels ? ` · ${Object.keys(h.channels ?? {}).join('+')}` : ''
      return `[mem:${h.id} | ${h.track ?? '-'}/${h.kind ?? '-'}${chans}]\n${h.snippet}${h.snippet.length >= 160 ? '…' : ''}\n→ mem_get ${h.id} 取全文`
    })
    .join('\n\n')
}

const TEXT = (text) => [{ type: 'text', text }]

/** 当前会话所属项目作用域（cwd → sha1 前 12 位，与旧库同一套标识）。 */
export function scopeForExec(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (!cwd) return null
  return `project:${projectHash(cwd)}`
}

/**
 * 构造工具定义。
 * @param {{ store: import('./store.js').Store, recall: import('./recall.js').Recall, host: any, config: any }} deps
 */
export function buildTools({ store, recall, host, config, ledger = null, runtime = null }) {
  const defaultK = config?.recall?.k ?? 6

  const memSearch = {
    name: 'mem_search',
    description:
      'Search this machine\'s long-term memory (project conventions, decisions, pitfalls, ready-made tools) before starting work. ' +
      'Memories are stored in five tracks (user/memory/key/project/daily); project logs and daily logs are NOT auto-injected, so search first. ' +
      'Returns ranked cards with ids; use mem_get <id> for the full text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Natural-language query (Chinese or English). Identifiers, paths and component names match best.' },
        k: { type: 'integer', description: `How many memories to return (default ${defaultK}).` },
        scope: { type: 'string', description: 'Optional scope filter: "all" (default), "global", or a project scope like "project:<hash>".' },
        track: { type: 'string', description: 'Optional track filter: user | memory | key | project | daily.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                rank: { type: 'integer' },
                track: { type: 'string' },
                kind: { type: 'string' },
                scope: { type: 'string' },
                snippet: { type: 'string' },
                channels: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'rank', 'snippet'],
            },
          },
          evidence: { type: 'boolean' },
          degraded: { type: 'array', items: { type: 'string' } },
          ms: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['query', 'hits', 'evidence', 'text'],
      },
      render: (_args, value) => TEXT(value.text),
    },
    async execute(args, exec) {
      // 默认范围 = 当前项目 + global（设计 §4.2）：项目日志与全局规则都要覆盖，
      // 否则会漏掉"所有会话都必须遵守"的全局约定。
      const projectScope = scopeForExec(exec)
      const scope = args.scope ?? (projectScope ? [projectScope, 'global'] : 'all')
      const res = recall.search({ query: args.query, scopes: scope, k: args.k ?? defaultK })
      const hits = res.hits
        .filter((h) => (args.track ? h.track === args.track : true))
        .map((h) => ({
          id: h.id,
          rank: h.rank,
          track: h.track ?? '-',
          kind: h.kind ?? '-',
          scope: h.scope ?? '-',
          snippet: h.snippet,
          channels: Object.keys(h.channels ?? {}),
        }))
      const head = `查询「${args.query}」→ ${hits.length} 条（${res.ms} ms，范围 ${scope}）`
      const footer = res.evidence.inject ? '' : '\n\n（证据不足：这些命中属于弱相关，必要时换关键词或放宽范围）'
      return {
        query: args.query,
        hits,
        evidence: res.evidence.inject,
        degraded: res.degraded,
        ms: res.ms,
        text: `${head}\n\n${renderHits(res.hits.filter((h) => hits.some((x) => x.id === h.id)))}${footer}`,
      }
    },
  }

  const memGet = {
    name: 'mem_get',
    description: 'Read the full text of one or more long-term memories by id (ids come from mem_search cards).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Memory id, e.g. 9f3a1c02. Multiple ids may be comma-separated.' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => TEXT(value.text),
    },
    async execute(args) {
      const ids = String(args.id)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const found = []
      const missing = []
      const blocks = []
      for (const id of ids) {
        const row = store.getUnit(id)
        if (!row) {
          missing.push(id)
          continue
        }
        found.push(id)
        store.db.prepare('UPDATE units SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(Date.now(), id)
        blocks.push(`[mem:${row.id} | ${row.track}/${row.kind ?? '-'} | ${row.scope} | v${row.version}]\n${row.content}`)
      }
      const text = blocks.length > 0 ? blocks.join('\n\n---\n\n') : `未找到：${missing.join(', ')}`
      return { found, missing, text }
    },
  }

  const memDiag = {
    name: 'mem_diag',
    description:
      'Explain why memories were (or were not) recalled for a query: per-channel raw rankings, RRF fusion, baseline seats and the evidence decision. Use when recall looks wrong.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The query to diagnose.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          ms: { type: 'integer' },
          degraded: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
        required: ['query', 'text'],
      },
      render: (_args, value) => TEXT(value.text),
    },
    async execute(args) {
      const diag = recall.diag(args.query, { scopes: 'all', limit: 6 })
      return { query: args.query, ms: diag.ms, degraded: diag.degraded, text: diag.formatter() }
    },
  }

  const memStatus = {
    name: 'mem_status',
    description:
      'Report memory-store health: schema version, item counts per track, index (FTS5), recall channels, last backup, host dsh version and capability probe.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          counts: { type: 'object', additionalProperties: true, properties: {} },
          host: { type: 'object', additionalProperties: true, properties: {} },
          injection: { type: 'object', additionalProperties: true, properties: {} },
          backup: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => TEXT(value.text),
    },
    async execute() {
      const counts = store.counts()
      const lastBackup = host?.latestBackup ?? null
      const snap = ledger?.snapshot?.(null) ?? null
      const totals = snap?.totals ?? null
      const lines = [
        `记忆库：${counts.units} 条（active ${counts.unitsActive}）· FTS ${counts.fts} · 待办 ${counts.todos} · 技能 ${counts.skills}`,
        `分轨：${Object.entries(counts.byTrack).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        `宿主 dsh：${host?.version ?? '未探测到'}（声明支持 ${host?.supported ?? '-'}）`,
        `能力：${Object.entries(host?.caps ?? {}).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`,
        `备份：${lastBackup ? `${lastBackup.name}（${(lastBackup.bytes / 1024).toFixed(0)} KB）` : '尚无'}`,
      ]
      if (totals) {
        lines.push(
          `注入账本：常驻段 ${totals.residentTokens} token · 按轮召回累计 ${totals.recallTokens} token / ${totals.recallSections} 次 / ${totals.cards} 张卡片 · 覆盖回合 ${totals.hitTurns}/${totals.turns}`,
        )
      }
      const failures = Number(store.getMeta('extract_failures', '0'))
      const degraded = store.getMeta('extract_degraded', 'false') === 'true'
      const lastSuccess = store.getMeta('extract_last_success_at', null)
      const lastFailure = store.getMeta('extract_last_failure', null)
      lines.push(
        `提取：${store.getMeta('extract_items_total', '0')} 条累计产出 · ${failures} 次连续失败${degraded ? '（已降级，暂停抽取）' : ''} · 上次成功 ${lastSuccess ? lastSuccess.slice(11, 19) : '无'}${lastFailure && failures > 0 ? ` · 最近失败：${String(lastFailure).slice(0, 80)}` : ''} · 模型 ${store.getMeta('extract_last_model', '未记录')}`,
      )
      return {
        counts,
        host: { version: host?.version ?? null, compatible: host?.compatible ?? null, caps: host?.caps ?? {} },
        injection: snap ?? {},
        backup: lastBackup?.name ?? '',
        text: lines.join('\n'),
      }
    },
  }

  const CANDIDATES = {
    type: 'array',
    items: obj({ id: { type: 'string' }, snippet: { type: 'string' }, similarity: { type: 'number' } }, ['id']),
  }

  const memWrite = {
    name: 'mem_write',
    description:
      'Save ONE durable memory (convention, decision, pitfall, environment fact, user preference, or project progress). ' +
      'By default rules/preferences/key facts go to the human confirmation queue and only project/daily progress writes directly; ' +
      'pass direct=true to bypass confirmation. Secrets (keys/tokens) are rejected outright. ' +
      'Before writing, search with mem_search — duplicates return status=duplicate with the existing id.',
    parameters: obj(
      {
        content: str('The memory text, self-contained, in the original language; keep paths/identifiers verbatim.'),
        track: { type: 'string', enum: WRITE_TRACKS, description: 'user | memory | key | project | daily (default memory).' },
        kind: { type: 'string', enum: KINDS, description: 'rule | preference | fact | decision | pitfall | env | progress.' },
        scope: str('Optional explicit scope; defaults to the current project for key/project, else global.'),
        tags: strArr('Optional topics.'),
        alias: strArr('Optional alternative phrasings people may search with (e.g. 底部操作栏 for FooterButton).'),
        entities: strArr('Optional paths/component names/commands/bug ids.'),
        direct: { type: 'boolean', description: 'Skip the confirmation queue (default false).' },
      },
      ['content'],
    ),
    output: TEXT_OUT(
      {
        status: { type: 'string' },
        id: { type: 'string' },
        relation: { type: 'string' },
        reason: { type: 'string' },
        candidates: CANDIDATES,
      },
      ['text', 'status'],
    ),
    async execute(args, exec) {
      const writer = runtime?.writer
      if (!writer) throw new Error('写入路径未初始化')
      const res = writer.writeMemory({
        store,
        recall,
        cwd: exec?.agent?.session?.header?.cwd ?? null,
        input: {
          content: args.content,
          track: args.track,
          kind: args.kind,
          scope: args.scope,
          tags: args.tags,
          alias: args.alias,
          ent: args.entities,
        },
        origin: exec?.agent ? `session:${exec.agent.session?.id ?? 'unknown'}` : 'tool',
        force: args.direct === true,
      })
      const label = {
        written: '已写入',
        queued: '已进待确认队列',
        'queued-duplicate': '队列中已有同一条',
        duplicate: '已存在相同记忆',
        rejected: '已拒绝',
      }[res.status] ?? res.status
      const tip =
        res.status === 'queued' || res.status === 'queued-duplicate'
          ? '（由用户在记忆面板或 /mem review 确认后才会注入上下文）'
          : res.status === 'duplicate'
            ? `（既有条目 [mem:${res.id}]）`
            : ''
      const near = (res.candidates ?? []).filter((c) => c.similarity >= 0.25).slice(0, 3)
      const nearText = near.length > 0 ? `\n相近条目：${near.map((c) => `[mem:${c.id}] ${c.similarity}`).join('、')}` : ''
      return {
        text: `${label}：${res.reason ?? res.relation ?? ''}${tip}${nearText}`.trim(),
        status: res.status,
        id: res.id ?? '',
        relation: res.relation ?? '',
        reason: res.reason ?? '',
        candidates: (res.candidates ?? []).slice(0, 5),
      }
    },
  }

  const memUpdate = {
    name: 'mem_update',
    description:
      'Edit an existing memory: change its text, move it to another track, change its kind, or archive/restore/pin it. ' +
      'Every edit is versioned (old text kept in history). Archived memories stay searchable with mem_search scope=all but stop being injected.',
    parameters: obj(
      {
        id: str('Memory id from a mem_search card.'),
        content: str('Replacement text (optional).'),
        track: { type: 'string', enum: WRITE_TRACKS, description: 'Move to another track (optional).' },
        kind: { type: 'string', enum: KINDS, description: 'Change kind (optional).' },
        action: { type: 'string', enum: ['edit', 'archive', 'restore', 'pin', 'unpin'], description: 'Default edit.' },
        reason: str('Why the change was made (kept in history).'),
      },
      ['id'],
    ),
    output: TEXT_OUT({ ok: { type: 'boolean' }, version: { type: 'integer' } }, ['text', 'ok']),
    async execute(args) {
      const write = runtime?.writer
      if (!write) throw new Error('写入路径未初始化')
      const row = store.getUnit(args.id)
      if (!row) return { text: `未找到条目 ${args.id}`, ok: false, version: 0 }
      const action = args.action ?? 'edit'
      if (action === 'archive' || action === 'restore' || action === 'pin' || action === 'unpin') {
        const status = action === 'archive' ? 'archived' : action === 'restore' ? 'active' : undefined
        const pinned = action === 'pin' ? 1 : action === 'unpin' ? 0 : undefined
        store.db
          .prepare(`UPDATE units SET status = COALESCE(?, status), pinned = COALESCE(?, pinned), updated_at = ?, lamport = lamport + 1 WHERE id = ?`)
          .run(status ?? null, pinned ?? null, Date.now(), args.id)
        store.logChange('unit', args.id, status ? 'status' : 'upsert', { status, pinned, reason: args.reason ?? null })
        return { text: `${args.id}：${action} 完成（当前 status=${status ?? row.status}, pinned=${pinned ?? row.pinned}）`, ok: true, version: row.version }
      }
      const res = store.updateUnit(args.id, {
        content: args.content,
        track: args.track,
        kind: args.kind,
        reason: args.reason ?? null,
        editedBy: 'model',
      })
      if (!res.ok) return { text: res.message, ok: false, version: 0 }
      return { text: `${args.id} 已更新到 v${res.version}（旧版本已留档，下一轮注入即生效）`, ok: true, version: res.version }
    },
  }

  const memReview = {
    name: 'mem_review',
    description:
      'Inspect the pending-confirmation queue (memories extracted from sessions, model-suggested todos, new skills). ' +
      'Listing is always allowed; approving/rejecting is reserved for the human (memory panel or /mem review) unless the deployment enables model decides.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'approve', 'reject', 'archive'], description: 'Default list.' },
        id: str('Suggestion id (required for approve/reject/archive).'),
        track: { type: 'string', enum: WRITE_TRACKS, description: 'Optional: change the track while approving.' },
        content: str('Optional: change the text while approving.'),
        kind: { type: 'string', enum: KINDS, description: 'Optional: change the kind while approving.' },
        reason: str('Optional reason (kept with reject/archive).'),
      },
      [],
    ),
    output: TEXT_OUT({ count: { type: 'integer' }, pending: { type: 'integer' } }, ['text']),
    async execute(args) {
      const write = runtime?.writer
      if (!write) throw new Error('写入路径未初始化')
      const action = args.action ?? 'list'
      const pending = store.listSuggestions({ status: 'pending', limit: 200 })
      if (action === 'list') {
        if (pending.length === 0) return { text: '待确认队列为空。', count: 0, pending: 0 }
        const lines = pending.slice(0, 20).map((row, i) => {
          const p = (() => {
            try {
              return JSON.parse(row.payload)
            } catch {
              return {}
            }
          })()
          return `${i + 1}. [${row.id}] ${row.kind}/${p.track ?? row.target ?? '-'} · ${String(p.content ?? '').replace(/\s+/g, ' ').slice(0, 120)}`
        })
        return {
          text: `待确认 ${pending.length} 条（仅人工可采纳/拒绝）：\n${lines.join('\n')}${pending.length > 20 ? `\n…（还有 ${pending.length - 20} 条）` : ''}`,
          count: pending.length,
          pending: pending.length,
        }
      }
      const allowModel = config?.review?.allowModelDecide === true
      if (!allowModel) {
        return {
          text: `已拒绝：${action} 需要人工确认（在记忆面板「待确认」或 /mem review 里操作）。当前队列 ${pending.length} 条。`,
          count: pending.length,
          pending: pending.length,
        }
      }
      if (!args.id) return { text: '缺少 id', count: pending.length, pending: pending.length }
      const res =
        action === 'approve'
          ? (runtime?.approveSuggestion ?? ((a) => write.approveSuggestion({ store, ...a })))({
              id: args.id,
              overrides: { track: args.track, content: args.content, kind: args.kind },
            })
          : action === 'reject'
            ? write.rejectSuggestion({ store, id: args.id, reason: args.reason })
            : write.archiveSuggestion({ store, id: args.id })
      return { text: res.ok ? `${action} ${args.id} 完成` : res.message, count: pending.length, pending: pending.length }
    },
  }

  const memExtract = {
    name: 'mem_extract',
    description:
      'Extract durable memories from this session (or a given session id) into the pending-confirmation queue. ' +
      'Runs automatically when a session goes idle; call this to do it now (e.g. before a long break or context compaction).',
    parameters: obj(
      {
        sessionId: str('Optional session id; defaults to the current session.'),
        turns: { type: 'integer', description: 'How many recent messages to consider (default 20).' },
        dryRun: { type: 'boolean', description: 'Only report what would be extracted (no queue writes).' },
      },
      [],
    ),
    output: TEXT_OUT({ ok: { type: 'boolean' }, queued: { type: 'integer' }, reason: { type: 'string' } }, ['text', 'ok']),
    async execute(args, exec) {
      if (!runtime?.extractNow) throw new Error('提取需要宿主运行时（插件未装配）')
      const sessionId = args.sessionId ?? exec?.agent?.session?.id ?? null
      const res = await runtime.extractNow(sessionId, { turns: args.turns ?? 20, dryRun: args.dryRun === true })
      return {
        ok: res.ok === true,
        queued: res.queued ?? 0,
        reason: res.reason ?? '',
        text: res.ok
          ? `提取完成：${res.queued ?? 0} 条进待确认队列（模型 ${res.model ?? '-'}${res.effort ? `@${res.effort}` : ''}）${res.items?.length ? `\n${res.items.map((i) => `- [${i.track}/${i.kind}] ${i.content.slice(0, 100)}`).join('\n')}` : ''}`
          : `提取未完成：${res.reason ?? '未知原因'}`,
      }
    },
  }

  const memPrompts = {
    name: 'mem_prompts',
    description:
      'Prompt manager: a reusable library of instruction templates plus an injection track. ' +
      'list/get browse the library (body only on get); create/update/enable/disable manage it; ' +
      'inject pushes a prompt into this session as a rule the model must follow — once, N times, every N turns, or持续 until stopped; ' +
      'stop removes an active injection. Templates may contain {{date}}/{{time}}.',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'enable', 'disable', 'delete', 'inject', 'stop', 'categories', 'seed'],
          description: 'What to do (default list).',
        },
        id: str('Prompt id or exact name (get/update/enable/disable/delete/inject/stop).'),
        query: str('list: filter by substring in name/summary/body.'),
        tag: str('list: filter by tag.'),
        category: str('list filter, or the category to set on create/update.'),
        name: str('create/update: prompt name.'),
        summary: str('create/update: one-line description (the model reads this when choosing).'),
        tags: strArr('create/update: topic tags.'),
        body: str('create/update: prompt body (Markdown).'),
        rounds: { type: 'integer', description: 'inject: how many times it should appear (default 1; 0 = unlimited until stopped).' },
        every: { type: 'integer', description: 'inject: interval in turns (default 1 = every turn; 0 = appear exactly once).' },
        sessionId: str('inject/stop: target session (default the current session).'),
        immediate: { type: 'boolean', description: 'inject: also nudge the session so it takes effect within this turn.' },
        injectionId: str('stop: injection id instead of a prompt id.'),
      },
      ['action'],
    ),
    output: TEXT_OUT({ ok: { type: 'boolean' }, id: { type: 'string' }, count: { type: 'integer' } }, ['text', 'ok']),
    async execute(args, exec) {
      const pm = runtime?.prompts
      if (!pm) throw new Error('提示词管理器未初始化')
      const action = args.action ?? 'list'
      const sessionId = args.sessionId ?? exec?.agent?.session?.id ?? null
      switch (action) {
        case 'list': {
          const items = pm.listPrompts({ category: args.category, tag: args.tag, q: args.query, enabledOnly: true })
          if (items.length === 0) return { text: '提示词库为空（可用 action=seed 写入种子库）。', ok: true, id: '', count: 0 }
          const lines = items.map((p) => `- ${p.name}（${p.category}）id=${p.id}${p.summary ? `：${p.summary}` : ''}`)
          return { text: `启用中的提示词 ${items.length} 条（不含正文，详情用 get）：\n${lines.join('\n')}`, ok: true, id: '', count: items.length }
        }
        case 'get': {
          const p = pm.getPrompt(args.id)
          if (!p) return { text: `未找到提示词 ${args.id}`, ok: false, id: '', count: 0 }
          const active = pm.activeFor(p.id)
          return {
            text: `# ${p.name}（${p.category}）id=${p.id}\n简介：${p.summary || '-'}\n标签：${p.tags.join(', ') || '-'}\n启用：${p.enabled ? '是' : '否'} · 使用 ${p.uses} 次\n注入中：${active.length > 0 ? active.map((i) => `${i.id}(${i.rounds_left === null ? '持续' : `剩 ${i.rounds_left} 次`}/每 ${i.every} 回合)`).join('、') : '无'}\n\n${p.body}`,
            ok: true,
            id: p.id,
            count: 1,
          }
        }
        case 'create': {
          const res = pm.createPrompt({ name: args.name, summary: args.summary, category: args.category, tags: args.tags, body: args.body })
          return { text: res.ok ? `已创建提示词 ${res.id}` : res.message, ok: res.ok === true, id: res.id ?? '', count: 0 }
        }
        case 'update': {
          const res = pm.updatePrompt(args.id, { name: args.name, summary: args.summary, category: args.category, tags: args.tags, body: args.body })
          return { text: res.ok ? `已更新 ${res.id}` : res.message, ok: res.ok === true, id: res.id ?? '', count: 0 }
        }
        case 'enable':
        case 'disable': {
          const res = pm.setEnabled(args.id, action === 'enable')
          return { text: res.ok ? `${args.id} 已${action === 'enable' ? '启用' : '禁用'}` : res.message, ok: res.ok === true, id: res.id ?? '', count: 0 }
        }
        case 'delete': {
          const res = pm.deletePrompt(args.id)
          return { text: res.ok ? `已删除 ${args.id}（含其活跃注入）` : res.message, ok: res.ok === true, id: res.id ?? '', count: 0 }
        }
        case 'categories': {
          const cats = pm.listCategories()
          return { text: `分类：${cats.map((c) => c.name).join('、')}`, ok: true, id: '', count: cats.length }
        }
        case 'seed': {
          const res = pm.importSeed()
          return { text: res.ok ? `种子库写入 ${res.imported} 条（已存在的同名条目跳过）` : res.message, ok: res.ok === true, id: '', count: res.imported ?? 0 }
        }
        case 'inject': {
          const p = pm.getPrompt(args.id)
          if (!p) return { text: `未找到提示词 ${args.id}`, ok: false, id: '', count: 0 }
          if (p.enabled === false) return { text: `提示词 ${p.name} 已禁用，先 enable 再注入`, ok: false, id: p.id, count: 0 }
          const res = pm.createInjection({
            promptId: p.id,
            title: args.name ?? p.name,
            content: args.body ?? p.body,
            rounds: args.rounds ?? 1,
            every: args.every ?? 1,
            sessionId,
          })
          if (!res.ok) return { text: res.message, ok: false, id: '', count: 0 }
          let nudged = false
          if (args.immediate && sessionId) nudged = runtime?.steer?.(sessionId, `规则「${p.name}」已生效，请在本回合内遵循。`) === true
          const scope = (args.rounds ?? 1) === 0 ? '持续注入（直到手动停止）' : `出现 ${args.rounds ?? 1} 次`
          return {
            text: `已注入「${p.name}」：${scope}，间隔 ${args.every ?? 1} 回合${nudged ? '（已插话，本回合内生效）' : '（下一轮生效）'}`,
            ok: true,
            id: res.id,
            count: 1,
          }
        }
        case 'stop': {
          if (args.injectionId) {
            const res = pm.stopInjection(args.injectionId)
            return { text: res.ok ? `已停止注入 ${args.injectionId}` : `未找到注入 ${args.injectionId}`, ok: res.ok, id: res.id, count: 0 }
          }
          const p = pm.getPrompt(args.id)
          const targets = p ? pm.activeFor(p.id) : []
          if (targets.length === 0) return { text: `没有活跃注入（${args.id ?? '全部'}）`, ok: true, id: '', count: 0 }
          let stopped = 0
          for (const t of targets) if (pm.stopInjection(t.id).ok) stopped += 1
          return { text: `已停止 ${stopped} 条注入`, ok: true, id: p?.id ?? '', count: stopped }
        }
        default:
          return { text: `未知动作：${action}`, ok: false, id: '', count: 0 }
      }
    },
  }

  const memTodo = {
    name: 'mem_todo',
    description:
      'Todo list with four tracks: life / work / project (isolated by working directory) / daily (by date). ' +
      'list returns only what needs attention by default (overdue, due today, current project, important+urgent — max 8); pass all=true for everything. ' +
      'Querying the past needs past=true AND expired=true (daily todos expire at end of day). ' +
      'User-dictated items are written directly; items the model invents should go through action=suggest into the confirmation queue.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['add', 'list', 'done', 'update', 'remove', 'suggest'], description: 'Default list.' },
        content: str('add/suggest: the todo text (first line is the title).'),
        id: str('done/update/remove: todo id.'),
        track: { type: 'string', enum: ['life', 'work', 'project', 'daily'], description: 'Track (default work).' },
        status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked', 'cancelled'], description: 'update: new status.' },
        quadrant: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'], description: 'Eisenhower quadrant (q1 = important+urgent).' },
        due: str('Due date YYYY-MM-DD (empty string clears it).'),
        important: { type: 'boolean', description: 'Important flag (derives quadrant when set).' },
        urgent: { type: 'boolean', description: 'Urgent flag (derives quadrant when set).' },
        category: str('Free-form category.'),
        date: str('daily track: YYYY-MM-DD (default today).'),
        all: { type: 'boolean', description: 'list: return everything, unfiltered.' },
        past: { type: 'boolean', description: 'list: include past daily todos (combine with expired=true to see unfinished leftovers).' },
        expired: { type: 'boolean', description: 'list: include expired leftovers when past=true.' },
        cwd: str('Project directory for the project track (defaults to the session cwd).'),
        limit: { type: 'integer', description: 'list: max rows (default 8 for the smart view, 500 for all).' },
      },
      ['action'],
    ),
    output: TEXT_OUT({ ok: { type: 'boolean' }, count: { type: 'integer' }, id: { type: 'string' } }, ['text', 'ok']),
    async execute(args, exec) {
      const tm = runtime?.todos
      if (!tm) throw new Error('待办模块未初始化')
      const cwd = args.cwd ?? exec?.agent?.session?.header?.cwd ?? null
      const sessionId = exec?.agent?.session?.id ?? null
      const action = args.action ?? 'list'
      switch (action) {
        case 'list': {
          const rows = tm.list({
            track: args.track ?? null,
            cwd,
            day: args.date ?? null,
            status: args.status ?? null,
            all: args.all === true,
            past: args.past === true,
            expired: args.expired === true,
            limit: args.limit ?? (args.all === true ? 500 : 8),
          })
          if (rows.length === 0) return { text: '没有需要关注的待办。', ok: true, count: 0, id: '' }
          const icon = (row) => (row.status === 'done' ? '✓' : row.status === 'doing' ? '▶' : row.status === 'blocked' ? '⛔' : '·')
          const lines = rows.map((row) => {
            const bits = [row.track]
            if (row.quadrant) bits.push(row.quadrant)
            if (row.due) bits.push(`due ${row.due}`)
            if (row.day && row.track === 'daily') bits.push(row.day)
            if (row.status !== 'pending') bits.push(row.status)
            return `${icon(row)} [${row.id}] ${row.content.replace(/\s+/g, ' ').slice(0, 120)}  （${bits.join(' · ')}）`
          })
          return {
            text: `${args.all === true ? '全部未完成待办' : '需要关注'} ${rows.length} 条：\n${lines.join('\n')}`,
            ok: true,
            count: rows.length,
            id: '',
          }
        }
        case 'add': {
          const res = tm.add({
            content: args.content,
            track: args.track ?? 'work',
            quadrant: args.quadrant,
            important: args.important,
            urgent: args.urgent,
            due: args.due || null,
            category: args.category ?? null,
            cwd,
            date: args.date ?? null,
            origin: sessionId ? `session:${sessionId}` : 'user',
          })
          return { text: res.ok ? `已添加待办 [${res.id}]（${res.track}${res.day ? ` ${res.day}` : ''}）` : res.message, ok: res.ok === true, count: 0, id: res.id ?? '' }
        }
        case 'suggest': {
          const res = tm.suggest({ content: args.content, track: args.track ?? 'work', due: args.due || null, cwd, sessionId })
          return {
            text: res.ok ? `已进待确认队列 [${res.id}]（用户在待办面板或 /mem review 采纳后才会出现）` : res.message,
            ok: res.ok === true,
            count: 0,
            id: res.id ?? '',
          }
        }
        case 'done': {
          const res = tm.done(args.id)
          return { text: res.ok ? `已完成 [${res.id}]` : res.message, ok: res.ok === true, count: 0, id: res.id ?? '' }
        }
        case 'update': {
          const res = tm.update(args.id, {
            content: args.content,
            track: args.track,
            status: args.status,
            due: args.due === undefined ? undefined : args.due || null,
            category: args.category,
            quadrant: args.quadrant,
            important: args.important,
            urgent: args.urgent,
            date: args.date,
          })
          return { text: res.ok ? `已更新 [${res.id}]（状态 ${res.status}）` : res.message, ok: res.ok === true, count: 0, id: res.id ?? '' }
        }
        case 'remove': {
          const res = tm.remove(args.id)
          return { text: res.ok ? `已删除 [${res.id}]` : res.message, ok: res.ok === true, count: 0, id: res.id ?? '' }
        }
        default:
          return { text: `未知动作：${action}`, ok: false, count: 0, id: '' }
      }
    },
  }

  const memSkill = {
    name: 'mem_skill',
    description:
      'Skill library manager. Skill files stay on disk (~/.agents/skills/<name>/SKILL.md is the source of truth); this only indexes them and manages them. ' +
      'list/read browse; create/update write files (read-before-write); enable/disable writes the official frontmatter flag disable-model-invocation; ' +
      'suggest queues a new skill for human confirmation (skills are injected into every session, so creation must be deliberate).',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'read', 'create', 'update', 'enable', 'disable', 'pending', 'suggest', 'scan'], description: 'Default list.' },
        name: str('Skill name (kebab-case).'),
        description: str('One-line description (frontmatter).'),
        body: str('create/update: SKILL.md body (Markdown).'),
        query: str('list: filter by substring.'),
        source: { type: 'string', enum: ['user', 'custom', 'project', 'bundled'], description: 'list: filter by source.' },
        enabledOnly: { type: 'boolean', description: 'list: only enabled skills.' },
        reason: str('suggest: why this skill is worth creating.'),
      },
      ['action'],
    ),
    output: TEXT_OUT({ ok: { type: 'boolean' }, count: { type: 'integer' }, name: { type: 'string' } }, ['text', 'ok']),
    async execute(args, exec) {
      const sm = runtime?.skills
      if (!sm) throw new Error('技能模块未初始化')
      const action = args.action ?? 'list'
      switch (action) {
        case 'list': {
          const rows = sm.list({ q: args.query ?? null, enabledOnly: args.enabledOnly === true, source: args.source ?? null })
          if (rows.length === 0) return { text: '没有匹配的技能。', ok: true, count: 0, name: '' }
          const lines = rows.map((r) => `- ${r.name}${r.enabled ? '' : '（已禁用）'} [${r.source}]${r.description ? `：${r.description}` : ''}`)
          return { text: `技能 ${rows.length} 个：\n${lines.join('\n')}`, ok: true, count: rows.length, name: '' }
        }
        case 'read': {
          const res = sm.read(args.name)
          return { text: res.ok ? `# ${res.name}\n${res.description ? `${res.description}\n\n` : ''}${res.body}` : res.message, ok: res.ok === true, count: 0, name: res.name ?? '' }
        }
        case 'create': {
          const res = sm.create({ name: args.name, description: args.description, body: args.body })
          return { text: res.ok ? `已创建技能 ${res.name}（${res.path}）` : res.message, ok: res.ok === true, count: 0, name: res.name ?? '' }
        }
        case 'update': {
          const res = sm.update(args.name, { body: args.body ?? null, description: args.description ?? null })
          return { text: res.ok ? `已更新技能 ${res.name}` : res.message, ok: res.ok === true, count: 0, name: res.name ?? '' }
        }
        case 'enable':
        case 'disable': {
          const res = sm.setEnabled(args.name, action === 'enable')
          return { text: res.ok ? `技能 ${res.name} 已${action === 'enable' ? '启用' : '禁用'}` : res.message, ok: res.ok === true, count: 0, name: res.name ?? '' }
        }
        case 'pending': {
          const rows = sm.pendingSuggestions()
          if (rows.length === 0) return { text: '没有待确认的技能建议。', ok: true, count: 0, name: '' }
          const lines = rows.map((r) => {
            let p = {}
            try {
              p = JSON.parse(r.payload)
            } catch {
              p = {}
            }
            return `- [${r.id}] ${p.name ?? '(未命名)'}：${String(p.description ?? p.reason ?? '').slice(0, 80)}`
          })
          return { text: `待确认技能 ${rows.length} 条（人工采纳后才会写入技能库）：\n${lines.join('\n')}`, ok: true, count: rows.length, name: '' }
        }
        case 'suggest': {
          const res = sm.suggest({ name: args.name, description: args.description, body: args.body, reason: args.reason, sessionId: exec?.agent?.session?.id ?? null })
          return { text: res.ok ? `已进待确认队列 [${res.id}]` : res.message, ok: res.ok === true, count: 0, name: args.name ?? '' }
        }
        case 'scan': {
          const res = sm.scan()
          return { text: `已重建技能索引：扫描 ${res.scanned} 个目录，索引 ${res.indexed} 个技能`, ok: true, count: res.indexed ?? 0, name: '' }
        }
        default:
          return { text: `未知动作：${action}`, ok: false, count: 0, name: '' }
      }
    },
  }

  return [memSearch, memGet, memDiag, memStatus, memWrite, memUpdate, memReview, memExtract, memPrompts, memTodo, memSkill]
}

const WRITE_TRACKS = ['user', 'memory', 'key', 'project', 'daily']
const KINDS = ['rule', 'preference', 'fact', 'decision', 'pitfall', 'env', 'progress']

const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })
const str = (description) => ({ type: 'string', description })
const strArr = (description) => ({ type: 'array', description, items: { type: 'string' } })
const TEXT_OUT = (extra = {}, required = ['text']) => ({
  schema: obj({ text: { type: 'string' }, ...extra }, required),
  render: (_args, value) => TEXT(value.text),
})
