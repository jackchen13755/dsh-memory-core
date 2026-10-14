/**
 * t10 实体归一化：normalizeEntity + entityMatches（给 lib/entities.js 新增的导出）。
 *
 * 覆盖：
 *   - normalizeEntity 幂等（对同一批输入连折两次结果不变）；
 *   - 归一化五件事：大小写、首尾与内部多余空白、全角转半角、分隔符统一（含 UNC 的 `\\`）、尾部斜杠；
 *   - 边界：空/null/undefined 不抛异常；根 `/` 不折成空串；不修改入参；
 *   - entityMatches：精确命中、别名/包含命中、正反例、空 query 与空列表不命中、不修改入参；
 *   - extractEntities 既有行为不回归（抽取规则、返回顺序、limit 截断原样）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { entityMatches, extractEntities, normalizeEntity } from '../lib/entities.js'

/** 归一化必须收敛：折一次和折两次结果相同。 */
function assertIdempotent(input) {
  const once = normalizeEntity(input)
  assert.equal(normalizeEntity(once), once, `不幂等：${JSON.stringify(input)} → ${JSON.stringify(once)}`)
  return once
}

test('normalizeEntity：幂等（折一次 = 折两次）', () => {
  const inputs = [
    '',
    '   ',
    '/',
    '//',
    'Foo',
    '  FOO  Bar  ',
    'ＣＯＭＰＯＮＥＮＴ／Ｆｏｏ',
    '／ＵＳＥＲＳ／Ａｌｉｃｅ／Ａｐｐ．ＪＳ／',
    'C:\\Users\\Alice\\Project\\',
    '\\\\server\\share\\dir\\',
    '@／components／Foo',
    '~/Repo//src///App.js',
    '/Users/Alice/Project/src/App.js/',
    '`pnpm   test`',
    'bug 12345',
    'Package-Name.Scope_Name',
    '\u3000全角　空格\u3000',
  ]
  for (const input of inputs) assertIdempotent(input)
})

test('normalizeEntity：大小写与空白（首尾 + 内部连续）', () => {
  assert.equal(normalizeEntity('Foo'), 'foo')
  assert.equal(normalizeEntity('  FOO  '), 'foo')
  assert.equal(normalizeEntity('mem  core\tcore'), 'mem core core')
  assert.equal(normalizeEntity('`pnpm   test`'), '`pnpm test`')
  assert.equal(normalizeEntity(' \u3000全角　空格\u3000 '), '全角 空格', '全角空格折成半角空格')
  assert.equal(normalizeEntity(''), '')
  assert.equal(normalizeEntity('   '), '')
})

test('normalizeEntity：全角转半角（含全角路径分隔符）', () => {
  assert.equal(normalizeEntity('ＢＵＧ１２３４５'), 'bug12345')
  assert.equal(normalizeEntity('ＡＢＣ－ＸＹＺ'), 'abc-xyz', '全角连字符 → 半角')
  assert.equal(normalizeEntity('Ｃｏｍｐｏｎｅｎｔ．Ｆｏｏ'), 'component.foo')
  // 全角斜杠 U+FF0F 先转半角，再走统一分隔符
  assert.equal(normalizeEntity('／ＵＳＥＲＳ／Ａｌｉｃｅ／Ａｐｐ．ＪＳ／'), '/users/alice/app.js')
  // 全角括号/中文标点：U+FF5E 段内的全角 ASCII 变体照常转半角
  assert.equal(normalizeEntity('（括号）'), '(括号)')
  assert.equal(normalizeEntity('中文实体'), '中文实体')
  assert.equal(normalizeEntity('【本范围】'), '【本范围】', '非 ASCII 变体（CJK 标点）保持原样')
})

test('normalizeEntity：路径分隔符统一为 / 且去掉尾部斜杠', () => {
  assert.equal(normalizeEntity('/Users/Alice/Project/src/App.js'), '/users/alice/project/src/app.js')
  assert.equal(normalizeEntity('C:\\Users\\Alice\\Project\\'), '/users/alice/project', '反斜杠 → 正斜杠、盘符去掉')
  assert.equal(normalizeEntity('c:/Users/Alice'), '/users/alice', '盘符 + 正斜杠同样是同一个键')
  assert.equal(normalizeEntity('12:30'), '12:30', '时间不被误当盘符')
  assert.equal(normalizeEntity('\\\\server\\share\\dir\\'), '/server/share/dir', 'UNC 双反斜杠 → /，不产生双斜杠')
  assert.equal(normalizeEntity('~/Repo//src///App.js'), '~/repo/src/app.js', '连续斜杠折成一个')
  assert.equal(normalizeEntity('@／components／Foo'), '@/components/foo')
  assert.equal(normalizeEntity('/Users/Alice/Project/src/App.js/'), '/users/alice/project/src/app.js', '尾部斜杠去掉')
  assert.equal(normalizeEntity('/'), '/', '根不能被折成空串')
  assert.equal(normalizeEntity('//'), '/')
  assert.equal(normalizeEntity('a/b'), '/a/b', '相对路径也带上前导 /，保证两种写法折成同一键')
  assert.equal(normalizeEntity('/a/b'), '/a/b')
  // `~/`（家目录）与 `@/`（别名路径）是常见写法，保留前缀、不变成绝对路径
  assert.equal(normalizeEntity('~/Repo//src///App.js'), '~/repo/src/app.js')
  assert.equal(normalizeEntity('@／components／Foo'), '@/components/foo')
  assert.equal(normalizeEntity('@/components/Foo/'), '@/components/foo')
  // 注意：`v1.2/` 这类"字母+冒号"不是盘符；只有单字母 + 冒号才当盘符（`x:y` 不是路径）
  assert.equal(normalizeEntity('x:y'), 'x:y')
})

test('normalizeEntity：纯字符串工具（不改入参、任何输入都不抛）', () => {
  const arr = ['/Users/Alice/', 'FOO']
  const snapshot = [...arr]
  normalizeEntity('/Users/Alice/')
  assert.deepEqual(arr, snapshot, '入参数组不得被改动')
  assert.equal(normalizeEntity(undefined), '')
  assert.equal(normalizeEntity(null), '')
  assert.equal(normalizeEntity(123), '123')
})

test('entityMatches：精确命中走归一键（大小写/全角/空白/分隔符差异都能命中）', () => {
  assert.equal(entityMatches('figma_read_node_ws', ['figma_read_node_ws']), true)
  assert.equal(entityMatches('Figma_Read_Node_WS', ['figma_read_node_ws']), true, '大小写差异')
  assert.equal(entityMatches('／ＵＳＥＲＳ／Ａｌｉｃｅ／', ['/Users/Alice']), true, '全角 + 尾部斜杠 + 大小写')
  assert.equal(entityMatches('C:\\Users\\Alice\\Project', ['/Users/Alice/Project/']), true, '分隔符差异')
  assert.equal(entityMatches('  mem   core  ', ['mem core']), true, '内部多余空白')
  assert.equal(entityMatches('bug12345', ['bug12345']), true)
})

test('entityMatches：包含（别名/换写法）命中，且不相关不命中', () => {
  // 文档实体更具体
  assert.equal(entityMatches('api/users', ['api/users/1']), true)
  // query 更具体
  assert.equal(entityMatches('/Users/Alice/Project/src/App.js', ['/Users/Alice/Project']), true)
  // 组件名换写法
  assert.equal(entityMatches('@/components/Foo', ['@/components/Foo/index.vue']), true)
  assert.equal(entityMatches('pnpm test', ['pnpm test --watch']), true)

  // 正反例：不相关实体不得互相命中
  assert.equal(entityMatches('api/users', ['api/types/1']), false)
  assert.equal(entityMatches('figma_read_node_ws', ['web_search']), false)
  assert.equal(entityMatches('/Users/Alice/Project', ['/Users/Bob/Project']), false)
  assert.equal(entityMatches('bug12345', ['bug12346']), false)
})

test('entityMatches：空值、多候选与不修改入参', () => {
  assert.equal(entityMatches('', ['/a']), false, '空 query 不命中')
  assert.equal(entityMatches('   ', ['/a']), false, '空白 query 折成空串后不命中')
  assert.equal(entityMatches('/a', []), false, '空列表不命中')
  assert.equal(entityMatches('/a', ['', '   ']), false, '空文档实体不参与匹配')
  assert.equal(entityMatches('/a', [null, undefined]), false)
  assert.equal(entityMatches('/a', ['/b', '/c', '/a/b']), true, '命中其中一个即可')
  assert.equal(entityMatches('/a', [['/a/x']]), true, '单个字符串（非数组）也能匹配')

  const docs = ['/Users/Alice/', 'FOO']
  const snapshot = [...docs]
  entityMatches('/users/alice', docs)
  assert.deepEqual(docs, snapshot, '入参数组不得被改动')
})

test('extractEntities：既有抽取行为不回归（子串/路径/依赖/bug 号 + limit）', () => {
  const ents = extractEntities('用 `pnpm test` 跑 ~/.local/bin/tool，涉及 @/components/Foo 与 bug 12345')
  assert.deepEqual(ents, ['pnpm test', '~/.local/bin/tool', '@/components/Foo', 'bug12345'])
  assert.deepEqual(extractEntities('nothing here'), [])
  assert.deepEqual(extractEntities(''), [])
  assert.deepEqual(extractEntities(undefined), [])
  // limit 语义不变：先抽后截断，顺序保持首次出现顺序
  const many = extractEntities('`a1` `a2` `a3` `a4`', { limit: 2 })
  assert.deepEqual(many, ['a1', 'a2'])
  assert.equal(extractEntities('`a1` `a2` `a3`', { limit: 0 }).length, 0)
})

test('抽出来的实体能被归一化匹配（两个新导出的联动）', () => {
  const doc = extractEntities('配置在 `/Users/Alice/Project/src/App.js`，命令 `pnpm  test`，见 bug #12345')
  assert.equal(entityMatches('／ＵＳＥＲＳ／Ａｌｉｃｅ／Ｐｒｏｊｅｃｔ／Ｓｒｃ／Ａｐｐ．ＪＳ', doc), true)
  assert.equal(entityMatches('pnpm test', doc), true)
  assert.equal(entityMatches('BUG12345', doc), true)
  assert.equal(entityMatches('/Users/Bob/Other/src/App.js', doc), false)
})
