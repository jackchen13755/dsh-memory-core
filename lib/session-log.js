/**
 * 会话日志读取（设计 §5.3 的"零丢区间"补做路径）。
 *
 * dsh 把会话日志落成 **多帧 zstd 追加**的 `session.jsonl.zstd`：每帧一个 zstd frame，
 * 单帧解压只能拿到第一段。这里实现帧边界解析（zstd 帧头 + block 头），逐帧解压，
 * 于是离线会话也能在插件里读回转录 —— 不依赖任何外部依赖。
 *
 * 帧格式（RFC 8878 摘要，只做边界计算，不做完整解码）：
 *   magic(4) | frame_header_descriptor(1) | [window_descriptor(1)] | [dict_id(0/1/2/4)]
 *   | [frame_content_size(0/1/2/4/8)] | blocks... | [checksum(4)]
 *   block: 3 字节头（last 1bit + type 2bit + size 21bit）+ payload（RLE 为 1 字节）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from './paths.js'

const ZSTD_MAGIC = 0xfd2fb528

/** 会话日志根目录：`$DSH_HOME/sessions/<mangled-cwd>/<session-id>/session.jsonl.zstd`。 */
export function sessionsRoot(env = process.env) {
  return join(dshHome(env), 'sessions')
}

/** 定位某个会话的日志文件（跨所有工作目录查找）。 */
export function findSessionLog(sessionId, root = sessionsRoot()) {
  if (!sessionId || !existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, sessionId, 'session.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return null
}

/**
 * 切出缓冲区里所有 zstd 帧（返回 [start, end) 区间）。
 * 遇到不认识的字节就停止，保证坏文件不会死循环。
 */
export function frameRanges(buf) {
  const ranges = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    const start = off
    off += 4
    const descriptor = buf.readUInt8(off)
    off += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) off += 1 // window descriptor
    off += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    off += fcsSize
    // blocks
    for (;;) {
      if (off + 3 > buf.length) return ranges
      const header = buf.readUIntLE(off, 3)
      off += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      if (type === 1) off += 1 // RLE：1 字节
      else if (type === 2 || type === 0) off += size
      else return ranges // reserved
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) return ranges
    ranges.push([start, off])
  }
  return ranges
}

/** 逐帧解压；单帧失败则跳过该帧（宽容坏帧）。 */
export function decompressMultiFrame(buf, { maxFrames = 100000 } = {}) {
  const ranges = frameRanges(buf)
  const parts = []
  let failed = 0
  for (const [start, end] of ranges.slice(0, maxFrames)) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      failed += 1
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: ranges.length, failed }
}

/**
 * 从事件里取"给人看的文本"。
 * 两种形状（实测）：
 *   user/message      → data = { content:[{type:'text',text}], source, role }
 *   assistant/message → data = { turn, step, message:{ role, content:[{type:'reasoning'|'text'|…}] } }
 * 只取 `type: 'text'` 段（reasoning 段不进转录）。
 */
export function textOfMessage(type, data) {
  const raw = type === 'assistant/message' ? data?.message : data
  if (!raw || typeof raw !== 'object') return ''
  if (typeof raw.content === 'string') return raw.content
  if (Array.isArray(raw.content)) {
    return raw.content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

/** 系统注入的提醒块（技能目录、运行时上下文等）不算真人输入。 */
function isNoise(text) {
  const t = String(text ?? '').trimStart()
  return t.startsWith('<system-reminder>') || t.startsWith('【记忆（dsh-memory-core）】') || t.startsWith('Current runtime context')
}

/**
 * 从会话日志文件读回最近若干条真人/助手消息（内存有界：只留环形缓冲）。
 * @returns {{ messages: Array<{seq:number, role:string, text:string}>, events: number, frames: number, truncated: boolean }}
 */
export function readTranscriptFromLog(file, { maxMessages = 40, maxBytes = 32 * 1024 * 1024 } = {}) {
  const size = statSync(file).size
  const truncated = size > maxBytes
  let raw = readFileSync(file)
  if (truncated) {
    // 大文件只取尾部：从最后一个完整的 frame magic 开始（帧尾才是最近的轮次）
    const tail = raw.subarray(size - maxBytes)
    let start = -1
    for (let i = 0; i + 4 <= tail.length; i += 1) {
      if (tail.readUInt32LE(i) === ZSTD_MAGIC) {
        start = i
        break
      }
    }
    raw = start === -1 ? tail : tail.subarray(start)
  }
  const { text, frames } = decompressMultiFrame(raw)
  const ring = []
  let events = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    events += 1
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const source = event.data?.source
    if (source?.kind === 'plugin') continue // 跳过插件注入的运行时快照
    const msg = textOfMessage(event.type, event.data)
    if (!msg || isNoise(msg)) continue
    ring.push({ seq: event.seq ?? events, role: event.type === 'user/message' ? 'user' : 'assistant', text: msg })
    if (ring.length > maxMessages) ring.shift()
  }
  return { messages: ring, events, frames, truncated }
}

/** 从活体会话对象读转录（优先内存态，读不到再落盘文件）。 */
export function readTranscript(session, { maxMessages = 40 } = {}) {
  const events = (() => {
    try {
      return session?.ownEvents?.() ?? session?.events ?? []
    } catch {
      return []
    }
  })()
  const ring = []
  for (const event of events) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
    if (event.data?.source?.kind === 'plugin') continue
    const msg = textOfMessage(event.type, event.data)
    if (!msg || isNoise(msg)) continue
    ring.push({ seq: event.seq ?? 0, role: event.type === 'user/message' ? 'user' : 'assistant', text: msg })
    if (ring.length > maxMessages) ring.shift()
  }
  if (ring.length > 0) return { messages: ring, source: 'live' }
  const id = session?.id ?? session?.header?.id
  const file = id ? findSessionLog(id) : null
  if (!file) return { messages: [], source: 'none' }
  const fromDisk = readTranscriptFromLog(file, { maxMessages })
  return { ...fromDisk, source: 'disk' }
}

/** 转录压成提示词可用的文本（带轮次上限与字符上限）。 */
export function renderTranscript(messages, { maxChars = 12000 } = {}) {
  const lines = messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.text.replace(/\s+/g, ' ').trim()}`)
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(text.length - maxChars)
  return text
}
