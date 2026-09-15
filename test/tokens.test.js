import assert from 'node:assert/strict'
import test from 'node:test'
import { cjkBigrams, ftsQuery, tokenize, tokensField } from '../lib/tokens.js'

test('中文切相邻双字组；单字保留', () => {
  assert.deepEqual(cjkBigrams('底部按钮'), ['底部', '部按', '按钮'])
  assert.deepEqual(cjkBigrams('中'), ['中'])
  // 中文与英文混排：只切中文连续段
  assert.deepEqual(cjkBigrams('用 FooterButton 组件'), ['用', '组件'])
})

test('标识符保原样，同时拆出分段词', () => {
  const toks = tokenize('@/components/FooterButton 与 internal-resolve-cli')
  assert.ok(toks.includes('@/components/footerbutton'), '整串标识符应保留')
  assert.ok(toks.includes('footerbutton'), '分段词应可命中')
  assert.ok(toks.includes('internal-resolve-cli'))
  assert.ok(toks.includes('resolve'))
})

test('路径、版本号、bug 号进索引', () => {
  const toks = tokenize('~/.local/bin/internal-resolve-cli 处理缺陷 12345 (v0.2.1)')
  assert.ok(toks.includes('~/.local/bin/internal-resolve-cli'))
  assert.ok(toks.includes('12345'))
  assert.ok(toks.some((t) => t.includes('0.2.1')), '版本号应可命中')
})

test('查询串必须用 OR 连接（隐式 AND 会让中文召回塌成 0 命中）', () => {
  const q = ftsQuery('底部按钮怎么加')
  assert.ok(q, '应产出查询串')
  assert.ok(q.includes(' OR '), '词条之间必须是 OR')
  assert.ok(!/  /.test(q), '不应出现连续空格')
  // FTS5 字面量：双引号包裹，内部引号转义
  assert.equal(ftsQuery('say "hi"'), '"say" OR "hi"')
})

test('空文本不产出索引与查询', () => {
  assert.equal(tokensField(''), '')
  assert.equal(ftsQuery('   '), null)
})
