#!/usr/bin/env node
/**
 * 新功能自检（v0.0.16–v0.0.18）：一条命令验证五项能力是否真的生效。
 *
 *   node scripts/verify-features.mjs            # 功能自检 + 真实库快照
 *   node scripts/verify-features.mjs --live-only # 只看真实库现状，不跑功能自检
 *
 * 设计原则：**在临时库上跑真实代码路径**，绝不写真实库（$DSH_HOME/memory-core/mem.db）。
 * 真实库那部分一律 `readOnly: true` 打开，只读快照。
 *
 * 为什么要有它：这几项能力里有两项曾在"274 项测试全绿"的情况下于真机不可用
 * （mem_status 输出契约、runEvolution 调用点接线），所以"跑测试"不等于"功能在跑"。
 * 本脚本从**使用者的入口**（工具定义、段渲染、后台巡演）反向验证副作用是否真的发生。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { artifactStats, fingerprint, verifyArtifacts } from '../lib/artifacts.js'
import { closeDb, currentVersion, migrate, openDb } from '../lib/db.js'
import { EVOLVE_DEFAULTS, reinforce, runEvolution } from '../lib/evolution.js'
import { renderSkeletonSection } from '../lib/inject.js'
import { extractNodes, loadNodes, upsertNodes, MAX_CONSTRAINTS } from '../lib/skeleton.js'
import { classifyText } from '../lib/skeleton.js'
import { Store } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { Recall } from '../lib/recall.js'
import { sweepSuggestions } from '../lib/writer.js'
import { dbPath } from '../lib/paths.js'

const results = []
const liveOnly = process.argv.includes('--live-only')

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail })
    return true
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
    return false
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** 临时库：跑真实代码路径，不碰真实库。 */
function tmpFixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-verify-')), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db) }
}

// ─────────────────────────────────────────────────────────────
// 一、功能自检（在临时库上跑真实路径）
// ─────────────────────────────────────────────────────────────
if (!liveOnly) {
  check('schema v5：nodes / node_edges 表与 suggestions.support 列', () => {
    const { db } = tmpFixture()
    const v = currentVersion(db)
    assert(v === 5, `schema_version 应为 5，实际 ${v}`)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','node_edges')")
      .all()
      .map((r) => r.name)
    assert(tables.length === 2, `缺表：${JSON.stringify(tables)}`)
    const cols = db
      .prepare('PRAGMA table_info(suggestions)')
      .all()
      .map((c) => c.name)
    assert(cols.includes('support') && cols.includes('last_seen_at'), 'suggestions 缺 support/last_seen_at')
    closeDb(db)
    return 'v5 / 2 表 / 2 列'
  })

  check('会话骨架：机械抽取 → 落库 → 确定性投影', () => {
    const { db, store } = tmpFixture()
    const nodes = extractNodes([{ role: 'user', text: '不要改 package.json，锁文件必须原样。我们决定改用 anchor 而不是摘要。已修复分页越界。' }])
    assert(nodes.length >= 2, `应抽出 ≥2 个节点，实际 ${nodes.length}`)
    const constraint = nodes.find((n) => n.kind === 'constraint')
    assert(constraint && constraint.pin === 1, '约束应置 pin=1')
    upsertNodes(store, { sessionId: 'verify', nodes })
    const a = renderSkeletonSection({ store, sessionId: 'verify' })
    const b = renderSkeletonSection({ store, sessionId: 'verify' })
    assert(a.text.length > 0, '投影不应为空')
    assert(a.text === b.text, '同图状态必须投影出同一字节串（确定性）')
    assert(renderSkeletonSection({ store, sessionId: 'nobody' }).text === '', '空图必须发空串')
    closeDb(db)
    return `${nodes.length} 节点 / ${a.tokens} token`
  })

  check('骨架防自反馈：类型标签被剥离、标题/工具提醒不被抽', () => {
    const stripped = extractNodes([{ role: 'user', text: '- 进度: 已提交并推送完成。' }])
    assert(stripped[0]?.content === '已提交并推送完成。', `前缀未剥离：${stripped[0]?.content}`)
    for (const line of ['## 设计稿（权威依据，必须先读）', '(上一步工具「x」可能未完成, 先确认状态再继续)']) {
      assert(classifyText(line).length === 0, `噪声行被抽成节点：${line}`)
    }
    const many = extractNodes([{ role: 'user', text: Array.from({ length: 20 }, (_, i) => `约束${i}：不要动配置，必须原样。`).join('\n') }])
    const cs = many.filter((n) => n.kind === 'constraint').length
    assert(cs <= MAX_CONSTRAINTS, `约束应 ≤${MAX_CONSTRAINTS}，实际 ${cs}`)
    closeDb
    return `上限 ${MAX_CONSTRAINTS} 生效`
  })

  check('权重水位：同一激活跨多轮巡演只计一次（importance 不虚高）', () => {
    const { db, store } = tmpFixture()
    const u = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则：提交前跑 lint。' })
    store.db.prepare('UPDATE units SET importance = 0.2, access_count = 0 WHERE id = ?').run(u.id)
    store.db
      .prepare('INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected) VALUES (?,?,?,?,?,?,?,?)')
      .run(Date.now(), 's', 'q', u.id, 'lexical', 1, 0.9, 1)
    const first = reinforce({ store })
    const imp1 = Number(store.getUnit(u.id).importance)
    const cnt1 = Number(store.getUnit(u.id).access_count)
    const second = reinforce({ store })
    assert(first.boosted === 1, `首轮应强化 1 条，实际 ${first.boosted}`)
    assert(second.boosted === 0, `无新激活不应再强化，实际 ${second.boosted}`)
    assert(Number(store.getUnit(u.id).importance) === imp1, 'importance 不得重复累加')
    assert(Number(store.getUnit(u.id).access_count) === cnt1, 'access_count 不得虚高')
    assert(store.getMeta('evolve_reinforce_rowid', null) !== null, '水位应已推进')
    closeDb(db)
    return `imp=${imp1.toFixed(2)} count=${cnt1}`
  })

  check('产物指纹：基线 → changed → missing（advisory，不动权重）', () => {
    const { db, store } = tmpFixture()
    const dir = mkdtempSync(join(tmpdir(), 'memcore-verify-art-'))
    const file = join(dir, 'a.js')
    writeFileSync(file, 'v1')
    const u = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `改动在 \`${file}\`。` })
    const imp0 = Number(store.getUnit(u.id).importance)
    const r1 = verifyArtifacts(store, { cwd: dir, limit: 20 })
    assert(r1.baselined >= 1, `应建基线，实际 ${JSON.stringify(r1)}`)
    writeFileSync(file, 'v2-changed')
    assert(verifyArtifacts(store, { cwd: dir, limit: 20 }).changed >= 1, '改文件应检出 changed')
    rmSync(file)
    assert(verifyArtifacts(store, { cwd: dir, limit: 20 }).missing >= 1, '删文件应检出 missing')
    const after = store.getUnit(u.id)
    assert(after.status === 'active', '不得因失效归档')
    assert(Number(after.importance) === imp0, '不得因失效改权重')
    // 状态必须落在 meta 表（不是 units.meta —— 那是同步载荷）
    assert(store.getMeta(`artifact:${u.id}`, null), '状态应存 meta 表')
    closeDb(db)
    return 'baseline/changed/missing'
  })

  check('产物栅栏：敏感目录 / 软链 / 越根目录一律跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memcore-verify-guard-'))
    const target = join(dir, 'real.js')
    writeFileSync(target, 'x')
    const link = join(dir, 'link.js')
    symlinkSync(target, link)
    const f = fingerprint(link, { cwd: dir })
    assert(f.skipped === 'symlink', `软链应跳过，实际 ${JSON.stringify(f)}`)
    const s = fingerprint(join(process.env.HOME ?? '~', '.ssh', 'id_rsa'))
    if (s) assert(s.skipped === 'sensitive', `敏感路径应跳过，实际 ${JSON.stringify(s)}`)
    return 'symlink/sensitive/outside-root'
  })

  check('队列支持度：同主体跨会话合并为一行并累加', () => {
    const { db, store } = tmpFixture()
    for (const [i, origin] of ['session:A#1', 'session:B#2', 'session:C#3'].entries()) {
      store.insertSuggestion({
        kind: 'memory',
        target: 'memory',
        payload: { content: '提交前必须跑 node --test。', track: 'memory', origin, cwd: `/tmp/p${i}`, relation: { relation: 'unrelated', candidates: [{ id: `x${i}`, similarity: 0.1 }] } },
      })
    }
    const rows = store.listSuggestions({ status: 'pending' })
    assert(rows.length === 1, `应合并为 1 行，实际 ${rows.length}`)
    assert(Number(rows[0].support) === 3, `support 应为 3，实际 ${rows[0].support}`)
    closeDb(db)
    return 'origin 不同仍合并 / support=3'
  })

  check('清扫两档：support 高只给更长宽限，不是永久免疫', () => {
    const { db, store } = tmpFixture()
    const now = Date.now()
    const old = now - 200 * 86400000
    const s = { kind: 'memory', target: 'memory', payload: { content: '很久以前反复提过的事。' }, createdAt: old }
    const kept = store.insertSuggestion(s)
    store.insertSuggestion(s)
    store.insertSuggestion(s)
    store.db.prepare('UPDATE suggestions SET last_seen_at = ? WHERE id = ?').run(old, kept.id)
    sweepSuggestions({ store, autoArchiveDays: 14, now })
    const archived = store.listSuggestions({ status: 'archived' }).some((r) => r.id === kept.id)
    assert(archived, '超过二级宽限期仍应归档（不能永久挂 pending）')
    closeDb(db)
    return '14 天 / 90 天两档'
  })

  await checkAsync('后台巡演：runEvolution 四步全 ok，artifacts 真实写入', async () => {
    const { db, store } = tmpFixture()
    const dir = mkdtempSync(join(tmpdir(), 'memcore-verify-run-'))
    const file = join(dir, 'a.js')
    writeFileSync(file, 'v1')
    const u = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `改动在 \`${file}\`。` })
    const report = await runEvolution({ store, config: { ...EVOLVE_DEFAULTS, artifactCwd: dir } })
    for (const step of ['reinforce', 'reconcile', 'decay', 'artifacts']) {
      const got = report.steps.find((s) => s.step === step)
      assert(got, `缺少步骤 ${step}`)
      assert(got.ok === true, `${step} 失败：${got.message ?? ''}`)
    }
    // 关键：验副作用，不只是步骤状态
    assert(store.getMeta(`artifact:${u.id}`, null), 'artifacts 步骤没有真的写入状态（接线断了）')
    closeDb(db)
    return '4 步 ok 且副作用已落地'
  })

  await checkAsync('mem_recall：两层回捞 + source 标注 + 密钥不原样回灌', async () => {
    const { db, store } = tmpFixture()
    const recall = new Recall(store)
    const tools = buildTools({ store, recall, host: {}, config: {} })
    const tool = tools.find((t) => t.name === 'mem_recall')
    assert(tool, 'mem_recall 未注册')
    // 声明与返回必须一致（宿主按 additionalProperties:false 校验，多一个字段整次调用失败）
    const declared = new Set(Object.keys(tool.output.schema.properties ?? {}))
    const mk = (id, lines) => ({
      id,
      header: { id, cwd: '/tmp/proj' },
      ownEvents: () =>
        lines.map((text, i) => ({
          type: i % 2 === 0 ? 'user/message' : 'assistant/message',
          seq: i + 1,
          data: i % 2 === 0 ? { content: [{ type: 'text', text }] } : { message: { content: [{ type: 'text', text }] } },
        })),
    })
    upsertNodes(store, { sessionId: 'r1', nodes: [{ kind: 'constraint', content: '不要改 package.json，锁文件必须原样。', hash: 'h1', pin: 1 }] })
    const hit = await tool.execute({ query: 'package.json 能不能改' }, { agent: { session: mk('r1', []) } })
    assert(hit.source === 'node', `节点命中应为 node，实际 ${hit.source}`)
    for (const key of Object.keys(hit)) assert(declared.has(key), `返回了未声明字段 ${key}`)
    const span = await tool.execute({ query: 'anchor 摘要' }, { agent: { session: mk('r2', ['用户: 继续', '助手: 我们决定改用 anchor 而不是摘要。']) } })
    assert(span.source === 'span', `回退原文应为 span，实际 ${span.source}`)
    const secret = ['用户: 数据库', '密码', ': ', 'hunter2', 'secretValue', '，帮我连'].join('')
    const leaked = await tool.execute({ query: '连数据库' }, { agent: { session: mk('r3', [secret]) } })
    assert(!leaked.text.includes('hunter2secretValue'), '含密钥的原文不得原样回灌')
    closeDb(db)
    return 'node / span / 密钥拦截 三态通过'
  })
}

// ─────────────────────────────────────────────────────────────
// 二、真实库只读快照
// ─────────────────────────────────────────────────────────────
function liveSnapshot() {
  const path = dbPath()
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return { error: `打不开真实库（${path}）：${error.message}` }
  }
  const one = (sql, ...args) => {
    try {
      return db.prepare(sql).get(...args)
    } catch {
      return null
    }
  }
  const all = (sql, ...args) => {
    try {
      return db.prepare(sql).all(...args)
    } catch {
      return []
    }
  }
  const snap = {
    path,
    schemaVersion: one("SELECT value AS v FROM meta WHERE key='schema_version'")?.v,
    nodes: one('SELECT COUNT(*) AS n FROM nodes')?.n ?? null,
    nodesByKind: all('SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind'),
    pinned: one('SELECT COUNT(*) AS n FROM nodes WHERE pin = 1')?.n ?? null,
    redundantPrefix: one("SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '进度:%' OR content LIKE '约束:%' OR content LIKE '决策:%'")?.n ?? null,
    reinforceRowid: one("SELECT value AS v FROM meta WHERE key='evolve_reinforce_rowid'")?.v ?? null,
    edgeRowid: one("SELECT value AS v FROM meta WHERE key='evolve_edge_rowid'")?.v ?? null,
    maxRecallRowid: one('SELECT MAX(rowid) AS n FROM recall_log')?.n ?? null,
    lastRun: one("SELECT value AS v FROM meta WHERE key='evolve_last_run'")?.v ?? null,
    artifactOffset: one("SELECT value AS v FROM meta WHERE key='artifact_offset'")?.v ?? null,
    pendingSuggestions: one("SELECT COUNT(*) AS n FROM suggestions WHERE status='pending'")?.n ?? null,
    supportGt1: one('SELECT COUNT(*) AS n FROM suggestions WHERE support > 1')?.n ?? null,
  }
  const arts = all("SELECT value FROM meta WHERE key LIKE 'artifact:%'")
  const states = {}
  for (const a of arts) {
    try {
      const st = JSON.parse(a.value).state
      states[st] = (states[st] ?? 0) + 1
    } catch {
      /* 坏值忽略 */
    }
  }
  snap.artifacts = { total: arts.length, states }
  db.close()
  return snap
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────
const snap = liveSnapshot()
let failed = 0
if (!liveOnly) {
  console.log('====== 功能自检（临时库上跑真实代码路径，不碰真实库）======\n')
  for (const r of results) {
    if (!r.ok) failed += 1
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  →  ${r.detail}` : ''}`)
  }
  console.log('')
}

console.log('====== 真实库快照（只读）======\n')
if (snap.error) {
  console.log(`! ${snap.error}`)
} else {
  console.log(`库：${snap.path}`)
  const schemaOk = String(snap.schemaVersion) === '5'
  console.log(`schema_version：${snap.schemaVersion}  ${schemaOk ? '✓' : '✗ 期望 5'}`)
  if (!schemaOk) failed += 1
  console.log(`会话骨架：${snap.nodes ?? '无表'} 个节点 · pin ${snap.pinned ?? '-'} · ${JSON.stringify(snap.nodesByKind)}`)
  if (snap.redundantPrefix) {
    console.log(`  ⚠ 发现 ${snap.redundantPrefix} 个带类型前缀的节点 —— 可能是自反馈残留（v0.0.18 已修，建议清库重抽）`)
  }
  const consumed = String(snap.reinforceRowid) === String(snap.maxRecallRowid)
  console.log(`权重水位：reinforce=${snap.reinforceRowid} edge=${snap.edgeRowid} · recall_log 最大 rowid=${snap.maxRecallRowid} ${consumed ? '✓ 已追平' : '· 尚有未消费行（下次巡演会补）'}`)
  if (snap.lastRun) {
    try {
      const r = JSON.parse(snap.lastRun)
      console.log(`上次巡演：${r.at} · ${r.steps.map((s) => `${s.step}=${s.ok ? 'ok' : 'FAIL'}`).join(' ')}`)
      if (r.steps.some((s) => s.step === 'artifacts' && !s.ok)) failed += 1
    } catch {
      console.log(`上次巡演：${String(snap.lastRun).slice(0, 120)}`)
    }
  } else {
    console.log('上次巡演：尚未运行（30 分钟一次，等一轮即可）')
  }
  console.log(`产物指纹：${snap.artifacts.total} 条已建 · ${JSON.stringify(snap.artifacts.states)} · 轮转 offset=${snap.artifactOffset ?? '-'}`)
  if (snap.artifacts.total > 0 && (snap.artifacts.states.missing ?? 0) / snap.artifacts.total > 0.3) {
    console.log(`  ⚠ 缺失比例 >30% —— 抽查是「文件真的没了」还是「路径解析误判」`)
  }
  console.log(`待确认队列：${snap.pendingSuggestions} 条 pending · support>1 的 ${snap.supportGt1} 条`)
  if (snap.supportGt1 === 0 && snap.pendingSuggestions > 0) {
    console.log('  · support 全为 1：正常（还没出现过"同一件事被提两次"）；想主动验可对同一句连写两次 mem_write')
  }
}

console.log('')
console.log(failed === 0 ? '结论：全部通过。' : `结论：${failed} 项不通过，见上方 ✗ / ⚠。`)
process.exit(failed === 0 ? 0 : 1)
