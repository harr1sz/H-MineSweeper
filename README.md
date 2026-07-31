# H-MineSweeper

<p align="center">
  <img src="./apps/web/public/og.png" alt="H-MineSweeper black and gold game board" width="100%" />
</p>

<p align="center">
  <strong>让每一局，都成为下一局的依据。</strong><br />
  <strong>Build a memory. Train the gap.</strong>
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

---

## 中文

H-MineSweeper 是一个黑金风格的专业单人扫雷训练项目。单人训练是当前唯一主产品；扫雷学院是辅助学习入口；同图实时 1v1 是可以独立关闭的实验功能。

这个仓库仍处于 Phase 0.5，正在建设 `v0.2.0-alpha.N` 公开访问候选版本。公开 Alpha 无账号、访问码、白名单或封闭研究门槛。Phase 1 只有在公开 Alpha 的指标定义、观察窗口和缺失数据规则预先冻结，并由真实公开流量得到足够证据后才算完成；代码合并、CI 通过、Alpha RC 部署或功能数量增加都不等于产品验证完成。

### 当前可以体验什么

| 模式 | 当前能力 | 成绩状态 |
| --- | --- | --- |
| 专业单人训练 | 初级、中级、高级、自定义、经典随机、无猜生成、本地历史与同规格趋势 | `LOCAL_UNVERIFIED`，不进入公开榜 |
| 扫雷学院 | 第 0 至 3 章、分级提示、proof 验证、定式与反例 | 辅助学习结果 |
| 实验 1v1 | 房间码竞速、Bo3、进度对比、即时重赛 | Feature Flag 控制，无正式评级 |

### 单人游戏

- 标准难度为 9×9 / 10 雷、16×16 / 40 雷、30×16 / 99 雷。
- 自定义宽高支持 5 至 100，总格数不超过 10,000。
- 首次揭格保留 3×3 安全区。
- 无猜生成在 Worker 中运行，最多尝试 50 次或 5 秒。生成时间不计入游戏时间。
- 统计面板支持时间、操作数、CPS、3BV、3BV/s、IOE、无效动作和旗标明细。
- 三套棋盘显示方案覆盖舒适、专业和高对比场景。
- 数字、旗帜、雷标和错旗均由 Canvas 矢量绘制，在高级棋盘的小格尺寸下仍保持清楚。

### 扫雷学院

学院不要求玩家背脱离棋形的口诀。每道题都从当前可见状态推导答案。

- 第 0 章：揭格、插旗、和弦和数字含义。
- 第 1 章：剩余雷数、已标雷与矛盾。
- 第 2 章：共有区、独享区和集合包含。
- 第 3 章：1-2-1、1-2-2-1 及其反例。
- H1 至 H7 提示会逐级展开。高级提示来自求解器 proof，不读取隐藏雷图猜答案。
- 课程进度和练习结果保存在本机；当前 Logic Streak 只代表本次页面会话，不宣称跨会话连续记录。

### 实验 1v1

两名玩家在各自界面解决同一张 Expert 无猜棋盘。双方不会抢格，也看不到对方的点击路线。

- 3 秒同步倒计时。
- 三局两胜，平局不计胜局，最多使用五张棋盘。
- 单局上限 180 秒，终局使用 50ms 裁定窗口。
- 对手进度以 10Hz 合并更新。
- 每个测试房间最多使用 15 张不重复棋盘。
- 赛后可以下载 JSON 回放并直接发起重赛。

当前 1v1 使用 `client_seed`。客户端即时展开棋盘，服务端独立复算动作和结果。这套模式适合测试手感，但无法提供正式排行榜所需的反作弊强度。只有协议解码、可靠序号、截止点回滚、Replay 预算和真实双端闸门全部通过时，`duelExperiment` 才能打开；失败时关闭入口，单人 Alpha 继续。

网页入口和服务端传输分别由 `VITE_DUEL_EXPERIMENT` 与
`H_MINESWEEPER_DUEL_EXPERIMENT` 控制。仓库提供的开发与部署配置默认关闭；
只有显式运行 `pnpm dev:duel` 或同时打开两端开关时才启用。服务端关闭时，
guest、room、Replay 和 WebSocket 路径不可用，但公开单人和本地历史继续运行。仅影响 1v1 的事故只关闭 1v1，不暂停健康单人。

### 操作

| 设备 | 揭格 | 插旗 | 和弦 |
| --- | --- | --- | --- |
| 鼠标 | 左键 | 右键 | 中键或左右键组合 |
| 键盘 | Enter / Space | F | C |
| 触屏 | 点击 | 长按 350ms | 点击已揭数字 |

窄屏初级棋盘会完整适配容器；中、高级棋盘在棋盘容器内平移，并提供显式缩放按钮。滑动不会当作揭格。键盘方向键可以移动焦点。

### 本地运行

需要：

- Node.js 22.13 或更高版本
- pnpm 11

安装依赖并启动 Web 与实时服务：

```bash
pnpm install
pnpm dev
```

浏览器打开：

```text
http://127.0.0.1:5173
```

默认实时服务地址为 `http://127.0.0.1:3001`。Vite 会代理 HTTP 和 WebSocket 请求。

如果默认端口已被占用，可以同时修改服务端端口和开发代理：

```bash
H_MINESWEEPER_PORT=3101 \
VITE_DEV_SERVER_URL=http://127.0.0.1:3101 \
pnpm dev
```

其他配置见 [`.env.example`](./.env.example)。

### 公开 Alpha 与遥测边界

公开 Alpha 的产品政策是无访问门槛：全新浏览器应能直接打开首页、进入学院和开始单人游戏，不需要账号、登记或研究同意。仓库实现已移除旧的邀请码访问控制；公开遥测会话只授权偏好与事件接口，不解锁任何产品路由，并固定标记为 `public/unsegmented`。在不可变部署产物通过匿名访问 smoke 前，这些本地实现仍不能作为 M2 Alpha RC 证据。

假名化原始事件和公开会话状态固定保留 7 天，到期删除，不因分析或产品研究延长；去除安装 ID 和单人明细的日聚合最多保留 30 天。用户可以退出遥测并删除仍在保留期内的可归属原始事件，本地历史不受影响。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 并行启动 Web 与实时服务 |
| `pnpm typecheck` | 检查全部 workspace 的 TypeScript |
| `pnpm test` | 运行单元与集成测试 |
| `pnpm build` | 构建三个 workspace |
| `pnpm check` | 依次运行类型检查、测试和生产构建 |

### 工程结构

```text
apps/web             React 19、Vite 8、Canvas 2D、单人游戏与扫雷学院
apps/server          Fastify 5、ws 8、REST、实时网关与房间 Actor
packages/game-core   PRNG、棋盘规则、求解器、协议、统计与 golden vectors
scripts              品牌资产、发布验证、合成探针与回滚校验
```

React 负责菜单、配置面板和结果页。实际扫雷棋盘使用双层 Canvas 2D，基础棋盘与短时特效分开绘制。棋盘状态使用 typed array；普通动作只重绘发生变化的格子。

服务端为每个房间维护单写者 Actor。动作按接收顺序执行，热路径不访问数据库。客户端动作带有幂等 ID、序号和状态哈希；缺失事件可以补发，事件环不足时使用快照恢复。

### 测试与性能

```bash
pnpm check
pnpm --filter @h-minesweeper/web e2e
```

测试覆盖：

- 固定 seed、首击安全、邻雷计数、洪泛、插旗与和弦。
- 无猜求解 proof、3BV、CPS、3BV/s 和 IOE。
- 本地历史 Schema、迁移、幂等写入、导入导出、损坏恢复和同规格趋势。
- 假名化遥测、容量上限、运行时协议解码和可靠序号。
- 双客户端 WebSocket、Bo3 重赛、重复动作、终局竞态和房间回收。
- 浏览器级移动可达性、键盘、200% 缩放、历史恢复和公开入口。
- 棋盘脏格重绘、像素预算和最小格可读性。

浏览器性能样本保存在 `globalThis.__HMS_PERF__`。其中包括输入到下一帧、规则应用、整盘绘制、脏格绘制和特效层帧间隔。这些数据用于本地回归检查，不代表公开 Beta 的跨设备 SLA。

### 当前边界

以下能力尚未实现：

- 2 至 10 人房间与重连。
- OIDC 账号、匹配、Glicko-2 评级和赛季。
- `server_secret` 正式棋盘与一次性棋盘库存。
- 账号/云同步历史、持久化多人回放和公开排行榜。
- 举报、隔离复核与申诉流程。

正式排位不会直接沿用当前 `client_seed` 模式。它需要服务器保密雷图、完整权威回放和经过验证的延迟公平性。

### 当前阶段路线

1. M0：统一阶段事实、仓库维护面和 320–390px 棋盘可达性。
2. M1：完成“终局—本地历史—同规格趋势—调整下一局”的专业单人闭环。
3. M2：完成无门槛公开访问、容量/协议/回滚闸门和单区域 Alpha RC。
4. 公开 Alpha 验证：预先冻结指标、观察窗口和缺失数据规则，使用真实公开流量决定扩大、聚焦修订或停止；不设置封闭样本或预定人数。

详细定义见 [`docs/product-phase-and-release-policy.md`](./docs/product-phase-and-release-policy.md)。

### 许可证

H-MineSweeper 使用 [MIT License](./LICENSE) 开源。欢迎提交 issue 和外部 PR；提交不代表自动接受。安全问题请使用 [`SECURITY.md`](./SECURITY.md) 的私密报告入口。

---

## English

H-MineSweeper is a black-and-gold professional solo Minesweeper training project. Solo training is the only primary product in this Alpha; the Academy is a supporting learning entry point; same-board real-time 1v1 is an independently switchable experiment.

The repository remains at Phase 0.5 while it builds `v0.2.0-alpha.N` public-access candidates. The public Alpha has no account, access-code, allowlist, or closed-research gate. Phase 1 closes only after metric definitions, observation windows, and missing-data rules are frozen in advance and real public traffic supplies sufficient evidence. A merge, green CI run, deployed Alpha RC, or larger feature count is not product validation.

### What you can play

| Mode | Available now | Result status |
| --- | --- | --- |
| Professional solo | Beginner, Intermediate, Expert, custom boards, classic random, no-guess generation, local history, and like-for-like trends | `LOCAL_UNVERIFIED`, not eligible for a public leaderboard |
| Academy | Chapters 0 through 3, staged hints, proof checks, patterns and counterexamples | Supporting learning result |
| Experimental 1v1 | Room-code racing, best of three, progress comparison, instant rematch | Feature-flagged, no official rating |

### Solo play

- Standard boards are 9×9 with 10 mines, 16×16 with 40 mines, and 30×16 with 99 mines.
- Custom width and height range from 5 to 100, with a maximum of 10,000 cells.
- The first reveal reserves a safe 3×3 area.
- No-guess generation runs in a Worker and stops after 50 attempts or five seconds. Generation time does not count toward the game clock.
- Optional statistics include time, actions, CPS, 3BV, 3BV/s, IOE, wasted actions, and flag details.
- The board has comfortable, professional, and high-contrast display profiles.
- Numbers, flags, mines, and incorrect flags are drawn as Canvas vectors so they remain readable on the smaller Expert cells.

### Minesweeper Academy

The Academy teaches deductions from the visible board instead of asking players to memorize number strings without context.

- Chapter 0 covers revealing, flagging, chording, and number meaning.
- Chapter 1 covers remaining mine counts, known mines, and contradictions.
- Chapter 2 introduces shared cells, exclusive cells, and set inclusion.
- Chapter 3 covers 1-2-1, 1-2-2-1, and counterexamples.
- Hints progress from H1 to H7. Advanced hints come from solver proofs and never inspect hidden mines to invent an answer.
- Course progress and practice results stay on the local device. The current Logic Streak describes only the active page session; it is not presented as a cross-session streak.

### Experimental real-time 1v1

Each player solves the same Expert no-guess board in a separate view. Players do not compete for cells, and neither player can see the other's cursor or route.

- Synchronized three-second countdown.
- Best of three. Drawn rounds do not count as wins, and a match uses at most five boards.
- Each round has a 180-second limit and a 50ms terminal decision window.
- Opponent progress is merged at 10Hz.
- A test room uses no more than 15 non-repeating boards.
- Players can download the JSON replay and start a rematch from the result screen.

The current 1v1 mode uses `client_seed`. The client reveals cells immediately while the server recomputes actions and results. This is useful for testing responsiveness, but it does not provide the anti-cheat guarantees needed for an official leaderboard. `duelExperiment` can be enabled only after protocol decoding, reliable sequencing, deadline rollback, replay-budget, and real two-client gates pass. A failure keeps 1v1 off without blocking the solo Alpha.

The browser entry and server transport are controlled independently by
`VITE_DUEL_EXPERIMENT` and `H_MINESWEEPER_DUEL_EXPERIMENT`. Repository
development and deployment defaults keep both off; use `pnpm dev:duel` or
explicitly enable both flags when validating the experiment. With the server
flag off, guest, room, replay, and WebSocket surfaces are
unavailable while public solo and local history continue. A duel-only incident
turns off 1v1 and does not pause healthy solo.

### Controls

| Device | Reveal | Flag | Chord |
| --- | --- | --- | --- |
| Mouse | Left click | Right click | Middle click or both mouse buttons |
| Keyboard | Enter / Space | F | C |
| Touch | Tap | Hold for 350ms | Tap a revealed number |

Beginner boards fit the narrow viewport. Intermediate and Expert boards pan inside the board viewport and expose explicit zoom controls. A swipe is not treated as a reveal. Arrow keys move the keyboard focus.

### Run locally

Requirements:

- Node.js 22.13 or newer
- pnpm 11

Install dependencies and start the web app and real-time server:

```bash
pnpm install
pnpm dev
```

Open:

```text
http://127.0.0.1:5173
```

The real-time server listens on `http://127.0.0.1:3001` by default. Vite proxies the HTTP and WebSocket routes.

If either default port is occupied, change the server and proxy together:

```bash
H_MINESWEEPER_PORT=3101 \
VITE_DEV_SERVER_URL=http://127.0.0.1:3101 \
pnpm dev
```

See [`.env.example`](./.env.example) for the remaining settings.

### Public Alpha and telemetry boundary

The product policy is ungated public access. A fresh browser must be able to
open the home page, enter the Academy, and start solo play without an account,
credential, registration, or research consent. The repository implementation
has removed the legacy invitation gate. Its public telemetry session authorizes
only preference and event endpoints, unlocks no product route, and is fixed to
`public/unsegmented`. These local changes are not M2 Alpha RC evidence until an
anonymous-access smoke test passes against the frozen deployed artifact.

The implemented telemetry schema accepts only named events with allowlisted
properties and excludes display names, private room data, guest tokens, seeds,
and free-text errors. Pseudonymous raw events and public-session state expire
after seven days and are not extended for analysis or product research.
Identifier-free daily counts expire within 30 days. Users can opt out and
delete attributable raw events that remain inside the retention window without
affecting local history.

REST token buckets, guest and room capacity limits, replay response byte
limits, and timer-driven expiry are independent of the WebSocket message
limiter. `/live`, `/ready`, and `/version` keep liveness, dependency readiness,
and build identity distinct. Optional network-surface exhaustion must not make
healthy local solo unavailable. `/health` remains a compatibility alias for
`/api/v1/health` for one release.

### Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the web app and real-time server in parallel |
| `pnpm typecheck` | Check TypeScript across all workspaces |
| `pnpm test` | Run unit and integration tests |
| `pnpm build` | Build all three workspaces |
| `pnpm check` | Run type checking, tests, and production builds |

### Repository layout

```text
apps/web             React 19, Vite 8, Canvas 2D, solo play, and the Academy
apps/server          Fastify 5, ws 8, REST, real-time gateway, and room actors
packages/game-core   PRNG, board rules, solver, protocol, metrics, and golden vectors
scripts              Brand assets, release checks, synthetic probes, and rollback verification
```

React handles menus, configuration, and result screens. The game board uses two Canvas 2D layers, one for board state and one for short effects. Typed arrays hold board state, and ordinary actions redraw only the cells that changed.

The server assigns a single-writer actor to each room. It processes actions in receive order and keeps database work out of the game loop. Client actions carry idempotency IDs, sequence numbers, and state hashes. Missing events can be replayed; a client receives a snapshot when the event ring is no longer sufficient.

### Tests and performance

```bash
pnpm check
pnpm --filter @h-minesweeper/web e2e
```

The test suite covers:

- Seeded generation, first-click safety, adjacent counts, flood reveal, flags, and chords.
- No-guess solver proofs, 3BV, CPS, 3BV/s, and IOE.
- Local-history schema, migration, idempotent writes, import/export, corruption recovery, and like-for-like trends.
- Pseudonymous telemetry, capacity limits, runtime protocol decoding, and reliable sequencing.
- Two-client WebSocket sessions, best-of-three rematches, duplicate actions, terminal races, and room cleanup.
- Browser-level mobile reachability, keyboard use, 200% zoom, history recovery, and public entry.
- Dirty-cell rendering, Canvas pixel budgets, and minimum-cell readability.

Browser performance samples are available at `globalThis.__HMS_PERF__`. They include input-to-paint timing, rule application, full-board drawing, dirty-cell drawing, and effect-layer frame intervals. These figures are local regression data, not a cross-device SLA for a public beta.

### Current limits

The following work is still pending:

- Rooms for 2 to 10 players and reconnect support.
- OIDC accounts, matchmaking, Glicko-2 ratings, and seasons.
- Official `server_secret` boards and a one-use board inventory.
- Account/cloud-synced history, persistent multiplayer replays, and public leaderboards.
- Reports, quarantine review, and appeals.

Official ranked play will not reuse the current `client_seed` setup. It requires secret server boards, complete authoritative replays, and measured latency fairness.

### Current phase path

1. M0: establish phase truth, maintainable GitHub surfaces, and 320–390px board reachability.
2. M1: complete the professional solo loop from terminal result to local history, like-for-like trends, and the next training decision.
3. M2: complete ungated public access, capacity/protocol/rollback gates, and a single-region Alpha RC.
4. Public Alpha validation: freeze metrics, observation windows, and missing-data rules in advance, then use real public traffic to decide whether to expand, focus a revision, or stop. There is no closed sample or predetermined headcount.

See [`docs/product-phase-and-release-policy.md`](./docs/product-phase-and-release-policy.md).

### License

H-MineSweeper is open source under the [MIT License](./LICENSE). Issues and external pull requests are welcome, but submission does not imply automatic acceptance. Report security issues privately through [`SECURITY.md`](./SECURITY.md).
