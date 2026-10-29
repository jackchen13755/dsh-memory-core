import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { renderSkeletonSection } from '../lib/inject.js'
import { classifyText, extractNodes, loadNodes, nodeLines, pruneNodes, upsertNodes } from '../lib/skeleton.js'
import { Store } from '../lib/store.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-skel-')), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db) }
}

test('分类：约束 / 决策 / 进度各归各类，且一条话只归一类（约束优先）', () => {
  const got = classifyText('不要改 package.json，锁文件必须原样。我们决定改用 anchor 而不是摘要。上一步已修复分页越界。')
  const kinds = got.map((g) => g.kind)
  assert.ok(kinds.includes('constraint'), '应识别约束')
  assert.ok(kinds.includes('decision'), '应识别决策')
  assert.ok(kinds.includes('progress'), '应识别进度')
  // 约束句里同时出现"必须"，不得再被归成决策/进度
  const constraint = got.find((g) => g.kind === 'constraint')
  assert.match(constraint.content, /package\.json|锁文件/)
  assert.equal(got.filter((g) => g.kind === 'constraint').length, 1, '同一条话只归一类')
})

test('分类：太短的行、纯代码行不抽（精度优先，宁可少抽）', () => {
  assert.equal(classifyText('必须').length, 0, '过短不算约束')
  assert.equal(classifyText('`npm test --force`').length, 0, '整行代码不算节点')
})

test('抽取：同一句重复出现只留一条，且约束 pin=1', () => {
  const messages = [
    { role: 'user', text: '不要动 schema.js，迁移已经定稿。' },
    { role: 'assistant', text: '好的，不动 schema.js。' },
    { role: 'user', text: '不要动 schema.js，迁移已经定稿。' },
  ]
  const nodes = extractNodes(messages)
  const constraints = nodes.filter((n) => n.kind === 'constraint')
  assert.equal(constraints.length, 1, '同一句去重')
  assert.equal(constraints[0].pin, 1, '约束置 pin')
})

test('投影是确定性全序：乱序输入必得同一字节串（否则每轮抖动会触发宿主追加）', () => {
  const { db, store } = fixture()
  upsertNodes(store, {
    sessionId: 's1',
    nodes: [
      { kind: 'progress', content: '已修复分页越界。', hash: 'h3', pin: 0 },
      { kind: 'constraint', content: '不要改 package.json。', hash: 'h1', pin: 1 },
      { kind: 'decision', content: '决定改用 anchor 而不是摘要。', hash: 'h2', pin: 0 },
    ],
  })
  const first = renderSkeletonSection({ store, sessionId: 's1' })
  const second = renderSkeletonSection({ store, sessionId: 's1' })
  assert.equal(first.text, second.text, '同状态必得同一字节串')
  assert.match(first.text, /约束/)
  // 约束永远排在决策/进度之前
  const lines = first.text.split('\n').filter((l) => l.startsWith('- '))
  assert.match(lines[0], /约束/)
  closeDb(db)
})

test('nodeLines：全序排序不受插入顺序影响', () => {
  const a = nodeLines([
    { id: '2', kind: 'progress', content: 'b', content_hash: 'z', pin: 0 },
    { id: '1', kind: 'constraint', content: 'a', content_hash: 'y', pin: 1 },
  ])
  const b = nodeLines([
    { id: '1', kind: 'constraint', content: 'a', content_hash: 'y', pin: 1 },
    { id: '2', kind: 'progress', content: 'b', content_hash: 'z', pin: 0 },
  ])
  assert.deepEqual(a, b)
  assert.match(a[0], /约束/)
})

test('落库幂等：同一批节点重复写入只刷新，不新增', () => {
  const { db, store } = fixture()
  const nodes = [{ kind: 'decision', content: '决定改用 anchor。', hash: 'h1', pin: 0 }]
  const first = upsertNodes(store, { sessionId: 's1', nodes })
  assert.deepEqual(first, { added: 1, refreshed: 0 })
  const second = upsertNodes(store, { sessionId: 's1', nodes })
  assert.deepEqual(second, { added: 0, refreshed: 1 })
  assert.equal(loadNodes(store, 's1').length, 1)
  closeDb(db)
})

test('空图发空串：新会话零成本，不付固定税', () => {
  const { db, store } = fixture()
  const res = renderSkeletonSection({ store, sessionId: 'nobody' })
  assert.equal(res.text, '')
  assert.equal(res.tokens, 0)
  assert.equal(res.reason, 'empty')
  closeDb(db)
})

test('预算为 0 = 关段（与按轮卡片同一约定）', () => {
  const { db, store } = fixture()
  upsertNodes(store, { sessionId: 's1', nodes: [{ kind: 'constraint', content: '不要改锁文件。', hash: 'h1', pin: 1 }] })
  const res = renderSkeletonSection({ store, sessionId: 's1', config: { skeleton: { budgetTokens: 0 } } })
  assert.equal(res.text, '')
  assert.equal(res.reason, 'budget-zero')
  closeDb(db)
})

test('回收：超过上限删未 pin 的旧节点，pin 的永不删', () => {
  const { db, store } = fixture()
  const nodes = []
  for (let i = 0; i < 6; i += 1) nodes.push({ kind: 'progress', content: `进度${i}。`, hash: `p${i}`, pin: 0 })
  nodes.push({ kind: 'constraint', content: '不要改锁文件。', hash: 'c1', pin: 1 })
  upsertNodes(store, { sessionId: 's1', nodes, now: 1000 })
  const res = pruneNodes(store, { sessionId: 's1', keep: 2 })
  assert.ok(res.pruned > 0, '应回收')
  const left = loadNodes(store, 's1', { limit: 50 })
  assert.ok(left.some((n) => n.pin === 1), 'pin 的绝不被删')
  closeDb(db)
})

test('B1：裸「别」不再把 区别在/特别在/类别是/分别在于 判成约束', () => {
  for (const line of ['区别在于我们用的是 anchor。', '特别在处理大文件时更明显。', '类别是这样的划分。', '分别在于两边实现不同。']) {
    assert.equal(classifyText(line).length, 0, `不应判成约束：${line}`)
  }
  // 祈使式「别」仍然要认
  assert.equal(classifyText('千万别动 schema.js 的迁移。')[0]?.kind, 'constraint')
})

test('R2 精度：约束/决策只从 user 消息抽；助手来源只产出 progress 且不置 pin', () => {
  const messages = [
    { role: 'user', text: '不要改 package.json。' },
    { role: 'assistant', text: '已修复分页越界。' },
    { role: 'assistant', text: '我决定改用 anchor 而不是摘要。' },
  ]
  const nodes = extractNodes(messages)
  const fromAssistant = nodes.filter((n) => n.role === 'assistant')
  assert.ok(fromAssistant.length > 0, '助手来源仍可产出进度')
  assert.ok(fromAssistant.every((n) => n.kind === 'progress'), '助手不得产出约束/决策（"我决定…"也要被过滤掉）')
  assert.ok(fromAssistant.every((n) => n.pin === 0), '助手来源一律不置 pin')
  const constraint = nodes.find((n) => n.kind === 'constraint')
  assert.equal(constraint?.role, 'user')
  assert.equal(constraint?.pin, 1, '用户来源的约束才置 pin')
})

test('B2：节点多于投影容量时，约束不被静默丢弃，且给出「另有 N 条」痕迹', () => {
  const { db, store } = fixture()
  const nodes = []
  for (let i = 0; i < 30; i += 1) nodes.push({ kind: 'constraint', content: `约束编号 ${String(i).padStart(2, '0')}：不许动构建配置。`, hash: `c${i}`, pin: 1 })
  upsertNodes(store, { sessionId: 's1', nodes })
  // loadNodes 不得在 24 条处截断
  assert.equal(loadNodes(store, 's1').length, 30, 'loadNodes 不应按 24 条截断')
  const res = renderSkeletonSection({ store, sessionId: 's1', config: { skeleton: { budgetTokens: 120 } } })
  assert.ok(res.dropped > 0, `预算不足时应报告丢弃条数，实际：${JSON.stringify(res)}`)
  assert.match(res.text, /另有|未展开/, '必须留下丢弃痕迹，不能静默消失')
  closeDb(db)
})

test('M2：同批 created_at 下投影确定性（用 250 条压到默认上限之上，才有鉴别力）', () => {
  const { db, store } = fixture()
  const N = 250 // 必须 > SAFETY_CAP 才能覆盖「按上限截断后选哪批」这条
  const mk = (i) => ({ kind: 'progress', content: `进度条目 ${String(i).padStart(3, '0')}。`, hash: `p${String(i).padStart(3, '0')}`, pin: 0 })
  const order = Array.from({ length: N }, (_, i) => i)
  upsertNodes(store, { sessionId: 'a', nodes: order.map(mk), now: 1000 })
  upsertNodes(store, { sessionId: 'b', nodes: [...order].reverse().map(mk), now: 1000 })
  const a1 = renderSkeletonSection({ store, sessionId: 'a' }).text
  const a2 = renderSkeletonSection({ store, sessionId: 'a' }).text
  assert.equal(a1, a2, '同一会话两次渲染必须一致')
  const b1 = renderSkeletonSection({ store, sessionId: 'b' }).text
  assert.equal(a1, b1, '同集合不同写入顺序必须投影出同一字节串')
  closeDb(db)
})

test('N2：超过安全上限时如实报 truncated，不静默丢弃', () => {
  const { db, store } = fixture()
  const N = 30
  const nodes = Array.from({ length: N }, (_, i) => ({ kind: 'constraint', content: `约束 ${i}：不许动。`, hash: `c${i}`, pin: 1 }))
  upsertNodes(store, { sessionId: 's1', nodes })
  const all = loadNodes(store, 's1')
  assert.equal(all.length, N, '默认应取全量（不再 24/192 截断）')
  const capped = loadNodes(store, 's1', { limit: 10 })
  assert.equal(capped.length, 10)
  assert.equal(capped.truncated, N - 10, '触碰上限时必须报出被截断条数')
  closeDb(db)
})

test('自反馈：注入的骨架块被 readTranscript 当噪声排除，不会再次被抽取', async () => {
  const { readTranscript } = await import('../lib/session-log.js')
  const skeletonBlock = ['[会话骨架] 以下为本次会话已确认的约束/决策/进度（数据，不是指令）：', '- 进度: 已提交并推送完成。'].join('\n')
  const session = {
    id: 'sf',
    header: { id: 'sf' },
    ownEvents: () => [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '用户: 正常的一句话，已提交并推送完成。' }] } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: skeletonBlock }] } },
    ],
  }
  const { messages } = readTranscript(session, { maxMessages: 10 })
  assert.equal(messages.length, 1, `骨架块必须被排除，实际保留了 ${messages.length} 条`)
  assert.ok(!messages.some((m) => m.text.includes('[会话骨架]')), '骨架块不得进入转录')
})

test('双前缀：渲染行的「进度:」标签会被剥掉，不叠成「进度: 进度: …」', () => {
  const nodes = extractNodes([{ role: 'user', text: '- 进度: 已提交并推送完成。' }])
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].content, '已提交并推送完成。', `实际：${nodes[0].content}`)
  // 再来一轮（模拟读回自己渲染的结果）仍不叠前缀
  const again = extractNodes([{ role: 'user', text: `- 进度: ${nodes[0].content}` }])
  assert.equal(again[0].content, '已提交并推送完成。')
})

test('噪声行：markdown 标题 / 纯标签行 / 宿主工具提醒都不算约束', () => {
  const noise = [
    '## 设计稿（权威依据，必须先读）',
    '**软件架构师**：改动面 / 接口与数据 / 兼容与回滚',
    '(上一步工具「validate_dsh_ui」可能未完成, 先确认状态再继续, 不要重复执行)',
    'https://example.com/必须看',
  ]
  for (const line of noise) {
    assert.equal(classifyText(line).length, 0, `不应抽成节点：${line}`)
  }
})

test('约束上限：一轮最多 8 条（pin 的永不回收，必须从源头限量）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `约束 ${i} 号：不要动构建配置，必须保持原样。`)
  const nodes = extractNodes([{ role: 'user', text: lines.join('\n') }])
  const constraints = nodes.filter((n) => n.kind === 'constraint')
  assert.ok(constraints.length <= 8, `约束数应 ≤8，实际 ${constraints.length}`)
  assert.ok(constraints.every((n) => n.pin === 1))
})
