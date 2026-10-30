import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { readTranscript } from '../lib/session-log.js'
import { buildLedger } from '../lib/index.js'
import * as sessionLog from '../lib/session-log.js'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { Store } from '../lib/store.js'
import { readFileSync } from 'node:fs'

/**
 * P0-0 的另外两个消费者：`session-log` 的转录读取。
 *
 * 它不只喂召回 query —— **会话骨架抽取**（`skeletonTick`）与 `mem_recall` 的
 * `source=span` 原文回捞都读同一份转录。旧判据（只排除 `source.kind === 'plugin'`）
 * 让 `runtime-context` / `time-context` / `skill-catalog` / `agent-instructions`
 * 这些宿主注入全被当成"用户说的话"喂进去。
 */
const USER_EVENT = (text, source) => ({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text }], source } })
// 助手事件的正文在 `data.message` 里（`textOfMessage` 的既有契约，别按 user 的形状构造）
const ASSISTANT_EVENT = (text) => ({ type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

test('readTranscript：活体事件里只保留真人消息，跳过宿主快照与其它注入', () => {
  const events = [
    USER_EVENT('帮我看看记忆插件', { kind: 'user' }),
    USER_EVENT('Current runtime context. This snapshot supersedes…', { kind: 'runtime-context', form: 'snapshot', sections: [] }),
    USER_EVENT('Time sampled while preparing turn 1', { kind: 'time-context', form: 'snapshot' }),
    USER_EVENT('<skills>…', { kind: 'skill-catalog', form: 'catalog' }),
    USER_EVENT('agent instructions', { kind: 'agent-instructions', form: 'instructions' }),
    USER_EVENT('plugin notice', { kind: 'plugin', form: 'notice' }),
    ASSISTANT_EVENT('好的，我看下'),
  ]
  const res = readTranscript({ id: 's-live', ownEvents: () => events })
  assert.equal(res.source, 'live')
  const userTexts = res.messages.filter((m) => m.role === 'user').map((m) => m.text)
  assert.deepEqual(userTexts, ['帮我看看记忆插件'], `只应保留真人消息：${JSON.stringify(userTexts)}`)
  assert.ok(res.messages.some((m) => m.role === 'assistant' && m.text.includes('我看下')), '助手消息照常保留')
})

test('readTranscript：无 source 的 user 事件仍算真人（兜底不误杀）', () => {
  const res = readTranscript({ id: 's-plain', ownEvents: () => [USER_EVENT('裸消息', undefined)] })
  assert.deepEqual(res.messages.map((m) => m.text), ['裸消息'])
})

test('readTranscriptFromLog（落盘路径）：同一判据生效', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'memcore-zstd-')), 'session.jsonl.zstd')
  const events = [
    { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: '磁盘上的真话' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: '磁盘上的快照' }], source: { kind: 'runtime-context', form: 'snapshot' } } },
    { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '磁盘上的回复' }] } } },
  ]
  writeFileSync(file, zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))
  const res = sessionLog.readTranscriptFromLog(file, { maxMessages: 20 })
  assert.deepEqual(res.messages.filter((m) => m.role === 'user').map((m) => m.text), ['磁盘上的真话'])
  assert.equal(res.messages.filter((m) => m.role === 'assistant').length, 1)
})

test('装配：apply 用的是 buildLedger（store 真的接上了）', () => {
  // 行为断言：buildLedger 把 store 接到 ledger 上，并跟随 config
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-wire-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const wired = buildLedger({ store, config: {} })
  assert.equal(wired.store, store)
  assert.equal(wired.persistSeen, true)
  assert.equal(wired.snapshot('x').session, null)
  wired.markSeen('x', ['a'])
  assert.ok(String(store.getMeta('inject:seen:x')).includes('a'), '装配后的账本应真的写 meta')
  assert.equal(buildLedger({ store, config: { recall: { persistSeen: false } } }).persistSeen, false)
  assert.equal(buildLedger({}).store, null, '无 store 时降级为纯内存')

  // 接线断言：apply 里必须通过 buildLedger 构造（否则 M-2 这类"写对但没接线"的回归无人发现）
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(/const ledger = buildLedger\(\{ store: opened\.store/.test(source), 'apply 必须用 buildLedger 装配账本')
  closeDb(db)
})
