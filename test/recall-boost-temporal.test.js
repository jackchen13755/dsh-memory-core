/**
 * t4 检索侧：乘性加权层 + 时序通道 + 实体归一化匹配（lib/recall.js）。
 *
 * 覆盖：
 *   1. **可执行对照**：boosts.enabled=false 时与改造前的 recall.js（固定基线提交 51f966e，
 *      测试运行时用 `git show 51f966e:lib/recall.js` 取回并 import）在同一 fixture 上
 *      逐条比 id/rank/rrf；另有一份从改造前实现录制的 golden（基线取不到时仍然有效）。
 *      注意不要改用 HEAD：本改造一提交，HEAD 就是含改造的代码，对照会退化成自比对。
 *   2. α 全 0 等价于 enabled=false（每个 boost 括号恒为 1.0）。
 *   3. **保底席位来源**：hits 的前 baselineSeats 条 = 纯 C1+C2 RRF 的前 N 名；
 *      加权只改总榜（overall）排序，不得打穿这条约束。
 *   4. 四个信号的取值与边界（recency 基准时间 = occurred_at ?? created_at，含 clamp 与中性值）。
 *   5. usage 信号（units.access_count）确实生效且可配；proof 只作用于 abstract。
 *   6. 语料新鲜度：演化只 UPDATE importance/access_count（不 bump updated_at）后加权层看得见。
 *   7. 时序通道：中文时间表达解析（今天/昨天/前天/本周/上周/本月/上个月/最近N天/N天前/今年/去年/
 *      YYYY-MM/YYYY-MM-DD）、解析不出时 skippedReason 跳过、窗口内按 bm25 选、
 *      分时间桶取代表（同桶极密 + 稀疏跨桶）、时间字段 COALESCE。
 *   8. 实体归一化匹配：大小写/空白/全角/分隔符差异不再漏配，加分数值语义不变（+4 / +1.5）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { DEFAULT_CONFIG, Recall, parseTimeWindow, signalImportance, signalProof, signalRecency, signalUsage } from '../lib/recall.js'
import { extractEntities } from '../lib/entities.js'
import { Store } from '../lib/store.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400000

// ───────────────────────────── 基础设施 ─────────────────────────────

function fixture({ units = [], config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memcore-t4-'))
  const db = openDb(join(dir, 'mem.db'))
  migrate(db)
  const store = new Store(db)
  for (const u of units) seed(store, u)
  return { db, store, recall: new Recall(store, config) }
}

/**
 * 插入一条记忆并补齐加权层要用的列（insertUnit 不暴露 importance/access_count/occurred_at/pinned，
 * 这里直接 UPDATE —— 也顺带**不 bump updated_at**，与演化的写法一致）。
 */
function seed(store, { id, content, track = 'memory', scope = 'global', kind = 'fact', meta = null, importance = 0.5, accessCount = 0, occurredAt = null, pinned = 0, createdAt = null }) {
  const res = store.insertUnit({ id, track, scope, kind, content, meta, createdAt, importance })
  assert.ok(res.id, `插入失败：${content}`)
  store.db
    .prepare('UPDATE units SET importance = ?, access_count = ?, occurred_at = ?, pinned = ? WHERE id = ?')
    .run(importance, accessCount, occurredAt, pinned, res.id)
  return res.id
}

/** 纯 C1+C2 的 RRF 排序（对照 search 里的 baseline 段）。 */
function pureBaselineOrder(recall, query, scopes = 'all') {
  const cfg = recall.config
  const fused = new Map()
  const add = (name, list) => {
    const w = cfg.channels[name]?.weight ?? 1
    for (const hit of list) {
      const e = fused.get(hit.id) ?? { id: hit.id, rrf: 0 }
      e.rrf += w / (cfg.rrfK + hit.rank)
      fused.set(hit.id, e)
    }
  }
  add('lexical', recall.channelLexical(query, { scopes, limit: cfg.perChannel }))
  add('sparse', recall.channelSparse(query, { scopes, limit: cfg.perChannel }))
  return [...fused.values()].sort((a, b) => b.rrf - a.rrf).map((e) => e.id)
}

/**
 * 本改造的**基线提交**（v0.0.13 的 51f966e）。对照必须锚在这个固定 SHA 上：
 * 锚 HEAD 的话，本改造一提交，HEAD 就变成"含改造的代码"，对照立刻退化成同一份代码自比对
 * （测试仍然全绿，但什么都没证明）。
 */
const LEGACY_REF = '51f966e'

/**
 * 改造前的实现（基线的 lib/recall.js）：把文件与两个自包含依赖落到临时目录后 import。
 * 这是**可执行对照**，不是"看着一样"——同一个 fixture、同一批查询，两套实现逐条比 id/rank/rrf。
 */
function loadLegacyRecall() {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'memcore-legacy-'))
    writeFileSync(join(dir, 'recall.js'), execFileSync('git', ['show', `${LEGACY_REF}:lib/recall.js`], { cwd: repoRoot, encoding: 'utf8' }))
    cpSync(join(repoRoot, 'lib/tokens.js'), join(dir, 'tokens.js'))
    cpSync(join(repoRoot, 'lib/entities.js'), join(dir, 'entities.js'))
    return { mod: null, url: pathToFileURL(join(dir, 'recall.js')).href, error: null }
  } catch (error) {
    return { mod: null, url: null, error: error.message }
  }
}

const legacyRef = loadLegacyRecall()
const legacy = legacyRef.url ? await import(legacyRef.url) : null

/** 对照 fixture：没有时间表达、没有实体的普通查询，隔离出"加权层"这一个变量。 */
const CONTROL_UNITS = [
  { id: 'c1', content: '底部按钮布局 底部按钮布局 底部按钮布局 直接用现成实现', importance: 0.06, accessCount: 3 },
  { id: 'c2', content: '底部按钮布局 的一点补充说明', importance: 1.0, accessCount: 5000 },
  { id: 'c3', content: '底部按钮 组件规范：不要裸用 antd 的 Button', importance: 0.4, accessCount: 120 },
  { id: 'c4', content: '抽屉底部按钮宽度为什么写死', importance: 0.2, accessCount: 900 },
  { id: 'c5', content: '完全无关的条目：禅道单子怎么点解决', importance: 0.9, accessCount: 4000 },
  { id: 'c6', content: '无关条目：图表的颜色规范', importance: 0.7, accessCount: 200 },
]
const CONTROL_QUERIES = ['底部按钮布局', '抽屉底部按钮宽度', '底部按钮 antd 组件规范']

// ───────────────────────────── 1/2. 等价对照 ─────────────────────────────

/**
 * golden：用**改造前**的实现（基线 51f966e 的 recall.js，见文件头注释）在同一 fixture 上录制。
 * 录制命令（改造时点执行）：
 *   git stash && node <录制脚本> && git stash pop
 * 对照实现（上面 import 的基线版本）在本测试里还会再跑一次逐位比对；
 * golden 的作用是：即使将来那份可执行对照取不到，这份"改造前行为"的证据仍然在仓库里。
 */
const GOLDEN_LEGACY_HITS = {
  '底部按钮布局': ['c2', 'c1', 'c4', 'c3'],
  '抽屉底部按钮宽度': ['c4', 'c2', 'c1', 'c3'],
  '底部按钮 antd 组件规范': ['c3', 'c2', 'c6', 'c1', 'c4'],
}

test('对照：boosts.enabled=false 与改造前实现逐位等价（基线 51f966e import 对照）', async (t) => {
  // 基线取不到（浅克隆/无 git）时必须**显式失败**：静默跳过等于把唯一的可执行对照变成假绿。
  assert.ok(legacy, `基线 ${LEGACY_REF} 的可执行对照不可用：${legacyRef.error}`)
  const { db, store, recall } = fixture({ units: CONTROL_UNITS, config: { boosts: { enabled: false } } })
  const legacyStore = new Store(db)
  const legacyRecall = new legacy.Recall(legacyStore, { boosts: { enabled: false } })
  let compared = 0
  for (const query of CONTROL_QUERIES) {
    const now = recall.search({ query, k: 5, log: false })
    // ① 与 golden（录制自改造前实现）逐位一致
    assert.deepEqual(now.hits.map((h) => h.id), GOLDEN_LEGACY_HITS[query], `golden 不一致：${query}`)
    assert.equal(now.boosted, 0, 'enabled=false 时不该有被加权的条目')
    assert.ok(now.hits.every((h) => h.boost === 1 && h.score === h.rrf), 'enabled=false 时 boost 恒 1、score 恒等于 rrf')
    // ② 与基线实现现场比 id / rank / rrf
    const before = legacyRecall.search({ query, k: 5, log: false })
    assert.deepEqual(
      now.hits.map((h) => [h.id, h.rank, h.rrf]),
      before.hits.map((h) => [h.id, h.rank, h.rrf]),
      `与基线(${LEGACY_REF})实现不一致：${query}`,
    )
    assert.equal(now.baselineSeats, before.baselineSeats)
    assert.equal(now.evidence.inject, before.evidence.inject)
    compared += 1
  }
  t.diagnostic(`与基线(${LEGACY_REF})实现逐条对照 ${compared} 条查询`)
  closeDb(db)
})

test('对照：全部 α=0 等价于 enabled=false（因子恒为 1.0，浮点精确）', () => {
  const units = CONTROL_UNITS
  const off = fixture({ units, config: { boosts: { enabled: false } } })
  const zero = fixture({
    units,
    config: { boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 0, usageAlpha: 0, proofAlpha: 0 } },
  })
  for (const query of CONTROL_QUERIES) {
    const a = off.recall.search({ query, k: 5, log: false })
    const b = zero.recall.search({ query, k: 5, log: false })
    assert.deepEqual(b.hits.map((h) => h.id), a.hits.map((h) => h.id), query)
    assert.ok(b.hits.every((h) => h.boost === 1), `α=0 时因子必须是精确的 1：${query}`)
    assert.deepEqual(b.hits.map((h) => h.rrf), a.hits.map((h) => h.rrf))
  }
  closeDb(off.db)
  closeDb(zero.db)
})

// ───────────────────────────── 3. 保底席位 ─────────────────────────────

test('保底席位：前 baselineSeats 条 = 纯 C1+C2 RRF 的前 N 名（加权不得打穿）', () => {
  // **保证的范围（明示契约）**：保底只保"席位集合"——top-k 里至少有 seats 条来自纯 C1+C2 RRF，
  // 不保它们**在 top-k 内的名次**（名次由总榜 order 决定，加权可以压后它们）。
  // 本用例同时把这两半都钉住：集合逐条等于纯 RRF 前 N 名；名次允许位移（下一条断言即证据）。
  const { db, recall } = fixture({ units: CONTROL_UNITS, config: { k: 5 } })
  const query = '底部按钮布局'
  const res = recall.search({ query, k: 5, log: false })
  const baseline = pureBaselineOrder(recall, query)
  assert.equal(res.baselineSeats, Math.max(1, Math.floor(5 * DEFAULT_CONFIG.baselineFloor)))
  assert.equal(res.baselineSeats, 2)
  // ① 席位集合逐条等于"纯 C1+C2 RRF 排序"的前 N 名 —— 钉住它的来源
  assert.deepEqual(res.baselineIds, baseline.slice(0, res.baselineSeats))
  for (const id of res.baselineIds) assert.ok(res.hits.some((h) => h.id === id), `${id} 拿了保底席位却没进结果`)

  // c2（importance 1.0 / access 5000）在加权后必须越过 c1，但**抢不走**保底席位
  const c1 = res.hits.find((h) => h.id === 'c1')
  const c2 = res.hits.find((h) => h.id === 'c2')
  assert.ok(c1 && c2)
  assert.ok(c2.boost > 1 && c1.boost < 1, `加权应压低低价值条目、抬高高价值条目：c1=${c1.boost} c2=${c2.boost}`)
  assert.equal(res.baselineIds[1], 'c1', 'c1 是纯 RRF 第 2 名，必须原样拿到保底席位')
  assert.ok(res.hits.indexOf(c1) > 0, 'c1 只拿到保底席位，不能靠加权排到最前')
  // ② 名次不保底：hits 的顺序必须按"总榜（含加权）"排，而不是"先保底后补位"的拼接序。
  //    这里 c2 在总榜第 1、c1 被加权压后 → 若有人把保底改成"名次也保"，本断言会立刻红。
  for (let i = 1; i < res.hits.length; i += 1) {
    assert.ok(res.hits[i - 1].score >= res.hits[i].score, `hits 必须按总榜分数降序（名次不受保底保护）：${res.hits.map((h) => h.id)}`)
  }
  assert.equal(res.hits[0].id, c2.id, '总榜第 1 应是加权后的 c2，而不是保底第 1 的 c1')
  // 加权只影响 overall：c2 的 score 与 rrf 的关系印证"乘性叠加在 RRF 上"
  assert.ok(Math.abs(c2.score - c2.rrf * c2.boost) < 1e-12)
  closeDb(db)
})

test('加权只改总榜：把 α 调大只改变补位顺序，保底席位不变', () => {
  const off = fixture({ units: CONTROL_UNITS, config: { boosts: { enabled: false } } })
  const strong = fixture({
    units: CONTROL_UNITS,
    config: { boosts: { enabled: true, recencyAlpha: 0.2, importanceAlpha: 2, usageAlpha: 2, proofAlpha: 0.1 } },
  })
  for (const query of CONTROL_QUERIES) {
    const a = off.recall.search({ query, k: 5, log: false })
    const b = strong.recall.search({ query, k: 5, log: false })
    assert.equal(b.baselineSeats, a.baselineSeats, query)
    assert.deepEqual(b.baselineIds, a.baselineIds, `保底席位被加权改动了：${query}`)
    assert.ok(b.boosted > 0, '开启加权后应报告被加权的条目数')
    // 加权确实改动了总榜：至少有一条查询的补位顺序与不加权时不同
  }
  const q = '底部按钮布局'
  assert.notDeepEqual(
    strong.recall.search({ query: q, k: 5, log: false }).hits.map((h) => h.id),
    off.recall.search({ query: q, k: 5, log: false }).hits.map((h) => h.id),
    '加权层没有生效（总榜顺序应与不加权时不同）',
  )
  closeDb(off.db)
  closeDb(strong.db)
})

// ───────────────────────────── 4. 信号取值 ─────────────────────────────

test('信号：recency 基准时间 = occurred_at ?? created_at，clamp 到 [0.1, 1]', () => {
  const now = Date.UTC(2026, 9, 14, 12)
  assert.equal(signalRecency(now, now, 365), 1)
  assert.equal(signalRecency(now - 182.5 * DAY, now, 365), 0.5)
  assert.equal(signalRecency(now - 365 * DAY, now, 365), 0.1, '衰减到 0 时被 clamp 到下限 0.1')
  assert.equal(signalRecency(now - 5000 * DAY, now, 365), 0.1)
  assert.equal(signalRecency(now + 5 * DAY, now, 365), 1, '未来时间不越界')
  assert.equal(signalRecency(null, now, 365), 0.1, '时间未知 → 保守下限')
  assert.equal(signalRecency(await0(), now, 365), 0.1, '非法时间 → 保守下限')
  assert.equal(signalRecency(now - 365 * DAY, now, 0), 0.1, 'span 非法时回落 365')
  function await0() {
    return Number.NaN
  }
})

test('信号：importance 0..1、0.5 中性；usage 按 access_count 的 ln 饱和且参考点可配', () => {
  assert.equal(signalImportance(0.5), 0.5)
  assert.equal(signalImportance(1), 1)
  assert.equal(signalImportance(0), 0)
  assert.equal(signalImportance(3), 1, '越界 clamp')
  assert.equal(signalImportance(-1), 0)
  assert.equal(signalImportance(Number.NaN), 0.5, '非法值取中性')
  assert.equal(signalImportance(undefined), 0.5)

  assert.equal(signalUsage(0, 1000), 0, '从未取回 = 0 使用证据')
  assert.equal(signalUsage(-5, 1000), 0)
  assert.equal(signalUsage(Number.NaN, 1000), 0)
  assert.equal(signalUsage(1000, 1000), 1)
  assert.equal(signalUsage(100, 100), 1, '参考点可配：同值即饱和')
  assert.ok(signalUsage(100, 1000) < 1 && signalUsage(100, 1000) > 0)
  assert.ok(signalUsage(5000, 1000) === 1, '超过参考点 clamp 到 1')
  assert.ok(signalUsage(10, 1000) < signalUsage(100, 1000))
})

test('信号：proof 仅 abstract 生效（非 abstract 恒 0.5 中性）', () => {
  assert.equal(signalProof('fact', 0), 0.5)
  assert.equal(signalProof('rule', 42), 0.5, '非 abstract 不应被证据数奖惩')
  assert.equal(signalProof(undefined, 3), 0.5)
  assert.equal(signalProof('abstract', 0), 0, '无派生证据的抽象层条目 → clamp 到 0')
  assert.equal(signalProof('abstract', 1), 0.5)
  assert.ok(Math.abs(signalProof('abstract', 10) - (0.5 + Math.log(10) / 10)) < 1e-12)
  assert.equal(signalProof('abstract', 1e6), 1, '越界 clamp')
})

// ───────────────────────────── 5. 信号接线 ─────────────────────────────

test('usage 信号：access_count 只在开启 usageAlpha 时影响总榜', () => {
  const units = [
    { id: 'lo', content: '缓存失效策略：写回与写穿的区别', accessCount: 5, importance: 0.5 },
    { id: 'hi', content: '缓存失效策略：写回与写穿的区别说明', accessCount: 5000, importance: 0.5 },
  ]
  const withUsage = fixture({ units, config: { boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 0, usageAlpha: 1, proofAlpha: 0 } } })
  const without = fixture({ units, config: { boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 0, usageAlpha: 0, proofAlpha: 0 } } })
  const a = withUsage.recall.search({ query: '缓存失效策略 写回 写穿', k: 2, log: false })
  const b = without.recall.search({ query: '缓存失效策略 写回 写穿', k: 2, log: false })
  assert.equal(a.hits.find((h) => h.id === 'hi').signals.usage, 1)
  assert.ok(a.hits.find((h) => h.id === 'lo').signals.usage < 1)
  assert.equal(a.hits.find((h) => h.id === 'hi').boost, 1 + 1 * (1 - 0.5), 'boost = 1 + α(signal−0.5)')
  assert.equal(b.hits.find((h) => h.id === 'hi').boost, 1)
  assert.equal(a.hits[0].id, 'hi', 'usageAlpha 打开后取回次数多的条目应排前面')
  closeDb(withUsage.db)
  closeDb(without.db)
})

test('recency 信号：occurred_at 优先于 created_at（事件时间，不是写入时间）', () => {
  const now = Date.UTC(2026, 9, 14, 12)
  const units = [
    // 老事件、新写入
    { id: 'oldEvent', content: '发布流程：灰度与回滚的操作步骤', createdAt: now - DAY, occurredAt: now - 900 * DAY, importance: 0.5 },
    // 新事件、老写入
    { id: 'newEvent', content: '发布流程：灰度与回滚的操作步骤补充', createdAt: now - 900 * DAY, occurredAt: now - DAY, importance: 0.5 },
  ]
  const { db, recall } = fixture({
    units,
    config: { boosts: { enabled: true, recencyAlpha: 1, importanceAlpha: 0, usageAlpha: 0, proofAlpha: 0, recencySpanDays: 365 } },
  })
  const res = recall.search({ query: '发布流程 灰度 回滚 操作步骤', k: 2, log: false, now })
  const oldEvent = res.hits.find((h) => h.id === 'oldEvent')
  const newEvent = res.hits.find((h) => h.id === 'newEvent')
  assert.equal(oldEvent.signals.recency, 0.1, 'occurred_at 优先：老事件的 signal 由事件时间算')
  assert.ok(newEvent.signals.recency > 0.9)
  assert.ok(newEvent.boost > oldEvent.boost)
  assert.equal(res.hits[0].id, 'newEvent', 'recencyAlpha 生效后新事件应排前')
  closeDb(db)
})

test('proof 信号：derivedFrom 入边数只作用于 abstract 条目', () => {
  const units = [
    // 词面更弱、但有 3 条派生证据
    { id: 'absProved', content: '抽象：本机 Figma 还原链路的固定顺序', kind: 'abstract', importance: 0.5 },
    // 词面更强、无派生证据
    { id: 'absBare', content: '抽象 Figma 还原链路 固定顺序 抽象 Figma 还原链路 固定顺序', kind: 'abstract', importance: 0.5 },
    { id: 'factSame', content: '普通条目：与查询无关', kind: 'fact', importance: 0.5 },
  ]
  const { db, store, recall } = fixture({
    units,
    config: { boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 0, usageAlpha: 0, proofAlpha: 1 }, coldStartUnits: 0 },
  })
  for (const [n, from] of ['e1', 'e2', 'e3'].entries()) {
    seed(store, { id: from, content: `无关的证据条目 ${n}`, kind: 'fact' })
    db.prepare("INSERT INTO edges (from_id, to_id, kind, weight) VALUES (?, 'absProved', 'derivedFrom', 1)").run(from)
  }
  recall.corpus.ensure()
  assert.equal(recall.boostFor('absProved').signals.proof, 0.5 + Math.log(3) / 10)
  assert.equal(recall.boostFor('absBare').signals.proof, 0, '无派生证据的抽象层条目 → 0')
  assert.equal(recall.boostFor('factSame').signals.proof, 0.5, '普通条目恒中性')

  const query = '抽象 Figma 还原链路 固定顺序'
  const res = recall.search({ query, k: 2, log: false })
  assert.equal(res.hits[0].id, 'absProved', '有派生证据的抽象条目应越过词面更强的无证据条目')
  assert.equal(res.hits[1].id, 'absBare')

  // 关掉 proof 权重 → 回到词面排序（证明上面的翻转确实由 proof 信号带来）
  const plain = fixture({
    units,
    config: { boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 0, usageAlpha: 0, proofAlpha: 0 }, coldStartUnits: 0 },
  })
  assert.equal(plain.recall.search({ query, k: 2, log: false }).hits[0].id, 'absBare')
  closeDb(db)
  closeDb(plain.db)
})

test('语料新鲜度：演化只改 importance/access_count（不 bump updated_at）后加权层仍看得见', () => {
  const units = [
    { id: 'x1', content: '构建产物目录约定：dist 与 lib 的分工', importance: 0.1, accessCount: 1 },
    { id: 'x2', content: '构建产物目录约定的补充说明', importance: 0.1, accessCount: 1 },
  ]
  const { db, recall } = fixture({ units, config: { boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 1, usageAlpha: 0, proofAlpha: 0 } } })
  const before = recall.search({ query: '构建产物目录约定 dist lib 分工', k: 2, log: false })
  assert.equal(before.hits.find((h) => h.id === 'x1').boost, 1 + 1 * (0.1 - 0.5))
  // 模拟演化/取回：只 UPDATE 信号列，updated_at 不动
  db.prepare('UPDATE units SET importance = 1.0, access_count = 9999 WHERE id = ?').run('x1')
  const after = recall.search({ query: '构建产物目录约定 dist lib 分工', k: 2, log: false })
  assert.equal(after.hits.find((h) => h.id === 'x1').boost, 1 + 1 * (1.0 - 0.5), '陈旧语料会让加权层用旧重要性打分')
  closeDb(db)
})

// ───────────────────────────── 6. 时序通道 ─────────────────────────────

test('时序解析：今天 / 昨天 / 前天 / 本周 / 上周 / 本月 / 上个月 / 今年 / 去年', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime() // 2026-10-14（周三）本地 12:00
  const day = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0).getTime()
  const win = (q) => parseTimeWindow(q, { now })

  assert.deepEqual(win('今天改了什么').from ?? null, day(2026, 10, 14))
  assert.equal(win('今天改了什么').to, day(2026, 10, 15))
  assert.equal(win('昨天提交的记录').label, '昨天')
  assert.equal(win('昨天提交的记录').from, day(2026, 10, 13))
  assert.equal(win('昨天提交的记录').to, day(2026, 10, 14))
  assert.equal(win('前天的那次评审').from, day(2026, 10, 12))

  const week = win('本周的进展')
  assert.equal(week.from, day(2026, 10, 12), '周一为一周之始')
  assert.equal(week.to, day(2026, 10, 19))
  const lastWeek = win('上周做了什么')
  assert.equal(lastWeek.from, day(2026, 10, 5))
  assert.equal(lastWeek.to, day(2026, 10, 12))

  const month = win('本月的记录')
  assert.equal(month.from, day(2026, 10, 1))
  assert.equal(month.to, day(2026, 11, 1))
  const lastMonth = win('上个月的需求')
  assert.equal(lastMonth.from, day(2026, 9, 1))
  assert.equal(lastMonth.to, day(2026, 10, 1))
  assert.equal(win('上月').from, day(2026, 9, 1))

  assert.equal(win('今年的目标').from, day(2026, 1, 1))
  assert.equal(win('今年的目标').to, day(2027, 1, 1))
  assert.equal(win('去年踩过的坑').from, day(2025, 1, 1))
  assert.equal(win('去年踩过的坑').to, day(2026, 1, 1))
})

test('时序解析：最近N天 / N天前 / YYYY-MM / YYYY-MM-DD；解析不出一律 null', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime()
  const day = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0).getTime()
  const win = (q) => parseTimeWindow(q, { now })

  const last3 = win('最近3天都有什么')
  assert.equal(last3.label, '最近3天')
  assert.equal(last3.from, day(2026, 10, 12), '含今天在内共 3 个日历日')
  assert.equal(last3.to, now + 1)
  assert.equal(win('近 7 天').from, day(2026, 10, 8))
  assert.equal(win('3天内改动').from, day(2026, 10, 12))

  const ago = win('3天前那笔改动')
  assert.equal(ago.label, '3天前')
  assert.equal(ago.from, day(2026, 10, 11))
  assert.equal(ago.to, day(2026, 10, 12))

  const ym = win('2026-09 的月度总结')
  assert.equal(ym.label, '2026-09')
  assert.equal(ym.from, day(2026, 9, 1))
  assert.equal(ym.to, day(2026, 10, 1))

  const ymd = win('2026-09-28 那天的评审')
  assert.equal(ymd.label, '2026-09-28')
  assert.equal(ymd.from, day(2026, 9, 28))
  assert.equal(ymd.to, day(2026, 9, 29))

  // 解析不出 → null（宁可跳过，不猜窗口）
  for (const q of ['这个按钮怎么改', '发布流程是什么', '2026-13-45', '400 报错怎么办', '5875 客商主数据页面']) {
    assert.equal(win(q), null, `不该解析出窗口：${q}`)
  }
})

test('时序通道：窗口内按 bm25 选（不是按新近度），时间字段走 COALESCE', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime()
  const day = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0).getTime()
  const units = [
    // 昨天窗口内的两条：弱相关但更新 / 强相关但更早（同一天内早晚）
    { id: 't-in-old', content: '昨天做的：底部按钮布局 底部按钮布局 底部按钮布局 底部按钮布局 收尾', occurredAt: day(2026, 10, 13) },
    { id: 't-in-new', content: '昨天做的：底部按钮布局 收尾', occurredAt: day(2026, 10, 13) + 6 * 3600 * 1000 },
    // 窗口外（前天）
    { id: 't-out', content: '底部按钮布局 底部按钮布局 底部按钮布局 底部按钮布局 底部按钮布局', occurredAt: day(2026, 10, 12) },
    // occurred_at 未知 → 由 created_at 落进窗口
    { id: 't-coalesce', content: '底部按钮布局 通过 created_at 落进窗口', occurredAt: null, createdAt: day(2026, 10, 13) + 3600 * 1000 },
  ]
  const { db, recall } = fixture({ units, config: { coldStartUnits: 0 } })
  const res = recall.search({ query: '昨天 底部按钮布局', k: 5, log: false, now })
  // 直接用通道输出断言窗口选择
  const ch = recall.channelTemporal('昨天 底部按钮布局', { scopes: 'all', limit: 5, now })
  const ids = ch.list.map((h) => h.id)
  assert.ok(ids.includes('t-in-old') && ids.includes('t-in-new'), '窗口内条目应被召回')
  assert.ok(!ids.includes('t-out'), '窗口外条目绝不能进')
  assert.ok(ids.includes('t-coalesce'), 'occurred_at 为 NULL 时回落 created_at')
  assert.ok(ch.list[0].score > ch.list[ch.list.length - 1].score, '按语义相关性 bm25 排序')
  // 搜索结果里 temporal 通道有计数、无 skipped
  assert.equal(res.channels.temporal.count, ch.list.length)
  assert.equal(res.channels.temporal.skipped, null)
  closeDb(db)
})

test('时序通道：解析不出窗口时安全跳过并给出 skippedReason', () => {
  const { db, recall } = fixture({ units: CONTROL_UNITS, config: { coldStartUnits: 0 } })
  const res = recall.search({ query: '底部按钮布局', k: 5, log: false })
  assert.equal(res.channels.temporal.count, 0)
  assert.equal(res.channels.temporal.skipped, '未解析出时间窗口')
  assert.equal(res.channels.temporal.error, null)
  // 冷启动（条目太少）时该通道整段跳过，不报"未解析出窗口"
  const cold = fixture({ units: CONTROL_UNITS })
  assert.equal(cold.recall.search({ query: '昨天有什么', k: 5, log: false }).channels.temporal.skipped, '冷启动（记忆量低于阈值）')
  // 显式关闭时不报 skippedReason 而是 disabled
  const off = fixture({ units: CONTROL_UNITS, config: { channels: { temporal: { enabled: false } }, coldStartUnits: 0 } })
  assert.equal(off.recall.search({ query: '昨天有什么', k: 5, log: false }).channels.temporal.skipped, 'disabled')
  closeDb(db)
  closeDb(cold.db)
  closeDb(off.db)
})

test('时序通道：分时间桶取代表 —— 同桶极密 + 稀疏跨桶时不会全挤在一段', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime()
  const day = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0).getTime()
  const units = []
  // 9 月 2 日（同一桶）极密：12 条
  for (let i = 0; i < 12; i += 1) {
    units.push({ id: `dense${i}`, content: `底部按钮布局 的第 ${i} 条重复记录`, occurredAt: day(2026, 9, 2, 9 + (i % 8)) })
  }
  // 跨桶稀疏：9 月 10 日 / 9 月 20 日 各 1 条
  units.push({ id: 'sparse-a', content: '底部按钮布局 稀疏记录 A', occurredAt: day(2026, 9, 10) })
  units.push({ id: 'sparse-b', content: '底部按钮布局 稀疏记录 B', occurredAt: day(2026, 9, 20) })
  const { db, recall } = fixture({ units, config: { coldStartUnits: 0 } })
  const ch = recall.channelTemporal('2026-09 底部按钮布局', { scopes: 'all', limit: 3, now })
  const ids = ch.list.map((h) => h.id)
  assert.equal(ids.length, 3)
  assert.deepEqual(ids, ['sparse-a', 'sparse-b', 'dense0'], '桶间轮转：三个桶各出一个代表')
  const days = new Set(ch.list.map((h) => new Date(units.find((u) => u.id === h.id).occurredAt).getDate()))
  assert.equal(days.size, 3, '窗口内结果必须分散在多个时间桶（3 个不同日）')
  // limit 大于桶数时，稠密桶的第二条才在后面补上
  const wide = recall.channelTemporal('2026-09 底部按钮布局', { scopes: 'all', limit: 5, now })
  assert.equal(wide.list.length, 5)
  assert.ok(wide.list.map((h) => h.id).filter((id) => id.startsWith('dense')).length >= 2)
  closeDb(db)
})

// ───────────────────────────── 7. 实体归一化匹配 ─────────────────────────────

test('实体归一化：大小写 / 内部空白 / 全角 / 分隔符差异不再漏配（精确仍 +4）', () => {
  // 每组：doc 侧写一种变体，query 侧写另一种 —— 归一化后是同一个键，改造前用裸串比较会漏配
  const cases = [
    ['盘符反斜杠 vs 正斜杠', 'C:\\Users\\Alice\\ProjectSrc', '/Users/Alice/ProjectSrc 是什么'],
    ['大小写', 'FootButton', '`footbutton` 是什么'],
    ['内部连续空白 vs 单空格', 'Footer  Button', '`Footer Button` 是什么'],
    ['全角 vs 半角', 'ＡｐｐＪＳ', '`AppJS` 是什么'],
    ['别名路径 + 尾部斜杠 + 大小写', '@/Repo/Src/', '@/repo/src 是什么'],
  ]
  let i = 0
  for (const [label, docEnt, query] of cases) {
    i += 1
    assert.equal(extractEntities(query).length, 1, `${label}：查询侧应只抽出一个实体，避免多实体干扰数值断言`)
    const { db, recall } = fixture({
      units: [
        // 两条**同 token、同长度**的条目，只有实体不同 —— 用于隔离出实体加分
        { id: `hit${i}`, content: `实体归一化样本 ${i}：这是什么情况`, track: 'memory', meta: { ent: [docEnt] } },
        { id: `miss${i}`, content: `实体归一化样本 ${i}：这是什么情况`, track: 'key', meta: { ent: ['完全无关的实体'] } },
      ],
    })
    const list = recall.channelSparse(query, { scopes: 'all', limit: 10 })
    const hit = list.find((h) => h.id === `hit${i}`)
    const miss = list.find((h) => h.id === `miss${i}`)
    assert.ok(hit, `${label}：归一化后应命中`)
    assert.ok(miss, label)
    assert.ok(Math.abs((hit.score - miss.score) - 4) < 1e-9, `${label}：精确命中仍应 +4，实得 ${hit.score - miss.score}`)
    assert.equal(list[0].id, `hit${i}`, label)
    // 证据判定同样走归一化：命中条目应被记为"实体精确命中"
    const res = recall.search({ query, k: 5, log: false })
    assert.ok(res.evidence.reasons.some((r) => r.startsWith(`hit${i}:实体精确命中`)), label)
    closeDb(db)
  }
})

test('实体归一化：部分包含仍走 +1.5 一档（换写法命中别名）', () => {
  const query = '/Users/Alice/ProjectSrc/Extra 是什么'
  assert.equal(extractEntities(query).length, 1)
  const { db, recall } = fixture({
    units: [
      { id: 'partial', content: '别名命中样本：这是什么情况', meta: { ent: ['/Users/Alice/ProjectSrc'] } },
      { id: 'plain', content: '别名命中样本：这是什么情况', track: 'key', meta: { ent: ['无关实体'] } },
    ],
  })
  const list = recall.channelSparse(query, { scopes: 'all', limit: 10 })
  const partial = list.find((h) => h.id === 'partial')
  const plain = list.find((h) => h.id === 'plain')
  assert.ok(partial && plain)
  assert.ok(Math.abs((partial.score - plain.score) - 1.5) < 1e-9, `部分包含仍应 +1.5，实得 ${partial.score - plain.score}`)
  closeDb(db)
})

// ───────────────────────── 默认值契约与灵敏度补测 ─────────────────────────

test('配置契约：boosts / channels.temporal 的默认值 = 契约冻结组（有出处，不得被网格最优值漂移）', () => {
  // 出处：recency 0.2 / importance 0.2 / proof 0.1 取自 hindsight 的实际设计值；
  // usage（本机独有信号）与它们并列取同一量级 0.2；span 365 = 一年；ref 1000 = 取回次数的饱和参考点。
  // 网格扫描出的更优组合（ua 0.4 / ref 500 等）**没有先验依据，属拟合**，不得写进默认值 —— 这条断言就是防线。
  assert.equal(DEFAULT_CONFIG.boosts.enabled, true)
  assert.equal(DEFAULT_CONFIG.boosts.recencyAlpha, 0.2)
  assert.equal(DEFAULT_CONFIG.boosts.importanceAlpha, 0.2)
  assert.equal(DEFAULT_CONFIG.boosts.usageAlpha, 0.2)
  assert.equal(DEFAULT_CONFIG.boosts.proofAlpha, 0.1)
  assert.equal(DEFAULT_CONFIG.boosts.recencySpanDays, 365)
  assert.equal(DEFAULT_CONFIG.boosts.usageReference, 1000)
  assert.equal(DEFAULT_CONFIG.boosts.now, null)
  assert.deepEqual(DEFAULT_CONFIG.channels.temporal, { enabled: true, weight: 1 })
  // 构造出的 Recall 必须原样继承默认（配置里没写的键也要在）
  const { db, recall } = fixture({ units: CONTROL_UNITS })
  assert.equal(recall.config.boosts.recencyAlpha, 0.2)
  assert.equal(recall.config.boosts.usageReference, 1000)
  assert.equal(recall.config.channels.temporal.enabled, true)
  closeDb(db)
})

test('补测 recencyAlpha=0：recency 信号照算但不再进入因子，总榜顺序等价于"时间被抹平"', () => {
  const now = Date.UTC(2026, 9, 14, 12)
  const base = [
    { id: 'r-old', content: '时间无关样本：写回与写穿的区别', createdAt: now - 900 * DAY, importance: 0.5 },
    { id: 'r-new', content: '时间无关样本：写回与写穿的补充', createdAt: now - DAY, importance: 0.5 },
  ]
  const query = '时间无关样本 写回 写穿 区别 补充'
  const mk = (units, recencyAlpha) =>
    fixture({
      units,
      config: { boosts: { enabled: true, recencyAlpha, importanceAlpha: 0.2, usageAlpha: 0.2, proofAlpha: 0.1 } },
    })
  const off = mk(base, 0)
  const on = mk(base, 1)
  // 同一份内容但时间抹平（两条同时间）→ recency 毫无区分度
  const flattened = mk(base.map((u) => ({ ...u, createdAt: now - DAY })), 1)
  for (const r of [off, on]) r.recall.corpus.ensure()

  const offOld = off.recall.boostFor('r-old', now)
  const offNew = off.recall.boostFor('r-new', now)
  const onOld = on.recall.boostFor('r-old', now)
  const onNew = on.recall.boostFor('r-new', now)
  // 信号本身照算（区别于"把通道关掉"）
  assert.equal(onOld.signals.recency, 0.1)
  assert.ok(onNew.signals.recency > 0.99)
  assert.equal(offOld.signals.recency, onOld.signals.recency)
  assert.equal(offNew.signals.recency, onNew.signals.recency)
  // α=0 → 因子与时间无关；α=1 → 因子随时钟差变化
  assert.equal(offOld.factor, offNew.factor)
  assert.ok(onNew.factor > onOld.factor)
  // 总榜：α=0 的结果与"时间被抹平后仍开 recency"逐条一致
  const a = off.recall.search({ query, k: 2, log: false, now })
  const b = flattened.recall.search({ query, k: 2, log: false, now })
  const c = on.recall.search({ query, k: 2, log: false, now })
  // α=0 → 因子只剩另外三个信号（importance .5 中性、usage 0 → 0.9、proof .5 中性），时间不再参与
  const onlyOthers = 1 * (1 + 0.2 * (0 - 0.5)) * 1
  assert.ok(Math.abs(offOld.factor - onlyOthers) < 1e-12)
  assert.deepEqual(a.hits.map((h) => h.id), b.hits.map((h) => h.id))
  assert.ok(a.hits.every((h) => Math.abs(h.boost - onlyOthers) < 1e-12), 'α=0 时因子不含 recency 项')
  assert.equal(c.hits[0].id, 'r-new', 'recency 开启时新条目排前')
  closeDb(off.db)
  closeDb(on.db)
  closeDb(flattened.db)
})

// ─────────────── T6-1：now 的 null / 非有限兜底（集成路径） ───────────────

test('集成路径：search() 不显式传 now 时，时序通道照常工作（now=null 不得被当成 epoch）', () => {
  // 回归靶子：`Number(null) === 0` 是有限数，早期写法 Number.isFinite(Number(now)) 会把
  // "未指定 now" 当成 1970-01-01 → 窗口整体落到 epoch 附近 → 时序通道永远返回空。
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStart = today.getTime()
  const yesterdayStart = todayStart - DAY
  const units = [
    // 昨天 10:00（本地）的事件
    { id: 'y-hit', content: '昨天 底部按钮布局 的改动记录', kind: 'progress', occurredAt: yesterdayStart + 10 * 3600 * 1000 },
    // 今天（不在"昨天"窗口内）
    { id: 't-other', content: '今天 底部按钮布局 的改动记录', kind: 'progress', occurredAt: todayStart + 60 * 1000 },
  ]
  const { db, recall } = fixture({ units, config: { coldStartUnits: 0 } })
  const res = recall.search({ query: '昨天 底部按钮布局', k: 5, log: false }) // 注意：不传 now
  assert.ok(res.channels.temporal.count > 0, `时序通道应有命中，实得 ${res.channels.temporal.count}（skipped=${res.channels.temporal.skipped}）`)
  assert.equal(res.channels.temporal.skipped, null)
  assert.ok(res.hits.some((h) => h.id === 'y-hit'), '昨天的事件必须被召回')
  const hit = res.hits.find((h) => h.id === 'y-hit')
  assert.ok(hit.occurredAt >= yesterdayStart && hit.occurredAt < todayStart, '命中条的 occurred_at 必须落在"昨天"窗口内')
  closeDb(db)
})

test('parseTimeWindow：now = null / undefined / NaN 一律回落"当前时刻"（不落 epoch）', () => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const expectFrom = today.getTime() - DAY
  for (const now of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 'not-a-date']) {
    const w = parseTimeWindow('昨天', { now })
    assert.ok(w, `now=${String(now)} 仍应解析出窗口`)
    assert.equal(w.from, expectFrom, `now=${String(now)} 必须回落 Date.now() 而不是 0`)
    assert.equal(w.to, today.getTime())
  }
  // 显式传 0 仍按显式值处理（不是"缺省"）——只有 null / 非有限才回落 Date.now()
  const zero = parseTimeWindow('昨天', { now: 0 })
  assert.ok(zero.from < new Date(1971, 0, 1).getTime(), 'now=0 应按"1970 附近的昨天"算，而不是回落今天')
  // 显式传值照用
  const explicit = new Date(2026, 9, 14, 12).getTime()
  const w = parseTimeWindow('昨天', { now: explicit })
  assert.equal(w.from, new Date(2026, 9, 13).getTime())
})

test('集成路径：channelTemporal 不传 now 时回落到 boosts.now，再回落到当前时刻', () => {
  const cfgNow = new Date(2026, 9, 14, 12, 0, 0).getTime()
  const local = (y, m, d, h = 10) => new Date(y, m - 1, d, h).getTime()
  const realToday = new Date()
  realToday.setHours(0, 0, 0, 0)
  const units = [
    // 相对 cfgNow（2026-10-14 12:00）的"昨天"
    { id: 'sep-hit', content: '昨天 底部按钮布局 的改动记录', occurredAt: local(2026, 10, 13) },
    // 很远的另一天：任何合理窗口都不该收进来
    { id: 'jan-hit', content: '昨天 底部按钮布局 的远古记录（窗口外）', occurredAt: local(2026, 1, 20) },
    // 相对**真实当前时刻**的"昨天"：用于证明回落确实走到了 Date.now()（落 epoch 的话这条必然收不到）
    { id: 'dyn-hit', content: '昨天 底部按钮布局 的真·昨日记录', occurredAt: realToday.getTime() - 12 * 3600 * 1000 },
  ]
  // ① 显式传 now → 按该时刻算窗口
  const explicit = fixture({ units, config: { coldStartUnits: 0 } })
  const a = explicit.recall.channelTemporal('昨天 底部按钮布局', { scopes: 'all', limit: 5, now: cfgNow })
  assert.ok(a.list.some((h) => h.id === 'sep-hit'), '显式 now 下的昨天命中')
  assert.ok(!a.list.some((h) => h.id === 'jan-hit'), '窗口外条目不得进')
  // ② 不传 now、但配了 boosts.now → 回落到配置值（结果与 ① 相同）
  const viaCfg = fixture({ units, config: { coldStartUnits: 0, boosts: { now: cfgNow } } })
  const b = viaCfg.recall.channelTemporal('昨天 底部按钮布局', { scopes: 'all', limit: 5 })
  assert.deepEqual(b.list.map((h) => h.id), a.list.map((h) => h.id), 'boosts.now 应作为 now 的回落值')
  // ③ 都不给 → 回落到 Date.now()（不是 epoch）：真·昨日那条必须收到，sep 那条（2026-10-13）不在
  const bare = fixture({ units, config: { coldStartUnits: 0 } })
  const c = bare.recall.channelTemporal('昨天 底部按钮布局', { scopes: 'all', limit: 5 })
  assert.ok(c.list.some((h) => h.id === 'dyn-hit'), '未指定 now 时必须回落到当前时刻（落 epoch 会返回空）')
  assert.ok(!c.list.some((h) => h.id === 'jan-hit'))
  closeDb(explicit.db)
  closeDb(viaCfg.db)
  closeDb(bare.db)
})

test('时序通道：窗口是半开区间 [from, to) —— 左端点含在内、右端点归下一段', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime()
  const day = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0).getTime()
  const win = parseTimeWindow('今天 底部按钮布局', { now })
  assert.equal(win.to, day(2026, 10, 15), 'to 是"下一段起点"（次日零点）')
  const units = [
    { id: 'edge-from', content: '底部按钮布局 左端点（窗口起点整点）', occurredAt: day(2026, 10, 14) },
    { id: 'edge-to', content: '底部按钮布局 右端点（次日零点整点）', occurredAt: day(2026, 10, 15) },
    { id: 'edge-in', content: '底部按钮布局 窗口正中', occurredAt: day(2026, 10, 14) + 6 * 3600 * 1000 },
  ]
  const { db, recall } = fixture({ units, config: { coldStartUnits: 0 } })

  const today = recall.channelTemporal('今天 底部按钮布局', { scopes: 'all', limit: 5, now })
  const ids = today.list.map((h) => h.id)
  assert.ok(ids.includes('edge-from'), 'from 端点含在窗口内（左闭）')
  assert.ok(ids.includes('edge-in'))
  assert.ok(!ids.includes('edge-to'), 'to 端点属下一段（右开）—— BETWEEN 双闭会把它错收进来')

  // 相邻窗口不该各自多含一条边界记录：昨天的窗口也不该收下"次日零点"那条
  const yesterday = recall.channelTemporal('昨天 底部按钮布局', { scopes: 'all', limit: 5, now })
  assert.ok(!yesterday.list.map((h) => h.id).includes('edge-to'))
  closeDb(db)
})

test('语料戳：occurred_at 变了（即使 updated_at 没动）语料也必须重建', () => {
  const { db, recall } = fixture({
    units: [{ id: 'c1', content: '底部按钮布局 收尾说明', occurredAt: 1000 }],
    config: { coldStartUnits: 0 },
  })
  assert.equal(recall.corpus.ensure().docs.get('c1').occurredAt, 1000)
  // 同步导入走的正是这条路径：就地改 occurred_at，而远端行的 updated_at 未必是本地的最大值
  db.prepare("UPDATE units SET occurred_at = 2000 WHERE id = 'c1'").run()
  assert.equal(
    recall.corpus.ensure().docs.get('c1').occurredAt,
    2000,
    '事件时间必须进戳 —— 否则 recency 用旧值打分、时序通道用新值归窗，两个消费方各说各话',
  )
  closeDb(db)
})

test('diag：归因诊断可用且如实报告跳过原因（去掉 Array 兼容分支后行为不变）', () => {
  const { db, recall } = fixture({ units: CONTROL_UNITS, config: { coldStartUnits: 0 } })
  const d = recall.diag('底部按钮布局', { scopes: 'all', limit: 5 })
  assert.ok(Array.isArray(d.channels.lexical), '各通道原始列表照旧输出')
  assert.equal(d.channels.temporalSkipped, '未解析出时间窗口', '无时间表达时报告跳过原因')
  assert.deepEqual(d.channels.temporal, [])
  assert.equal(typeof d.formatter(), 'string')
  closeDb(db)
})
