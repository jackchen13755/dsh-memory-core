# dsh-memory-core

DeepSeek Harness 的长期记忆插件：**四通道检索 + 演化闭环 + 分层治理**，目标是完整替代 `dsh-memory-evolve` 的**记忆 / 待办 / 技能**三域后将其卸载。

> 当前状态：**M4 已完成**（待办四轨 / 技能索引与管理 / 技能自进化审查）；**M3 已完成**（写入接管 / 会话结束自动提取 / 修改与版本 / 提示词管理器 / 演化 / 宿主 HTTP API / Web 面板客户端半边）。
> ⚠️ **Web 面板（记忆 Tab + 🔴 红点）需要重启一次 dsh 才生效**：`client-modules` 按**启动时的 bundle 快照**组合客户端模块，运行时新装的包不会进图（后端 API 已即时可用，不受影响）。
> 支持的 dsh：**≥ 0.1.5-rc.1**（本机实测 0.1.5-rc.1 = npm `latest`；工具、提示词段、写入与提取均已活体验证）。

## M3 已交付（写入 · 提取 · 修改）

```sh
node bin/mem.js write "<内容>" [--track key] [--kind rule] [--cwd <项目路径>] [--direct]
node bin/mem.js review list|approve|reject|archive <id[,id]> [--track key] [--content "<改后文案>"]
node bin/mem.js review sweep [--days 14]      # 超期建议自动归档
node bin/mem.js update <id> [--content "…"] [--track key] [--action archive|restore|pin|unpin]
node bin/mem.js extract                       # 会话提取账本（游标/空闲/上次提取时间）
node bin/mem.js extract --session <id> --show # 离线会话：读回 zstd 多帧日志 + 预览提取提示词
```

模型侧工具（共 8 个）：`mem_search` · `mem_get` · `mem_diag` · `mem_status` · **`mem_write`** · **`mem_update`** · **`mem_review`** · **`mem_extract`**。

| 能力 | 行为 |
|---|---|
| **写入分轨** | 规则/偏好/关键事实 → **待确认队列**（人工采纳后才注入）；项目/每日**进展** → 直写 |
| **隐私拦截** | 密钥/token/私钥/密码/JWT 形态**直接拒写**（9 类正则，回报命中的模式名） |
| **写入前比对** | 先检索 + 相似度判定：`duplicate`（返回既有 id）/ `update` / `related` / `unrelated` |
| **会话结束自动提取** | 空闲（默认 3 分钟）/ 长会话兜底（30 分钟且新增 ≥2 轮）/ 压缩前 / 退出前排空；按会话游标断点续做；**产物 100% 进待确认队列（零直写）** |
| **离线补做** | 会话日志是**多帧 zstd**，本插件自实现帧切分逐帧解压，重启后也能读回转录（不依赖任何外部依赖） |
| **提取铁律** | 显式 `reasoningEffort: off` + `maxTokens: 8000`；失败保留原始输出前缀、计数、连续 3 次失败自动降级停抽 |
| **修改与版本** | `mem_update` 改文案/改轨/改 kind；每次修改 `version++` 且旧版本进 `unit_history`；归档（软删）/恢复/pin |

## 提示词管理器（M3 追加模块，语义参考 dsh-memory-evolve）

```sh
node bin/mem.js prompts list [--all] [--category 评审] [--q 关键词]   # 库（默认只列启用）
node bin/mem.js prompts show <id|名称>          # 详情（含正文与注入状态）
node bin/mem.js prompts add --name "X" --summary "一句话" --category 开发 --body "正文"
node bin/mem.js prompts edit <id> [--body "…"] [--category …] [--tag a,b]
node bin/mem.js prompts enable|disable <id>
node bin/mem.js prompts inject <id|名称> [--rounds 1] [--every 1] [--session <id>]
node bin/mem.js prompts active [--session <id>]   # 活跃注入
node bin/mem.js prompts stop <注入id>|--all       # 停止注入
node bin/mem.js prompts render [--session <id>]   # 预览"本轮该出现"的段文本
node bin/mem.js prompts seed                      # 写入种子库（8 条：Spec/评审/调试/安全/重构/测试/性能/交付自检）
node bin/mem.js prompts import --from <旧 prompts.json>   # 从旧插件导入
```

模型侧工具 **`mem_prompts`**：`list / get / create / update / enable / disable / delete / inject / stop / categories / seed`。

| 能力 | 行为 |
|---|---|
| **库** | CRUD + 分类（9 个内置 + 自定义，删分类自动把条目移到「临时」）+ 标签 + 搜索 + 启用开关 + 使用统计 |
| **注入轨** | 一次性（`--every 0` 或 `--rounds 1`）/ 持续（`--rounds 0`，直到手动停止）/ 次数×间隔（`--rounds 3 --every 5`）；`countdown=0` 表示本轮该出现 |
| **推进** | `agent/turn-stopping` 每回合推进（**subagent 不消耗次数**）；出现轮消耗一次，等待轮递减 |
| **作用域** | 注入可绑定单个会话（`--session`），缺省全局 |
| **段渲染** | 只在"该出现"的回合输出 `【用户规则（必须遵循）】`；**文案是给模型的指令，不暴露机制** |
| **变量** | `{{date}}` / `{{time}}` 展开；**残留 `{{x}}` 会被拆成 `{x}`**——宿主模板渲染器遇到未注册变量会直接抛异常，整轮注入都会失败 |
| **立即生效** | `mem_prompts inject --immediate` 或 CLI 注入后，向目标会话发 next-step 插话，模型本回合内再走一步即可看到 |

## 演化与宿主 API（M3）

```sh
node bin/mem.js evolve [--halfLife 30] [--archiveBelow 0.15] [--json]   # 跑一次演化巡演
curl http://127.0.0.1:3080/memory-core/api/badge                        # 红点计数
curl http://127.0.0.1:3080/memory-core/api/status                       # 健康度 + 提取 + 演化
curl "http://127.0.0.1:3080/memory-core/api/suggestions?status=pending" # 待确认队列
curl -X POST -d '{"id":"<id>","overrides":{"track":"key"}}' -H 'content-type: application/json' \
     http://127.0.0.1:3080/memory-core/api/suggestions/approve
```

| 过程 | 行为 | 兜底/边界 |
|---|---|---|
| **强化** | 按 `recall_log` 给"真正被取回过"的条目加权；同批召回建 `coRetrieval` 边 | 只看 72 小时内证据；异常整步回滚 |
| **衰减** | importance 按半衰期指数下降，低于阈值转 `archived`（**只归档不删除**，pin 豁免） | **30 天宽限期**：新建/刚导入的记忆不参与（首次巡演不能把历史资产判死） |
| **调和** | 重叠系数 ≥0.82 的近似重复 → 旧的标 `superseded` + 版本链；数字不同 → 判冲突，**成对保留** + `contradicts` 边 | 无 LLM 的启发式；不做物理删除 |
| **抽象** | 同轨同作用域成簇（默认 ≥12）→ LLM 汇总成 `kind=abstract` 高层条目 | **默认关**；叠加不替换，来源保持 active |
| **看门狗** | 连续 N 轮没写记忆 → 快照置顶提醒，写入即消 | **默认关**（与旧插件一致：根源是模型指令遵循） |

HTTP API（前缀 `/memory-core/api`）：`status` · `badge` · `suggestions{,/approve,/reject,/archive}` · `extract` · `prompts{,/active,/inject,/stop}` · `memory{,/get,/update}` · `evolution`。无 `webServer` 服务时整体跳过（headless 安全）。

## M5 跨设备同步（变更日志 + git）

SQLite 是二进制事实源、无法三方合并 → 把"历史"单独装进**每设备一个只追加文件**
`changes/changes-<deviceId>.jsonl`：多设备各自追加自己的文件，**git 永不冲突**，git 只搬日志不搬库。

```sh
node bin/mem.js sync export   # 追加本设备增量 → changes-<device>.jsonl
node bin/mem.js sync import   # 应用对端日志（lamport LWW；冲突双留）
node bin/mem.js sync status   # 设备 / lamport / 待导出 / 各设备文件行数
```

| 语义 | 行为 |
|---|---|
| 合并 | 条目级 lamport + **LWW**（同 lamport 比对内容） |
| 冲突 | **双留**：本地保留，对端版本另存为新条目（副本 id 只由内容推导 → 双方收敛）+ `contradicts` 边 + 待确认建议，**绝不静默覆盖** |
| 幂等 | 重复导入不产生副本（同 lamport 同内容 = 已收敛） |
| 时钟 | 收到远端 t 后本地时钟 `max(本地, t)`（Lamport 规则）——否则"只导入不写入"的设备会用过期时钟改条目，更晚的编辑反被 LWW 判负 |
| 实体 | unit / todo / skill 三类都随日志走 |

**双机演练**（`test/sync.test.js`，两台设备共用日志目录）：各自新增 → 互导后内容集合一致；重复导入幂等；
同 lamport 并行编辑 → 冲突双留且两边集合仍一致；lamport 大者胜；待办随日志同步。

## M5 图通道（C4 · PPR）

词面检索补不上的那一类，交给**关联图**：种子取词法/稀疏通道前 8 名，沿 `edges`
（`coRetrieval` 同批召回 / `association` 关联 / `derivedFrom` 派生；`contradicts` 作弱负权重）
做个性化 PageRank（阻尼 0.85，12 轮），只补"新面孔"（种子自身不重复给出），
再以权重 0.6 并入 RRF 总榜——**不占基线保底席位**，所以不会挤掉词面证据。

| 项 | 值 |
|---|---|
| 默认开关 | 开（`channels.graph.enabled`，可配 `damping / iterations / seedCount / minEdges`） |
| 冷启动 | 记忆量 < 50 条时跳过；关联边 < 20 条时跳过并给出原因（不硬凑结果） |
| 邻接表缓存 | 按 `store.stamp()` 缓存，写入即失效（不每次全表扫边） |
| 真库实测 | 84 条关联边 / 63 条有邻居；Top1 命中来源 `lexical+sparse+granularity+graph` 四通道 |
| 验收（只增不减） | 标注集 top-5 **87.5%**（开）= **87.5%**（关，`eval/run.js --no-graph`）✅ |

## M4 待办与技能

| 能力 | 工具/命令 | 与旧插件的关系 |
|---|---|---|
| 待办四轨（life / work / project 按 cwd / daily 按日期） | `mem_todo`、`mem todo …` | 动作词汇与视图语义**逐条对齐**旧 `dtodo`：默认智能视图（逾期/今日到期/本项目/重要紧急，≤8 条）、`all` 看全部、`past`+`expired` 查过往 |
| 待办落盘格式 | 快照 `TODOS-*.md` / `daily/<日期>.todo.md` / `projects/<hash>/TODOS.md` | 与旧插件同款 `[时间] [id: …] [q1] [due: …] [status: …] [cat: …]`，**旧解析器能读回**（有测试钉住） |
| 模型自建待办 | `mem_todo suggest` | 零直写：进待确认队列，采纳才落库 |
| 技能索引与管理 | `mem_skill`、`mem skill …` | 文件是真相（`~/.agents/skills/<name>/SKILL.md`），库只做索引；启停落地为**官方 frontmatter** `disable-model-invocation` |
| 技能自进化审查 | 提取链路里的 `skills` 字段 | 与记忆提取**同一次 LLM 调用**（不额外烧 token）；候选仍走待确认队列，人工采纳才写技能库 |

CLI：`mem todo list|add|done|update|remove|remind|stats|export`、`mem skill list|read|enable|disable|scan|pending`。

## Web 面板（客户端半边）

一个会话页 Tab「记忆」（`conversation.view` 槽位，order 15），标签带 🔴 待确认角标（30 秒轮询 `/badge`，计数变化即重注册 label）：

子 Tab：`待确认 / 待办 / 技能 / 提示词 ‖ 长期记忆 · 用户档案 · 项目关键记忆 · 项目日志 · 每日日志`

| 区块 | 操作 |
|---|---|
| 待确认队列 | 逐条 **采纳（可改轨）/ 拒绝 / 归档** |
| 待办 | 需要关注 / 全部切换 + **完成 / 进行中 / 删除** |
| 技能 | 搜索 + **启用 / 禁用**（写官方 frontmatter `disable-model-invocation`） |
| 提示词 | **注入一次 / 持续注入 / 停止** |
| 最近记忆 | 展开全文 / **置顶 · 取消置顶** / 归档 |

产物形态与官方客户端插件一致（**无需构建**）：`window.__ModuleLoader__.load({ id, factory: (require) => exports })`，
只 `require` 白名单模块（`react` 等），清单在 `package.json` 的 `dsh.client`（`platform: web`）。
`test/client.test.js` 钉住信封形态、白名单与槽位契约，防产物漂移。

## M3 验收证据（截至本期）

| 项 | 结果 |
|---|---|
| 单测 | `node --test test/` **96 项全绿**（记忆 45 + 提示词 8 + 演化 9 + API 7 + 客户端 4 + 待办/技能 11 + 技能候选 3） |
| 活体工具 | registry 确认 **9 个 `mem_*` 工具** |
| 写入闭环 | CLI 写入 → 进队列 → 改轨后采纳 → **下一轮常驻段即出现该条**（实测：该条随即出现在常驻段） |
| **注入轨闭环** | CLI 注入一条演示规则 → **下一轮运行时上下文出现 `【用户规则（必须遵循）】`，模型按规则执行**（实测） |
| 注入推进 | 一次性注入在回合结束后自动消耗移除；间隔注入按 `every` 只在出现轮渲染；持续注入需手动停止 |
| 离线提取 | 真实会话日志 14907 帧 / 21559 事件 → 转录 8 条消息 → 提示词构建成功（`effort=off maxTokens=8000`） |
| **演化实测** | 真库 237 条：强化扫描 94 条召回记录 → 加权 94、建 87 条关联边；调和 1 对判冲突；衰减宽限期生效（0 归档） |
| **宿主 API** | 运行中的 dsh 上 `curl` 实测：`/status` 返回宿主版本与能力、`/badge`、`/prompts`、`/suggestions`、`/memory` 全部 200 |

## 注入设计（M2）

| 段 | 内容 | 预算 | 触发 |
|---|---|---|---|
| **常驻段** `memory-core:resident` | ① 规则/偏好类记忆（`kind ∈ {rule, preference}` 或 pin）② **索引目录**（未常驻条目的一行标题，按 key→memory→user→project→daily 排优先级，daily 限量） | ≤1200 token（实测 **1055**） | 每步组装；内容不变则零成本 |
| **按轮卡片** `memory-core:recall` | 用**本轮用户消息**检索，证据达标才注入 ≤3 张卡片（id + 摘要 + `mem_get` 提示） | ≤400 token（实测 **253**） | 每轮一次；同轮内保持稳定，跨轮按 id 去重，连续 5 轮无命中停止 |

> 关键机制：dsh 的运行时快照**按内容去重**——文本不变就不会追加消息；且提示词组装发生在
> `agent/pre-step` **之前**，所以按轮卡片的 query 由 `session/event` 的 `user/message` 先缓存。

## M2 验收证据（2026-09-15）

| 项 | 结果 | 目标 |
|---|---|---|
| 常驻段 token | **1055** | ≤1200 ✅ |
| 按轮卡片 token | **253**（3 张） | ≤400 ✅ |
| 标注集 top-5 命中率 | **87.5%** | ≥80% ✅ |
| 检索延迟 | p50 1 ms · p95 12 ms | ≤150 ms ✅ |
| 同轮渲染稳定性 | ✓ 同一 query 多次组装文本一致（不抖动） | 必须 |
| 活体 | 常驻段已在运行中的 dsh 上下文里出现（规则块 + 目录 40 行） | 必须 |
| 单测 | `node --test test/` **33 项全绿** | — |

## 兼容性（最新版 dsh）

只用官方文档化的扩展点，且全部"探测 + 降级"，**插件任何故障都不阻断宿主启动**：

| 接法 | 说明 |
|---|---|
| `ctx.inject(['tools'], cb)` | 工具注册。**不依赖模块级 `export const inject`**——`loader.create`（热注入）路径下 loader 只读 entry options 的 inject，静态导出不会被采纳，会报 `cannot get property "tools" without inject` |
| `ctx.get(name)` | 能力探测（systemPrompt / commands / llm / webserver）。**不能写 `ctx.tools` 这种属性访问**：cordis 对未声明 inject 的服务直接抛异常 |
| 原始 JSON Schema 工具定义 | 不 import `@deepseek-ai/dsh-tools`（零依赖），契约按 0.1.5-rc.1 的 `tools.register`：`name/description/parameters/output{schema,render}/execute` |
| 不声明 `peerDependencies` | 避免 pnpm 安装期拉依赖/触发构建脚本授权；兼容范围写在 `package.json` 的 `dsh.supported` |

## 用法（M1）

```sh
node bin/mem.js search "<查询>"    # 四通道召回（C1 词法 + C2 稀疏语义 + C3 多粒度/熵路由 + RRF 融合）
node bin/mem.js search "<查询>" --raw   # 只看 C1 原始词法
node bin/mem.js diag "<查询>"      # 归因：各通道原始列表 + 融合 + 保底席位 + 证据判定
node bin/mem.js status            # 库状态 / 完整性 / 备份新鲜度 / 项目反查
node bin/mem.js import            # 从 ~/.dsh/memories 一次性迁移（只读源目录，可重复执行）
node bin/mem.js export --dir <快照目录>   # 导出 Markdown 快照（人读/grep/备份）
node bin/mem.js verify            # 与旧库对账 + 导出往返字节比对
node bin/mem.js backup            # 每日 VACUUM INTO 备份，默认保留 7 份
node bin/mem.js restore --from <快照目录> --db <新库>   # 灾备重建演练
node eval/run.js                  # 标注集评测（命中率 / 注入预算 / 延迟）
node --test test/                 # 单测
```

事实源：`$DSH_HOME/memory-core/mem.db`（SQLite + WAL）；备份 `backups/mem-YYYYMMDD.db`；快照默认 `snapshots/`。

模型侧工具（dsh 里）：`mem_search` · `mem_get` · `mem_diag` · `mem_status`。

## M1 验收证据（2026-09-15）

| 项 | 结果 |
|---|---|
| 标注集（24 条自然语言查询，刻意与条目用词不一致） | **top-5 命中率 87.5%**（目标 70%）✅ |
| 延迟 | p50 **1 ms** · p95 **12 ms**（预算 150/300 ms） |
| 基线保底 | 最终 top-k 至少一半席位留给 C1+C2，增强通道只补位与重排 |
| 降级 | 冷启动 / 通道异常 / 超预算 / 语料超限均有退路，`diag` 可见 |
| 活体注册 | 在运行中的 dsh 0.1.5-rc.1 里注入后，registry 确认 `mem_search/mem_get/mem_diag/mem_status` 四个工具 |
| 单测 | `node --test test/` 26 项全绿 |

## M0 验收证据（2026-09-15，本机真数据）

| 项 | 结果 |
|---|---|
| 迁移 | 236 条记忆（memory 19 / user 3 / key 15 / project 104 / daily 95）+ 11 个技能索引，**0 错误** |
| 项目反查 | 6 个 `projects/<sha1(cwd)>` 目录全部还原出真实 cwd |
| **零丢失往返** | 导出后与旧文件逐字比对：**24/24 文件字节完全一致** |
| 幂等 | 重复导入全部 skipped，无重复条目 |
| 灾备 | 每日备份可打开；从快照重建 236 条 + 11 技能，`quick_check` ok |
| 检索 | C1 词法在真数据上命中"现成工具"类记忆（设计稿链路 / 缺陷系统 CLI / 组件复用约定） |
| 单测 | `node --test test/` 20 项全绿 |

## 设计要点（v2）

- **存储**：SQLite 单一事实源（`node:sqlite` + WAL）+ **Markdown 快照导出**（人读 / grep / 备份 / 灾备重建）
- **同步**：文本变更日志（每设备一个只追加 JSONL，git 可合并）+ lamport 时钟 LWW + 冲突双留
- **检索**：C1 FTS5 词法 ∥ C2 稀疏语义（元数据加权）∥ C2' 可选稠密 ∥ C3 多粒度（熵路由）∥ C4 图扩展（PPR），RRF 融合 + **基线保底** + 逐级降级 + 延迟预算
- **注入**：常驻段只放规则类 + 索引目录（≤1200 token）；事实类按轮召回**卡片**（≤3 张 / ≤400 token，正文按需 `mem_get`）
- **会话结束自动提取**：会话空闲（默认 3 分钟）/ 退出前 / 压缩前自动提取 → **一律进待确认队列**（零直写）→ 记忆 Tab 红点角标 + 面板「待确认」可**改轨后采纳 / 合并进既有 / 拒绝**（参考 dsh-memory-evolve 的做法）
- **可修改**：`mem_update` 改文案 / **改轨** / 改 kind / 元数据，版本留痕（`unit_history`），归档 / 恢复 / pin，编辑**下一轮即生效**
- **演化**：关联 · 调和 · 强化 · 衰减归档 · 抽象 · 重关联 · 分支校正 · 同步收敛
- **成本**：每轮零 LLM 调用（自动蒸馏默认关）；LLM 只用于演化与可选查询扩展
- **铁律**：结构化输出的 LLM 调用必须显式声明推理档位 + 充足预算 + 失败留痕 + 失败可见（教训来自 dsh-memgas issue #1）

## 里程碑

| 里程碑 | 内容 | 关键验收 |
|---|---|---|
| M0 | 骨架 + **迁移导入器** + 快照导出 + 每日备份 | 230 条旧记忆 + 待办 + 技能全部入库，hash 全量比对通过 |
| M1 | 索引 + 召回（`mem_search` / `mem_diag`） | 标注集 top-5 ≥ 70%，归因可解释 |
| M2 | 注入 + 评测 | top-5 ≥ 80%；常驻 ≤1200 / 按轮 ≤400 token；p95 ≤150 ms |
| M3 | 写入接管 + **会话结束自动提取 → 待确认** + 待确认面板与红点 + 修改与版本 + 演化 | 空闲 3 分钟内完成提取；候选**零直写**；页面 ≤30 s 可见且可改轨采纳；异常退出后**零丢区间** |
| M4 | 待办 + 技能模块 | 与旧数据逐条对齐；技能禁用与官方 frontmatter 一致 |
| M5 | 图通道 + 三个面板 + 跨设备同步 | 图通道"只增不减"；双机同步与卸载演练通过 |

## 工具面（规划）

```text
记忆：mem_search · mem_get · mem_write · mem_status · mem_diag
待办：mem_todo (add|list|done|update|remove)
技能：mem_skill (list|read|create|update|enable|disable|pending)
```

## 参考

- [dsh-memgas](https://github.com/quqxui/dsh-memgas) —— 四通道检索 / RRF / 演化过程的来源
- [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) —— 五轨分层 / 确认制 / 归档 / 同步的成熟实践

## License

MIT（LICENSE 待补）
