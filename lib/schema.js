/**
 * SQLite schema 与迁移（设计 §4.1）。
 *
 * 事实源 = 本库；Markdown 只是快照导出层，因此这里可以放心用列存元数据
 * （不再需要 v1 设计里的侧车文件方案）。
 */

export const SCHEMA_VERSION = 3

const V1 = `
-- 记忆单元：五轨合一张表，靠 track / scope 区分注入与召回策略
CREATE TABLE IF NOT EXISTS units (
  id            TEXT PRIMARY KEY,
  track         TEXT NOT NULL,              -- user | memory | key | project | daily
  scope         TEXT NOT NULL,              -- global | project:<slug>@<hash>
  kind          TEXT,                       -- rule|preference|fact|decision|pitfall|env|progress
  content       TEXT NOT NULL,              -- 条目原文（逐字保留，导出即回放）
  tokens        TEXT NOT NULL,              -- CJK bigram + 标识符（写入时算好，供 FTS5）
  content_hash  TEXT NOT NULL,
  meta          TEXT,                       -- JSON: tags / alias / ent / conf / label
  day           TEXT,                       -- daily 轨：YYYY-MM-DD
  ord           INTEGER,                    -- 源文件内原始顺序（导出按它回放，保证字节级往返）
  source_file   TEXT,                       -- 导入来源（快照路径），便于对账
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  git_branch    TEXT,
  importance    REAL NOT NULL DEFAULT 0.5,
  pinned        INTEGER NOT NULL DEFAULT 0,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | superseded | archived
  superseded_by TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  lamport       INTEGER NOT NULL DEFAULT 0,       -- 同步逻辑时钟
  origin        TEXT                              -- session:<id>#<seq> | import | tool | ui
);
CREATE INDEX IF NOT EXISTS units_scope  ON units (scope, track, status);
CREATE INDEX IF NOT EXISTS units_kind   ON units (kind, pinned);
CREATE UNIQUE INDEX IF NOT EXISTS units_content_hash ON units (content_hash, track, scope);

-- 词法索引（C1）。tokens 列由 lib/tokens.js 生成；查询必须 OR 连接（见该文件注释）
CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5 (content, tokens);

-- 向量（C2'/可选本地模型）
CREATE TABLE IF NOT EXISTS vectors (
  id          TEXT NOT NULL,
  embedder_id TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  data        BLOB NOT NULL,
  PRIMARY KEY (id, embedder_id)
);

-- 关联图（C4 图扩展）
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  kind    TEXT NOT NULL,                   -- association|coRetrieval|supersedes|derivedFrom|contradicts
  weight  REAL NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_id);

-- 检索归因留档（"这次为什么召回 / 没召回"）
CREATE TABLE IF NOT EXISTS recall_log (
  ts         INTEGER NOT NULL,
  session_id TEXT,
  query      TEXT NOT NULL,
  unit_id    TEXT,
  channel    TEXT,
  rank       INTEGER,
  score      REAL,
  injected   INTEGER NOT NULL DEFAULT 0,
  reason     TEXT
);
CREATE INDEX IF NOT EXISTS recall_log_ts ON recall_log (ts);

-- 待办（四轨：生活 / 工作 / 项目 / 每日）
CREATE TABLE IF NOT EXISTS todos (
  id         TEXT PRIMARY KEY,
  track      TEXT NOT NULL,                -- life|work|project|daily
  scope      TEXT,                         -- project 轨按 cwd 隔离
  day        TEXT,                         -- daily 轨：YYYY-MM-DD
  content    TEXT NOT NULL,
  quadrant   TEXT,                         -- q1..q4
  due        TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending|doing|done|blocked|cancelled
  category   TEXT,
  important  INTEGER,
  urgent     INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  done_at    INTEGER,
  origin     TEXT,
  lamport    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS todos_view ON todos (track, scope, status, due);

-- 技能索引（技能文件是真相，位于 ~/.agents/skills）
CREATE TABLE IF NOT EXISTS skills (
  name        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  source      TEXT,                        -- user|custom|bundled|project
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  hash        TEXT,
  bytes       INTEGER,
  updated_at  INTEGER,
  last_used   INTEGER
);

-- 统一建议队列（给"待确认"面板用：记忆 / 待办 / 技能）
CREATE TABLE IF NOT EXISTS suggestions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                -- memory|todo|skill
  target     TEXT,                         -- memory 轨或 todo 轨
  payload    TEXT NOT NULL,                -- JSON
  session_id TEXT,
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|archived
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions (status, kind, created_at);

-- 变更日志（跨设备同步载体；changes/*.jsonl 是它的文本投影）
CREATE TABLE IF NOT EXISTS changes (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op        TEXT NOT NULL,                 -- upsert|delete|status
  payload   TEXT NOT NULL,
  device    TEXT NOT NULL,
  lamport   INTEGER NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_entity ON changes (entity, entity_id);

-- 记忆版本历史（「支持修改」：每次编辑留档）
CREATE TABLE IF NOT EXISTS unit_history (
  id        TEXT NOT NULL,
  version   INTEGER NOT NULL,
  content   TEXT NOT NULL,
  meta      TEXT,
  track     TEXT,
  kind      TEXT,
  edited_by TEXT,
  edited_at INTEGER,
  reason    TEXT,
  PRIMARY KEY (id, version)
);

-- 会话（收割游标：会话结束自动提取靠它做断点续做）
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  scope         TEXT,
  ingest_cursor INTEGER,
  last_seen     INTEGER,
  title         TEXT
);

-- 项目目录（旧插件按 sha1(cwd) 分目录，这里显式记 cwd/remote，便于展示与作用域解析）
CREATE TABLE IF NOT EXISTS projects (
  hash       TEXT PRIMARY KEY,
  cwd        TEXT,
  remote     TEXT,
  label      TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 顺序迁移表：index 0 即 schema v1。 */
export const MIGRATIONS = [
  { version: 1, sql: V1 },
  {
    // v2：会话提取的游标与账本（M3）
    version: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN last_extract_at INTEGER;
ALTER TABLE sessions ADD COLUMN turns_processed INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions (last_seen);
`,
  },
  {
    // v3：提示词管理器（库 + 分类 + 注入轨）—— 参考 dsh-memory-evolve 的成熟语义
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS prompts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  summary      TEXT,                      -- 一句话简介（AI 选词时看它）
  category     TEXT,
  tags         TEXT,                      -- JSON 数组
  body         TEXT NOT NULL,             -- 正文（Markdown，可含 {{date}}/{{time}}）
  enabled      INTEGER NOT NULL DEFAULT 1,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  source       TEXT,                      -- seed | user | import
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_category ON prompts (category, enabled);

CREATE TABLE IF NOT EXISTS prompt_categories (
  name       TEXT PRIMARY KEY,
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 注入轨：countdown=0 表示"本轮该出现"；每回合结束由 agent/turn-stopping 推进
CREATE TABLE IF NOT EXISTS prompt_injections (
  id            TEXT PRIMARY KEY,
  prompt_id     TEXT,
  session_id    TEXT,                     -- NULL = 全局（所有会话）
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  rounds_left   INTEGER,                  -- 剩余出现次数；NULL = 无限（持续注入）
  every         INTEGER NOT NULL DEFAULT 1, -- 间隔回合数；1=每回合，0=只出现一次
  countdown     INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_shown_at INTEGER
);
CREATE INDEX IF NOT EXISTS prompt_injections_active ON prompt_injections (active, session_id);
`,
  },
]
