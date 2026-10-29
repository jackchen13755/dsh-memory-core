/**
 * 会话状态骨架（借鉴 dsh-soul 的骨架思路，2026-10-29）
 *
 * 为什么要有它：压缩之后"这轮到底定了什么"没有任何恢复路径。
 *   - 常驻段只放 rule / preference（inject.js 的 RESIDENT_KINDS）；
 *   - 按轮卡片是 **query 驱动**（用本轮用户消息检索）。
 * 于是"我们决定用 anchor 而不是摘要，因为摘要会丢约束"这类**决策**：它不是规则，
 * 也没有任何 query 能命中它 —— 压缩一擦，就再也捞不回来。
 *
 * 四条硬约束（都来自 dsh-memory-core 既有契约，不是这里的自由发挥）：
 *   ① **零模型调用**：纯机械抽取，纯函数可单测（对齐 README「每轮零 LLM 调用」铁律）。
 *   ② **确定性投影**：同一图状态必得同一字节串。否则每轮抖动的投影会不断触发宿主
 *      「按内容去重后追加」的运行时快照（见 inject.js 顶部注释）。
 *   ③ **不碰队列 / 同步 / 快照**：节点是会话级派生态，丢了能从会话重算；
 *      因此不进 suggestions、不进 sync 的 ENTITIES、不进 Markdown 快照。
 *   ④ **只抽三类**：constraint / decision / progress。artifact 刻意不抽 ——
 *      它的价值在"失效判定"，而那属于 P2 的后台核对，先抽只会在投影里堆噪声。
 *
 * 精度优先：宁可少抽，不可乱抽。抽取规则全部是显式词表，不做模糊推断。
 */
import { sha1 } from './paths.js'

/** 只抽这三类；顺序即投影时的优先级（约束最先，永不被挤出预算）。 */
export const NODE_KINDS = ['constraint', 'decision', 'progress']

const KIND_RANK = { constraint: 0, decision: 1, progress: 2 }
const KIND_LABEL = { constraint: '约束', decision: '决策', progress: '进度' }

/**
 * 显式词表。**顺序即优先级**：一条话同时像约束和决策时，按约束记（约束丢了后果最重）。
 * 每条都要求出现具体标记词，不做"含否定词就算约束"这类模糊判断。
 */
const MARKERS = [
  {
    kind: 'constraint',
    /**
     * 裸 `别` 不能当祈使标记：实测「区别在/特别在/类别是/分别在于」会被判成约束，
     * 而约束会置 pin=1（永不回收 + 投影最前 + 每步注入），等于用中文技术写作里最常见的
     * 四个词稳定地把真约束挤出预算。所以 `别` 必须紧跟祈使动词。
     */
    re: /(?:^|[，。；：、\s]|你|请|千万|一定|永远|再|都)别(?:再|乱|改|动|用|把|碰|删|忘|来回|自己|只|去|在)|不要|禁止|严禁|必须|务必|只能|一定要|不得|不许|绝不|绝对不|不能改|不许改/,
  },
  {
    kind: 'decision',
    // 决定 / 定下来 / 就按 / 改用 / 换成 / 采用 / 选择 / 方案是 / 结论是 / 用X而不是Y
    re: /(决定|定下来|就按|改用|改成|换成|采用|选择用|方案是|结论是|而不是|最终用|定为)/,
  },
  {
    kind: 'progress',
    // 已完成 / 已修复 / 已提交 / 已推送 / 已改成 / 还剩 / 下一步 / 接下来 / 待办 / TODO
    re: /(已完成|已修复|已提交|已推送|已改好|已搞定|已通过|还剩|剩下的|下一步|接下来|待办|TODO|待处理)/,
  },
]

/**
 * 哪些来源允许产出哪类节点。
 *
 * 真实会话实测（6 个会话、生产默认 maxMessages=20）：抽出的 26 个节点里 **24 个来自助手**
 * （92%），里面混着"接下来测试 R6 的边界情况"这类过程自述，以及被切成片段的 JSON/表格，
 * 那些碎片还会因为命中"必须"被置成 pin=1 的约束、永不回收。
 *
 * DSH 的会话结构是「一条用户消息 + 几十条助手步骤」，所以：
 *   - **约束 / 决策只从用户消息抽** —— 这是"人定的规矩"，助手复述不算；
 *   - **进度**两个来源都要（助手才知道做完没），但助手来源**不置 pin**。
 * 精度优先：宁可少抽一条，不可把噪声钉成永久约束。
 */
const ALLOWED = {
  user: new Set(['constraint', 'decision', 'progress']),
  assistant: new Set(['progress']),
}

/** 单条节点内容的上限（字符）。超过就截断——投影里不需要整段论述。 */
const MAX_CONTENT_CHARS = 160
/** 单轮最多看多少条消息（只看最近这些，历史早已被压掉的不管）。 */
const MAX_MESSAGES = 20
/** 单会话最多保留多少条节点。 */
export const MAX_NODES_PER_SESSION = 24
/**
 * 单轮最多抽多少条约束。约束会被置 `pin=1`（投影优先 + 永不回收），
 * 所以它是唯一需要从源头限量的类型：实测一个 20 条消息的窗口能抽出十几条"含必须/不要"的行，
 * 里面混着标题、给子 agent 的指令、宿主提醒，会把真正的硬约束挤掉且永久占位。
 */
export const MAX_CONSTRAINTS = 8

/**
 * 去掉行首的列表符号 / 引用符号 / 人称前缀 / **本项目自己的类型标签**，留下内容本体。
 *
 * 剥 `约束:` / `决策:` / `进度:` 是必须的（2026-10-29 实测）：渲染出去的行形如
 * `- 进度: xxx`，被读回来再抽一次时，`进度:` 会变成内容的一部分，于是叠成
 * 「进度: 进度: xxx」「进度: 进度: 进度: …」。即使上游已把骨架块当噪声排除，
 * 这里也要兜一道，否则任何引用过骨架文本的场合都会长出这种前缀。
 */
function cleanLine(line) {
  return String(line ?? '')
    .replace(/^\s*(?:[-*+>]|\d+[.)、])\s*/, '')
    .replace(/^\s*(?:用户|助手|你|我)\s*[:：]\s*/, '')
    .replace(/^\s*(?:约束|决策|进度)\s*[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 明显不是「会话状态」的行，直接跳过（精度优先）。
 * 实测这些形态会大量误入：markdown 标题、给子 agent 的指令、"上一步工具…"这类宿主提醒。
 */
function isNotStateLine(line) {
  if (/^#/.test(line)) return true // markdown 标题
  if (/^\*\*[^*]{1,20}\*\*\s*[:：]/.test(line)) return true // 纯标签行：`**软件架构师**：…`
  if (/^\(/.test(line)) return true // 括号开头的宿主/工具提醒：(上一步工具…)
  if (/上一步工具|可能未完成|先确认状态再继续/.test(line)) return true
  if (/^https?:\/\//.test(line)) return true // 裸链接
  return false
}

/**
 * 机械分类：把一段文本切成候选节点（纯函数，不碰库、不调模型）。
 * @param {string} text
 * @returns {Array<{kind: string, content: string}>}
 */
export function classifyText(text) {
  const out = []
  for (const rawLine of String(text ?? '').split(/\n+/)) {
    // 句读也切开：一行里常同时挂着"约束+进度"，切句后各自归类更准
    for (const piece of rawLine.split(/(?<=[。！？；;!?])/)) {
      const line = cleanLine(piece)
      if (line.length < 6 || line.length > 400) continue
      // 引用/代码行不算：整行被反引号包住的、明显是命令或路径的
      if (/^`.*`$/.test(line)) continue
      if (isNotStateLine(line)) continue
      for (const m of MARKERS) {
        if (m.re.test(line)) {
          out.push({ kind: m.kind, content: line.slice(0, MAX_CONTENT_CHARS) })
          break // 一条话只归一类（约束优先，MARKERS 已按优先级排序）
        }
      }
    }
  }
  return out
}

/**
 * 从转录里抽节点（纯函数）。
 * @param {Array<{role: string, text: string}>} messages readTranscript 的产物
 * @param {{maxMessages?: number, maxNodes?: number}} [opts]
 * @returns {Array<{kind: string, content: string, hash: string, pin: number}>}
 */
export function extractNodes(messages, { maxMessages = MAX_MESSAGES, maxNodes = MAX_NODES_PER_SESSION, maxConstraints = MAX_CONSTRAINTS } = {}) {
  const tail = Array.isArray(messages) ? messages.slice(-maxMessages) : []
  const seen = new Set()
  const nodes = []
  let constraints = 0
  // 从最新往旧走：新信息优先占位，旧约束在超限时才被牺牲
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const role = tail[i]?.role === 'assistant' ? 'assistant' : 'user'
    const allowed = ALLOWED[role]
    for (const item of classifyText(tail[i]?.text)) {
      if (!allowed.has(item.kind)) continue
      // 约束置 pin、永不回收，所以必须**从源头限量**：一轮会话里真正的硬约束不会超过这个数
      if (item.kind === 'constraint') {
        if (constraints >= maxConstraints) continue
        constraints += 1
      }
      const hash = sha1(`${item.kind}\u0000${item.content}`)
      if (seen.has(hash)) continue
      seen.add(hash)
      // 只有**用户来源**的约束才置 pin：助手的过程自述不该是永久约束
      nodes.push({ ...item, hash, role, pin: item.kind === 'constraint' && role === 'user' ? 1 : 0 })
      if (nodes.length >= maxNodes) return nodes
    }
  }
  return nodes
}

/**
 * 落库（幂等）：同一会话内 (kind, content_hash) 唯一。
 * 已存在只刷新 updated_at —— 重复说不改变节点内容，但能让它"仍然有效"。
 * @returns {{added: number, refreshed: number}}
 */
export function upsertNodes(store, { sessionId, nodes, now = Date.now() }) {
  if (!sessionId || !Array.isArray(nodes) || nodes.length === 0) return { added: 0, refreshed: 0 }
  const db = store.db
  let added = 0
  let refreshed = 0
  const exists = db.prepare('SELECT 1 AS hit FROM nodes WHERE id = ?')
  const stmt = db.prepare(
    `INSERT INTO nodes (id, session_id, kind, content, content_hash, pin, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(session_id, kind, content_hash) DO UPDATE SET updated_at = excluded.updated_at`,
  )
  // 一批走一个事务：这是 turn-stopping 热路径，24 条各自 autocommit 是不可接受的开销
  db.exec('BEGIN')
  try {
    for (const node of nodes) {
      const id = sha1(`${sessionId}\u0000${node.kind}\u0000${node.hash}`).slice(0, 16)
      const hit = exists.get(id)
      stmt.run(id, sessionId, node.kind, node.content, node.hash, node.pin ?? 0, now, now)
      if (hit) refreshed += 1
      else added += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已在事务外 */
    }
    throw error
  }
  return { added, refreshed }
}

/**
 * 读某会话的 active 节点。
 *
 * 排序键必须是**全序**（pin → created_at → id）：同一次 upsert 写入的节点 created_at 完全相同，
 * 没有 id 兜底时「选哪几条」由实现细节决定，同一图状态能投影出不同字节（实测踩过）。
 *
 * **不按条数静默截断**（踩过两次）：第一版 `LIMIT 24`，30 条 pin 约束只进去 19 条、其余无声消失；
 * 改成 `LIMIT 192` 只是把阈值挪远（250 条时仍丢 58 条且不计数）。现在默认取全量，
 * 只留一个 `SAFETY_CAP` 防病态数据，且真的超了会把 `truncated` 报给调用方用于留痕。
 * 真正的约束应该是 token 预算，不是条数。
 */
export const SAFETY_CAP = 1000

export function loadNodes(store, sessionId, { limit = SAFETY_CAP } = {}) {
  if (!sessionId) return []
  const rows = store.db
    .prepare(
      `SELECT id, kind, content, content_hash, pin, created_at FROM nodes
        WHERE session_id = ? AND status = 'active'
        ORDER BY pin DESC, created_at DESC, id ASC LIMIT ?`,
    )
    .all(sessionId, limit)
  if (rows.length < limit) return rows
  // 触碰上限：如实报告，别让调用方以为拿全了
  const total = Number(store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE session_id = ? AND status = 'active'").get(sessionId)?.n ?? 0)
  if (total > rows.length) Object.defineProperty(rows, 'truncated', { value: total - rows.length, enumerable: false })
  return rows
}

/**
 * 确定性投影行（**纯函数，同一组节点必得同一输出**）。
 *
 * 排序键是**全序**：pin → kind 秩 → content_hash → id。
 * 刻意不把 importance/时间戳放进排序键——那会让同一图状态在不同时刻渲染出不同字节，
 * 从而每轮都触发宿主追加运行时快照（这正是 inject.js 顶部那段注释要防的事）。
 */
export function nodeLines(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return []
  return [...nodes]
    .sort((a, b) => {
      const pinDiff = Number(b.pin ?? 0) - Number(a.pin ?? 0)
      if (pinDiff !== 0) return pinDiff
      const rankDiff = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
      if (rankDiff !== 0) return rankDiff
      const hashDiff = String(a.content_hash ?? '').localeCompare(String(b.content_hash ?? ''))
      if (hashDiff !== 0) return hashDiff
      return String(a.id ?? '').localeCompare(String(b.id ?? ''))
    })
    .map((n) => `- ${KIND_LABEL[n.kind] ?? n.kind}: ${String(n.content ?? '').replace(/\s+/g, ' ').trim()}`)
}

/**
 * 回收：按会话保留上限删除未 pin 的旧节点（pin 的永不删除，对齐 soul 的 /mem prune）。
 * 只删本表的派生态，不碰 units。
 */
export function pruneNodes(store, { sessionId = null, keep = MAX_NODES_PER_SESSION } = {}) {
  const db = store.db
  const where = sessionId ? 'session_id = ? AND pin = 0' : 'pin = 0'
  const args = sessionId ? [sessionId] : []
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(...args)?.n ?? 0)
  if (total <= keep) return { pruned: 0 }
  // 全序：updated_at 同批写入时完全相同，没有 id 兜底就删得不稳定
  const victims = db
    .prepare(`SELECT id FROM nodes WHERE ${where} ORDER BY updated_at ASC, id ASC LIMIT ?`)
    .all(...args, total - keep)
  const del = db.prepare('DELETE FROM nodes WHERE id = ?')
  // 删节点同时清掉指向它的边，避免 node_edges 攒孤儿
  const delEdge = db.prepare('DELETE FROM node_edges WHERE from_id = ? OR to_id = ?')
  db.exec('BEGIN')
  try {
    for (const v of victims) {
      del.run(v.id)
      delEdge.run(v.id, v.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已在事务外 */
    }
    throw error
  }
  return { pruned: victims.length }
}

/** 给 mem_status / 面板用的计数。 */
export function skeletonStats(store, sessionId = null) {
  const db = store.db
  const scope = sessionId ? 'WHERE session_id = ?' : ''
  const args = sessionId ? [sessionId] : []
  const row = db.prepare(`SELECT COUNT(*) AS nodes FROM nodes ${scope}`).get(...args)
  const byKind = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM nodes ${scope} GROUP BY kind`)
    .all(...args)
  const edges = db.prepare('SELECT COUNT(*) AS n FROM node_edges').get()
  return {
    nodes: Number(row?.nodes ?? 0),
    byKind: Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)])),
    edges: Number(edges?.n ?? 0),
  }
}
