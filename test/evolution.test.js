import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { EVOLVE_DEFAULTS, WriteWatchdog, decay, reconcile, reinforce, reviveArchivedBoosted, runEvolution } from '../lib/evolution.js'
import { Store } from '../lib/store.js'
import { writeMemory } from '../lib/writer.js'
import { Recall } from '../lib/recall.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-evo-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  return { db, store, recall: new Recall(store) }
}

test('强化：被召回过的条目加权，同批召回建 coRetrieval 边', () => {
  const { db, store } = fixture()
  const a = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则A：提交前跑 lint。' })
  const b = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则B：提交信息用中文。' })
  const before = Number(store.getUnit(a.id).importance)
  const ts = Date.now()
  const ins = store.db.prepare(
    'INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(ts, 's1', 'lint 规则', a.id, 'lexical+sparse', 1, 0.9, 1, '两通道命中')
  ins.run(ts, 's1', 'lint 规则', b.id, 'lexical', 2, 0.5, 1, null)
  const res = reinforce({ store })
  assert.equal(res.ok, true)
  assert.ok(res.boosted >= 1)
  assert.ok(Number(store.getUnit(a.id).importance) > before, '被取回的应加权')
  const edge = store.db.prepare("SELECT * FROM edges WHERE kind = 'coRetrieval'").get()
  assert.ok(edge, '同批召回应建边')
  closeDb(db)
})

test('强化消费水位：同一条激活跨多轮巡演只计一次（importance / access_count 不再虚高）', () => {
  const { db, store } = fixture()
  const a = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则C：推送前做隐私扫描。' })
  store.db.prepare('UPDATE units SET importance = 0.2, access_count = 0 WHERE id = ?').run(a.id)
  const ins = store.db.prepare(
    'INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(Date.now(), 's1', '推送 隐私', a.id, 'lexical', 1, 0.9, 1, null)

  const first = reinforce({ store })
  assert.equal(first.boosted, 1, '首次巡演应强化')
  const afterFirst = Number(store.getUnit(a.id).importance)
  const countFirst = Number(store.getUnit(a.id).access_count)
  assert.ok(afterFirst > 0.2)
  assert.equal(countFirst, 1)

  // 30 分钟后第二轮巡演：日志没有新行，不得再次计入同一批激活
  const second = reinforce({ store, now: Date.now() + 30 * 60000 })
  assert.equal(second.boosted, 0, '没有新激活就不该再强化')
  assert.equal(Number(store.getUnit(a.id).importance), afterFirst, 'importance 不得重复累加')
  assert.equal(Number(store.getUnit(a.id).access_count), countFirst, 'access_count 不得虚高')

  // 新激活照常计入
  ins.run(Date.now() + 2, 's1', '推送 隐私', a.id, 'lexical', 1, 0.9, 1, null)
  const third = reinforce({ store, now: Date.now() + 60 * 60000 })
  assert.equal(third.boosted, 1, '新激活应照常强化')
  assert.ok(Number(store.getUnit(a.id).importance) > afterFirst, '新激活应继续加权')
  assert.equal(Number(store.getUnit(a.id).access_count), countFirst + 1)
  closeDb(db)
})

test('衰减：按半衰期下降，低于阈值转 archived；pin 豁免；只归档不删除', () => {
  const { db, store } = fixture()
  const old = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '很久没用的旧事实。' })
  const pinned = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '置顶规则不该被衰减。', pinned: 1 })
  const longAgo = Date.now() - 400 * 86400000
  store.db.prepare('UPDATE units SET importance = 0.5, last_accessed = ?, updated_at = ?, created_at = ? WHERE id = ?').run(longAgo, longAgo, longAgo, old.id)
  store.db.prepare('UPDATE units SET importance = 0.5, last_accessed = ? WHERE id = ?').run(longAgo, pinned.id)

  const res = decay({ store })
  assert.equal(res.ok, true)
  const afterOld = store.getUnit(old.id)
  assert.ok(Number(afterOld.importance) < 0.5, '应衰减')
  assert.equal(afterOld.status, 'archived', '低于阈值应归档')
  assert.equal(store.getUnit(pinned.id).status, 'active', 'pin 豁免')
  assert.ok(Number(store.getUnit(pinned.id).importance) === 0.5)
  assert.ok(store.getUnit(old.id) !== null, '归档不是删除')
  closeDb(db)
})

test('衰减宽限期：新建/刚导入的记忆不参与衰减（避免首次巡演把历史资产判死）', () => {
  const { db, store } = fixture()
  const fresh = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '刚写入的一条记忆。' })
  store.db.prepare('UPDATE units SET importance = 0.2, last_accessed = NULL, updated_at = ?, created_at = ? WHERE id = ?').run(
    Date.now() - 10 * 86400000,
    Date.now() - 10 * 86400000,
    fresh.id,
  )
  const res = decay({ store })
  assert.equal(res.archived, 0, '10 天前创建、宽限期内不应被归档')
  assert.equal(store.getUnit(fresh.id).status, 'active')
  assert.equal(Number(store.getUnit(fresh.id).importance), 0.2, '也不应被衰减')

  // 超过宽限期后才参与
  store.db.prepare('UPDATE units SET created_at = ?, updated_at = ?, last_accessed = NULL, importance = 0.2 WHERE id = ?').run(
    Date.now() - 120 * 86400000,
    Date.now() - 120 * 86400000,
    fresh.id,
  )
  const res2 = decay({ store })
  assert.ok(res2.archived >= 1, '超期后应被归档')
  closeDb(db)
})

test('调和：高度相似的同一件事合并（旧条目 superseded 且留版本链），数字不同的判为冲突成对保留', () => {
  const { db, store } = fixture()
  const first = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '本机 node 版本是 v26，自带 node:sqlite 与 FTS5。' })
  const dup = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '本机 node 版本是 v26，自带 node:sqlite 和 FTS5 支持。' })
  const conflictA = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '服务端口是 8080，部署用 docker。' })
  const conflictB = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '服务端口是 9090，部署用 docker。' })

  const res = reconcile({ store })
  assert.equal(res.ok, true)
  assert.ok(res.merged >= 1, `应合并至少一对：${JSON.stringify(res)}`)
  const statuses = [first.id, dup.id].map((id) => store.getUnit(id).status)
  assert.ok(statuses.includes('superseded'), '保留一条、另一条标记取代')
  const supersededRow = store.db.prepare("SELECT * FROM units WHERE status = 'superseded'").get()
  assert.ok(supersededRow.superseded_by, '应记录取代链')
  assert.equal(store.getUnit(conflictA.id).status, 'active')
  assert.equal(store.getUnit(conflictB.id).status, 'active')
  const contradicts = store.db.prepare("SELECT * FROM edges WHERE kind = 'contradicts'").get()
  assert.ok(contradicts, '冲突应建 contradicts 边并以成对保留')
  closeDb(db)
})

test('演化巡演：单步失败不影响其余步骤，报告落 meta', () => {
  const { db, store } = fixture()
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '随便一条。' })
  return runEvolution({ store }).then((report) => {
    assert.ok(report.steps.length >= 3, '至少跑强化/调和/衰减三步')
    const meta = JSON.parse(store.getMeta('evolve_last_run'))
    assert.equal(meta.steps.length, report.steps.length)
    closeDb(db)
  })
})

test('写入看门狗：默认关；开启后连续 N 轮未写就提醒，写入即消', () => {
  const off = new WriteWatchdog()
  off.noteTurn('s')
  off.noteTurn('s')
  assert.equal(off.warningFor('s'), null, '默认关闭')

  const wd = new WriteWatchdog({ enabled: true, threshold: 2 })
  wd.noteTurn('s')
  assert.equal(wd.warningFor('s'), null, '第一轮不提醒')
  wd.noteTurn('s')
  const warn = wd.warningFor('s')
  assert.ok(warn && warn.includes('连续 2 轮'), `实际：${warn}`)
  wd.noteWrite('s')
  assert.equal(wd.warningFor('s'), null, '写入即消')
})

test('看门狗与真实写入路径联动（mem_write 消警）', () => {
  const { db, store, recall } = fixture()
  const wd = new WriteWatchdog({ enabled: true, threshold: 1 })
  wd.noteTurn('s-1')
  assert.ok(wd.warningFor('s-1'))
  writeMemory({ store, recall, cwd: null, input: { content: '本回合的进展记录。', track: 'project', kind: 'progress' }, origin: 'session:s-1' })
  const m = /^session:(.+)$/.exec('session:s-1')
  wd.noteWrite(m[1])
  assert.equal(wd.warningFor('s-1'), null)
  closeDb(db)
})

test('默认配置与设计一致（衰减 30 天、归档阈值 0.15、看门狗默认关）', () => {
  assert.equal(EVOLVE_DEFAULTS.decayHalfLifeDays, 30)
  assert.equal(EVOLVE_DEFAULTS.archiveBelow, 0.15)
  assert.equal(EVOLVE_DEFAULTS.writeGuard.enabled, false)
  assert.equal(EVOLVE_DEFAULTS.llm.abstract, false, 'LLM 抽象默认关')
})

// ---------------------------------------------------------------------------
// 衰减误杀修复（2026-10-14）：recency 只做排序，不做删除决策
// ---------------------------------------------------------------------------

test('衰减误杀：access_count>0（被取回过）的条目本轮不被归档——即使 importance 早已跌破阈值', () => {
  const { db, store } = fixture()
  // 真实库复盘出的形态：长期未取回（last_accessed 很旧）但 access_count 极高
  const recalled = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '被反复取回过的规则（access_count 很高）。' })
  const never = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '从未被取回过的旧事实。' })
  const longAgo = Date.now() - 400 * 86400000
  const setRow = store.db.prepare(
    'UPDATE units SET importance = ?, access_count = ?, last_accessed = ?, updated_at = ?, created_at = ? WHERE id = ?',
  )
  setRow.run(0.01, 1639, longAgo, longAgo, longAgo, recalled.id)
  setRow.run(0.01, 0, longAgo, longAgo, longAgo, never.id)

  const res = decay({ store })
  assert.equal(res.ok, true)
  assert.equal(store.getUnit(recalled.id).status, 'active', 'access_count>0 的条目不得被同一轮归档（这正是 141~7505 那批误杀）')
  assert.equal(store.getUnit(never.id).status, 'archived', '从未被取回的才该归档')
  assert.ok(res.accessGuarded >= 1, `报告应体现取回宽限（实际 ${JSON.stringify(res)}）`)
  assert.ok(Number(store.getUnit(recalled.id).importance) < 0.01, 'importance 仍照常衰减（recency 保留为排序信号）')
  assert.ok(store.getUnit(recalled.id) !== null, '只归档不删除')
  closeDb(db)
})

test('衰减误杀：decayAccessGrace=0 可关掉取回宽限（回到旧行为），默认值大于 0', () => {
  const { db, store } = fixture()
  const recalled = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '被取回过的规则（关掉宽限后应归档）。' })
  const longAgo = Date.now() - 400 * 86400000
  store.db
    .prepare('UPDATE units SET importance = ?, access_count = ?, last_accessed = ?, updated_at = ?, created_at = ? WHERE id = ?')
    .run(0.01, 500, longAgo, longAgo, longAgo, recalled.id)

  assert.ok(EVOLVE_DEFAULTS.decayAccessGrace > 0, '取回宽限默认开启')
  const off = decay({ store, config: { decayAccessGrace: 0 } })
  assert.equal(off.archived, 1, '置 0 后恢复旧行为')
  assert.equal(store.getUnit(recalled.id).status, 'archived')
  closeDb(db)
})

test('强化复活：importance 已回到阈值以上却仍是 archived 的矛盾态 → 复活为 active（自愈，不是删除）', () => {
  const { db, store } = fixture()
  const ts = Date.now()
  const ins = store.db.prepare(
    'INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  // 反例 312d0096 的形态：被强化到 1.0，status 却还是 archived
  const healed = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '已被强化到满值但仍挂在 archived 的矛盾条目。' })
  store.db.prepare("UPDATE units SET importance = 1.0, status = 'archived' WHERE id = ?").run(healed.id)
  ins.run(ts, 's1', '矛盾条目', healed.id, 'lexical', 1, 0.9, 1, '命中')

  const res = reinforce({ store })
  assert.equal(res.ok, true)
  assert.ok(res.revived >= 1, `reinforce 应报告复活数：${JSON.stringify(res)}`)
  const after = store.getUnit(healed.id)
  assert.equal(after.status, 'active', '矛盾态必须被自愈回 active')
  assert.ok(Number(after.importance) >= EVOLVE_DEFAULTS.archiveBelow, '复活前提是 importance 已达标')
  assert.ok(store.db.prepare("SELECT 1 FROM changes WHERE entity_id = ? AND op = 'status'").get(healed.id), '复活要留 changes 痕迹')
  assert.ok(store.getUnit(healed.id) !== null, '复活不是重建/删除')

  // 单步入口同样可用，且可配关掉（reviveOnReinforce=false 属于「矛盾态仍在」，必须原样保留）
  store.db.prepare("UPDATE units SET status = 'archived' WHERE id = ?").run(healed.id)
  assert.equal(reviveArchivedBoosted({ store }).revived, 1)
  store.db.prepare("UPDATE units SET status = 'archived' WHERE id = ?").run(healed.id)
  assert.equal(reviveArchivedBoosted({ store, config: { reviveOnReinforce: false } }).revived, 0, 'reviveOnReinforce=false 时不复活')
  assert.equal(store.getUnit(healed.id).status, 'archived', '关掉开关就保持原地不动')

  // 矛盾态前提：importance 未达标的 archived 条目不该被无脑复活
  // （先把 healed 复位为 active，让本段只考察 deep 一条，避免上一段的遗留状态混入）
  store.db.prepare("UPDATE units SET status = 'active' WHERE id = ?").run(healed.id)
  const deep = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '早就沉底的归档条目，不该被复活。' })
  store.db.prepare("UPDATE units SET status = 'archived', importance = 0.01 WHERE id = ?").run(deep.id)
  assert.equal(reviveArchivedBoosted({ store }).revived, 0, 'importance 未达标不是矛盾态')
  assert.equal(store.getUnit(deep.id).status, 'archived')
  assert.equal(store.getUnit(healed.id).status, 'active')
  closeDb(db)
})

test('只归档不删除：archived 条目仍可经 status 更新（mem_update restore）恢复为 active', () => {
  const { db, store } = fixture()
  const old = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '会被归档但绝不删除的条目。' })
  const longAgo = Date.now() - 400 * 86400000
  store.db
    .prepare('UPDATE units SET importance = 0.01, access_count = 0, last_accessed = ?, updated_at = ?, created_at = ? WHERE id = ?')
    .run(longAgo, longAgo, longAgo, old.id)
  assert.equal(decay({ store }).archived, 1)
  assert.equal(store.getUnit(old.id).status, 'archived')

  // mem_update restore 走的就是这条 SQL
  store.db.prepare('UPDATE units SET status = ?, updated_at = ?, lamport = lamport + 1 WHERE id = ?').run('active', Date.now(), old.id)
  assert.equal(store.getUnit(old.id).status, 'active', 'archived 可逆')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM units WHERE id = ?').get(old.id).n, 1, '恢复路径没有物理删除')
  closeDb(db)
})

// ---------------------------------------------------------------------------
// t8：历史误杀（seed 版本仍在误杀）——判据必须与 decay 对称，且不得误救用户手动归档
// ---------------------------------------------------------------------------

/** 造一条「旧规则 decay 归档」的历史受害者：低 importance + 高 access_count + decay 痕迹。 */
function seedDecayVictim(store, content, { access = 1639, importance = 0.1013 } = {}) {
  const id = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content }).id
  const longAgo = Date.now() - 400 * 86400000
  store.db
    .prepare('UPDATE units SET importance = ?, access_count = ?, last_accessed = ?, updated_at = ?, created_at = ? WHERE id = ?')
    .run(importance, access, longAgo, longAgo, longAgo, id)
  store.logChange('unit', id, 'status', { status: 'archived', reason: 'decay' })
  store.db.prepare("UPDATE units SET status = 'archived' WHERE id = ?").run(id)
  return id
}

test('判据对称：access_count>0 且带 decay 痕迹的历史误杀条目可被救回（importance 低于阈值也救）', () => {
  const { db, store } = fixture()
  const victim = seedDecayVictim(store, '被旧规则 decay 误杀的规则：明明被反复取回过，importance 却已衰减到 0.10。')
  const before = store.getUnit(victim)
  assert.equal(before.status, 'archived', '前提：它确实已被归档')
  assert.ok(
    Number(before.importance) < EVOLVE_DEFAULTS.archiveBelow,
    `前提：importance 低于阈值（t1 判据救不了），实际 ${before.importance}`,
  )
  assert.ok(Number(before.access_count) > 0, '前提：它被取回过')

  const res = reviveArchivedBoosted({ store })
  assert.equal(store.getUnit(victim).status, 'active', 'decay 说「access_count>0 不该归档」，revive 就必须肯救——判据对称')
  assert.ok(res.revived >= 1, `报告应计入复活：${JSON.stringify(res)}`)
  assert.ok(res.bySymmetry >= 1, '应经「access_count+decay-trace」路径复活，而非 importance 路径')
  assert.ok(res.decayTraced >= 1, '应识别出 decay 归档痕迹')
  const via = store.db
    .prepare("SELECT payload FROM changes WHERE entity_id = ? AND op = 'status' AND json_extract(payload, '$.reason') = 'revive'")
    .get(victim)
  assert.ok(via && JSON.parse(via.payload).via === 'access_count+decay-trace', '复活要留可复核的判据痕迹')
  assert.ok(store.getUnit(victim) !== null, '复活不是删除')
  closeDb(db)
})

test('不得误救用户手动归档：无 reason 的手动归档与 legacy 导入归档（无痕迹）一律保持 archived', () => {
  const { db, store } = fixture()
  // ① 旧规则 decay 误杀 → 应救
  const decayed = seedDecayVictim(store, '旧规则 decay 误杀的条目：应被救回。', { access: 1639 })
  // ② 用户显式归档（mem_update --action archive 的痕迹：reason 缺失）——即使被取回过也不该救
  const manual = seedDecayVictim(store, '用户手动归档的条目：不该被自愈复活。', { access: 240 })
  store.db.prepare("UPDATE changes SET payload = ? WHERE entity_id = ? AND op = 'status'").run(JSON.stringify({ status: 'archived', pinned: null }), manual)
  // ③ 手动归档但写了人话 reason
  const manualReason = seedDecayVictim(store, '用户手动归档并写明理由的条目：不该被自愈复活。', { access: 99 })
  store.db
    .prepare("UPDATE changes SET payload = ? WHERE entity_id = ? AND op = 'status'")
    .run(JSON.stringify({ status: 'archived', reason: '按用户要求迁移到别的项目，原作用域副本归档' }), manualReason)
  // ④ legacy 导入的 archive.md 产物：建库时即 archived，无任何 changes 痕迹
  const legacy = store.insertUnit({
    track: 'memory',
    scope: 'global',
    kind: 'fact',
    content: 'legacy 导入时就是 archived 的条目（MEMORY-archive.md 的产物）。',
    origin: 'import',
    status: 'archived',
  })
  store.db.prepare('UPDATE units SET access_count = 7 WHERE id = ?').run(legacy.id)
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE entity_id = ? AND op = 'status'").get(legacy.id).n,
    0,
    '前提：legacy 导入归档没有任何 status 痕迹',
  )

  reviveArchivedBoosted({ store })
  assert.equal(store.getUnit(decayed).status, 'active', 'decay 误杀的要救')
  assert.equal(store.getUnit(manual).status, 'archived', '用户手动归档（无 reason）不得被复活')
  assert.equal(store.getUnit(manualReason).status, 'archived', '用户手动归档（人话 reason）不得被复活')
  assert.equal(store.getUnit(legacy.id).status, 'archived', 'legacy 导入的归档不得被复活')
  closeDb(db)
})

test('自愈判据对称开关：reviveAccessCounted=false 只保留 importance 矛盾态那条路径；冻结字段名不变', () => {
  const { db, store } = fixture()
  const victim = seedDecayVictim(store, '关掉对称开关后不该被救的历史误杀条目。')
  const off = reviveArchivedBoosted({ store, config: { reviveAccessCounted: false } })
  assert.equal(off.revived, 0, '开关关闭 → 不救低 importance 的历史误杀')
  assert.equal(store.getUnit(victim).status, 'archived')

  // 幂等：同一批不会重复复活；已在 active 的不再改动
  const on = reviveArchivedBoosted({ store })
  assert.equal(on.revived, 1, '打开开关后救回这一条')
  assert.equal(reviveArchivedBoosted({ store }).revived, 0, '已复活的不重复计入')

  // 冻结接口：字段名与默认值不得改动
  assert.equal(EVOLVE_DEFAULTS.reviveAccessCounted, true)
  assert.equal(EVOLVE_DEFAULTS.reviveOnReinforce, true)
  assert.equal(EVOLVE_DEFAULTS.decayAccessGrace, 2)
  closeDb(db)
})

test('t8 不新增删除路径：自愈只改 status，绝不 DELETE/DROP', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/evolution.js', import.meta.url), 'utf8')
  assert.ok(!/DELETE\s+FROM/i.test(src), 'evolution.js 不得出现 DELETE FROM')
  assert.ok(!/DROP\s+(TABLE|INDEX)/i.test(src), 'evolution.js 不得出现 DROP TABLE/INDEX')

  const { db, store } = fixture()
  const victim = seedDecayVictim(store, '自愈前后都必须还在库里（只归档不删除）的条目。')
  const totalBefore = store.db.prepare('SELECT COUNT(*) AS n FROM units').get().n
  reviveArchivedBoosted({ store })
  assert.equal(store.getUnit(victim).status, 'active')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM units').get().n, totalBefore, '自愈不得减少行数')
  closeDb(db)
})

test('可选的收窄开关：reviveDurableOnly=true 时只救可沉淀轨（daily/progress 留在 archived），默认 false 全救', () => {
  const { db, store } = fixture()
  const durable = seedDecayVictim(store, '可沉淀轨的误杀条目（默认与收窄都该救）。')
  const transient = seedDecayVictim(store, '逐日流水/进行中快照的误杀条目（收窄时留在 archived）。')
  store.db.prepare("UPDATE units SET track = 'daily', kind = 'progress' WHERE id = ?").run(transient)
  assert.equal(EVOLVE_DEFAULTS.reviveDurableOnly, false, '默认不收窄（判据正当性来自归档来源，不是内容价值）')

  const narrow = reviveArchivedBoosted({ store, config: { reviveDurableOnly: true } })
  assert.equal(store.getUnit(durable).status, 'active', '可沉淀轨仍救')
  assert.equal(store.getUnit(transient).status, 'archived', '收窄时 transient 不救')
  assert.ok(narrow.sparedTransient >= 1, `报告要计入被收窄豁免的条数：${JSON.stringify(narrow)}`)

  const full = reviveArchivedBoosted({ store })
  assert.equal(store.getUnit(transient).status, 'active', '恢复默认（全救）后可沉淀与否都会自愈——判据只看归档来源')
  assert.ok(full.revived >= 1)
  closeDb(db)
})

// ---------------------------------------------------------------------------
// M5：C4 图通道（PPR）
// ---------------------------------------------------------------------------

test('图通道：能捞出"词面没命中、但被同批取回/显式关联过"的条目', async () => {
  const { closeDb: cd, migrate: mg, openDb: od } = await import('../lib/db.js')
  const { Recall: R } = await import('../lib/recall.js')
  const { Store: S } = await import('../lib/store.js')
  const db = od(':memory:')
  mg(db)
  const store = new S(db)
  // 小样本：把边数门槛与冷启动门槛调低（生产默认 20 边 / 50 条）
  const recall = new R(store, { coldStartUnits: 0, channels: { graph: { enabled: true, weight: 0.6, minEdges: 1, seedCount: 8 } } })

  // A：查询词面命中；B：与 A 无共同词，但被同批取回过；C：只有一条链路（B—C）
  const a = store.insertUnit({ track: 'memory', scope: 'global', content: '搜索插件已换成 AnySearch，走 /v1/search 与 /v1/extract。' })
  const b = store.insertUnit({ track: 'memory', scope: 'global', content: '该网关的密钥放在 ~/.dsh/.credentials.yaml 的 refs 里，改完无需重启。' })
  const c = store.insertUnit({ track: 'key', scope: 'global', content: '本机凭据文件由 credentials-local 热刷新，落盘即生效。' })
  const ins = db.prepare('INSERT INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, ?, ?)')
  ins.run(a.id, b.id, 'coRetrieval', 1)
  ins.run(b.id, c.id, 'association', 0.8)

  // 词法/稀疏通道：只有 A 命中（B、C 无共同词）
  const lexical = recall.channelLexical('AnySearch 搜索插件', { scopes: 'all', limit: 10 })
  assert.ok(lexical.some((h) => h.id === a.id), 'A 应被词法命中')
  assert.ok(!lexical.some((h) => h.id === b.id), 'B 不应被词法命中（这是前提）')

  const graph = recall.channelGraph('AnySearch 搜索插件', { scopes: 'all', limit: 10 })
  const ids = graph.list.map((h) => h.id)
  assert.ok(ids.includes(b.id), `B 应被图通道捞出：${JSON.stringify(ids)}`)
  assert.ok(ids.includes(c.id), '二跳的 C 也应被捞出（PPR 会沿链传播）')
  assert.ok(!ids.includes(a.id), '种子自身不再由图通道重复给出')
  assert.ok(graph.list[0].reason.includes('PPR'), graph.list[0].reason)

  // 融合后：B 进入候选集（词面完全没有它的情况下）
  const res = recall.search({ query: 'AnySearch 搜索插件', k: 8 })
  assert.ok(res.hits.some((r) => r.id === b.id), `融合结果里应出现 B：${JSON.stringify(res.hits.map((r) => r.id))}`)
  const bHit = res.hits.find((r) => r.id === b.id)
  assert.ok(bHit.channels.graph, 'B 的命中来源应标注为 graph 通道')
  cd(db)
})

test('图通道：关联边不足时明确跳过（不硬凑结果）', async () => {
  const { closeDb: cd, migrate: mg, openDb: od } = await import('../lib/db.js')
  const { Recall: R } = await import('../lib/recall.js')
  const { Store: S } = await import('../lib/store.js')
  const db = od(':memory:')
  mg(db)
  const store = new S(db)
  const recall = new R(store, { coldStartUnits: 0 })
  store.insertUnit({ track: 'memory', scope: 'global', content: '一条没有关联边的记忆。' })
  const graph = recall.channelGraph('记忆', { scopes: 'all', limit: 10 })
  assert.equal(graph.list.length, 0)
  assert.ok(graph.reason.includes('关联边不足'), graph.reason)
  const res = recall.search({ query: '记忆', k: 5 })
  assert.equal(res.channels.graph.skipped.includes('关联边不足'), true, JSON.stringify(res.channels.graph))
  cd(db)
})
