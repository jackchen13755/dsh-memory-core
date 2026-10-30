import assert from 'node:assert/strict'
import test from 'node:test'
import { humanText, isHumanMessage } from '../lib/inject.js'

/**
 * P0-0：召回的 query 曾经读到的是**宿主运行时快照**，不是用户说的话。
 *
 * 宿主的快照是 `role:'user'` 消息，`source = { kind: 'runtime-context', form: 'snapshot' }`
 * （`@deepseek-ai/dsh-agent-loop`：`const SOURCE = "runtime-context"`）。旧判据写的是
 * `source.kind === 'plugin'` —— 该值在宿主链路里不存在，守卫从未生效。
 */
test('isHumanMessage：宿主的 runtime-context 快照不算真人消息', () => {
  assert.equal(isHumanMessage({ role: 'user', content: 'x', source: { kind: 'runtime-context' } }), false)
  assert.equal(isHumanMessage({ role: 'user', content: 'x', source: { kind: 'runtime-context', form: 'snapshot', sections: [] } }), false)
  // 快照标记比 kind 更权威：form=snapshot 一律排除（即使 kind 换名）
  assert.equal(isHumanMessage({ role: 'user', content: 'x', source: { kind: 'whatever', form: 'snapshot' } }), false)
})

test('isHumanMessage：真人消息（无 source / kind=user）通过', () => {
  assert.equal(isHumanMessage({ role: 'user', content: '你好' }), true)
  assert.equal(isHumanMessage({ role: 'user', content: '你好', source: { kind: 'user' } }), true)
  assert.equal(isHumanMessage({ role: 'assistant', content: '回复' }), false)
  assert.equal(isHumanMessage(null), false)
})

test('form=snapshot 是独立判据：kind 伪装成 user 也照样排除', () => {
  // 宿主空快照的形态是 { kind: 'runtime-context' }（没有 form）；
  // 带 sections 的是 { kind:'runtime-context', form:'snapshot' }。
  // 但只要换了名字（kind 变成 user），只有 form 这一层能兜住 —— 两条判据必须各自有效。
  assert.equal(isHumanMessage({ role: 'user', content: 'x', source: { kind: 'user', form: 'snapshot' } }), false)
  assert.equal(isHumanMessage({ role: 'user', content: 'x', source: { kind: 'runtime-context' } }), false)
  assert.equal(isHumanMessage({ role: 'user', content: 'x', source: { kind: 'user' } }), true)
})

test('humanText：跳过运行时快照，取真正的最后一句用户输入', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '帮我看下记忆插件' }] },
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context: 一堆注入段' }], source: { kind: 'runtime-context', form: 'snapshot', sections: ['记忆', '骨架'] } },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ]
  assert.equal(humanText(messages), '帮我看下记忆插件')
})

test('humanText：快照正文里带着上一轮的记忆片段，不会被当成 query（切断自反馈）', () => {
  const snapshotText = ['Current runtime context', '【本轮相关记忆（自动召回）】query: 上一轮的话', '【会话骨架】…'].join('\n')
  const messages = [
    { role: 'user', content: '真正的用户输入' },
    { role: 'user', content: [{ type: 'text', text: snapshotText }], source: { kind: 'runtime-context', form: 'snapshot' } },
  ]
  const picked = humanText(messages)
  assert.equal(picked, '真正的用户输入')
  assert.ok(!picked.includes('本轮相关记忆'), '快照里的回忆片段不得成为新的 query')
})

test('humanText：其它非真人来源一律跳过（plugin / agent-message / user-approval）', () => {
  for (const kind of ['plugin', 'agent-message', 'user-approval', 'subagent-settled', 'tool-jobs']) {
    const messages = [{ role: 'user', content: `来自 ${kind} 的文本`, source: { kind } }]
    assert.equal(humanText(messages), '', `${kind} 不应被当作真人输入`)
  }
})

test('humanText：没有来源字段的 user 消息仍当真人（兜底不误杀）', () => {
  assert.equal(humanText([{ role: 'user', content: '纯字符串' }]), '纯字符串')
  assert.equal(humanText([{ role: 'user', content: [{ type: 'text', text: '数组分段' }] }]), '数组分段')
  assert.equal(humanText([]), '')
})
