import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEntry, parseFile, renderEntries, splitEntries } from '../lib/markdown.js'

const SAMPLE = [
  '[id:9f3a1c02] [2026-09-14 11:20] [git feature/x] 跨项目底部按钮直接用 @/components/FooterButton。',
  '§',
  '[09:11] [dsh] 今天的进展记录。',
  '§',
  '[2026-09-11] [summary:SPMS 多选 tag 必须用 block 容器]',
  'SPMS 多选 Select 的 tag 样式关键事实：必须用 inline-block。',
].join('\n')

test('切条目：与旧插件同一分隔符，丢弃空白条目', () => {
  const entries = splitEntries(`${SAMPLE}\n§\n   \n`)
  assert.equal(entries.length, 3)
})

test('条目头解析：id / 日期时间 / git 分支 / 项目标签', () => {
  const [a, b] = parseFile(SAMPLE)
  assert.equal(a.id, '9f3a1c02')
  assert.equal(a.date, '2026-09-14')
  assert.equal(a.time, '11:20')
  assert.equal(a.git, 'feature/x')
  assert.equal(b.time, '09:11')
  assert.equal(b.label, 'dsh')
})

test('key 轨的 summary 前缀被剥离成元数据，正文保留', () => {
  const [, , c] = parseFile(SAMPLE)
  assert.equal(c.summary, 'SPMS 多选 tag 必须用 block 容器')
  assert.ok(c.body.startsWith('SPMS 多选 Select 的 tag 样式关键事实'))
})

test('content 是逐字原文（导出可字节级回放）', () => {
  const entries = parseFile(SAMPLE)
  assert.equal(entries[0].content, '[id:9f3a1c02] [2026-09-14 11:20] [git feature/x] 跨项目底部按钮直接用 @/components/FooterButton。')
  assert.equal(renderEntries(entries), `${SAMPLE}\n`)
})

test('renderEntries 与 splitEntries 往返稳定', () => {
  const text = renderEntries(parseFile(SAMPLE))
  assert.deepEqual(splitEntries(text), splitEntries(SAMPLE))
})

test('缺少头部标记的裸文本也能解析', () => {
  const meta = parseEntry('纯文本条目，没有任何头部标记。')
  assert.equal(meta.id, null)
  assert.equal(meta.date, null)
  assert.equal(meta.content, '纯文本条目，没有任何头部标记。')
})
