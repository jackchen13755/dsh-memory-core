/**
 * t2 时间维度：units.occurred_at 迁移（schema v4）+ 抽取侧 occurredAt 解析 + retain_mission。
 *
 * 覆盖：
 *   - v4 迁移在「已有数据的 v3 老库」上升级：加列加索引、旧条目该列为 NULL、数据不丢、既有查询不受影响；
 *   - 重复 migrate 幂等（不报错、版本稳定、quick_check ok）；
 *   - occurredAt 四种输入（ISO / YYYY-MM-DD / 空 / 非法）的解析容错：坏日期只丢字段、绝不丢整条；
 *   - retain_mission：空串不注入（提示词与改造前逐字一致，golden 对比），非空注入抽取倾向；
 *   - extractSession 端到端：mission 真进提示词、occurredAt 真落到 item 上。
 *
 * 铁律：不碰真实库（$DSH_HOME/memory-core/mem.db），一律用 mkdtemp 副本。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, currentVersion, migrate, openDb, quickCheck } from '../lib/db.js'
import { EXTRACT_DEFAULTS, EXTRACT_SYSTEM, TRACK_GUIDE, buildExtractRequest, buildExtractSystem, extractSession, parseExtraction, parseOccurredAt } from '../lib/extract.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/schema.js'
import { Store } from '../lib/store.js'

/** 临时库（每次调用新建目录，绝不落到真实 $DSH_HOME）。 */
function tmpDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'memcore-t2-')), 'mem.db'))
}

/** 只应用到指定版本（模拟"改造前的老库"）。 */
function migrateUpTo(db, version) {
  for (const m of MIGRATIONS) {
    if (m.version > version) continue
    db.exec(m.sql)
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(m.version))
  }
}

function insertLegacyUnit(db, id = 'u-legacy') {
  db.prepare(
    `INSERT INTO units (id, track, scope, kind, content, tokens, content_hash, created_at, updated_at, importance, pinned, access_count, status, version, lamport)
     VALUES (?, 'memory', 'global', 'fact', ?, ?, ?, 1700000000000, 1700000000000, 0.5, 0, 0, 'active', 1, 0)`,
  ).run(id, `升级前写入的既有条目 ${id}`, '升 级 前 写 入 的 既 有 条 目', `hash-${id}`)
}

const ISO_MS = Date.parse('2026-10-14T09:30:00.000Z')
const DATE_ONLY_MS = Date.UTC(2026, 9, 14)

test('v4 迁移：v3 老库升级后新增 occurred_at 列与 units_occurred 索引，旧条目为 NULL 且数据不丢', () => {
  const db = tmpDb()
  try {
    migrateUpTo(db, 3)
    assert.equal(currentVersion(db), 3, '前置：老库停在 v3')
    insertLegacyUnit(db)

    const res = migrate(db)
    assert.equal(res.from, 3)
    assert.equal(res.to, SCHEMA_VERSION)
    assert.equal(res.applied, 2, 'v3 老库一次升到当前版本：v4 时间维度 + v5 会话骨架')
    assert.equal(res.target, SCHEMA_VERSION)
    assert.equal(SCHEMA_VERSION, 5, 'SCHEMA_VERSION 必须同步递增')

    // 列：INTEGER、可 NULL
    const cols = db.prepare('PRAGMA table_info(units)').all()
    const occurred = cols.find((c) => c.name === 'occurred_at')
    assert.ok(occurred, 'units.occurred_at 列必须存在')
    assert.equal(String(occurred.type).toUpperCase(), 'INTEGER')
    assert.equal(Number(occurred.notnull), 0, 'occurred_at 必须可 NULL（NULL = 未知，召回回落 created_at）')
    assert.equal(cols.filter((c) => c.name === 'occurred_at').length, 1, '列不得重复添加')

    // 索引
    const indexes = db.prepare('PRAGMA index_list(units)').all().map((r) => r.name)
    assert.ok(indexes.includes('units_occurred'), `缺少 units_occurred 索引（现有：${indexes.join(',')}）`)
    const idxCols = db.prepare('PRAGMA index_info(units_occurred)').all().map((r) => r.name)
    assert.deepEqual(idxCols, ['occurred_at'])

    // 老数据：一条不少、内容原样、新列为 NULL
    const rows = db.prepare('SELECT id, content, occurred_at FROM units').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'u-legacy')
    assert.equal(rows[0].content, '升级前写入的既有条目 u-legacy')
    assert.equal(rows[0].occurred_at, null, '旧条目 occurred_at 必须为 NULL（未知）')

    assert.equal(quickCheck(db).ok, true)
  } finally {
    closeDb(db)
  }
})

test('v4 迁移幂等：重复 migrate 不报错、版本稳定、quick_check ok、数据不丢', () => {
  const db = tmpDb()
  try {
    const first = migrate(db)
    assert.equal(first.to, SCHEMA_VERSION)
    insertLegacyUnit(db)

    for (const round of [1, 2, 3]) {
      const again = migrate(db)
      assert.equal(again.applied, 0, `第 ${round} 次重复迁移不应再应用任何迁移`)
      assert.equal(again.to, SCHEMA_VERSION, `第 ${round} 次重复迁移后版本仍应是当前版本`)
    }

    const cols = db.prepare('PRAGMA table_info(units)').all().filter((c) => c.name === 'occurred_at')
    assert.equal(cols.length, 1, '重复迁移不得把列加两次')
    const rows = db.prepare('SELECT id, content FROM units').all()
    assert.equal(rows.length, 1, '重复迁移不得丢数据')
    assert.equal(rows[0].content, '升级前写入的既有条目 u-legacy')
    assert.equal(quickCheck(db).ok, true, 'quick_check 必须 ok')
  } finally {
    closeDb(db)
  }
})

test('v4 迁移不影响既有查询：Store 读写照常，occurred_at 可空可写', () => {
  const db = tmpDb()
  try {
    migrate(db)
    const store = new Store(db)
    insertLegacyUnit(db, 'u-1')
    db.prepare("INSERT INTO units (id, track, scope, kind, content, tokens, content_hash, created_at, updated_at, occurred_at, status, version, lamport) VALUES ('u-2','memory','global','fact','带发生时间的条目','带 发 生 时 间','hash-u-2',1700000000001,1700000000001,?, 'active', 1, 0)").run(DATE_ONLY_MS)

    const listed = store.listUnits({ track: 'memory', scope: 'global' })
    assert.equal(listed.length, 2, '既有 listUnits 查询必须照常返回全部条目')
    assert.equal(store.getUnit('u-1').occurred_at, null)
    assert.equal(store.getUnit('u-2').occurred_at, DATE_ONLY_MS, 'occurred_at 应能按 epoch ms 写入并读回')
    // 索引可用（EXPLAIN 不报错的轻量证据：按 occurred_at 过滤能返回结果）
    const byTime = db.prepare('SELECT id FROM units WHERE occurred_at = ?').all(DATE_ONLY_MS)
    assert.deepEqual(byTime.map((r) => r.id), ['u-2'])
  } finally {
    closeDb(db)
  }
})

test('parseOccurredAt：ISO / YYYY-MM-DD / 空 / 非法 四类输入全部容错（非法一律 null）', () => {
  const cases = [
    // ISO 日期（带时区）
    { input: '2026-10-14T09:30:00.000Z', want: ISO_MS, why: 'ISO 8601 UTC' },
    { input: '2026-10-14T17:30:00+08:00', want: ISO_MS, why: 'ISO 8601 带时区偏移' },
    // YYYY-MM-DD
    { input: '2026-10-14', want: DATE_ONLY_MS, why: '纯日期按 UTC 零点' },
    { input: '  2026-10-14  ', want: DATE_ONLY_MS, why: '前后空白应容忍' },
    // 空
    { input: null, want: null, why: '显式 null' },
    { input: undefined, want: null, why: '字段缺失' },
    { input: '', want: null, why: '空串' },
    { input: '   ', want: null, why: '纯空白' },
    { input: 'null', want: null, why: '模型写成字符串 null' },
    { input: '未知', want: null, why: '模型写成中文占位' },
    // 非法
    { input: '不是日期', want: null, why: '乱字符串' },
    { input: '2026-02-30', want: null, why: '越界日期（不得滚成 3-02）' },
    { input: '2026-13-01', want: null, why: '越界月份' },
    { input: '2026-00-10', want: null, why: '零月' },
    { input: '2026-10-00', want: null, why: '零日' },
    { input: {}, want: null, why: '对象' },
    { input: [], want: null, why: '数组' },
    { input: true, want: null, why: '布尔' },
    { input: Number.NaN, want: null, why: 'NaN' },
    // 数字（epoch ms 直通）
    { input: ISO_MS, want: ISO_MS, why: '已是 epoch ms 的数字' },
  ]
  for (const c of cases) {
    const got = parseOccurredAt(c.input)
    assert.equal(got, c.want, `${c.why}：parseOccurredAt(${JSON.stringify(c.input)}) 应为 ${c.want}，实际 ${got}`)
  }
})

test('parseExtraction：四种 occurredAt 输入同批出现时不丢整条，非法一律归 NULL', () => {
  const raw = JSON.stringify({
    items: [
      { content: '条目 A：ISO 日期', track: 'memory', kind: 'fact', occurredAt: '2026-10-14T09:30:00.000Z' },
      { content: '条目 B：纯日期', track: 'memory', kind: 'fact', occurredAt: '2026-10-14' },
      { content: '条目 C：空值', track: 'memory', kind: 'fact', occurredAt: '' },
      { content: '条目 D：非法值', track: 'memory', kind: 'fact', occurredAt: '大概是上个月' },
      { content: '条目 E：缺字段', track: 'memory', kind: 'fact' },
      { content: '条目 F：越界日期', track: 'memory', kind: 'fact', occurredAt: '2026-02-30' },
    ],
  })
  const res = parseExtraction(raw)
  assert.equal(res.ok, true)
  assert.equal(res.items.length, 6, '坏 occurredAt 不得让任何一条记忆消失')
  assert.deepEqual(
    res.items.map((i) => i.content),
    ['条目 A：ISO 日期', '条目 B：纯日期', '条目 C：空值', '条目 D：非法值', '条目 E：缺字段', '条目 F：越界日期'],
  )
  assert.deepEqual(
    res.items.map((i) => i.occurredAt),
    [ISO_MS, DATE_ONLY_MS, null, null, null, null],
  )
  for (const item of res.items) {
    assert.equal(typeof item.content, 'string')
    assert.ok(item.content.length >= 4, 'content 必须被完整保留')
    assert.ok(item.occurredAt === null || typeof item.occurredAt === 'number', 'occurredAt 只允许 number|null')
  }
})

test('parseExtraction：occurred_at 下划线别名与数字时间也接受（模型手滑不丢条目）', () => {
  const res = parseExtraction(JSON.stringify({ items: [{ content: '别名写法', track: 'key', kind: 'fact', occurred_at: '2026-10-14' }, { content: '数字写法', track: 'key', kind: 'fact', occurredAt: DATE_ONLY_MS }] }))
  assert.equal(res.ok, true)
  assert.equal(res.items.length, 2)
  assert.equal(res.items[0].occurredAt, DATE_ONLY_MS)
  assert.equal(res.items[1].occurredAt, DATE_ONLY_MS)
})

test('mission：空串不注入（与改造前提示词逐字一致），非空才注入抽取倾向', () => {
  assert.equal(EXTRACT_DEFAULTS.mission, '', '接口冻结：EXTRACT_DEFAULTS.mission 默认空串')

  const noMissionArg = buildExtractRequest({ transcript: '用户: 你好' })
  const emptyMission = buildExtractRequest({ transcript: '用户: 你好', mission: '' })
  const blankMission = buildExtractRequest({ transcript: '用户: 你好', mission: '   ' })

  assert.equal(noMissionArg.system, EXTRACT_SYSTEM, '不传 mission 时系统提示必须与 base 完全一致')
  assert.equal(emptyMission.system, EXTRACT_SYSTEM, 'mission 为空串时必须不注入')
  assert.equal(blankMission.system, EXTRACT_SYSTEM, 'mission 只有空白时必须视同不注入')
  assert.equal(buildExtractSystem({}), EXTRACT_SYSTEM)
  assert.equal(buildExtractSystem({ mission: '' }), EXTRACT_SYSTEM)
  assert.ok(!noMissionArg.system.includes('retain_mission'), '空 mission 时提示词里不得出现 mission 痕迹')
  assert.deepEqual(emptyMission.messages, noMissionArg.messages, '注入与否不得改动 user 消息')

  const missionText = '总是包含技术决策 / API 设计 / 架构权衡；忽略寒暄与会议事务'
  const withMission = buildExtractRequest({ transcript: '用户: 你好', mission: missionText })
  assert.ok(withMission.system.startsWith(EXTRACT_SYSTEM), '注入必须是追加：base 提示词逐字在前')
  assert.ok(withMission.system.includes('本库关注的抽取倾向'), '非空 mission 必须说明这是"本库关注的抽取倾向"')
  assert.ok(withMission.system.includes(missionText), 'mission 原文必须进入提示词')
  assert.ok(withMission.system.length > EXTRACT_SYSTEM.length)
  assert.deepEqual(withMission.messages, noMissionArg.messages, 'mission 只改 system，不改 user 消息')
  assert.equal(buildExtractSystem({ mission: `  ${missionText}  ` }), withMission.system, 'mission 前后空白应被裁剪')
})

/** 改造前的 EXTRACT_SYSTEM（v0.0.13，git HEAD:lib/extract.js）——用于锁定"改造面只有 occurredAt"。 */
const PRE_CHANGE_SYSTEM = `你是记忆提取器。从对话里提取"值得跨会话长期保留"的内容，输出严格 JSON。

${TRACK_GUIDE}

只提取这些类型：用户偏好、环境事实、工具用法、项目约定、决策、踩坑根因、可复用的做法。
**不要提取**：一次性的中间状态、密钥/token/密码、模型的推理过程、工具的长原始输出、代码细节的逐行复述。
**同时**判断本轮是否沉淀出了"可复用的工作方法"——即值得写成技能（SKILL.md）的流程/协议/检查清单：
- 只在**方法本身可复用**时建议（如"某类 bug 的排查步骤""某项目的发布核对清单"），不要建议一次性任务；
- 技能正文写成可执行步骤（命令、判据、验证方式），不要写空泛原则；
- 没有就省略 skills 字段，**不要硬凑**。

如果本轮没有任何值得长期保留的内容，返回 {"items": []}。

输出格式（严格 JSON，不要 markdown 代码块，不要解释）：
{"items":[{"content":"一条独立可读的记忆（中文，含关键标识符/路径/组件名原样）","track":"user|memory|key|project|daily","kind":"rule|preference|fact|decision|pitfall|env|progress","confidence":0.0-1.0,"evidence":"来自用户还是助手 + 关键原话片段","aliases":["换个说法时可能用到的词"],"entities":["路径/组件名/命令/bug号"]}],"skills":[{"name":"kebab-case-技能名","description":"一句话说明何时使用","body":"## 步骤\n1. …\n## 验证\n…","reason":"为什么值得沉淀"}]}

要求：
1. content 必须自包含（脱离对话也看得懂），一条只讲一件事，≤300 字；
2. 不确定的内容 confidence 给低分（助手推断 ≤0.6，用户明说可 0.9+）；
3. 保留原文语言与标识符原样，不要翻译、不要改写路径与组件名。`

test('EXTRACT_SYSTEM 的改造面仅限 occurredAt：抹掉新增两处即与改造前逐字一致（golden 对比）', () => {
  const stripped = EXTRACT_SYSTEM
    .replace(',"occurredAt":"YYYY-MM-DD 或 null"', '')
    .replace('\n4. occurredAt = 这条事实/事件**发生**的时间（不是现在、不是对话时间）：能从上下文判定就写 YYYY-MM-DD，判不出或只是泛泛而谈就写 null，**不要编造日期**。', '')
    .replace('不要翻译、不要改写路径与组件名；', '不要翻译、不要改写路径与组件名。')
  assert.equal(stripped, PRE_CHANGE_SYSTEM, '除 occurredAt 外，提示词必须与改造前逐字一致')
  assert.ok(EXTRACT_SYSTEM.includes('"occurredAt":"YYYY-MM-DD 或 null"'), '输出格式必须声明 occurredAt')
  assert.ok(EXTRACT_SYSTEM.includes('4. occurredAt ='), '必须给出 occurredAt 的填写判据（判不出写 null，不要编造）')
})

test('extractSession 端到端：mission 进提示词、occurredAt 落到 item（坏字段不丢条目）', async () => {
  const db = tmpDb()
  try {
    migrate(db)
    const store = new Store(db)
    const seen = []
    const llm = {
      stream(options) {
        seen.push(options)
        return (async function* () {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                { content: '决策：记忆库采用双时间维度', track: 'key', kind: 'decision', occurredAt: '2026-10-14' },
                { content: '踩坑：坏日期字段不该连累整条记忆', track: 'key', kind: 'pitfall', occurredAt: '上个月吧' },
              ],
            }),
          }
        })()
      },
    }
    const mission = '只保留技术决策与踩坑根因，忽略寒暄'
    const res = await extractSession({
      store,
      transcript: '用户: 记一下\n助手: 好',
      llm,
      route: { provider: 'p', model: 'm' },
      config: { ...EXTRACT_DEFAULTS, mission },
      enqueue: () => ({ status: 'queued' }),
    })
    assert.equal(res.ok, true)
    assert.equal(seen.length, 1)
    assert.ok(seen[0].system.startsWith(EXTRACT_SYSTEM), 'base 提示词仍在最前')
    assert.ok(seen[0].system.includes(mission), 'config.mission 必须真的拼进抽取提示')
    assert.equal(res.items.length, 2, '坏 occurredAt 不得丢条目')
    assert.deepEqual(
      res.items.map((i) => i.occurredAt),
      [DATE_ONLY_MS, null],
    )

    // mission 缺省时提示词回到 base（逐字一致），不因改造引入额外注入
    seen.length = 0
    const res2 = await extractSession({
      store,
      transcript: '用户: 再来一轮\n助手: 好',
      llm,
      route: { provider: 'p', model: 'm' },
      config: { ...EXTRACT_DEFAULTS },
      enqueue: () => ({ status: 'queued' }),
    })
    assert.equal(res2.ok, true)
    assert.equal(seen[0].system, EXTRACT_SYSTEM, 'mission 为空时抽取提示必须与改造前逐字一致')
    assert.deepEqual(res2.items.map((i) => i.occurredAt), [DATE_ONLY_MS, null])
  } finally {
    closeDb(db)
  }
})
