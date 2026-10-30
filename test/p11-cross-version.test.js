/**
 * P1-1 的**跨版本可执行对照**：默认配置必须与接线前的实现（基线提交 45d1091 的 `lib/inject.js`）逐字节一致。
 *
 * 为什么需要它（专家复核提出的缺口）：`dead-config.test.js` 里的"默认等价"两例比的是
 * **新代码 vs 新代码的两种写法**，它能守住"中性值 ≡ 省略该键"，但结构上追不上
 * "与旧版本等价"这个真承诺 —— 把 `threshold` 的默认值悄悄改回 0.62，那两例照样全绿
 * （回退变异实测 SURVIVED），而真实库上它确实会改变 1/40 条查询的卡片。
 *
 * 做法沿用仓库既有先例（`test/recall-boost-temporal.test.js` 的 `git show <sha>:lib/recall.js`）：
 * 把基线文件落临时目录后真 import，同一个 fixture、同一批查询，两套实现逐字节比 render 结果。
 * 基线取不到（浅克隆 / 无 git）时**显式失败**，绝不静默跳过 —— 静默跳过等于把唯一可执行的对照变成假绿。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { InjectionLedger, RECALL_SECTION_DEFAULTS, renderRecallSection } from '../lib/inject.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 基线 = P1-1 接线**之前**的提交（v0.0.20 的 P0 那轮）。不要改成 HEAD：
 * 本改造一提交，HEAD 就是含改造的代码，对照会退化成自比对。
 */
const LEGACY_REF = '45d1091'

function loadLegacyInject() {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'memcore-p11-legacy-'))
    // inject.js 依赖 paths.js / skeleton.js，整目录拷一份再覆盖 inject.js 最稳
    cpSync(join(repoRoot, 'lib'), dir, { recursive: true })
    writeFileSync(join(dir, 'inject.js'), execFileSync('git', ['show', `${LEGACY_REF}:lib/inject.js`], { cwd: repoRoot, encoding: 'utf8' }))
    return { url: pathToFileURL(join(dir, 'inject.js')).href, error: null }
  } catch (error) {
    return { url: null, error: error.message }
  }
}

const legacyRef = loadLegacyInject()
const legacy = legacyRef.url ? await import(legacyRef.url) : null

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-p11-db-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  for (let i = 1; i <= 6; i += 1) {
    store.insertUnit({
      track: 'memory',
      scope: 'global',
      kind: 'fact',
      content: `zulu 参数 zulu-${i}：网关端口 ${8000 + i}，灰度比例 ${i}0%。`,
      meta: { ent: ['zulu'] },
    })
  }
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '提交前必须跑 lint。' })
  return { db, store, recall: new Recall(store) }
}

/** 用同一份 ledger 状态渲染一次（两侧各建一份同构 ledger，避免共享内存态）。 */
function renderWith(mod, { store, recall }, { query = 'zulu 网关端口', turns = 1, config = {} } = {}) {
  const ledger = new mod.InjectionLedger()
  for (let i = 0; i < turns; i += 1) ledger.noteUserMessage('s', query)
  return mod.renderRecallSection({ store, recall, ledger, sessionId: 's', cwd: null, config })
}

test('跨版本对照：默认配置下，新实现与基线(45d1091)渲染逐字节一致', (t) => {
  assert.ok(legacy, `基线 ${LEGACY_REF} 的可执行对照不可用：${legacyRef.error}`)
  const { db, store, recall } = fixture()
  let compared = 0
  for (const query of ['zulu 网关端口', 'zulu-3 灰度', '提交前要做什么', '完全无关的查询 zzz']) {
    for (const turns of [1, 2]) {
      const now = renderWith({ InjectionLedger, renderRecallSection }, { store, recall }, { query, turns })
      const before = renderWith(legacy, { store, recall }, { query, turns })
      assert.equal(now.text, before.text, `文本不一致：${query}（turns=${turns}）\n新=${now.text}\n旧=${before.text}`)
      assert.deepEqual([now.cards, now.tokens, now.injected, now.reason], [before.cards, before.tokens, before.injected, before.reason], `记账不一致：${query}`)
      compared += 1
    }
  }
  t.diagnostic(`与基线(${LEGACY_REF})逐字节对照 ${compared} 次渲染`)
  closeDb(db)
})

test('跨版本对照：maxCards 的非默认值语义与旧版一致（显式 0 仍是"关掉"，不是 3 张）', (t) => {
  assert.ok(legacy, `基线 ${LEGACY_REF} 的可执行对照不可用：${legacyRef.error}`)
  const { db, store, recall } = fixture()
  // 专家实测：新代码曾把 maxCards: 0 用 `|| 3` 兜成 3 张，与旧版 slice(0,0)=0 张相反
  for (const maxCards of [0, 0.5, 1, 2, 3, 4, '4', null, 'abc']) {
    const config = { recall: { maxCards, injectBudgetTokens: 4000 } }
    const now = renderWith({ InjectionLedger, renderRecallSection }, { store, recall }, { config })
    const before = renderWith(legacy, { store, recall }, { config })
    assert.equal(now.cards, before.cards, `maxCards=${String(maxCards)} 张数不一致：新 ${now.cards} / 旧 ${before.cards}`)
    t.diagnostic(`maxCards=${String(maxCards)} → cards=${now.cards}（与旧版一致）`)
  }
  // 已知偏差（有意为之，写进 README）：负值旧版是 slice(0,-1) 的"少给最后一张"，现在收敛为 0
  const neg = renderWith({ InjectionLedger, renderRecallSection }, { store, recall }, { config: { recall: { maxCards: -1 } } })
  const negOld = renderWith(legacy, { store, recall }, { config: { recall: { maxCards: -1 } } })
  assert.equal(neg.cards, 0, '负值应视为关闭（不注入）')
  assert.ok(negOld.cards > 0, '旧版对负值的行为是 slice(0,-1)（本改造有意纠正）')
  closeDb(db)
})

test('默认值被钉住：RECALL_SECTION_DEFAULTS 的每个键都必须是中性值', () => {
  // 没有这条断言时，"有人把 threshold 改回 0.62" 全量测试是绿的（回退变异实测 SURVIVED）
  assert.equal(RECALL_SECTION_DEFAULTS.threshold, 0, 'threshold 默认必须是不约束')
  assert.equal(RECALL_SECTION_DEFAULTS.firstTurnBoost, false, 'firstTurnBoost 默认必须关闭')
  assert.equal(RECALL_SECTION_DEFAULTS.maxCards, 3)
  assert.equal(RECALL_SECTION_DEFAULTS.injectBudgetTokens, 400)
  assert.equal(RECALL_SECTION_DEFAULTS.idleTurnsStop, 5)
  assert.equal(RECALL_SECTION_DEFAULTS.perTurn, true)
})
