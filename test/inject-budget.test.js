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

/**
 * A2：`budget=0` 是「关掉这一段」的**显式语义**，不是「保底一条」。
 * 契约修正见 trimToBudget 的 jsdoc：保底承诺（「不会拿到空段」）的前提是 `budget > 0`。
 * 旧版没有把这条写进契约，也没有用例钉住它，于是「0 预算」的行为只能靠读实现去猜。
 */
test('trimToBudget：budget=0 走「整段关掉」语义（不保底、不超预算、不抛错）', () => {
  const out = trimToBudget(['【规则与偏好（常驻，必须遵守）】', '- 一条规则'], 0)
  assert.deepEqual(out.lines, [], 'budget=0 必须是空段（0 预算 = 这一段不要发）')
  assert.equal(out.tokens, 0)
  assert.equal(out.fellBack, false, 'budget=0 不走保底分支（保底是「预算紧」，不是「不要」）')
  assert.equal(out.dropped, 2, 'dropped 仍是全部输入行数')
  // 负预算与非法值同样收敛到「关掉」，且绝不抛错、绝不死循环
  for (const b of [-5, null, undefined, NaN, '0', 'x']) {
    const r = trimToBudget(['- 一条规则'], b)
    assert.deepEqual(r.lines, [], `非法/零预算 ${String(b)} 应得到空段`)
    assert.equal(r.tokens, 0)
  }
  // 而 budget=1（>0）仍然保底：契约的另一半没被顺手改掉
  const one = trimToBudget(['- 一条规则内容'], 1)
  assert.equal(one.fellBack, true, 'budget>0 时保底分支必须还在')
  assert.equal(one.lines.length, 1)
  assert.ok(one.lines[0].length > 0, '保底行不能是空串')
})

/**
 * A2 的第二面：预算只够装下标题时，**常驻段整段不发**。
 * trimToBudget 是通用装箱器（它不知道第一行是标题），所以这层判断在 renderResidentSection：
 * 只有标题、没有条目的段落对模型是纯噪声，还会让它以为「本范围确实没有规则」。
 */
test('常驻段：规则预算只够装标题时整段不发（标题与条目同进同退）', () => {
  const db = tmpDb()
  migrate(db)
  const store = new Store(db)
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: `规则内容 ${cjk(40)}` })
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'preference', content: `偏好内容 ${cjk(40)}` })

  // 前提自证：这一轮预算区间里确实存在「只有标题」的装箱结果（否则本用例覆盖不到那句话）
  const probe = ['【规则与偏好（常驻，必须遵守）】', `- [mem:x|rule] ${cjk(40)}`]
  const sawHeaderOnly = Array.from({ length: 60 }, (_, i) => i + 1).some((b) => {
    const t = trimToBudget(probe, b)
    return t.lines.length > 0 && !t.lines.some((l) => l.startsWith('- '))
  })
  assert.ok(sawHeaderOnly, '必须存在「只有标题」的装箱结果，否则这条断言测不到东西')

  let sawSection = false
  let sawDroppedSection = false
  for (let b = 1; b <= 60; b += 1) {
    const out = renderResidentSection({
      store,
      cwd: null,
      config: { resident: { rulesBudgetTokens: b, budgetTokens: 9000, indexCatalog: false } },
    })
    const hasHeader = out.text.includes('【规则与偏好')
    const hasEntry = /^- \[mem:/m.test(out.text)
    assert.equal(hasHeader, hasEntry, `规则预算 ${b}：标题与条目必须同进同退（不能出现只有标题的空段）`)
    if (hasHeader) {
      sawSection = true
      assert.ok(out.rules >= 1, `预算 ${b}：既然发了标题，rules 计数就该 ≥1`)
      assert.ok(out.rulesTokens > 0, `预算 ${b}：既然发了段，rulesTokens 就该 >0`)
    } else {
      sawDroppedSection = true
      assert.equal(out.rules, 0, `预算 ${b}：整段不发时 rules 必须归零`)
      assert.equal(out.rulesTokens, 0, `预算 ${b}：整段不发时 rulesTokens 必须归零`)
    }
  }
  assert.ok(sawSection && sawDroppedSection, `两侧都要覆盖到：发了段=${sawSection} 整段不发=${sawDroppedSection}`)
  closeDb(db)
})

/**
 * F2 回归：按轮卡片的「预算 0」必须与常驻段同语义（关掉该段），不能谎报注入、
 * 更不能把卡片标记已见 —— 旧行为会同时污染账本（injected:true/cards:N）并在本会话内
 * 永久吞掉这些记忆（下一轮 reason=all-seen）。
 */
test('按轮卡片：预算 0 等于关掉该段（不谎报注入、不把卡片标记已见）', () => {
  const recall = {
    search: () => ({
      evidence: { inject: true },
      ms: 1,
      hits: [
        { id: 'mem-a', track: 'project', kind: 'progress', snippet: cjk(300), channels: { sparse: 1 } },
        { id: 'mem-b', track: 'daily', kind: 'progress', snippet: cjk(300), channels: { lexical: 1 } },
      ],
    }),
  }
  const led = new InjectionLedger()
  led.noteUserMessage('Z', '第一轮')
  for (const budget of [0, -1, 'x', NaN]) {
    const r = renderRecallSection({ store: null, recall, ledger: led, sessionId: 'Z', cwd: null, config: { recall: { injectBudgetTokens: budget } } })
    assert.equal(r.injected, false, `预算 ${String(budget)} 不得谎报 injected`)
    assert.equal(r.text, '', `预算 ${String(budget)} 正文应为空`)
    assert.equal(r.cards, 0, `预算 ${String(budget)} 不得报告卡片数（否则账本记假数据）`)
    assert.equal(r.reason, 'budget-zero')
  }
  // 关键后果：这一轮什么都没注入，就**不能**把卡片算作已见（否则它们在本会话内永久不再注入）
  led.noteUserMessage('Z', '第二轮')
  const next = renderRecallSection({ store: null, recall, ledger: led, sessionId: 'Z', cwd: null, config: { recall: { injectBudgetTokens: 400 } } })
  assert.equal(next.injected, true, '预算恢复后必须还能注入（旧行为是 all-seen 永久吞掉）')
  assert.ok(next.cards >= 1, '至少要有一张卡片')
  assert.equal(next.ids.length, next.cards, 'ids 必须与 cards 同源（只报真正进了正文的卡片）')
  closeDb
})

/**
 * F5 / 孤立标题：总预算截断（末端 `tokens > budgetTokens` 分支）只按行装箱，
 * 可能把某段的条目全丢掉却留下它的标题。这里把所有预算轴扫一遍，钉住三条不变量：
 *   ① 正文里不得出现「只有标题、没有条目」的空段（首行总标题除外）；
 *   ② 计数字段与正文一致（没有条目就必须归零）；
 *   ③ 返回形状同构（三个出口都要有 rulesTokens/catalogTokens/dropped）。
 */
test('常驻段：任何预算组合下都不留孤立标题、计数与正文一致、形状同构', () => {
  // 两种语料都要扫：长条目装不下（走保底），短条目装得下（总标题反而会被 skip-and-continue 跳过，
  // 段标题顶上第一行 —— N3 残留的窗口只在短条目 + 小预算这一带出现，只测长条目会漏掉）
  const fixtures = []
  for (const [label, len] of [['长条目', 30], ['短条目', 3]]) {
    const db = tmpDb()
    migrate(db)
    const store = new Store(db)
    for (let i = 0; i < 6; i += 1) {
      store.insertUnit({ track: 'memory', scope: 'global', kind: i < 3 ? 'rule' : 'fact', content: `条目 ${i} ${cjk(len)}` })
    }
    fixtures.push({ label, db, store })
  }
  /** 找出正文里的孤立段标题：**按内容**识别总标题，不按「第一行」（N5：按位置识别会与实现同源漏判）。 */
  const TOTAL_HEADER = '【记忆（dsh-memory-core）】'
  const orphanHeaders = (text) => {
    const lines = text.split('\n').filter((l) => l.length > 0)
    const out = []
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('【') || lines[i].startsWith(TOTAL_HEADER)) continue
      let hasEntry = false
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('【'); j += 1) {
        if (lines[j].startsWith('- ')) hasEntry = true
      }
      if (!hasEntry) out.push(lines[i])
    }
    return out
  }
  /** 正文非空时第一行必须是总标题：总标题被装箱丢掉、段标题顶上（N3）就是这里挂。 */
  const assertFirstLineIsTotal = (text, label) => {
    const first = text.split('\n').filter((l) => l.length > 0)[0]
    if (first) assert.ok(first.startsWith(TOTAL_HEADER), `${label}：正文第一行必须是总标题，实际 ${JSON.stringify(first.slice(0, 20))}`)
  }

  const configs = []
  // 总预算 **连续** 扫 0..120：稀疏表会漏掉 19 / 29..33 这些「总标题被装箱丢掉、正文以段标题
  // 或裸条目开头」的档位（第三轮就栽在这里），所以这里不再挑档
  for (let b = 0; b <= 120; b += 1) configs.push({ resident: { budgetTokens: b } })
  for (const b of [200, 600, 1200, 9000]) configs.push({ resident: { budgetTokens: b } })
  for (const r of [0, 20, 200, 600]) for (const c of [0, 20, 500]) configs.push({ resident: { rulesBudgetTokens: r, catalogBudgetTokens: c } })
  configs.push({ resident: { rules: false, indexCatalog: false } })

  for (const { label: corpus, store } of fixtures) {
    for (const cfg of configs) {
      const label = `${corpus} + ${JSON.stringify(cfg)}`
      const out = renderResidentSection({ store, cwd: null, config: cfg })
      assert.deepEqual(orphanHeaders(out.text), [], `${label}：正文出现了只有标题的空段`)
      assertFirstLineIsTotal(out.text, label)
      assert.equal(typeof out.rulesTokens, 'number', `${label}：rulesTokens 形状必须同构`)
      assert.equal(typeof out.catalogTokens, 'number', `${label}：catalogTokens 形状必须同构`)
      assert.equal(typeof out.dropped, 'number', `${label}：dropped 形状必须同构`)
      const entries = out.text.split('\n').filter((l) => l.startsWith('- ')).length
      assert.equal(out.rules + out.catalog, entries, `${label}：rules+catalog 应等于正文里的条目数`)
      if (out.rules === 0) assert.equal(out.rulesTokens, 0, `${label}：没有规则却报 rulesTokens`)
      if (out.catalog === 0) assert.equal(out.catalogTokens, 0, `${label}：没有目录条目却报 catalogTokens`)
      if (out.text === '') assert.equal(out.tokens, 0, `${label}：正文为空时 tokens 必须为 0`)
    }
  }
  for (const f of fixtures) closeDb(f.db)
})

/**
 * N2：按轮卡片的卡片集合必须来自**结构**（装箱保留的输入行下标），不能从渲染文本反解。
 * 旧写法用 `[mem:` 前缀从文本里抓 id：片段自身长得像结构行时，cards 会虚报，并且把
 * **不存在的 id** 永久写进 seen —— 与本轮要消灭的「永久吞卡片」是同一个失败模式。
 */
test('按轮卡片：片段的正文里出现 [mem: 形态也不得污染 cards/ids/seen（N2）', () => {
  const fake = '[mem:fake-id | project/x | lexical] 用户内容里就有这么一行'
  const recall = {
    search: () => ({
      evidence: { inject: true },
      ms: 1,
      hits: [{ id: 'mem-real', track: 'project', kind: 'progress', snippet: fake, channels: { sparse: 1 } }],
    }),
  }
  const led = new InjectionLedger()
  led.noteUserMessage('N', 'q')
  const r = renderRecallSection({ store: null, recall, ledger: led, sessionId: 'N', cwd: null, config: { recall: { injectBudgetTokens: 400 } } })
  assert.equal(r.cards, 1, '真实卡片只有 1 张')
  assert.deepEqual(r.ids, ['mem-real'], 'ids 只能来自结构，不能把片段里的假 id 抓进来')
  const seen = [...led.session('N').seen]
  assert.deepEqual(seen, ['mem-real'], `seen 被污染：${JSON.stringify(seen)}`)
  // 关键后果：若真有内容哈希等于 fake-id 的记忆，它会在本会话内被静默吞掉
  assert.ok(!seen.includes('fake-id'))
})

/**
 * N6：预算太紧到一张卡片的标记行都装不下 = 什么都没注入 —— 与预算 0 一样不许谎报，
 * 且要给出与「预算 0」不同的原因（后者是显式关掉，前者是装不下）。
 */
test('按轮卡片：预算紧到装不下任何卡片时不谎报、不吞卡片（N6）', () => {
  const recall = {
    search: () => ({
      evidence: { inject: true },
      ms: 1,
      hits: [{ id: 'mem-real', track: 'project', kind: 'progress', snippet: cjk(300), channels: { sparse: 1 } }],
    }),
  }
  for (const budget of [1, 12, 20, 21]) {
    const led = new InjectionLedger()
    led.noteUserMessage('T', 'q')
    const r = renderRecallSection({ store: null, recall, ledger: led, sessionId: 'T', cwd: null, config: { recall: { injectBudgetTokens: budget } } })
    const injectedCard = /^\[mem:/m.test(r.text)
    assert.equal(r.injected, injectedCard, `预算 ${budget}：injected 必须与正文里真的有卡片一致`)
    if (!injectedCard) {
      assert.equal(r.cards, 0)
      assert.equal([...led.session('T').seen].length, 0, `预算 ${budget}：没注入就不得标记已见`)
      assert.equal(r.reason, 'no-card-fits')
    }
  }
})
