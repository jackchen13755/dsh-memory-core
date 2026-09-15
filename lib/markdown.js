/**
 * 旧 Markdown 记忆格式的解析与回放（设计 §4.4 / §11）。
 *
 * 兼容目标 = dsh-memory-evolve 的落盘格式，逐字对齐：
 *   分隔符：`\n§\n`（文件末尾一个换行）
 *   条目头：可选 `[id:xxxxxxxx]` → 时间戳（`[YYYY-MM-DD]` 或 `[YYYY-MM-DD HH:MM]`
 *           或 `[HH:MM]`）→ 若干 `[git <branch>]` → 可选 `[branch:...]` → 可选 `[dsh-only]`
 *   其后常见：可选项目标签 `[proj]`、可选 `[summary:...]` 摘要行
 *
 * **关键设计：`content` 逐字保留原始条目文本**（含头部 token）。解析出的
 * id/时间/分支等只作为元数据进库，导出时直接回放 content，因此
 * `导入 → 导出` 是字节级可逆的。
 */

export const ENTRY_DELIMITER = '\n§\n'

const TOKEN_RES = [
  ['id', /^\[id:([0-9a-f]{8})\]\s*/],
  ['datetime', /^\[(\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2}(?::\d{2})?))?\]\s*/],
  ['time', /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/],
  ['git', /^\[git ([^\]]+)\]\s*/],
  ['branch', /^\[branch:([^\]]*)\]\s*/],
  ['dshOnly', /^\[dsh-only\]\s*/],
]

/** 切条目：与旧插件同一分隔符；空白条目丢弃（与旧插件一致）。 */
export function splitEntries(text) {
  return String(text ?? '')
    .split(ENTRY_DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 解析单条条目：返回元数据 + 原文。
 * @param {string} raw
 */
export function parseEntry(raw) {
  const content = String(raw ?? '').trim()
  const meta = { id: null, date: null, time: null, git: null, branch: null, dshOnly: false, label: null, summary: null }
  let rest = content

  // 头部 token（顺序敏感，与旧插件 ENTRY_HEAD_RE 一致）
  for (;;) {
    let matched = false
    for (const [key, re] of TOKEN_RES) {
      const m = re.exec(rest)
      if (!m) continue
      if (key === 'datetime') {
        meta.date = m[1]
        meta.time = m[2] ?? null
      } else if (key === 'time') {
        meta.time = m[1]
      } else if (key === 'git') {
        meta.git = m[1]
      } else if (key === 'branch') {
        meta.branch = m[1] || null
      } else if (key === 'id') {
        meta.id = m[1]
      } else if (key === 'dshOnly') {
        meta.dshOnly = true
      }
      rest = rest.slice(m[0].length)
      matched = true
      break
    }
    if (!matched) break
  }

  // 项目标签：紧跟头部的短方括号（旧插件 daily 里写作 `[proj]` / `[tool]`）
  const labelMatch = /^\[([^\][:]{1,32})\]\s*/.exec(rest)
  if (labelMatch && !/^\d/.test(labelMatch[1])) {
    meta.label = labelMatch[1]
    rest = rest.slice(labelMatch[0].length)
  }

  // 摘要行：旧插件 key 轨的渐进式披露前缀 `[summary:...]`
  const firstLineEnd = rest.indexOf('\n')
  const firstLine = firstLineEnd === -1 ? rest : rest.slice(0, firstLineEnd)
  const sum = /^\[summary:([\s\S]*)\]\s*$/.exec(firstLine.trim())
  if (sum) {
    meta.summary = sum[1]
    rest = rest.slice(firstLineEnd === -1 ? rest.length : firstLineEnd + 1)
  }

  meta.body = rest.trim()
  meta.content = content
  return meta
}

/** 解析整份文件 → 条目数组（带元数据）。 */
export function parseFile(text) {
  return splitEntries(text).map((raw) => parseEntry(raw))
}

/** 回放：条目数组 → 文件文本（与旧插件 `join + '\n'` 一致）。 */
export function renderEntries(entries) {
  const parts = entries.map((e) => (typeof e === 'string' ? e.trim() : String(e.content ?? '').trim())).filter(Boolean)
  if (parts.length === 0) return ''
  return `${parts.join(ENTRY_DELIMITER)}\n`
}

/** 毫秒时间戳：由条目元数据 + 所属文件日期推导（daily 用当天，其余缺省用导入时刻）。 */
export function entryTimestamp(meta, { fallback = Date.now(), fileDay = null } = {}) {
  const day = meta.date ?? fileDay
  if (!day) return fallback
  const time = meta.time ?? '00:00'
  const [hh, mm] = time.split(':')
  const dt = new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm ?? '00').padStart(2, '0')}:00`)
  return Number.isNaN(dt.getTime()) ? fallback : dt.getTime()
}

// ---------------------------------------------------------------------------
// 待办条目（旧插件 § 格式 + tag 语法；本机当前无历史待办数据，解析保持宽容）
// ---------------------------------------------------------------------------

const TODO_TAGS = {
  id: /\[id:\s*([0-9a-f]{4,8})\]/i,
  quadrant: /\[(q[1-4])\]/i,
  status: /\[(?:status:\s*)?(pending|doing|done|blocked|cancelled)\]/i,
  due: /\[due:\s*(\d{4}-\d{2}-\d{2})\]/i,
  category: /\[cat:\s*([^\]]+)\]/i,
  done: /\[done:\s*([^\]]+)\]/i,
}

/**
 * 宽容解析一条待办（认 tag；认不出就整条当内容）。
 * @param {string} raw
 * @param {{ track?: string, scope?: string|null, day?: string|null }} [ctx]
 */
export function parseTodoEntry(raw, ctx = {}) {
  let rest = String(raw ?? '').trim()
  const out = { id: null, quadrant: null, status: 'pending', due: null, category: null, doneAt: null }
  for (const [key, re] of Object.entries(TODO_TAGS)) {
    const m = re.exec(rest)
    if (!m) continue
    if (key === 'done') out.doneAt = m[1]
    else out[key] = m[1]
    rest = rest.replace(m[0], ' ')
  }
  // 前置日期头（旧插件待办也可能带 `[2026-08-05]`）
  const head = /^\[(\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?)\]\s*/.exec(rest)
  if (head) rest = rest.slice(head[0].length)
  out.content = rest.replace(/\s+/g, ' ').trim()
  out.track = ctx.track ?? 'work'
  out.scope = ctx.scope ?? null
  out.day = ctx.day ?? null
  return out
}

export function renderTodoEntry(todo) {
  const bits = []
  if (todo.id) bits.push(`[id: ${todo.id}]`)
  if (todo.quadrant) bits.push(`[${todo.quadrant}]`)
  if (todo.due) bits.push(`[due: ${todo.due}]`)
  bits.push(`[${todo.status}]`)
  if (todo.category) bits.push(`[cat: ${todo.category}]`)
  return `${bits.join(' ')} ${todo.content}`.trim()
}
