import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { InjectionLedger, RECALL_SECTION_DEFAULTS, renderRecallSection, resolveMaxCards, resolveThreshold } from '../lib/inject.js'
import { DEFAULT_CONFIG, Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

/**
 * P1-1：三个「声明了但没人读」的配置接线。
 *
 * 失败模式（与 §0.4 的死配置同型）：开关写进代码、写进 README，但**没有任何地方读它** ——
 * 按文档调参得到的是噪声，比没有开关更坏。所以每个键都要有两类断言：
 *   ① **默认等价**：不传 / 传中性值时，结果与接线前逐条一致（这里是"与省略该键一致"）；
 *   ② **接线有效**：非中性值必须真的改变结果 —— 否则又是一个假开关。
 */

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-deadcfg-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  // 6 条同族事实：分数有阶梯，便于验证"相对分下限"
  for (let i = 1; i <= 6; i += 1) {
    store.insertUnit({
      track: 'memory',
      scope: 'global',
      kind: 'fact',
      content: `zulu 参数 zulu-${i}：网关端口 ${8000 + i}，灰度比例 ${i}0%。`,
      meta: { ent: ['zulu'] },
    })
  }
  return { db, store, recall: new Recall(store) }
}

const THREE = ['evidence.inject', 'id 集合', 'id 序列']

test('默认等价：三个中性值与"省略该键"逐条一致（三档口径：命中标志 / id 集合 / id 序列）', () => {
  const { db, store } = fixture()
  const plain = new Recall(store)
  const neutral = new Recall(store, { evidence: { requireTwoChannel: false } })
  for (const q of ['zulu 网关端口', 'zulu-3 灰度', 'gray 灰度比例']) {
    const a = plain.search({ query: q, scopes: ['global'], k: 6, log: false })
    const b = neutral.search({ query: q, scopes: ['global'], k: 6, log: false })
    assert.equal(a.evidence.inject, b.evidence.inject, `${THREE[0]} 不一致：${q}`)
    assert.deepEqual(a.hits.map((h) => h.id), b.hits.map((h) => h.id), `${THREE[2]} 不一致：${q}`)
    assert.deepEqual([...new Set(a.hits.map((h) => h.id))].sort(), [...new Set(b.hits.map((h) => h.id))].sort(), `${THREE[1]} 不一致：${q}`)
  }
  // 声明的默认值必须是中性值（否则"接线"就等于偷偷改行为）
  assert.equal(DEFAULT_CONFIG.evidence.requireTwoChannel, false)
  closeDb(db)
})

test('默认等价：按轮卡片在 threshold=0 / firstTurnBoost=false 时与省略该键逐字节一致', () => {
  const { db, store, recall } = fixture()
  const render = (cfg) => {
    const ledger = new InjectionLedger()
    ledger.noteUserMessage('eq', 'zulu 网关端口')
    return renderRecallSection({ store, recall, ledger, sessionId: 'eq', cwd: null, config: cfg })
  }
  const a = render({})
  const b = render({ recall: { threshold: 0, firstTurnBoost: false } })
  assert.equal(a.text, b.text, '中性值必须与省略该键逐字节一致')
  assert.equal(a.cards, b.cards)
  assert.equal(a.tokens, b.tokens)
  closeDb(db)
})

test('threshold 接线：按「候选集相对分」裁剪尾部（含中间值），且永不砍空候选集', () => {
  const { db, store, recall } = fixture()
  const run = (recallCfg) => {
    const ledger = new InjectionLedger()
    ledger.noteUserMessage('th', 'zulu 网关端口')
    return renderRecallSection({ store, recall, ledger, sessionId: 'th', cwd: null, config: { recall: { injectBudgetTokens: 4000, maxCards: 6, ...recallCfg } } })
  }
  const loose = run({ threshold: 0 })
  assert.ok(loose.cards >= 4, `默认应注入多张：${loose.cards}`)

  // 中间值必须真的生效（只测 0.999/1.01 那种两端 plateau 等于没测）
  const mid = run({ threshold: 0.5 })
  const tight = run({ threshold: 0.95 })
  assert.ok(mid.cards <= loose.cards && tight.cards <= mid.cards, `下限越紧卡片只会更少：${loose.cards}/${mid.cards}/${tight.cards}`)

  // 语义边界：分母取候选集最高分 ⇒ 最高者相对分恒 1.000，所以 threshold=1 仍会留下它
  const top1 = run({ threshold: 1 })
  assert.equal(top1.cards, 1, `threshold=1 只该留下最高分那张：${top1.cards}`)
  assert.deepEqual(top1.ids, [loose.ids[0]], '留下的必须是候选里分数最高的那张（ids 顺序即分数降序）')

  // 非法值 fail-open（不约束），而不是静默变成"1 张"或"永不注入"
  for (const bad of [1.01, -0.5, 'abc', NaN, true, null, Infinity]) {
    const r = run({ threshold: bad })
    assert.equal(r.cards, loose.cards, `非法值 ${String(bad)} 应回落为不约束：${r.cards} vs ${loose.cards}`)
  }
  closeDb(db)
})

test('resolveThreshold / resolveMaxCards：边界归一化的单元契约', () => {
  assert.equal(resolveThreshold(0), 0)
  assert.equal(resolveThreshold(0.5), 0.5)
  assert.equal(resolveThreshold('0.8'), 0.8, '字符串数字可用')
  assert.equal(resolveThreshold(1), 1)
  for (const bad of [1.0001, 2, -1, 0, NaN, Infinity, 'abc', null, undefined, true, false, {}])
    assert.equal(resolveThreshold(bad), 0, `${String(bad)} 应归一为 0`)

  assert.equal(resolveMaxCards(undefined), 3, '未配置 → 默认 3')
  assert.equal(resolveMaxCards(3), 3)
  assert.equal(resolveMaxCards('4'), 4)
  assert.equal(resolveMaxCards(0), 0, '显式 0 = 关掉卡片（旧版语义，不能被 ||3 兜成 3）')
  assert.equal(resolveMaxCards(0.5), 0, '小数向下取整到 0')
  assert.equal(resolveMaxCards(null), 0)
  assert.equal(resolveMaxCards('abc'), 0)
  assert.equal(resolveMaxCards(-1), 0, '负值收敛为 0（旧版 slice(0,-1) 的怪语义不再保留）')
  assert.equal(resolveMaxCards(3, { turns: 1, firstTurnBoost: true }), 4, '首轮 +1')
  assert.equal(resolveMaxCards(3, { turns: 2, firstTurnBoost: true }), 3, '非首轮不加')
})

test('firstTurnBoost 接线：只放宽首轮 1 张，第二轮恢复原上限', () => {
  const { db, store, recall } = fixture()
  const cfg = { recall: { injectBudgetTokens: 4000, maxCards: 3, firstTurnBoost: true } }
  const ledger = new InjectionLedger()
  ledger.noteUserMessage('ft', 'zulu 网关端口') // turns = 1
  const first = renderRecallSection({ store, recall, ledger, sessionId: 'ft', cwd: null, config: cfg })
  assert.equal(first.cards, 4, `首轮应放宽到 4 张，实际 ${first.cards}`)

  // 同一会话第二轮（新 query）：回到 3 张上限
  const ledger2 = new InjectionLedger()
  ledger2.noteUserMessage('ft2', 'zulu 网关端口')
  ledger2.noteUserMessage('ft2', 'zulu 灰度比例') // turns = 2
  const second = renderRecallSection({ store, recall, ledger: ledger2, sessionId: 'ft2', cwd: null, config: cfg })
  assert.ok(second.cards <= 3, `非首轮不得超过 maxCards=3，实际 ${second.cards}`)

  // 关掉（默认）时首轮也是 3 张
  const ledger3 = new InjectionLedger()
  ledger3.noteUserMessage('ft3', 'zulu 网关端口')
  const off = renderRecallSection({ store, recall, ledger: ledger3, sessionId: 'ft3', cwd: null, config: { recall: { ...cfg.recall, firstTurnBoost: false } } })
  assert.ok(off.cards <= 3, `默认关闭时首轮不得超过 3，实际 ${off.cards}`)
  closeDb(db)
})

test('requireTwoChannel：严格模式下"两通道"必须含词法/稀疏（只靠 granularity/graph 不算）', () => {
  const { db } = fixture()
  const store = new Store(db)
  // 直接给 evaluateEvidence 喂命中，避免受真实通道实现影响：只测"判据本身"
  const strict = new Recall(store, { evidence: { ...DEFAULT_CONFIG.evidence, requireTwoChannel: true } })
  const lenient = new Recall(store, {})
  const doc = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '判据夹具：zulu 端口。', meta: { ent: ['zulu'] } })
  const hit = { id: doc.id, rank: 1, score: 1, channels: { granularity: { rank: 1, score: 1 }, graph: { rank: 1, score: 1 } } }
  // 只靠 granularity+graph：真库实测这类命中占 0.6%，但它们是最容易把"两通道"判据撑成恒真的来源
  assert.equal(lenient.evaluateEvidence('zulu', [hit], { lexical: { list: [] }, sparse: { list: [] } }).inject, true)
  const s2 = strict.evaluateEvidence('zulu', [hit], { lexical: { list: [] }, sparse: { list: [] } })
  assert.equal(s2.inject, false, `无词法/稀疏的两通道在严格模式下不算：${JSON.stringify(s2)}`)
  assert.ok(s2.reasons.some((r) => r.includes('无词法/稀疏')), '应给出可读理由')

  // 反向责任：带 lexical 的两通道在严格模式下**仍然算**（否则功能被改坏也无人发现）
  const hit2 = { id: doc.id, rank: 1, score: 1, channels: { lexical: { rank: 1, score: 1 }, graph: { rank: 1, score: 1 } } }
  assert.equal(strict.evaluateEvidence('zulu', [hit2], { lexical: { list: [{ id: doc.id, rank: 1, score: 1 }] } }).inject, true, '两通道含词法必须算强证据')
  closeDb(db)
})

test('requireTwoChannel 接线：开启后单通道证据不再算数（默认仍算）', () => {
  const { db, store } = fixture()
  // 只留词法通道 ⇒ 命中必然只有 1 个通道，正好检验"两通道"这条判据本身
  const onlyLexical = {
    ...DEFAULT_CONFIG,
    channels: {
      lexical: { enabled: true, weight: 1 },
      sparse: { enabled: false, weight: 1 },
      granularity: { enabled: false, weight: 0.8 },
      graph: { enabled: false, weight: 0.6 },
      temporal: { enabled: false, weight: 1 },
    },
  }
  const lenient = new Recall(store, onlyLexical)
  const strict = new Recall(store, { ...onlyLexical, evidence: { ...DEFAULT_CONFIG.evidence, requireTwoChannel: true } })
  const q = 'zulu 网关端口'
  const a = lenient.search({ query: q, scopes: ['global'], k: 6, log: false })
  const b = strict.search({ query: q, scopes: ['global'], k: 6, log: false })
  assert.ok(a.hits.length > 0, 'fixture 应命中')
  assert.ok(a.hits.every((h) => Object.keys(h.channels).length === 1), '前提：本用例里只可能单通道命中')
  assert.equal(a.evidence.inject, true, '默认（宽松）下单通道前 N 名算强证据')
  assert.equal(b.evidence.inject, false, '开启 requireTwoChannel 后单通道不得算强证据')
  // 检索结果本身不变（只影响"要不要注入"这一层，不影响排序）
  assert.deepEqual(a.hits.map((h) => h.id), b.hits.map((h) => h.id), '严格模式不得改变召回排序')
  closeDb(db)
})
