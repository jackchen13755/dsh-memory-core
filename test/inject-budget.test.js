/**
 * t9 预算装箱：trimToBudget 从「超预算即 break」改为「装不下就跳过、继续装后面的」。
 *
 * 覆盖：
 *   - skip-and-continue：一条超长行不再吃掉它后面本可装下的短行；
 *   - 保底：一条都装不下时仍输出第一条（按预算截断），调用方不会拿到空段；
 *   - dropped 语义 = 被跳过的行数；折叠提示按真实 dropped 计数；
 *   - 返回结构与 tokens 记账不回归（{lines, tokens, dropped}，tokens ≤ 预算）；
 *   - 两个消费方不回归：常驻段总预算、按轮卡片预算。
 *
 * 铁律：不碰真实库（$DSH_HOME/memory-core/mem.db），一律用 mkdtemp 副本。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { InjectionLedger, estimateTokens, renderRecallSection, renderResidentSection, trimToBudget } from '../lib/inject.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

/** 中文行（约 0.667 token/字）。 */
const cjk = (n) => '长'.repeat(n)
/** ASCII 行（约 0.25 token/字符）。 */
const ascii = (n) => 'x'.repeat(n)
const keptLines = (out) => out.lines.filter((l) => !l.startsWith('…（另有'))

function tmpDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'memcore-budget-')), 'mem.db'))
}

/** 返回结构与记账口径：tokens 等于实际装箱行的估算之和（每行含一个换行计 1 token），不超预算。 */
function assertPackingSane(out, budget, input) {
  assert.ok(Array.isArray(out.lines), 'lines 必须是数组')
  assert.equal(typeof out.tokens, 'number', 'tokens 必须是数字')
  assert.equal(typeof out.dropped, 'number', 'dropped 必须是数字')
  // 只有「预算小到装不下任何整行」时，保底行才可能因 1 token 的换行开销略过预算（上限 +1）
  assert.ok(out.tokens <= budget + 1, `装箱结果超预算：${out.tokens} > ${budget}`)
  const counted = out.lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0)
  assert.equal(out.tokens, counted, 'tokens 必须等于装箱行的估算之和')
  assert.ok(out.dropped >= 0 && out.dropped <= (input?.length ?? Infinity), `dropped 越界：${out.dropped}`)
}

test('trimToBudget：超长行不再吃掉后面的短行（skip-and-continue）', () => {
  const lines = [ascii(1000), 'short-1', 'short-2', 'short-3']
  const out = trimToBudget(lines, 40)
  const kept = keptLines(out)
  // 旧实现（超预算即 break）会在这里丢掉三条短行
  assert.deepEqual(kept, ['short-1', 'short-2', 'short-3'])
  // 折叠提示计入 tokens（预算已为它留位）
  assert.ok(out.lines.includes('…（另有 1 条，用 mem_search 检索）'))
  assert.equal(out.dropped, 1, 'dropped = 被跳过的行数（只跳过那条超长行）')
})

test('trimToBudget：跳过中段超长行，尾部短行照常装箱', () => {
  const lines = ['head', ascii(1000), 'tail-1', 'tail-2']
  const out = trimToBudget(lines, 40)
  const kept = keptLines(out)
  assert.deepEqual(kept, ['head', 'tail-1', 'tail-2'])
  assert.equal(out.dropped, 1)
})

test('trimToBudget：一条都装不下时保底输出第一条（截断），绝不给空段', () => {
  const long = cjk(60) // 54 tokens
  const out = trimToBudget([long], 30)
  assert.equal(out.lines.length, 1, '单条也不许输出空段')
  assert.ok(out.lines[0].length > 0)
  assert.notEqual(out.lines[0], long, '保底行必须按预算截断')
  assert.ok(out.lines[0].endsWith('…'), '截断要有可见标记')
  assert.ok(out.tokens <= 30, `保底行也要在预算内：${out.tokens}`)

  // 单条超预算：保底输出截断版，没有别的行被跳过 → dropped = 0
  assert.equal(out.dropped, 0, '保底输出的第一条不算「被跳过」')
  assert.equal(out.fellBack, true, '走了保底分支要留信号（常驻段据此不把它算作完整规则）')
  assert.equal(trimToBudget(['a', 'b'], 100).fellBack, false, '正常装箱不得标记保底')

  // 多条且都装不下：第一条截断保底，其余计为「被跳过」
  const many = trimToBudget([cjk(60), cjk(80)], 30)
  assert.equal(many.lines.length, 1, '全部装不下时也只保底一条')
  assert.ok(many.lines[0].endsWith('…'))
  assert.equal(many.dropped, 1, 'dropped = 1（第二条被跳过；第一条保底不算丢弃）')
  assert.ok(many.tokens <= 30)

  // 长行虽被跳过，但它后面的短行仍能装箱（保底不越权顶替真实装箱）
  const mixed = trimToBudget([cjk(60), 'second', 'third'], 30)
  assert.deepEqual(keptLines(mixed), ['second', 'third'])
  assert.equal(mixed.dropped, 1)

  // 空输入不炸、不给假行
  const empty = trimToBudget([], 30)
  assert.equal(empty.lines.length, 0)
  assert.equal(empty.tokens, 0)
  assert.equal(empty.dropped, 0)

  // 极端预算（0 / 负数）不抛异常、不无限循环，仍保证有内容或明确为空
  for (const budget of [0, -5]) {
    const degenerate = trimToBudget([cjk(20), 'x'], budget)
    assert.ok(degenerate.lines.length <= 1)
    assert.ok(degenerate.tokens <= Math.max(0, budget))
  }
})

test('trimToBudget：装得下就一行不少，装不下按真实 dropped 折叠', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `- 第 ${i} 行中文内容`)
  const all = trimToBudget(lines, 200)
  assert.deepEqual(all.lines, lines, '预算充足时必须原样保留')
  assert.equal(all.dropped, 0)
  assert.ok(!all.lines.some((l) => l.includes('另有')), '无丢弃则无折叠提示')

  // 第一条整行装得下（room = budget - 折叠提示开销）→ 保底不触发，按真实 dropped 折叠
  const tight = trimToBudget(lines, 20)
  assert.equal(tight.dropped, 7)
  assert.equal(tight.lines[0], lines[0])
  assert.equal(tight.lines[1], '…（另有 7 条，用 mem_search 检索）')
  assert.ok(tight.tokens <= 20, `折叠提示也要在预算内：${tight.tokens}`)

  // foldNote:false → 不追加提示、也不为它预留预算
  const noFold = trimToBudget(lines, 13, { foldNote: false })
  assert.ok(!noFold.lines.some((l) => l.includes('另有')))
  assert.ok(noFold.tokens <= 13)
  assert.ok(noFold.dropped >= 1)
})

test('trimToBudget：返回结构与 tokens 记账（估算单调、不超预算）', () => {
  const cases = [
    { lines: [], budget: 10 },
    { lines: [ascii(4), ascii(8), cjk(10), ascii(200)], budget: 12 },
    { lines: [cjk(50), ascii(20)], budget: 5 },
    { lines: Array.from({ length: 30 }, (_, i) => `- item-${i}`), budget: 7 },
    { lines: [cjk(30)], budget: 21 },
  ]
  for (const { lines, budget } of cases) {
    const out = trimToBudget(lines, budget)
    assertPackingSane(out, budget, lines)
    // 三个既有字段必须原样存在且语义不变；fellBack 只是附加信号
    for (const key of ['lines', 'tokens', 'dropped']) {
      assert.ok(Object.hasOwn(out, key), `返回结构缺少既有字段：${key}`)
    }
    assert.equal(typeof out.fellBack, 'boolean', 'fellBack 是布尔附加信号')
  }
})

test('常驻段：预算紧张时仍输出规则块（不回归为重复标题），且总预算 ≤1200', () => {
  const db = tmpDb()
  migrate(db)
  const store = new Store(db)
  // 20 条超长规则：规则块预算 600 装不下全部
  for (let i = 0; i < 20; i += 1) {
    store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: `规则 ${i}：${cjk(200)}` })
  }
  store.insertUnit({ track: 'key', scope: 'global', kind: 'fact', content: '目录条目：本机 node 自带 FTS5。', meta: { summary: 'node 自带 FTS5' } })

  const res = renderResidentSection({ store, cwd: null, config: {} })
  assert.ok(res.tokens <= 1200, `常驻段超预算：${res.tokens}`)
  assert.ok(res.rules > 0, '预算紧张时规则块也必须有内容（旧实现会重复输出标题）')
  const rulesPart = res.text.split('【本范围记忆目录')[0]
  assert.equal((rulesPart.match(/【规则与偏好（常驻，必须遵守）】/g) ?? []).length, 1, '标题只许出现一次')
  assert.ok(rulesPart.includes('- [mem:'), '必须留下至少一条规则')

  // 放宽规则宽限后：rules 计数 = 实际装箱的条目行数
  const wide = renderResidentSection({ store, cwd: null, config: { resident: { rulesBudgetTokens: 4000, budgetTokens: 9000 } } })
  const wideRulesPart = wide.text.split('【本范围记忆目录')[0]
  assert.equal(wide.rules, (wideRulesPart.match(/^- \[mem:/gm) ?? []).length, 'rules 应等于实际装箱的条目数')
  closeDb(db)
})

test('按轮卡片：预算收紧时只装装得下的卡片，仍不超预算、不给空段', () => {
  const db = tmpDb()
  migrate(db)
  const store = new Store(db)
  const kws = ['kilo', 'lima', 'mike']
  for (let i = 0; i < kws.length; i += 1) {
    store.insertUnit({
      track: 'memory',
      scope: 'global',
      kind: 'fact',
      content: `zulu 相关事实 ${i}：${kws[i]} 是关键词，${cjk(40)}`,
      meta: { ent: ['zulu', kws[i]] },
    })
  }
  const recall = new Recall(store)
  const ledger = new InjectionLedger()
  const sessionId = 'b1'
  ledger.noteUserMessage(sessionId, 'zulu 是什么')

  const wide = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: { recall: { injectBudgetTokens: 400 } } })
  assert.equal(wide.injected, true, '证据达标应注入')
  assert.ok(wide.tokens <= 400, `按轮卡片超预算：${wide.tokens}`)
  assert.ok(wide.text.includes('【本轮相关记忆（自动召回）】'), '标题行必须在（否则丢了卡片语义）')
  assert.ok(wide.cards >= 1)

  // 把预算压到只装得下标题 + 第一张卡片
  const ledger2 = new InjectionLedger()
  ledger2.noteUserMessage('b2', 'zulu 是什么')
  const tight = renderRecallSection({ store, recall, ledger: ledger2, sessionId: 'b2', cwd: null, config: { recall: { injectBudgetTokens: 40 } } })
  assert.equal(tight.injected, true)
  assert.ok(tight.tokens <= 40, `收紧预算后仍超预算：${tight.tokens}`)
  assert.ok(tight.text.length > 0, '预算再紧也不许给空段')
  assert.ok(tight.cards <= 3, `cards 不得超过 maxCards：${tight.cards}`)
  assert.ok(tight.text.includes('【本轮相关记忆（自动召回）】'), '保底时也要保住标题行')
  closeDb(db)
})
