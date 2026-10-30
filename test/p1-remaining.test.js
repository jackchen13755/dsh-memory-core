import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { decay, readInjectionCounts } from '../lib/evolution.js'
import { isDesignIntendedSkip } from '../lib/recall.js'
import { SyncEngine } from '../lib/sync.js'
import { InjectionLedger, bumpInjectionCounts, fmtBeta, renderRecallSection } from '../lib/inject.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { writeMemory } from '../lib/writer.js'

/**
 * P1-2 / P1-3 / P1-4 / P1-5 的四项验收。
 *
 * 共同要求（本轮账本 C21/C23）：
 *   ① 每项默认关闭或只读 ⇒ 与改造前行为一致（P1-5 例外，见该用例注释：它默认开，但有 kill switch）；
 *   ② 每项都必须有"开关真的生效"的断言 —— 这是这个仓库已经踩过两次的坑（假开关、写对但没接线）。
 */
const DAY = 86400000
const zulu_plain = 'zulu 端口 8080（故意不带 β）'

function fixture(units = []) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-p1x-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  for (const u of units) store.insertUnit(u)
  return { db, store, recall: new Recall(store) }
}

function render(ctx, { sessionId = 's', turns = 1, config = {}, query = 'zulu 网关端口' } = {}) {
  const ledger = new InjectionLedger()
  for (let i = 0; i < turns; i += 1) ledger.noteUserMessage(sessionId, query)
  return { ledger, res: renderRecallSection({ store: ctx.store, recall: ctx.recall, ledger, sessionId, cwd: null, config }) }
}

const HITS = [1, 2, 3, 4, 5].map((i) => ({
  track: 'memory',
  scope: 'global',
  kind: 'fact',
  content: `zulu 参数 zulu-${i}：网关端口 ${8000 + i}，灰度比例 ${i}0%。`,
  meta: { ent: ['zulu'] },
}))

// ───────────────────────────── P1-2 再注入冷却 ─────────────────────────────

test('P1-2 默认（reinjectAfterTurns=0）：见过就不再注入 —— 与改造前一致', () => {
  // 只放 3 条（= 默认 maxCards），保证第一轮就把全部候选注入了；
  // 放 5 条的话第二轮会把"还没见过的那两张"注入 —— 那是正确行为，会把本用例的前提搞错
  const ctx = fixture(HITS.slice(0, 3))
  const first = render(ctx, { turns: 1 })
  assert.equal(first.res.injected, true)
  const ids = first.res.ids
  // 同一会话继续：换成第 2、3 轮，仍不该重复注入同一批
  const ledger = first.ledger
  for (let t = 2; t <= 3; t += 1) {
    ledger.noteUserMessage('s', 'zulu 网关端口')
    const res = renderRecallSection({ store: ctx.store, recall: ctx.recall, ledger, sessionId: 's', cwd: null, config: {} })
    assert.equal(res.injected, false, `第 ${t} 轮不该重复注入`)
    assert.equal(res.reason, 'all-seen')
  }
  assert.ok(ids.length >= 1)
  closeDb(ctx.db)
})

test('P1-2 冷却生效：隔够轮次且排名靠前时允许再注入，排名靠后的仍被挡', () => {
  const ctx = fixture(HITS)
  const config = { recall: { reinjectAfterTurns: 2, reinjectTopRank: 1, injectBudgetTokens: 4000, maxCards: 5 } }
  const { ledger, res: first } = render(ctx, { turns: 1, config })
  assert.equal(first.injected, true)
  const firstIds = first.ids
  assert.ok(firstIds.length >= 2, '需要至少两张卡才能区分"排名靠前"与"靠后"')

  // 第 2 轮（冷却未到）→ 不该重复
  ledger.noteUserMessage('s', 'zulu 网关端口')
  const second = renderRecallSection({ store: ctx.store, recall: ctx.recall, ledger, sessionId: 's', cwd: null, config })
  assert.equal(second.injected, false, '冷却窗口内不该重复注入')

  // 第 3 轮（turns 差 ≥ 2）→ 允许 top1 再来一次，但 top2 之后的仍被挡
  ledger.noteUserMessage('s', 'zulu 网关端口')
  const third = renderRecallSection({ store: ctx.store, recall: ctx.recall, ledger, sessionId: 's', cwd: null, config })
  assert.equal(third.injected, true, '冷却到期后应允许再注入')
  assert.deepEqual(third.ids, [firstIds[0]], `只允许排名第 1 的再来一次，实际 ${JSON.stringify(third.ids)}`)
  closeDb(ctx.db)
})

// ───────────────────────────── P1-3 β_judge ─────────────────────────────

test('P1-3 fmtBeta：带符号一位小数，-0 归一为 0.0', () => {
  assert.equal(fmtBeta(8), '+8.0')
  assert.equal(fmtBeta(-2.54), '-2.5')
  assert.equal(fmtBeta(0), '0.0')
  assert.equal(fmtBeta(-0.01), '0.0')
  assert.equal(fmtBeta(99), '+10.0', '超界夹到 10')
  assert.equal(fmtBeta('abc'), '0.0')
})

test('P1-3 mem_update 写 β：不丢原 meta、越界拒绝、null 清除', async () => {
  const { db, store, recall } = fixture([
    { track: 'memory', scope: 'global', kind: 'fact', content: '判据夹具：zulu 端口 8080。', meta: { ent: ['zulu'], summary: '摘要必须保留' } },
  ])
  const runtime = { writer: { writeMemory: (a) => writeMemory({ store, recall, ...a }) } }
  const tools = buildTools({ store, recall, host: {}, config: {}, runtime })
  const update = tools.find((t) => t.name === 'mem_update')
  const id = db.prepare("SELECT id FROM units WHERE content LIKE '判据夹具%'").get().id

  const ok = await update.execute({ id, trust: 7.5, trustReason: '实测过的决定' })
  assert.equal(ok.ok, true)
  let meta = JSON.parse(db.prepare('SELECT meta FROM units WHERE id = ?').get(id).meta)
  assert.equal(meta.beta, 7.5)
  assert.equal(meta.betaSource, 'model')
  assert.equal(meta.betaReason, '实测过的决定')
  assert.deepEqual(meta.ent, ['zulu'], '原有 meta 字段不得被整列替换清掉')
  assert.equal(meta.summary, '摘要必须保留')
  assert.ok(ok.text.includes('β=+7.5'), ok.text)

  const bad = await update.execute({ id, trust: 42 })
  assert.equal(bad.ok, false, '越界必须拒绝')
  assert.equal(JSON.parse(db.prepare('SELECT meta FROM units WHERE id = ?').get(id).meta).beta, 7.5, '拒绝时不得改动')

  const cleared = await update.execute({ id, trust: null })
  assert.equal(cleared.ok, true)
  meta = JSON.parse(db.prepare('SELECT meta FROM units WHERE id = ?').get(id).meta)
  assert.equal(meta.beta, undefined, 'null 表示清除')
  assert.equal(meta.betaSource, undefined)
  closeDb(db)
})

test('P1-3 卡片显示 β：showTrust 默认关（不占 token），打开后才出现', () => {
  const { db, store, recall } = fixture([
    { track: 'memory', scope: 'global', kind: 'fact', content: 'zulu 端口 8080，已复核。', meta: { ent: ['zulu'], beta: 8, betaSource: 'model', betaAt: Date.now() } },
  ])
  const ctx = { store, recall }
  const off = render(ctx, { turns: 1 }).res
  assert.ok(off.text.includes('[mem:'), off.text)
  assert.ok(!off.text.includes('β='), '默认不显示 β')

  const on = render(ctx, { turns: 1, config: { recall: { showTrust: true } } }).res
  assert.ok(on.text.includes('β=+8.0'), `打开后应显示：\n${on.text}`)
  assert.ok(on.tokens >= off.tokens)
  closeDb(db)
})

// ───────────────────────────── P1-4 通道可观测 ─────────────────────────────

test('P1-4 mem_status 报通道状态：图通道边数不足时要显式说"静默 skip"', async () => {
  const { db, store, recall } = fixture(HITS)
  const tool = buildTools({ store, recall, host: {}, config: {} }).find((t) => t.name === 'mem_status')
  const cold = await tool.execute({})
  assert.equal(cold.channels.graph.active, false, '没有 coRetrieval 边时图通道不活跃')
  assert.ok(cold.text.includes('静默 skip'), cold.text)

  // 造够门槛以上的 coRetrieval 边
  const ids = db.prepare('SELECT id FROM units LIMIT 3').all().map((r) => r.id)
  const ins = db.prepare("INSERT OR REPLACE INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, 'coRetrieval', 1)")
  for (let i = 0; i < 25; i += 1) ins.run(ids[0], `${ids[1]}-${i}`)
  const warm = await tool.execute({})
  assert.equal(warm.channels.graph.active, true, '过门槛后应报"在跑"')
  assert.ok(warm.text.includes('在跑'), warm.text)
  closeDb(db)
})

// ───────────────────────────── P1-5 注入计数进 decay ─────────────────────────────

test('P1-5 注入计数：bump 累加进 meta KV，同一 id 多次注入可累计', () => {
  const { db, store } = fixture([])
  assert.equal(readInjectionCounts(store).size, 0)
  bumpInjectionCounts(store, ['a1', 'b2'])
  bumpInjectionCounts(store, ['a1'])
  const map = readInjectionCounts(store)
  assert.equal(map.get('a1'), 2)
  assert.equal(map.get('b2'), 1)
  closeDb(db)
})

test('P1-5 接线：从 renderRecallSection 真实注入一次就应写进 KV（不是只测 bump 本身）', () => {
  // 上一轮教训：直接测 bumpInjectionCounts 只能证明"函数会写"，证明不了"注入时调用了它"
  // —— 回退变异实测 SURVIVED。这里从渲染入口走一遍。
  const ctx = fixture(HITS.slice(0, 2))
  const { res } = render(ctx, { turns: 1 })
  assert.equal(res.injected, true)
  const counts = readInjectionCounts(ctx.store)
  for (const id of res.ids) assert.ok((counts.get(id) ?? 0) >= 1, `${id} 应被计数`)
  // 关掉计数开关后不再累加
  const before = readInjectionCounts(ctx.store).get(res.ids[0])
  render(ctx, { sessionId: 's2', turns: 1, config: { recall: { countInjections: false } } })
  assert.equal(readInjectionCounts(ctx.store).get(res.ids[0]), before, 'countInjections:false 时不得再累加')
  closeDb(ctx.db)
})

test('P1-5 decay：天天被注入但从未 mem_get 的条目不被归档（且可关回旧行为）', () => {
  const seeded = (id) => ({ track: 'memory', scope: 'global', kind: 'fact', content: `zulu 条目 ${id} 内容。`, createdAt: Date.now() - 200 * DAY })
  const run = (withInjected) => {
    const { db, store } = fixture([seeded('keep'), seeded('drop')])
    const old = Date.now() - 200 * DAY
    store.db.prepare('UPDATE units SET created_at = ?, updated_at = ?, importance = 0.05, access_count = 0').run(old, old)
    const keepId = store.db.prepare("SELECT id FROM units WHERE content LIKE '%keep%'").get().id
    if (withInjected) bumpInjectionCounts(store, [keepId])
    const res = decay({ store, config: { decayGraceDays: 0, decayAccessGrace: 2 } })
    const status = (id) => store.db.prepare('SELECT status FROM units WHERE content LIKE ?').get(`%${id}%`)?.status
    return { archivedKeep: status('keep'), archivedDrop: status('drop'), res, db }
  }
  const off = run(false)
  assert.equal(off.archivedKeep, 'archived', '没有注入记录时按旧行为归档')
  assert.equal(off.archivedDrop, 'archived')
  closeDb(off.db)

  const on = run(true)
  assert.equal(on.archivedKeep, 'active', '被注入过的条目不该被归档（P1-5）')
  assert.equal(on.archivedDrop, 'archived', '没被注入过的仍照常归档')
  assert.ok(on.res.accessGuarded >= 1, '应计入 accessGuarded')

  // kill switch：关掉即回到旧判据
  const { db, store } = fixture([seeded('keep')])
  const old = Date.now() - 200 * DAY
  store.db.prepare('UPDATE units SET created_at = ?, updated_at = ?, importance = 0.05, access_count = 0').run(old, old)
  bumpInjectionCounts(store, [store.db.prepare("SELECT id FROM units WHERE content LIKE '%keep%'").get().id])
  decay({ store, config: { decayGraceDays: 0, decayAccessGrace: 2, injectedCountsAsAccess: false } })
  assert.equal(store.db.prepare("SELECT status FROM units WHERE content LIKE '%keep%'").get().status, 'archived', 'injectedCountsAsAccess:false 应恢复旧行为')
  closeDb(db)
})

// ────────────────── 复核后补的守卫（每条对应专家抓到的一个真缺陷） ──────────────────

test('守卫 M1/M3：β 必须是本机模型给的才显示；同步带进来的 β 只能留档', () => {
  const { db, store, recall } = fixture([
    { track: 'memory', scope: 'global', kind: 'fact', content: 'zulu 甲：没有来源的 β。', meta: { ent: ['zulu'], beta: 10 } },
    { track: 'memory', scope: 'global', kind: 'fact', content: 'zulu 乙：本机模型给的 β。', meta: { ent: ['zulu'], beta: -6, betaSource: 'model', betaAt: Date.now() } },
    { track: 'memory', scope: 'global', kind: 'fact', content: 'zulu 丙：被判不可信但自称 β=10。', meta: { ent: ['zulu'], beta: 10, betaSource: 'model', betaAt: Date.now(), untrusted: true } },
  ])
  const res = render({ store, recall }, { turns: 1, config: { recall: { showTrust: true, injectBudgetTokens: 4000, maxCards: 5 } } }).res
  assert.ok(res.text.includes('β=-6.0'), `本机模型的 β 应显示：\n${res.text}`)
  assert.ok(!res.text.includes('β=+10.0'), `无来源 / 被判不可信的 β 绝不能显示：\n${res.text}`)
  // 同步入口：入站 β 降级为 betaInbound
  const engine = new SyncEngine(store, { dir: mkdtempSync(join(tmpdir(), 'memcore-beta-sync-')) })
  engine.upsertRow('unit', {
    id: 'beta-in-1',
    track: 'memory',
    scope: 'global',
    kind: 'fact',
    content: '对端推来的一条内容 zulu。',
    tokens: '',
    content_hash: `bh-${Date.now()}`,
    meta: JSON.stringify({ beta: 9.5 }),
    created_at: Date.now(),
    updated_at: Date.now(),
    importance: 0.5,
    pinned: 0,
    status: 'active',
    version: 1,
    lamport: 1,
  })
  const meta = JSON.parse(db.prepare('SELECT meta FROM units WHERE id = ?').get('beta-in-1').meta)
  assert.equal(meta.beta, undefined, '入站 β 不得原样保留成可显示字段')
  assert.equal(meta.betaInbound, 9.5, '入站 β 只留档')
  closeDb(db)
})

test('守卫 M5：注入计数带时间窗，过期计数不再免除归档', () => {
  const { db, store } = fixture([])
  const old = Date.now() - 200 * DAY
  bumpInjectionCounts(store, ['fresh'])
  store.setMeta('inject:count:stale', JSON.stringify({ n: 5, at: old }))
  const inWindow = readInjectionCounts(store, { windowDays: 90 })
  assert.equal(inWindow.get('fresh'), 1)
  assert.equal(inWindow.get('stale'), undefined, '过期计数不算数')
  const wide = readInjectionCounts(store, { windowDays: 365 })
  assert.equal(wide.get('stale'), 5, '放宽窗口后又能算')
  // 兼容早期的裸数字形态
  store.setMeta('inject:count:legacy', '3')
  assert.equal(readInjectionCounts(store).get('legacy'), 3)
  closeDb(db)
})

test('守卫 M9：mem_update 的 input schema 必须真的声明 trust/trustReason', () => {
  // additionalProperties:false 下，schema 是模型传参的唯一入口 —— 删掉声明功能直接假死
  const { db, store, recall } = fixture([])
  const tool = buildTools({ store, recall, host: {}, config: {} }).find((t) => t.name === 'mem_update')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.ok(tool.parameters.properties.trust, 'trust 必须声明在 parameters 里')
  assert.ok(tool.parameters.properties.trustReason, 'trustReason 必须声明在 parameters 里')
  assert.deepEqual(tool.parameters.required, ['id'], 'trust 必须可选')
  closeDb(db)
})

test('守卫 M11：没有 β 的条目在 showTrust 打开时也不得显示 β=0.0', () => {
  const { db, store, recall } = fixture([{ track: 'memory', scope: 'global', kind: 'fact', content: zulu_plain, meta: { ent: ['zulu'] } }])
  const res = render({ store, recall }, { turns: 1, config: { recall: { showTrust: true } } }).res
  assert.ok(!/β=/.test(res.text), `没有 β 就不该出现任何 β 标记：\n${res.text}`)
  closeDb(db)
})

test('守卫 M14：设计内跳过用白名单判定（disabled / 窗口内无语义相关都不算故障）', () => {
  assert.equal(isDesignIntendedSkip('未解析出时间窗口'), true)
  assert.equal(isDesignIntendedSkip('时间窗口「昨天」内没有可用的查询词'), true)
  assert.equal(isDesignIntendedSkip('时间窗口「昨天」内无语义相关条目'), true)
  assert.equal(isDesignIntendedSkip('disabled'), true)
  assert.equal(isDesignIntendedSkip('禁用'), true)
  assert.equal(isDesignIntendedSkip('超预算'), false, '超预算才是真故障')
  assert.equal(isDesignIntendedSkip('冷启动（记忆量低于阈值）'), false)
  assert.equal(isDesignIntendedSkip('边不足'), false)
})

test('守卫 ①：重启后 seen 有值而 seenAt 为空时，冷却按「刚看过」锚定（不得立刻重推）', () => {
  const { db, store, recall } = fixture(HITS.slice(0, 2))
  const config = { recall: { reinjectAfterTurns: 3, reinjectTopRank: 2, injectBudgetTokens: 4000 } }
  const a = new InjectionLedger({ store })
  a.noteUserMessage('r', 'zulu 网关端口')
  const first = renderRecallSection({ store, recall, ledger: a, sessionId: 'r', cwd: null, config })
  assert.equal(first.injected, true)
  // 模拟重启：新 ledger 从 store 载入 seen，但 seenAt 是空的
  const b = new InjectionLedger({ store })
  for (let i = 0; i < 4; i += 1) b.noteUserMessage('r', 'zulu 网关端口')
  assert.ok(b.session('r').seen.size >= 1, '前提：seen 应从 store 载入')
  assert.equal(b.session('r').seenAt.size, 0, '前提：seenAt 只存内存，重启后为空')
  const again = renderRecallSection({ store, recall, ledger: b, sessionId: 'r', cwd: null, config })
  assert.equal(again.injected, false, '重启后不得因为"seenAt 缺失→锚点 0"而立刻重推')
  closeDb(db)
})

test('守卫 M2：β 要能读回来（mem_get 与 mem_search 卡片都带上）', async () => {
  const { db, store, recall } = fixture([
    { track: 'memory', scope: 'global', kind: 'fact', content: 'zulu 端口 8080，已复核过。', meta: { ent: ['zulu'], beta: 8, betaSource: 'model', betaAt: Date.now(), betaReason: '实测过' } },
  ])
  const tools = buildTools({ store, recall, host: {}, config: {}, runtime: { writer: { writeMemory: (a) => writeMemory({ store, recall, ...a }) } } })
  const id = db.prepare("SELECT id FROM units WHERE content LIKE 'zulu 端口%'").get().id
  const got = await tools.find((t) => t.name === 'mem_get').execute({ id })
  assert.ok(got.text.includes('β=+8.0'), `mem_get 应回读 β：\n${got.text}`)
  assert.ok(got.text.includes('实测过'), 'β 的理由也应可见（可审计）')
  const search = await tools.find((t) => t.name === 'mem_search').execute({ query: 'zulu 端口' })
  assert.ok(search.text.includes('β=+8.0'), `mem_search 卡片应带 β：\n${search.text}`)
  closeDb(db)
})
