#!/usr/bin/env node
/**
 * M1 标注集评测（设计 §16 M1 验收：top-5 命中率 ≥ 70%）。
 *
 * 用法：
 *   node eval/run.js [--db <路径>] [--k 5] [--json] [--verbose]
 *
 * 指标：top-k 命中率、注入率（证据达标比例）、注入 token 估算、p50/p95 延迟、降级事件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { dbPath as defaultDbPath } from '../lib/paths.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next
        i += 1
      } else out[a.slice(2)] = true
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// 真实标注集（含个人记忆 id 与提问原文）不进仓库：优先本地 labels.local.json
const localSpec = join(here, 'labels.local.json')
const specPath = existsSync(localSpec) ? localSpec : join(here, 'labels.json')
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
console.error(`[eval] 标注集：${specPath.endsWith('labels.local.json') ? '本地真实集（未入库）' : '仓库合成样例'}`)
const topK = args.k ? Number(args.k) : spec.targets.topK
const target = Number(args.hitRate ?? spec.targets.hitRate)

const db = openDb(args.db ?? defaultDbPath())
migrate(db)
const store = new Store(db)
// --no-graph：对照组（用于验收"图通道只增不减"——关掉它命中率不得更高）
const recall = new Recall(store, {
  k: topK,
  ...(args.noGraph === true ? { channels: { graph: { enabled: false, reason: '评测对照（--no-graph）' } } } : {}),
})

const rows = []
let hits = 0
let injectCount = 0
let injectChars = 0
const latencies = []

for (const label of spec.labels) {
  const res = recall.search({ query: label.query, scopes: 'all', k: topK, log: false })
  latencies.push(res.ms)
  const ids = res.hits.map((h) => h.id)
  const hit = label.expect.some((id) => ids.includes(id))
  if (hit) hits += 1
  if (res.evidence.inject) {
    injectCount += 1
    injectChars += res.hits.slice(0, 3).reduce((acc, h) => acc + h.snippet.length, 0)
  }
  rows.push({
    query: label.query,
    hit,
    expect: label.expect,
    got: ids,
    inject: res.evidence.inject,
    reasons: res.evidence.reasons.slice(0, 2),
    degraded: res.degraded,
    ms: res.ms,
    note: label.note,
  })
}

const pct = (n) => `${(n * 100).toFixed(1)}%`
const sorted = [...latencies].sort((a, b) => a - b)
const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

const summary = {
  queries: rows.length,
  topK,
  hitRate: hits / rows.length,
  target,
  pass: hits / rows.length >= target,
  injectRate: injectCount / rows.length,
  injectTokensEstimate: Math.round(injectChars / 3), // 中文约 1 token ≈ 1.5-2 字，取保守 3 字/token
  latency: { p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] },
  missed: rows.filter((r) => !r.hit).map((r) => ({ query: r.query, expect: r.expect, got: r.got.slice(0, 3), note: r.note })),
}

if (args.json) {
  console.log(JSON.stringify({ summary, rows }, null, 2))
} else {
  console.log(`标注集评测：${summary.queries} 条查询 · top-${topK} 命中率 ${pct(summary.hitRate)}（目标 ${pct(target)}）${summary.pass ? '✅' : '❌'}`)
  console.log(`证据达标（可注入）${pct(summary.injectRate)} · 注入 token 估算 ≈ ${summary.injectTokensEstimate}（按每查询前 3 张卡片）`)
  console.log(`延迟 p50 ${summary.latency.p50} ms · p95 ${summary.latency.p95} ms · max ${summary.latency.max} ms`)
  if (args.verbose) {
    console.log('\n逐条：')
    for (const r of rows) {
      console.log(`  ${r.hit ? '✓' : '✗'} [${r.ms}ms${r.inject ? ' · 可注入' : ''}] ${r.query}`)
      console.log(`      期望 ${r.expect.join(',')} → 实得 ${r.got.join(',')}`)
    }
  }
  if (summary.missed.length > 0) {
    console.log('\n未命中明细：')
    for (const m of summary.missed) console.log(`  ✗ ${m.query}\n      期望 ${m.expect.join(',')} → 前三 ${m.got.join(',')}  （${m.note}）`)
  }
}

closeDb(db)
process.exitCode = summary.pass ? 0 : 1
