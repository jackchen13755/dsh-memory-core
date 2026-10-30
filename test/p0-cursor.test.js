import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { EXTRACT_DEFAULTS } from '../lib/extract.js'
import { createInflight } from '../lib/index.js'
import { readTranscript, readTranscriptFromLog } from '../lib/session-log.js'

/**
 * P0-1（参考 dsh-world 的 `sourceArchive.ts` 游标重放）：`ingest_cursor` 必须真的是切片边界。
 *
 * 旧行为两处致命：
 *   ① 切片永远取**最新** N 条（环形缓冲 shift）→ 长会话里"游标之后最旧的那批"永远轮不到；
 *   ② 提取成功后游标写成**会话最新 seq** → 剩余内容被永久跳过，而账面显示已处理。
 */
const U = (text, seq) => ({ type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const A = (text, seq) => ({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

function session(events) {
  return { id: 's-p0', ownEvents: () => events }
}

const EVENTS = [
  U('第一轮：帮我看看记忆插件', 1),
  A('好的，先读一下代码。', 2),
  U('第二轮：提取怎么切片', 3),
  A('现在只取最新 20 条。', 4),
  U('第三轮：那积压怎么办', 5),
  A('会被跳过。', 6),
]

test('P0-1 默认（newest）行为不变：取最新 N 条 —— 与改造前一致', () => {
  const res = readTranscript(session(EVENTS), { maxMessages: 2 })
  assert.deepEqual(res.messages.map((m) => m.seq), [5, 6], '旧语义：最新的两条')
})

test('P0-1 afterSeq 下界：只返回游标之后的消息（提取过的不重复送）', () => {
  const res = readTranscript(session(EVENTS), { maxMessages: 99, afterSeq: 4 })
  assert.deepEqual(res.messages.map((m) => m.seq), [5, 6])
  assert.equal(readTranscript(session(EVENTS), { maxMessages: 99, afterSeq: 6 }).messages.length, 0, '游标到末尾后应无新消息')
})

test('P0-1 order=oldest：从游标往后取**最旧**一批（积压分批消化，不再被尾部截断）', () => {
  const first = readTranscript(session(EVENTS), { maxMessages: 2, afterSeq: 0, order: 'oldest' })
  assert.deepEqual(first.messages.map((m) => m.seq), [1, 2], '第一批必须是最旧的两条')
  const second = readTranscript(session(EVENTS), { maxMessages: 2, afterSeq: 2, order: 'oldest' })
  assert.deepEqual(second.messages.map((m) => m.seq), [3, 4], '第二批接着往前走')
  const third = readTranscript(session(EVENTS), { maxMessages: 2, afterSeq: 4, order: 'oldest' })
  assert.deepEqual(third.messages.map((m) => m.seq), [5, 6], '第三批收尾')
  // 三批并集 = 全部，且没有一条被跳过（旧实现会永远只拿到 [5,6]）
  const all = [...first.messages, ...second.messages, ...third.messages].map((m) => m.seq)
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6])
})

test('P0-1 落盘路径同样支持 afterSeq（重启后积压也能续做）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'memcore-p0-')), 'session.jsonl.zstd')
  const events = EVENTS.map((e) => ({ ...e }))
  writeFileSync(file, zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))
  const res = readTranscriptFromLog(file, { maxMessages: 99, afterSeq: 2 })
  assert.deepEqual(res.messages.map((m) => m.seq), [3, 4, 5, 6], '落盘读取也必须尊重游标下界')
})

test('P0-1b 按会话单飞：不同会话互不阻塞，同会话并发被拒，force 可越过', async () => {
  const inflight = createInflight()
  const slow = (tag) => () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, tag }), 20))
  const a = inflight.run('session-A', slow('A'))
  const b = inflight.run('session-B', slow('B'))
  // 旧实现（全局 size>0）这里会直接拒掉 B —— 正是要修的 bug
  const blocked = await inflight.run('session-A', slow('A2'))
  assert.equal(blocked.ok, false)
  assert.match(blocked.reason, /该会话已有提取任务在跑/)
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.ok, true, 'A 应正常跑完')
  assert.equal(rb.ok, true, 'B 不得因为 A 在跑而被拒（按会话单飞）')
  assert.equal(inflight.size(), 0, '跑完应清空')

  const c = inflight.run('session-A', slow('A3'))
  const forced = await inflight.run('session-A', slow('A4'), { force: true })
  assert.equal(forced.ok, true, 'force 应允许越过同会话单飞')
  await c
  await inflight.drain()
})

test('P0-1 默认批大小被钉住：maxMessages 存在且为 200（不再硬编码 20）', () => {
  assert.equal(EXTRACT_DEFAULTS.maxMessages, 200)
})
