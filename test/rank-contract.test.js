import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { DEFAULT_CONFIG, Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

/**
 * 排序契约（2026-10-30 实测修复）：
 *
 * 设计注释一直写着"加权只能按比例微调，**不允许盖过词面证据**"，但数值上做不到 ——
 * factor 带宽 0.69~1.40 远大于 RRF 实际差距（常 10~20%），于是 weight 必然能翻转"词法第一"。
 * 实测触发：查唯一标识符 ZULU-TEST-9F3A 时，lexical#1/sparse#1/bm25=1.00 的条目被
 * importance=1.0、access_count=1402 的老条目（lexical#8）挤到 #2。
 *
 * 两条新契约：
 *   ① 查询串**逐字**出现在正文里 → 置顶（`boosts.verbatim`，最短 `verbatimMinChars` 字符）；
 *   ② rrf 相对差 > `boosts.tieEpsilon` → 按 rrf 排，加权不参与；近似平手才让加权决定次序。
 */
function fixture(units, config = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-rank-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  for (const u of units) store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', ...u })
  return { db, store, recall: new Recall(store, config) }
}

const boost = (over = {}) => ({ boosts: { enabled: true, recencyAlpha: 0, importanceAlpha: 0.2, usageAlpha: 0.2, proofAlpha: 0, ...over }, coldStartUnits: 0 })

test('契约①：查询串逐字命中的条目置顶，即使对手 importance/usage 压倒性更高', () => {
  const units = [
    // 逐字含查询串，但 importance/usage 都是地板
    { id: 'exactOne', content: '测试条目：唯一标记 ZULU-TEST-9F3A 在这里。', importance: 0.1 },
    // 词面乱七八糟，但 importance=1、被取回 5000 次
    { id: 'popularOne', content: '测试条目 唯一标记 在这里 测试 条目 标记 ZULU 测试 条目', importance: 1 },
  ]
  const { db, store, recall } = fixture(units, boost())
  store.db.prepare("UPDATE units SET access_count = 5000 WHERE id = 'popularOne'").run()
  store.db.prepare("UPDATE units SET access_count = 0 WHERE id = 'exactOne'").run()
  recall.corpus.ensure()
  const res = recall.search({ query: 'ZULU-TEST-9F3A', k: 5, log: false })
  assert.equal(res.hits[0].id, 'exactOne', `逐字命中必须置顶：${res.hits.map((h) => h.id + ':' + h.rrf.toFixed(4) + '/' + h.boost.toFixed(2))}`)
  assert.equal(res.hits[0].verbatim, true, '应标记 verbatim')
  assert.ok(res.evidence.reasons.some((r) => r.includes('逐字命中')), evolutionReason(res))
  closeDb(db)
})

function evolutionReason(res) {
  return `evidence 应含「逐字命中」：${JSON.stringify(res.evidence.reasons)}`
}

test('契约① 守卫：查询短于 verbatimMinChars（默认 4）不置顶；关掉开关也不置顶', () => {
  const units = [
    { id: 'a', content: '要 这个字出现在很多地方', importance: 0.1 },
    { id: 'b', content: '要 另一个地方也有 要', importance: 1 },
  ]
  const { db, store, recall } = fixture(units, boost())
  store.db.prepare("UPDATE units SET access_count = 5000 WHERE id = 'b'").run()
  recall.corpus.ensure()
  const res = recall.search({ query: '要', k: 5, log: false })
  assert.ok(res.hits.every((h) => h.verbatim === false), '单字查询不得触发逐字置顶')
  closeDb(db)

  const off = fixture(units, boost({ verbatim: false }))
  off.store.db.prepare("UPDATE units SET access_count = 5000 WHERE id = 'b'").run()
  off.recall.corpus.ensure()
  const r2 = off.recall.search({ query: 'ZULU-TEST-9F3A', k: 5, log: false })
  assert.ok(r2.hits.every((h) => h.verbatim === false), 'verbatim:false 时不得有置顶')
  closeDb(off.db)
})

test('契约②：rrf 差距显著时加权不得翻转（这就是实测踩到的那个坑）', () => {
  const units = [
    // 词面更强：查询词反复出现
    { id: 'strong', content: 'kilo 网关 端口 kilo 网关 端口 kilo 网关 端口', importance: 0.1 },
    // 词面较弱，但 importance 拉满 + 取回五千次（旧实现靠这个翻盘）
    { id: 'boosted', content: 'kilo 网关 端口 与 一些 无关 的 补充 说明 文字 在 这里', importance: 1 },
  ]
  const { db, store, recall } = fixture(units, boost({ importanceAlpha: 1, usageAlpha: 1 }))
  store.db.prepare("UPDATE units SET access_count = 5000 WHERE id = 'boosted'").run()
  recall.corpus.ensure()
  const res = recall.search({ query: 'kilo 网关 端口', k: 5, log: false })
  const s = res.hits.find((h) => h.id === 'strong')
  const b = res.hits.find((h) => h.id === 'boosted')
  assert.ok(b.boost > s.boost, '前提：被加权条目的因子确实更高')
  const eps = DEFAULT_CONFIG.boosts.tieEpsilon
  const gap = Math.abs(s.rrf - b.rrf) / (Math.max(s.rrf, b.rrf) || 1)
  if (gap > eps) {
    assert.ok(res.hits.indexOf(s) < res.hits.indexOf(b), `rrf 差 ${(gap * 100).toFixed(1)}% > ε=${eps}，加权不得翻转：${res.hits.map((h) => h.id)}`)
  } else {
    assert.ok(res.hits.indexOf(b) < res.hits.indexOf(s), `rrf 近似平手（${(gap * 100).toFixed(1)}%），加权应当决定次序`)
  }
  closeDb(db)
})

test('契约② 全局不变量：任意权重配置下，输出顺序都必须符合文档化比较器', () => {
  const units = [
    { id: 'u1', content: 'kilo 网关 端口 配置 说明', importance: 0.2 },
    { id: 'u2', content: 'kilo 网关 端口 kilo 网关 端口 配置', importance: 0.9 },
    { id: 'u3', content: 'kilo 网关 端口 另有一条 记录 补充', importance: 0.5 },
    { id: 'u4', content: 'kilo 网关 端口 短', importance: 1 },
  ]
  const configs = [
    boost(),
    boost({ importanceAlpha: 2, usageAlpha: 2 }),
    boost({ recencyAlpha: 0.5, importanceAlpha: 0.5, usageAlpha: 0.5, proofAlpha: 0.5 }),
    boost({ tieEpsilon: 0 }),
    boost({ tieEpsilon: 1 }),
  ]
  for (const [i, cfg] of configs.entries()) {
    const { db, store, recall } = fixture(units, cfg)
    store.db.prepare("UPDATE units SET access_count = 300 WHERE id IN ('u2','u4')").run()
    recall.corpus.ensure()
    const res = recall.search({ query: 'kilo 网关 端口', k: 4, log: false })
    const eps = cfg.boosts.tieEpsilon
    for (let k = 1; k < res.hits.length; k += 1) {
      const a = res.hits[k - 1]
      const b = res.hits[k]
      if (a.verbatim !== b.verbatim) {
        assert.ok(a.verbatim, `cfg#${i} 逐字命中必须在前：${res.hits.map((h) => h.id)}`)
        continue
      }
      const hi = Math.max(a.rrf, b.rrf) || 1
      if (Math.abs(b.rrf - a.rrf) / hi > eps) {
        assert.ok(a.rrf >= b.rrf, `cfg#${i} rrf 差距 > ε 时必须按 rrf：${a.id}(${a.rrf.toFixed(4)}) vs ${b.id}(${b.rrf.toFixed(4)})`)
      } else {
        assert.ok(a.score >= b.score, `cfg#${i} 近似平手时应按加权分：${a.id} vs ${b.id}`)
      }
    }
    closeDb(db)
  }
})
