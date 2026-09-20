#!/usr/bin/env node
/**
 * dsh-memory-core CLI（M0）：导入 / 导出 / 备份 / 对账 / 重建 / 状态。
 *
 * 用法：
 *   dsh-mem status [--json]
 *   dsh-mem import [--dir <旧记忆目录>] [--json]
 *   dsh-mem export [--dir <导出目录>]
 *   dsh-mem backup  [--keep 7]
 *   dsh-mem verify  [--dir <旧记忆目录>] [--roundtrip]
 *   dsh-mem restore --from <快照目录> [--db <新库路径>]
 *   dsh-mem sql "<query>"
 *
 * 通用参数：`--db <路径>` 覆盖默认库位置。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { backupDaily, closeDb, latestBackup, migrate, openDb, quickCheck } from '../lib/db.js'
import { importLegacy } from '../lib/legacy-import.js'
import { backupDir, dataDir, dbPath as defaultDbPath, ensureDir, legacyMemoryDir, projectHash } from '../lib/paths.js'
import { diffSnapshot, exportSnapshot } from '../lib/snapshot.js'
import { Store } from '../lib/store.js'
import * as tokensModule from '../lib/tokens.js'
import * as recallModule from '../lib/recall.js'
import * as injectModule from '../lib/inject.js'
import * as writerModule from '../lib/writer.js'
import * as extractModule from '../lib/extract.js'
import * as sessionLogModule from '../lib/session-log.js'
import * as promptsModule from '../lib/prompts.js'
import * as evolutionModule from '../lib/evolution.js'
import * as todosModule from '../lib/todos.js'
import * as skillsModule from '../lib/skills.js'
import * as syncModule from '../lib/sync.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i += 1
      } else {
        out[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function openAndMigrate(args) {
  const path = args.db ? resolve(args.db) : defaultDbPath()
  ensureDir(dataDir())
  const db = openDb(path)
  migrate(db, { log: (m) => console.error(`[mem] ${m}`) })
  return { db, path, store: new Store(db) }
}

const fmt = (n) => String(n).padStart(6)

function cmdStatus(args) {
  const { db, path, store } = openAndMigrate(args)
  const counts = store.counts()
  const check = quickCheck(db)
  const backups = latestBackup(backupDir())
  const projects = store.listProjects()
  const report = {
    db: path,
    schemaVersion: store.getMeta('schema_version'),
    device: store.device,
    quickCheck: check,
    latestBackup: backups,
    counts,
    projects,
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`库文件      ${path}`)
    console.log(`schema      v${report.schemaVersion} · device ${report.device}`)
    console.log(`完整性      ${check.ok ? 'ok' : `异常：${check.messages.join('; ')}`}`)
    console.log(`备份        ${backups ? `${backups.name}（${(backups.bytes / 1024).toFixed(0)} KB，共 ${backups.count} 份）` : '尚无'}`)
    console.log(`单元        ${counts.units}（active ${counts.unitsActive} / 归档 ${counts.units - counts.unitsActive}）· FTS ${counts.fts}`)
    console.log(`分轨        ${Object.entries(counts.byTrack).map(([k, v]) => `${k}=${v}`).join(' ') || '（空）'}`)
    console.log(`待办        ${counts.todos}   建议 ${counts.suggestions}   技能 ${counts.skills}   变更 ${counts.changes}`)
    for (const p of projects) console.log(`项目        ${p.hash}  ${p.cwd ?? '（未反查）'}  ${p.label ?? ''}`)
  }
  closeDb(db)
  return check.ok ? 0 : 1
}

function cmdImport(args) {
  const dir = args.dir ? resolve(args.dir) : legacyMemoryDir()
  const { db, store } = openAndMigrate(args)
  const report = importLegacy(store, { dir, log: (m) => console.error(`[mem] ${m}`) })
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`导入源      ${report.dir}`)
    console.log(`项目        ${report.projects.length} 个（反查出 cwd ${report.projects.filter((p) => p.cwd).length} 个）`)
    console.log(`记忆单元    总计 ${report.units.total} · 新增 ${report.units.inserted} · 已存在 ${report.units.skipped}`)
    console.log(`分轨        ${Object.entries(report.units.byTrack).map(([k, v]) => `${k}=${v}`).join(' ') || '（空）'}`)
    console.log(`待办        ${report.todos.total}（新增 ${report.todos.inserted}）`)
    console.log(`建议        ${report.suggestions.total}（新增 ${report.suggestions.inserted}）`)
    console.log(`技能索引    ${report.skills.total}`)
    for (const e of report.errors) console.log(`⚠️  ${e}`)
  }
  closeDb(db)
  return report.errors.length ? 1 : 0
}

function cmdExport(args) {
  const dir = args.dir ? resolve(args.dir) : legacyMemoryDir()
  const { db, store } = openAndMigrate(args)
  const report = exportSnapshot(store, { dir, log: (m) => console.error(`[mem] ${m}`) })
  console.log(`已导出      ${report.files.length} 个文件 → ${report.dir}`)
  console.log(`单元        ${report.units}   待办 ${report.todos}`)
  closeDb(db)
  return 0
}

function cmdBackup(args) {
  const { db, path } = openAndMigrate(args)
  const keep = args.keep ? Number(args.keep) : 7
  const out = backupDaily(db, backupDir(), { keep })
  console.log(`已备份      ${out.file}（${(out.bytes / 1024).toFixed(0)} KB，保留 ${out.kept} 份${out.removed.length ? `，清理 ${out.removed.join(', ')}` : ''}）`)
  console.log(`源库        ${path}`)
  closeDb(db)
  return 0
}

function cmdVerify(args) {
  const dir = args.dir ? resolve(args.dir) : legacyMemoryDir()
  const { db, store } = openAndMigrate(args)
  let failures = 0

  // 1) 源文件条目数 vs 库内计数
  console.log('== 条目数对账 ==')
  const rows = db.prepare('SELECT source_file, COUNT(*) AS n FROM units GROUP BY source_file ORDER BY source_file').all()
  const counts = store.counts()
  console.log(`库内单元 ${counts.units}（active ${counts.unitsActive}）· 待办 ${counts.todos} · 技能 ${counts.skills}`)
  for (const r of rows) console.log(`  ${fmt(r.n)}  ${r.source_file ?? '(未标记)'}`)

  // 2) 导出往返：导出到临时目录后与旧文件逐字比较
  if (args.roundtrip !== false) {
    console.log('== 导出往返对账 ==')
    const tmp = mkdtempSync(join(tmpdir(), 'memcore-verify-'))
    try {
      exportSnapshot(store, { dir: tmp, log: () => {} })
      const diff = diffSnapshot(tmp, dir)
      for (const f of diff.files) {
        const mark = f.status === 'same' ? '✓' : '✗'
        console.log(`  ${mark} ${f.path}${f.detail ? `  ${f.detail}` : ''}`)
        if (f.status !== 'same') failures += 1
      }
      if (!diff.ok) console.log('  （仅统计顶层与 daily 文件；项目文件见下方明细）')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  closeDb(db)
  console.log(failures === 0 ? '对账通过 ✅' : `对账失败 ${failures} 项 ❌`)
  return failures === 0 ? 0 : 1
}

function cmdRestore(args) {
  const from = args.from ? resolve(args.from) : null
  if (!from || !existsSync(from)) {
    console.error('用法：dsh-mem restore --from <快照目录> [--db <新库路径>]')
    return 2
  }
  const target = args.db ? resolve(args.db) : join(dataDir(), 'restored.db')
  if (existsSync(target)) rmSync(target)
  const db = openDb(target)
  migrate(db)
  const store = new Store(db)
  const report = importLegacy(store, { dir: from, log: () => {} })
  const counts = store.counts()
  console.log(`已从快照重建 ${target}`)
  console.log(`单元 ${counts.units}（新增 ${report.units.inserted}）· 待办 ${counts.todos} · 技能 ${counts.skills}`)
  closeDb(db)
  return report.units.total === report.units.inserted ? 0 : 1
}

function cmdSql(args) {
  const query = args._.join(' ')
  if (!query) {
    console.error('用法：dsh-mem sql "<query>"')
    return 2
  }
  const { db } = openAndMigrate(args)
  const rows = db.prepare(query).all()
  console.log(JSON.stringify(rows, null, 2))
  closeDb(db)
  return 0
}

function cmdSearch(args) {
  const query = args._.join(' ')
  if (!query) {
    console.error('用法：dsh-mem search "<查询>" [--k 8] [--raw] [--scope <scope>|<all>] [--json]')
    return 2
  }
  const { db, store } = openAndMigrate(args)
  const k = args.k ? Number(args.k) : 8

  if (args.raw) {
    const match = tokensModule.ftsQuery(query, { maxTerms: args.maxTerms ? Number(args.maxTerms) : 40 })
    if (!match) {
      console.log('（查询为空）')
      closeDb(db)
      return 0
    }
    const rows = db
      .prepare(
        `SELECT u.id, u.track, u.kind, u.created_at, u.content, bm25(units_fts) AS score
           FROM units_fts JOIN units u ON u.rowid = units_fts.rowid
          WHERE units_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(match, k)
    console.log(`[C1 原始词法] 「${query}」命中 ${rows.length} 条`)
    for (const r of rows) {
      console.log(`  [${r.id}] ${r.track} · ${r.kind ?? '-'}  ${r.content.replace(/\s+/g, ' ').slice(0, 96)}…`)
    }
    closeDb(db)
    return 0
  }

  const { Recall } = recallModule
  const engine = new Recall(store, { k })
  const res = engine.search({ query, scopes: args.scope ?? 'all', k })
  if (args.json) {
    console.log(JSON.stringify(res, null, 2))
  } else {
    console.log(`查询「${query}」→ ${res.hits.length} 条（${res.ms} ms，保底席位 ${res.baselineSeats}${res.degraded.length ? `，降级 ${res.degraded.join('、')}` : ''}）`)
    for (const h of res.hits) {
      console.log(`  #${h.rank} [${h.id}] ${h.track ?? '-'} · ${h.kind ?? '-'} · 通道 ${Object.keys(h.channels).join('+')}  ${h.snippet.slice(0, 88)}…`)
    }
    console.log(`证据：${res.evidence.inject ? '达标（可注入）' : '不足'}`)
    for (const r of res.evidence.reasons.slice(0, 5)) console.log(`  · ${r}`)
  }
  closeDb(db)
  return 0
}

function cmdDiag(args) {
  const query = args._.join(' ')
  if (!query) {
    console.error('用法：dsh-mem diag "<查询>" [--k 8] [--json]')
    return 2
  }
  const { db, store } = openAndMigrate(args)
  const { Recall } = recallModule
  const engine = new Recall(store)
  const diag = engine.diag(query, { scopes: args.scope ?? 'all', limit: args.k ? Number(args.k) : 8 })
  if (args.json) console.log(JSON.stringify(diag, null, 2))
  else console.log(diag.formatter())
  closeDb(db)
  return 0
}

function cmdInject(args) {
  const { db, store } = openAndMigrate(args)
  const { Recall } = recallModule
  const { InjectionLedger, renderResidentSection, renderRecallSection, estimateTokens } = injectModule
  const recall = new Recall(store, args.k ? { k: Number(args.k) } : {})
  const cwd = args.cwd ? String(args.cwd) : process.cwd()
  const query = args._.join(' ')

  const resident = renderResidentSection({ store, cwd, config: {} })
  const ledger = new InjectionLedger()
  const sessionId = 'cli-preview'
  let cards = { text: '', tokens: 0, cards: 0, injected: false, reason: 'no-query' }
  if (query) {
    ledger.noteUserMessage(sessionId, query)
    cards = renderRecallSection({ store, recall, ledger, sessionId, cwd, config: {} })
  }
  // 第二轮：同一 query 再次渲染必须完全一致（不能重复消费卡片）
  const again = query ? renderRecallSection({ store, recall, ledger, sessionId, cwd, config: {} }) : null

  const report = {
    cwd,
    resident: { tokens: resident.tokens, rules: resident.rules, catalog: resident.catalog, rulesTokens: resident.rulesTokens, catalogTokens: resident.catalogTokens },
    recall: { tokens: cards.tokens, cards: cards.cards, injected: cards.injected, reason: cards.reason },
    stableWithinTurn: again ? again.text === cards.text : null,
    budgets: { resident: 1200, recall: 400 },
    withinBudget: resident.tokens <= 1200 && cards.tokens <= 400 && (again ? again.text === cards.text : true),
  }
  if (args.json) {
    console.log(JSON.stringify({ ...report, residentText: resident.text, recallText: cards.text }, null, 2))
  } else {
    console.log(`注入预览（cwd=${cwd}）`)
    console.log(`  常驻段 ${resident.tokens} token（规则 ${resident.rules} 条 / 目录 ${resident.catalog} 条；预算 1200）`)
    console.log(`  按轮卡片 ${cards.tokens} token / ${cards.cards} 张（预算 400，判定：${cards.injected ? '注入' : cards.reason}）`)
    console.log(`  同轮稳定性：${report.stableWithinTurn === null ? '（未给 query）' : report.stableWithinTurn ? '✓ 同一 query 渲染一致' : '✗ 渲染抖动'}`)
    console.log(`  预算合规：${report.withinBudget ? '✓' : '✗'}（estimateTokens 保守偏高）`)
    console.log('\n──── 常驻段 ────')
    console.log(resident.text)
    if (cards.text) {
      console.log('\n──── 按轮卡片 ────')
      console.log(cards.text)
    }
  }
  closeDb(db)
  return report.withinBudget ? 0 : 1
}

function cmdWrite(args) {
  const content = args._.join(' ')
  if (!content) {
    console.error('用法：dsh-mem write "<内容>" [--track memory|key|project|daily|user] [--kind rule|fact|decision|pitfall|env|preference|progress] [--cwd <路径>] [--direct]')
    return 2
  }
  const { db, store } = openAndMigrate(args)
  const { Recall } = recallModule
  const { writeMemory } = writerModule
  const recall = new Recall(store)
  const res = writeMemory({
    store,
    recall,
    cwd: args.cwd ?? process.cwd(),
    input: { content, track: args.track, kind: args.kind, tags: args.tag ? String(args.tag).split(',') : undefined },
    origin: 'cli',
    force: args.direct === true,
  })
  console.log(`${res.status}${res.reason ? ` · ${res.reason}` : ''}${res.id ? ` · ${res.id}` : ''}`)
  if (res.candidates?.length) {
    for (const c of res.candidates.slice(0, 3)) console.log(`  相近 [mem:${c.id}] 相似度 ${c.similarity}  ${c.snippet.slice(0, 60)}`)
  }
  closeDb(db)
  return res.status === 'rejected' ? 1 : 0
}

function cmdUpdate(args) {
  const id = args.id ?? args._[0]
  if (!id) {
    console.error('用法：dsh-mem update <id> [--content "<新文案>"] [--track key] [--kind rule] [--action archive|restore|pin|unpin] [--reason "<原因>"]')
    return 2
  }
  const { db, store } = openAndMigrate(args)
  const row = store.getUnit(id)
  if (!row) {
    console.error(`未找到条目 ${id}`)
    closeDb(db)
    return 1
  }
  const action = args.action ?? 'edit'
  if (['archive', 'restore', 'pin', 'unpin'].includes(action)) {
    const status = action === 'archive' ? 'archived' : action === 'restore' ? 'active' : null
    const pinned = action === 'pin' ? 1 : action === 'unpin' ? 0 : null
    store.db
      .prepare('UPDATE units SET status = COALESCE(?, status), pinned = COALESCE(?, pinned), updated_at = ?, lamport = lamport + 1 WHERE id = ?')
      .run(status, pinned, Date.now(), id)
    store.logChange('unit', id, 'status', { status, pinned })
    console.log(`${id}：${action} 完成`)
  } else {
    const res = store.updateUnit(id, { content: args.content, track: args.track, kind: args.kind, reason: args.reason ?? 'cli edit', editedBy: 'cli' })
    if (!res.ok) {
      console.error(res.message)
      closeDb(db)
      return 1
    }
    console.log(`${id} 已更新到 v${res.version}（旧版本已留档）`)
  }
  closeDb(db)
  return 0
}

function cmdReview(args) {
  const action = args.action ?? args._[0] ?? 'list'
  const { db, store } = openAndMigrate(args)
  const { approveSuggestion, rejectSuggestion, archiveSuggestion, sweepSuggestions } = writerModule
  if (action === 'list') {
    const pending = store.listSuggestions({ status: args.status ?? 'pending', limit: Number(args.limit ?? 50) })
    console.log(`待确认 ${pending.length} 条（status=${args.status ?? 'pending'}）`)
    for (const row of pending) {
      let p = {}
      try {
        p = JSON.parse(row.payload)
      } catch {
        p = {}
      }
      console.log(`  [${row.id}] ${row.kind}/${p.track ?? row.target ?? '-'} · ${String(p.content ?? '').replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  } else if (action === 'sweep') {
    const res = sweepSuggestions({ store, autoArchiveDays: Number(args.days ?? 14) })
    console.log(`已归档超期建议 ${res.archived} 条`)
  } else {
    const ids = String(args.id ?? args._[1] ?? '').split(',').filter(Boolean)
    if (ids.length === 0) {
      console.error('用法：dsh-mem review approve|reject|archive <id[,id]> [--track key] [--content "<改后文案>"] [--reason "<原因>"]')
      closeDb(db)
      return 2
    }
    for (const id of ids) {
      // 采纳 project/key 轨时按「当前项目」落 scope（--cwd 优先，缺省用命令所在目录），
      // 与面板一致：不沿用建议产生时那个项目的作用域
      const projectScope = `project:${projectHash(args.cwd ?? process.cwd())}`
      const res =
        action === 'approve'
          ? approveSuggestion({ store, id, overrides: { track: args.track, content: args.content, kind: args.kind }, decidedBy: 'cli', projectScope })
          : action === 'reject'
            ? rejectSuggestion({ store, id, reason: args.reason, decidedBy: 'cli' })
            : archiveSuggestion({ store, id, decidedBy: 'cli' })
      console.log(res.ok ? `${action} ${id} ✓${res.id ? ` → [mem:${res.id}]` : ''}` : `${action} ${id} ✗ ${res.message}`)
    }
  }
  closeDb(db)
  return 0
}

function cmdExtract(args) {
  const sessionId = args.session ?? args._[0]
  const { db, store } = openAndMigrate(args)
  const { readTranscriptFromLog, findSessionLog, renderTranscript } = sessionLogModule
  const { buildExtractRequest, EXTRACT_DEFAULTS, parseExtraction, extractJson } = extractModule

  // 无 --session 时：列出"该提取但还没提取"的会话（游标 + 空闲判定）
  if (!sessionId) {
    const rows = store.db
      .prepare('SELECT id, scope, ingest_cursor, last_seen, last_extract_at, turns_processed FROM sessions ORDER BY last_seen DESC LIMIT 20')
      .all()
    console.log(`会话账本 ${rows.length} 条（最近 20）`)
    for (const r of rows) {
      const idleMin = r.last_seen ? ((Date.now() - r.last_seen) / 60000).toFixed(1) : '-'
      console.log(`  ${r.id}  空闲 ${idleMin} 分钟 · 游标 ${r.ingest_cursor ?? 0} · 已处理轮次 ${r.turns_processed ?? 0} · 上次提取 ${r.last_extract_at ? new Date(r.last_extract_at).toISOString().slice(11, 19) : '从未'}`)
    }
    console.log('\n提示：实际提取由宿主插件执行（需要模型路由）；离线会话可用 --session <id> --dry-run 预览提示词。')
    closeDb(db)
    return 0
  }

  const file = findSessionLog(sessionId)
  if (!file) {
    console.error(`未找到会话日志：${sessionId}`)
    closeDb(db)
    return 1
  }
  const t = readTranscriptFromLog(file, { maxMessages: Number(args.turns ?? 20) })
  const transcript = renderTranscript(t.messages, { maxChars: Number(args.maxChars ?? EXTRACT_DEFAULTS.maxTranscriptChars) })
  const req = buildExtractRequest({ transcript, maxItems: Number(args.max ?? EXTRACT_DEFAULTS.maxItemsPerRun) })
  console.log(`会话 ${sessionId}`)
  console.log(`  日志帧 ${t.frames} · 事件 ${t.events} · 转录消息 ${t.messages.length} · 转写字符 ${transcript.length}`)
  console.log(`  模型调用（宿主执行）：effort=${EXTRACT_DEFAULTS.distill.reasoningEffort} maxTokens=${EXTRACT_DEFAULTS.distill.maxTokens}`)
  console.log(`  提示词字符数：system ${req.system.length} / user ${req.messages[0].content[0].text.length}`)
  if (args.json) console.log(JSON.stringify({ sessionId, transcript, request: req }, null, 2))
  else if (args.show) {
    console.log('\n──── 转录 ────')
    console.log(transcript.slice(-2000))
    console.log('\n──── 提示词（user）────')
    console.log(req.messages[0].content[0].text.slice(0, 1200))
  }
  closeDb(db)
  return 0
}

function cmdPrompts(args) {
  const sub = args.action ?? args._[0] ?? 'list'
  const { db, store } = openAndMigrate(args)
  const { PromptManager } = promptsModule
  const pm = new PromptManager(store)
  const rest = args._.slice(1)

  if (sub === 'list') {
    const items = pm.listPrompts({ category: args.category, tag: args.tag, q: args.q ?? (rest.join(' ') || null), enabledOnly: args.all !== true })
    console.log(`提示词 ${items.length} 条（${args.all === true ? '含禁用' : '仅启用'}）`)
    for (const p of items) console.log(`  [${p.id}] ${p.name}（${p.category}）uses=${p.uses}${p.summary ? ` · ${p.summary}` : ''}`)
  } else if (sub === 'categories') {
    for (const c of pm.listCategories()) console.log(`  ${c.name}${c.builtin ? '（内置）' : ''}`)
  } else if (sub === 'seed') {
    const res = pm.importSeed()
    console.log(`种子库写入 ${res.imported} 条`)
  } else if (sub === 'import') {
    const file = args.from ?? rest[0]
    if (!file) {
      console.error('用法：dsh-mem prompts import --from <旧 prompts.json>')
      closeDb(db)
      return 2
    }
    const res = pm.importLegacy(file)
    console.log(res.ok ? `导入 ${res.imported}/${res.total} 条` : res.message)
  } else if (sub === 'show') {
    const p = pm.getPrompt(args.id ?? rest[0])
    if (!p) {
      console.error('未找到')
      closeDb(db)
      return 1
    }
    console.log(`# ${p.name}（${p.category}）id=${p.id} 启用=${p.enabled} uses=${p.uses}`)
    if (p.summary) console.log(`简介：${p.summary}`)
    const active = pm.activeFor(p.id)
    if (active.length) console.log(`注入中：${active.map((i) => `${i.id}(${i.rounds_left === null ? '持续' : `剩 ${i.rounds_left}`}/每 ${i.every} 回合, countdown ${i.countdown})`).join('、')}`)
    console.log('\n' + p.body)
  } else if (sub === 'add') {
    const body = args.body ?? rest.join(' ')
    const res = pm.createPrompt({ name: args.name, summary: args.summary ?? '', category: args.category ?? '临时', tags: args.tag ? String(args.tag).split(',') : [], body })
    console.log(res.ok ? `已创建 ${res.id}` : res.message)
  } else if (sub === 'edit') {
    const res = pm.updatePrompt(args.id ?? rest[0], { name: args.name, summary: args.summary, category: args.category, body: args.body, tags: args.tag ? String(args.tag).split(',') : undefined })
    console.log(res.ok ? `已更新 ${res.id}` : res.message)
  } else if (sub === 'enable' || sub === 'disable') {
    const res = pm.setEnabled(args.id ?? rest[0], sub === 'enable')
    console.log(res.ok ? `${sub} 完成` : res.message)
  } else if (sub === 'inject') {
    const p = pm.getPrompt(args.id ?? rest[0])
    if (!p) {
      console.error('未找到提示词')
      closeDb(db)
      return 1
    }
    const res = pm.createInjection({
      promptId: p.id,
      title: args.name ?? p.name,
      content: args.body ?? p.body,
      rounds: args.rounds !== undefined ? Number(args.rounds) : 1,
      every: args.every !== undefined ? Number(args.every) : 1,
      sessionId: args.session ?? null,
    })
    console.log(res.ok ? `已注入 ${res.id}（${res.roundsLeft === null ? '持续' : `出现 ${res.roundsLeft} 次`}/每 ${res.every} 回合）` : res.message)
  } else if (sub === 'stop') {
    if (args.all === true) {
      const res = pm.stopAll({ sessionId: args.session ?? undefined })
      console.log(`已停止 ${res.stopped} 条`)
    } else {
      const res = pm.stopInjection(args.id ?? rest[0])
      console.log(res.ok ? '已停止' : '未找到该注入')
    }
  } else if (sub === 'active') {
    const rows = pm.listInjections({ sessionId: args.session ?? undefined, activeOnly: true })
    console.log(`活跃注入 ${rows.length} 条`)
    for (const i of rows) {
      console.log(`  [${i.id}] ${i.title} · ${i.rounds_left === null ? '持续' : `剩 ${i.rounds_left}`} · 每 ${i.every} 回合 · countdown ${i.countdown} · 会话 ${i.session_id ?? '全局'}`)
    }
  } else if (sub === 'render') {
    const text = pm.renderSection(args.session ?? null)
    console.log(text || '（本轮无注入）')
  } else {
    console.error('用法：dsh-mem prompts list|show|add|edit|enable|disable|inject|stop|active|render|categories|seed|import')
    closeDb(db)
    return 2
  }
  closeDb(db)
  return 0
}

async function cmdEvolve(args) {
  const { db, store } = openAndMigrate(args)
  const { runEvolution, EVOLVE_DEFAULTS } = evolutionModule
  const config = {
    ...EVOLVE_DEFAULTS,
    decayHalfLifeDays: args.halfLife ? Number(args.halfLife) : EVOLVE_DEFAULTS.decayHalfLifeDays,
    archiveBelow: args.archiveBelow ? Number(args.archiveBelow) : EVOLVE_DEFAULTS.archiveBelow,
  }
  const report = await runEvolution({ store, config, log: (m) => console.error(`[mem] ${m}`) })
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`演化巡演 @ ${report.at}`)
    for (const step of report.steps) {
      if (step.step === 'reinforce') console.log(`  强化：扫描 ${step.scanned} 条召回记录 → 加权 ${step.boosted} 条，建 coRetrieval 边 ${step.edges}`)
      else if (step.step === 'reconcile') console.log(`  调和：比较 ${step.pairs} 对 → 合并 ${step.merged}，标记冲突 ${step.conflicts}`)
      else if (step.step === 'decay') console.log(`  衰减：扫描 ${step.scanned} 条 → 调整 ${step.decayed}，归档 ${step.archived}`)
      else if (step.step === 'abstract') console.log(`  抽象：${step.created ?? 0} 条新抽象${step.reason ? `（${step.reason}）` : ''}`)
      else console.log(`  ${JSON.stringify(step)}`)
    }
  }
  closeDb(db)
  return 0
}

function cmdTodo(args) {
  const sub = args.action ?? args._[0] ?? 'list'
  const { db, store } = openAndMigrate(args)
  const { TodoManager } = todosModule
  const tm = new TodoManager(store)
  const rest = args._.slice(1)
  const cwd = args.cwd ?? process.cwd()

  if (sub === 'list') {
    const rows = tm.list({
      track: args.track ?? null,
      cwd,
      status: args.status ?? null,
      all: args.all === true,
      past: args.past === true,
      expired: args.expired === true,
      limit: Number(args.limit ?? (args.all === true ? 200 : 8)),
    })
    console.log(`${args.all === true ? '全部未完成' : '需要关注'} ${rows.length} 条`)
    for (const r of rows) {
      const bits = [r.track, r.quadrant, r.due ? `due ${r.due}` : null, r.status !== 'pending' ? r.status : null].filter(Boolean)
      console.log(`  [${r.id}] ${r.content.replace(/\s+/g, ' ').slice(0, 90)}  （${bits.join(' · ')}）`)
    }
  } else if (sub === 'add') {
    const res = tm.add({ content: args.content ?? rest.join(' '), track: args.track ?? 'work', due: args.due || null, category: args.cat ?? null, quadrant: args.q1 ? 'q1' : undefined, cwd, origin: 'cli' })
    console.log(res.ok ? `已添加 [${res.id}]（${res.track}${res.day ? ` ${res.day}` : ''}）` : res.message)
  } else if (sub === 'done' || sub === 'remove') {
    const res = sub === 'done' ? tm.done(args.id ?? rest[0]) : tm.remove(args.id ?? rest[0])
    console.log(res.ok ? `${sub} 完成 [${res.id}]` : res.message)
  } else if (sub === 'update') {
    const res = tm.update(args.id ?? rest[0], { content: args.content, status: args.status, due: args.due === undefined ? undefined : args.due || null, category: args.cat, important: args.important, urgent: args.urgent })
    console.log(res.ok ? `已更新 [${res.id}]` : res.message)
  } else if (sub === 'remind') {
    console.log(tm.reminderLine({ cwd }) ?? '（无到期待办）')
  } else if (sub === 'stats') {
    console.log(JSON.stringify(tm.stats(), null, 2))
  } else if (sub === 'export') {
    const dir = args.dir ?? null
    const rows = tm.list({ all: true, limit: 500 })
    const groups = new Map()
    for (const r of rows) {
      const key = r.track === 'project' ? `projects/${String(r.scope).slice('project:'.length)}/TODOS.md` : r.track === 'daily' ? `daily/${r.day}.todo.md` : r.track === 'life' ? 'TODOS-life.md' : 'TODOS-work.md'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(todosModule.stampTodoLine(r))
    }
    for (const [rel, list] of groups) {
      const target = dir ? join(dir, rel) : rel
      if (dir) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, `${list.join('\n§\n')}\n`, 'utf8')
      }
      console.log(`  ${rel}：${list.length} 条${dir ? ` → ${target}` : '（未指定 --dir，仅预览）'}`)
    }
  } else {
    console.error('用法：dsh-mem todo list|add|done|update|remove|remind|stats|export [--all] [--past --expired] [--track project] [--cwd <路径>] [--due YYYY-MM-DD] [--q1] [--cat 分类]')
    closeDb(db)
    return 2
  }
  closeDb(db)
  return 0
}

function cmdSkill(args) {
  const sub = args.action ?? args._[0] ?? 'list'
  const { db, store } = openAndMigrate(args)
  const { SkillManager } = skillsModule
  const sm = new SkillManager(store, { dir: args.dir ?? null })
  const rest = args._.slice(1)
  if (sub === 'list') {
    sm.scan()
    const rows = sm.list({ q: args.q ?? null, enabledOnly: args.all !== true, source: args.source ?? null })
    console.log(`技能 ${rows.length} 个${args.all === true ? '（含禁用）' : '（仅启用）'}`)
    for (const r of rows) console.log(`  ${r.enabled ? '✓' : '✗'} ${r.name} [${r.source}]${r.description ? ` · ${r.description}` : ''}`)
  } else if (sub === 'read') {
    const res = sm.read(args.name ?? rest[0])
    console.log(res.ok ? `# ${res.name}\n${res.body}` : res.message)
  } else if (sub === 'enable' || sub === 'disable') {
    const res = sm.setEnabled(args.name ?? rest[0], sub === 'enable')
    console.log(res.ok ? `${sub} 完成：${res.name}（写 frontmatter disable-model-invocation）` : res.message)
  } else if (sub === 'scan') {
    const res = sm.scan()
    console.log(`扫描 ${res.scanned} 个目录，索引 ${res.indexed} 个技能`)
  } else if (sub === 'pending') {
    const rows = sm.pendingSuggestions()
    console.log(`待确认技能建议 ${rows.length} 条`)
    for (const r of rows) console.log(`  [${r.id}] ${r.payload.slice(0, 120)}`)
  } else {
    console.error('用法：dsh-mem skill list|read|enable|disable|scan|pending [--q 关键词] [--all] [--dir <技能目录>]')
    closeDb(db)
    return 2
  }
  closeDb(db)
  return 0
}

function cmdSync(args) {
  const sub = args._[0] ?? 'status'
  const { db, store } = openAndMigrate(args)
  const { SyncEngine } = syncModule
  const dir = args.dir ?? join(dataDir(), 'changes')
  const engine = new SyncEngine(store, { dir })
  if (sub === 'export') {
    const res = engine.exportChanges({ limit: Number(args.limit ?? 5000) })
    console.log(`导出 ${res.written} 条 → ${res.file}（游标 ${res.cursor}）`)
  } else if (sub === 'import') {
    const res = engine.importChanges()
    console.log(`扫描 ${res.scanned} 行：应用 ${res.applied} · 跳过 ${res.skipped} · 冲突双留 ${res.conflicts} · 异常 ${res.bad}`)
    for (const [entity, n] of Object.entries(res.touched ?? {})) console.log(`  ${entity}: ${n}`)
  } else if (sub === 'status') {
    const st = engine.status()
    console.log(`设备 ${st.device} · lamport ${st.lamport} · 待导出 ${st.pendingExport} · 冲突累计 ${st.conflicts}`)
    console.log(`日志目录 ${st.dir}`)
    for (const f of st.files) console.log(`  ${f.mine ? '*' : ' '} ${f.device}：${f.lines} 行 / ${f.bytes} 字节`)
  } else {
    console.error('用法：dsh-mem sync export|import|status [--dir <日志目录>]')
    closeDb(db)
    return 2
  }
  closeDb(db)
  return 0
}

const COMMANDS = {
  sync: cmdSync,
  evolve: cmdEvolve,
  todo: cmdTodo,
  skill: cmdSkill,
  status: cmdStatus,
  import: cmdImport,
  export: cmdExport,
  backup: cmdBackup,
  verify: cmdVerify,
  restore: cmdRestore,
  search: cmdSearch,
  diag: cmdDiag,
  inject: cmdInject,
  write: cmdWrite,
  update: cmdUpdate,
  review: cmdReview,
  extract: cmdExtract,
  prompts: cmdPrompts,
  sql: cmdSql,
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(Object.keys(COMMANDS).map((c) => `  dsh-mem ${c}`).join('\n'))
    return 0
  }
  const handler = COMMANDS[cmd]
  if (!handler) {
    console.error(`未知命令：${cmd}`)
    return 2
  }
  return handler(parseArgs(rest)) ?? 0
}

// async 子命令（如 evolve）返回 Promise：不能直接赋给 process.exitCode
const outcome = main()
if (outcome instanceof Promise) {
  outcome.then((code) => {
    process.exitCode = code ?? 0
  }).catch((error) => {
    console.error(`[mem] ${error?.stack ?? error}`)
    process.exitCode = 1
  })
} else {
  process.exitCode = outcome ?? 0
}
