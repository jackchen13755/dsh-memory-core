/**
 * dsh-memory-core —— dsh 插件入口（M1：工具面接入）。
 *
 * 支持的最新 dsh：`0.1.5-rc.1`（npm `latest`）。接线只用**官方文档化的扩展点**，
 * 且全部走"探测 + 降级"：
 *   - `inject = ['tools']`：唯一硬依赖（工具注册必需）。**可选服务一律不写进 inject**，
 *     改用 `ctx.get(name)` 探测——旧插件的教训是 inject 里放 headless 不存在的服务
 *     会让整棵插件树加载失败（设计 §4.3 故障隔离）。
 *   - 缺 `@deepseek-ai/dsh-tools` 依赖也行：工具以**原始 JSON Schema 定义**注册。
 *
 * 阶段：M1（`mem_search` / `mem_get` / `mem_diag` / `mem_status`）。
 * M2 起接注入（常驻段 + 按轮卡片），M3 起接写入/提取/待确认，见 DESIGN.md §16。
 */
import { mkdirSync } from 'node:fs'
import { closeDb, latestBackup, migrate, openDb, quickCheck } from './db.js'
import { installApi } from './api.js'
import { EVOLVE_DEFAULTS, WriteWatchdog, runEvolution } from './evolution.js'
import { EXTRACT_DEFAULTS, extractSession, markExtracted, noteSessionActivity, planAutoExtract, routeOf } from './extract.js'
import { health } from './health.js'
import { probeHost } from './host.js'
import { InjectionLedger, humanText, renderRecallSection, renderResidentSection } from './inject.js'
import { backupDir, dataDir, dbPath as defaultDbPath, projectHash, scopeForProject } from './paths.js'
import { PromptManager } from './prompts.js'
import { Recall } from './recall.js'
import { SkillManager } from './skills.js'
import { TodoManager } from './todos.js'
import { readTranscript, renderTranscript } from './session-log.js'
import { Store } from './store.js'
import { buildTools } from './tools.js'
import * as writerModule from './writer.js'

export const name = 'memory-core'
export const inject = ['tools']

export { Store } from './store.js'
export { Recall, createRecall } from './recall.js'
export { buildTools, scopeForExec } from './tools.js'
export { InjectionLedger, renderResidentSection, renderRecallSection, estimateTokens, humanText } from './inject.js'
export { readTranscript, readTranscriptFromLog, renderTranscript, findSessionLog, decompressMultiFrame } from './session-log.js'
export { scanSecrets, writeMemory, approveSuggestion, rejectSuggestion, archiveSuggestion, restoreSuggestion, sweepSuggestions, relate, similarity } from './writer.js'
export { PromptManager, expandVars, sanitizeSnapshotBody, DEFAULT_CATEGORIES } from './prompts.js'
export { EVOLVE_DEFAULTS, runEvolution, reinforce, decay, reconcile, abstractCluster, WriteWatchdog } from './evolution.js'
export { installApi } from './api.js'
export { TodoManager, stampTodoLine } from './todos.js'
export { SkillManager, parseSkill, setFrontmatterFlag } from './skills.js'
export * as extract from './extract.js'
export { probeHost, detectHostVersion, SUPPORTED_DSH } from './host.js'
export { health } from './health.js'
export { importLegacy, inferKind } from './legacy-import.js'
export { extractEntities } from './entities.js'
export { exportSnapshot, diffSnapshot } from './snapshot.js'
export { tokenize, tokensField, ftsQuery } from './tokens.js'
export { parseEntry, parseFile, renderEntries, splitEntries } from './markdown.js'
export { mapProjectHashes } from './scan-cwds.js'

/**
 * 打开事实源库（不抛：失败降级为内存库并在状态里说明，见设计 §4.3）。
 * @param {{ db?: string }} [config]
 */
export function openStore(config = {}) {
  const path = config.db ?? defaultDbPath()
  try {
    mkdirSync(dataDir(), { recursive: true })
    const db = openDb(path)
    migrate(db)
    const store = new Store(db)
    return { ok: true, store, db, path, degraded: false }
  } catch (error) {
    try {
      const db = openDb(':memory:')
      migrate(db)
      const store = new Store(db)
      return { ok: false, store, db, path: ':memory:', degraded: true, error: error.message }
    } catch (fatal) {
      return { ok: false, store: null, db: null, path: ':memory:', degraded: true, error: fatal.message }
    }
  }
}

/** 读 meta 里的 JSON（缺失/坏数据返回 null，绝不抛）。 */
function safeJsonMeta(store, key) {
  try {
    const raw = store.getMeta(key, null)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * dsh 插件装配。
 * @param {any} ctx cordis context
 * @param {{ db?: string, recall?: object, tools?: boolean, verbose?: boolean, extract?: object, review?: object }} [config]
 */
export function apply(ctx, config = {}) {
  const host = probeHost(ctx)
  if (config.verbose) {
    console.log(
      `[memory-core] 宿主 dsh ${host.version ?? '未知'}（声明支持 ${host.supported}，兼容 ${host.compatible === null ? '未知' : host.compatible ? '✓' : '✗'}）；能力 ${Object.entries(host.caps)
        .map(([k, v]) => `${k}=${v ? '✓' : '✗'}`)
        .join(' ')}`,
    )
  }

  const opened = openStore(config)
  if (!opened.store) {
    console.warn(`[memory-core] 事实源库不可用，插件进入空转（不影响宿主）：${opened.error}`)
    return
  }
  if (opened.degraded) {
    console.warn(`[memory-core] 事实源库打开失败，已降级为内存库：${opened.error}`)
  }

  const state = { host, opened, store: opened.store, recall: new Recall(opened.store, config.recall ?? {}), tools: [], ledger: new InjectionLedger() }

  // ── 提示词管理器（M3 追加模块；语义参考 dsh-memory-evolve）────────────────
  // 历史修复（幂等）：把早期没写 session_id 的建议补上归属会话
  try {
    const fixed = state.store.backfillSuggestionSessions()
    if (fixed > 0) console.warn(`[memory-core] 回填 ${fixed} 条建议的归属会话`)
  } catch {
    /* 回填失败不影响启动 */
  }
  state.todos = new TodoManager(state.store)
  state.skills = new SkillManager(state.store, { dir: config.skillsDir ?? null })
  state.skills.scan()
  state.watchdog = new WriteWatchdog(config.writeGuard ?? EVOLVE_DEFAULTS.writeGuard)
  state.evolveCfg = { ...EVOLVE_DEFAULTS, ...(config.evolve ?? {}) }
  state.prompts = new PromptManager(state.store)
  if (config.prompts?.seed !== false) {
    const seeded = Number(state.store.db.prepare('SELECT COUNT(*) AS n FROM prompts').get()?.n ?? 0)
    if (seeded === 0) {
      const res = state.prompts.importSeed()
      if (res.imported > 0 && config.verbose) console.log(`[memory-core] 已写入提示词种子库 ${res.imported} 条`)
    }
  }
  state.agents = null
  try {
    ctx.inject(['agents'], (agentsCtx) => {
      state.agents = agentsCtx.agents ?? null
    })
  } catch {
    /* headless 等无 agents 服务的场景：立即注入降级为"下一轮生效" */
  }

  // 回合推进：主 agent 回合即将关闭时推进注入计划（subagent 不消耗次数）
  try {
    ctx.on?.('agent/turn-stopping', (payload) => {
      try {
        const header = payload?.agent?.session?.header
        if (!header || header.origin === 'subagent') return
        state.prompts.tickTurn(payload?.agent?.session?.id ?? null)
      } catch (error) {
        console.warn(`[memory-core] 注入轨推进失败（已忽略）：${error.message}`)
      }
    })
  } catch (error) {
    console.warn(`[memory-core] turn-stopping 订阅失败（已忽略）：${error.message}`)
  }

  // ── 会话活动跟踪（M3：会话结束自动提取的原料）───────────────────────────
  state.sessions = new Map() // sessionId → session 对象（活体）
  state.live = new Map() // sessionId → { lastSeen, seq, turns }
  state.compactPending = new Set() // 需要"压缩前立即提取"的会话
  state.inflight = new Set() // 正在跑的提取 Promise（退出前排空用）

  try {
    ctx.on?.('session/event', (subject, event) => {
      try {
        const id = subject?.id ?? subject?.header?.id
        if (!id || !event) return
        // firstSeen：本进程第一次看到这个会话的时间 —— 「长会话兜底」（planAutoExtract 的
        // max-wait 支）拿它当基准；last_seen 会随每次活动刷新，活跃会话永远够不到 30 分钟。
        const state4 = state.live.get(id) ?? { lastSeen: 0, seq: 0, turns: 0, firstSeen: Date.now() }
        state4.lastSeen = Date.now()
        state4.seq = Math.max(state4.seq, Number(event.seq ?? 0))
        if (event.type === 'user/message') {
          const text = humanText([event.data])
          if (text) {
            state.ledger.noteUserMessage(id, text)
            state.watchdog.noteTurn(id)
            state4.turns += 1
          }
        } else if (event.type === 'compaction/start') {
          state.compactPending.add(id)
        }
        state.live.set(id, state4)
        state.sessions.set(id, subject)
        // 落库节流：最多每 10 秒写一次
        if (Date.now() - (state4.flushedAt ?? 0) > 10000) {
          state4.flushedAt = Date.now()
          // 会话作用域：由会话 cwd 推导项目作用域（面板/待办/技能按此过滤；一次性写实）
          const sessionCwd = subject?.header?.cwd ?? null
          noteSessionActivity({
            store: state.store,
            sessionId: id,
            scope: sessionCwd ? scopeForProject({ cwd: sessionCwd }) : null,
            seq: state4.seq,
            turns: state4.turns,
          })
        }
      } catch {
        /* 跟踪失败不影响会话 */
      }
    })
  } catch (error) {
    console.warn(`[memory-core] session/event 订阅失败（已忽略）：${error.message}`)
  }

  // ── 写入 / 提取运行时（工具与定时任务共用）─────────────────────────────
  const extractCfg = { ...EXTRACT_DEFAULTS, ...(config.extract ?? {}) }

  /**
   * 当前**打开的项目**的作用域（"精确区分会话 / 项目"）：活体会话的 cwd 优先
   * （sessions 表是节流写的，刚开的会话可能还没落库），其次退回 sessions.scope 记录。
   * 采纳 project/key 轨时按它落 scope —— 用的是用户此刻打开的项目，不是建议产生时那个。
   */
  function projectScopeForSession(sessionId) {
    if (!sessionId) return null
    const id = String(sessionId)
    const cwd = state.sessions.get(id)?.header?.cwd ?? null
    if (cwd) return scopeForProject({ cwd })
    return state.store.db.prepare('SELECT scope FROM sessions WHERE id = ?').get(id)?.scope ?? null
  }

  /** 统一的建议采纳：按 kind 分派到记忆 / 待办 / 技能；记忆的 project/key 轨按当前项目解析 scope。 */
  function approveSuggestionByKind({ id, overrides = {}, decidedBy = 'user', sessionId = null, projectScope = null }) {
    const row = state.store.db.prepare('SELECT kind FROM suggestions WHERE id = ?').get(String(id))
    if (!row) return { ok: false, message: `未找到建议 ${id}` }
    if (row.kind === 'todo') return state.todos.approveSuggestion({ id, overrides, decidedBy })
    if (row.kind === 'skill') return state.skills.approveSuggestion({ id, overrides, decidedBy })
    return writerModule.approveSuggestion({
      store: state.store,
      id,
      overrides,
      decidedBy,
      projectScope: projectScope ?? projectScopeForSession(sessionId),
    })
  }

  const runtime = {
    llm: (() => {
      try {
        return ctx.get('llm') ?? null
      } catch {
        return null
      }
    })(),
    writer: {
      writeMemory: (args) => {
        const res = writerModule.writeMemory({ store: state.store, recall: state.recall, ...args })
        const m = /^session:(.+)$/.exec(String(args?.origin ?? ''))
        if (m) state.watchdog.noteWrite(m[1])
        return res
      },
      approveSuggestion: (args) => writerModule.approveSuggestion({ store: state.store, ...args }),
      rejectSuggestion: (args) => writerModule.rejectSuggestion({ store: state.store, ...args }),
      archiveSuggestion: (args) => writerModule.archiveSuggestion({ store: state.store, ...args }),
      restoreSuggestion: (args) => writerModule.restoreSuggestion({ store: state.store, ...args }),
      scanSecrets: writerModule.scanSecrets,
    },
    prompts: state.prompts,
    todos: state.todos,
    skills: state.skills,
    /** 当前打开项目的作用域（面板/工具采纳 project/key 轨时按它落 scope）。 */
    projectScopeForSession,
    /** 统一的建议采纳：按 kind 分派到记忆 / 待办 / 技能。 */
    approveSuggestion: approveSuggestionByKind,
    /** 立即注入的"踢一步"：发 next-step 插话，让模型本回合内再走一步看到新规则。 */
    steer(sessionId, text) {
      try {
        const agent = state.agents?.get?.(sessionId)
        if (!agent?.steer) return false
        agent.steer({
          role: 'user',
          id: `memcore-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        return true
      } catch {
        return false
      }
    },
    /** 立即抽取一个会话（工具 mem_extract、空闲定时器、压缩前都走这里）。 */
    async extractNow(sessionId, { turns = 20, dryRun = false, reason = 'manual' } = {}) {
      const session = sessionId ? state.sessions.get(sessionId) : null
      const transcriptRes = sessionId
        ? readTranscript(session, { maxMessages: turns })
        : { messages: [], source: 'none' }
      const transcript = renderTranscript(transcriptRes.messages, { maxChars: extractCfg.maxTranscriptChars })
      if (transcript.length < 80) {
        return { ok: false, reason: `转录太短（${transcriptRes.messages.length} 条消息，来源 ${transcriptRes.source}），不值得提取` }
      }
      const ctxCwd = session?.header?.cwd ?? null
      const enqueue = (item) =>
        writerModule.writeMemory({
          store: state.store,
          recall: state.recall,
          cwd: ctxCwd,
          input: {
            content: item.content,
            track: item.track,
            kind: item.kind,
            alias: item.aliases,
            ent: item.entities,
            source: `extract:${sessionId ?? 'session'}#${reason}`,
          },
          origin: `extract:${sessionId ?? 'session'}`,
          sessionId, // 归属会话：面板据此区分"本会话/全部"
          force: false, // 零直写：一律进待确认队列
        })
      // 技能候选（自进化审查）：同一份 LLM 产出里的 skills 字段，同样零直写
      const enqueueSkill = (cand) =>
        state.skills.suggest({
          name: cand.name,
          description: cand.description,
          body: cand.body,
          sessionId,
          reason: cand.reason || '会话提取（自进化审查）',
        })
      const route = routeOf(session) ?? safeJsonMeta(state.store, 'extract_last_route')
      const res = await extractSession({
        store: state.store,
        transcript,
        llm: runtime.llm,
        route,
        sessionId,
        cwd: ctxCwd,
        config: extractCfg,
        enqueue: dryRun ? null : enqueue,
        enqueueSkill: dryRun ? null : enqueueSkill,
        log: (m) => console.warn(`[memory-core] ${m}`),
      })
      if (res.ok && sessionId && !dryRun) {
        const liveState = state.live.get(sessionId)
        markExtracted({
          store: state.store,
          sessionId,
          cursor: liveState?.seq ?? 0,
          scope: ctxCwd ? `project:${projectHash(ctxCwd)}` : null,
          turns: liveState?.turns ?? 0,
        })
        if (route) state.store.setMeta('extract_last_route', JSON.stringify(route))
      }
      return res
    },
  }

  const runExtraction = async (sessionId, opts) => {
    if (state.inflight.size > 0 && !opts?.force) return { ok: false, reason: '已有提取任务在跑（单会话单任务）' }
    const task = runtime
      .extractNow(sessionId, opts)
      .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }))
      .finally(() => state.inflight.delete(task))
    state.inflight.add(task)
    return task
  }
  state.runExtraction = runExtraction

  // HTTP API（面板与红点角标的后端；web-only，无 webServer 服务时自动跳过）
  state.apiInstalled = installApi(ctx, {
    store: state.store,
    recall: state.recall,
    prompts: state.prompts,
    todos: state.todos,
    skills: state.skills,
    /** 统一的建议采纳（面板与工具共用同一个入口，避免"路由直连专用实现"那类分叉 bug）。 */
    approveSuggestion: approveSuggestionByKind,
    ledger: state.ledger,
    runtime,
    host,
    config,
  })

  // 空闲定时器：会话结束（空闲 N 分钟）自动提取 + 超期建议自动归档
  ctx.effect(() => {
    const tick = async () => {
      try {
        if (extractCfg.auto === false) return
        const due = planAutoExtract({ store: state.store, live: state.live, config: extractCfg })
        // 压缩前触发的会话优先
        for (const id of [...state.compactPending]) {
          if (!due.some((d) => d.sessionId === id)) due.push({ sessionId: id, reason: 'compaction' })
        }
        state.compactPending.clear()
        for (const item of due) {
          await runExtraction(item.sessionId, { reason: item.reason, force: true })
        }
        writerModule.sweepSuggestions({ store: state.store, autoArchiveDays: config.review?.autoArchiveDays ?? 14 })
        // 演化巡演（默认每 30 分钟一次；各项独立容错，失败不影响会话）
        const interval = (state.evolveCfg.intervalMinutes ?? 30) * 60000
        const last = Number(state.store.getMeta('evolve_last_at', '0'))
        if (state.evolveCfg.enabled !== false && Date.now() - last >= interval) {
          state.store.setMeta('evolve_last_at', String(Date.now()))
          await runEvolution({
            store: state.store,
            llm: runtime.llm,
            route: safeJsonMeta(state.store, 'extract_last_route'),
            config: state.evolveCfg,
            log: (m) => console.warn(`[memory-core] ${m}`),
          })
        }
      } catch (error) {
        console.warn(`[memory-core] 空闲提取失败（已忽略）：${error.message}`)
      }
    }
    // 用 Node 原生定时器：**不能**写 `ctx.setInterval`（cordis 对未 inject 的服务做属性
    // 访问会直接抛 `cannot get property "timer" without inject`，整个 entry 会加载失败）；
    // 生命周期由本 effect 的 disposer 负责清理，unref 保证不阻塞进程退出。
    const timer = setInterval(() => void tick(), 60000)
    timer.unref?.()
    return () => {
      try {
        clearInterval(timer)
      } catch {
        /* 忽略 */
      }
    }
  }, 'dsh-memory-core: idle-extract')

  // 退出前排空（有界）：提取是异步的，插件卸载时给它一段时间收尾
  ctx.effect(
    () => () => {
      if (extractCfg.onDispose === false) return
      const drain = Promise.all([...state.inflight]).catch(() => {})
      const timeout = new Promise((resolve) => {
        const t = setTimeout(resolve, 5000)
        t.unref?.()
      })
      return Promise.race([drain, timeout]).then(() => undefined)
    },
    'dsh-memory-core: drain',
  )

  // ② 两个提示词上下文段：常驻段（低频稳定）+ 按轮卡片（有命中才变）
  const residentCache = { key: null, value: null }
  const residentFor = (cwd) => {
    const reminder = config.resident?.todoReminder === false ? null : state.todos.reminderLine({ cwd })
    const key = `${cwd ?? ''}|${state.store.stamp()}|${reminder ?? ''}|${JSON.stringify(config.resident ?? {})}`
    if (residentCache.key === key) return residentCache.value
    const base = renderResidentSection({ store: state.store, cwd, config })
    const text = [base.text, reminder].filter(Boolean).join('\n')
    const value = { ...base, text, tokens: base.tokens + (reminder ? 20 : 0) }
    residentCache.key = key
    residentCache.value = value
    state.ledger.noteResident(value.tokens)
    return value
  }

  try {
    ctx.inject(['systemPrompt'], (spCtx) => {
      const register = (name, order, text) => {
        try {
          spCtx.systemPrompt.context({ name, order, text })
        } catch (error) {
          // 幂等保护：宿主把插件装配两次时同名段会抛 already registered（旧插件踩过 issue #23）
          if (!String(error?.message ?? '').includes('already registered')) throw error
          console.warn(`[memory-core] 提示词段 ${name} 已注册，跳过重复注册`)
        }
      }
      register('memory-core:resident', config.residentOrder ?? 600, (context) => {
        try {
          return residentFor(context?.agent?.session?.header?.cwd ?? null).text
        } catch {
          return ''
        }
      })
      register('memory-core:recall', config.recallOrder ?? 610, (context) => {
        try {
          const agent = context?.agent
          const sessionId = agent?.session?.id
          const cwd = agent?.session?.header?.cwd ?? null
          const res = renderRecallSection({
            store: state.store,
            recall: state.recall,
            ledger: state.ledger,
            sessionId,
            cwd,
            config,
          })
          state.ledger.noteRecall(sessionId, res)
          const warn = state.watchdog?.warningFor(sessionId) ?? null
          return [warn, res.text].filter(Boolean).join('\n')
        } catch {
          return ''
        }
      })
      // 提示词注入轨：只渲染"本轮该出现"的（countdown===0），由 turn-stopping 推进
      register('memory-core:prompts', config.promptsOrder ?? 620, (context) => {
        try {
          return state.prompts.renderSection(context?.agent?.session?.id ?? null)
        } catch {
          return ''
        }
      })
    })
  } catch (error) {
    console.warn(`[memory-core] 提示词段注入失败（已忽略）：${error.message}`)
  }

  /**
   * 工具注册。**两条装载路径都要能拿到 `tools` 服务**：
   *   - bundles 路径：cordis 读 entry options 的 inject（本模块同时导出了 `inject`）；
   *   - `loader.create` / 热注入路径：entry options 不带 inject，静态导出不被采纳，
   *     此时必须靠 `ctx.inject([...], cb)` 手动注入（否则报
   *     `cannot get property "tools" without inject`）。
   * 注册失败只告警，绝不让宿主加载失败。
   */
  const registerTools = (toolsCtx) => {
    toolsCtx.effect(() => {
      try {
        if (typeof toolsCtx.tools?.register !== 'function') {
          console.warn('[memory-core] 宿主未提供 tools.register，跳过工具注册')
          return () => {}
        }
        const disposers = []
        for (const def of buildTools({
          store: state.store,
          recall: state.recall,
          host: { ...host, latestBackup: latestBackup(backupDir()) },
          config,
          ledger: state.ledger,
          runtime,
        })) {
          disposers.push(toolsCtx.tools.register(def))
          state.tools.push(def.name)
        }
        state.recall.reconfigure(config.recall ?? {})
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose?.()
            } catch {
              /* 忽略卸载异常 */
            }
          }
          state.tools = []
        }
      } catch (error) {
        console.warn(`[memory-core] 工具注册失败（已忽略，不影响宿主）：${error.message}`)
        return () => {}
      }
    }, 'dsh-memory-core: tools')
  }

  try {
    ctx.inject(['tools'], registerTools)
  } catch (error) {
    console.warn(`[memory-core] tools 注入失败（已忽略）：${error.message}`)
  }

  // 库句柄随插件卸载关闭。
  ctx.effect(
    () => () => {
      try {
        closeDb(state.opened.db)
      } catch {
        /* 忽略 */
      }
    },
    'dsh-memory-core: store',
  )
}

export default apply
