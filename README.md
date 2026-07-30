# H‑MineSweeper

低延迟扫雷原型：既能本地完成经典单人训练，也能让两名玩家在独立界面解决同一张确定性棋盘，以实时进度、Bo3 裁定、双端事件回放和即时重赛形成直接对抗。

## 当前交付：Phase 0.5

已经实现：

- 三条首页路径：单人游戏、扫雷学院、多人对战；实际模式支持刷新、前进和后退恢复。
- 暖黑金视觉升级、完整/轻量/核心特效档位、系统 Reduced Motion 优先和运行时自动降级。
- 完整本地单人模式：初级、中级、高级、自定义 5–100 尺寸、经典随机和无猜生成。
- 单人任意首击 3×3 安全；无猜棋盘在 Worker 中最多尝试 50 次或 5 秒，生成等待不计时。
- 单人计时、剩余雷数、安全格进度、操作数、终局雷位显示、本地个人最佳和即时换图。
- 版本化 CPS/动作每秒、3BV、3BV/s、IOE、动作分类、无效动作和旗标明细；最终数值由 `game-core` 复算。
- 扫雷学院第 0–3 章：操作预热、剩余雷数、集合包含、1-2-1、1-2-2-1 与反例。
- 学院 H1–H7 逐级提示、可见约束穷举 proof、状态/证明哈希、旋转镜像练习、Logic Streak 和本地学习状态。
- Flow Combo：只奖励被接受且由当前可见状态证明或首击安全规则保证的揭格/和弦，不影响时间、评级或成绩。
- 桌面浏览器房间码 1v1、3 秒同步倒计时、Expert 30×16 / 99 雷。
- 32 张经 `NG-Competitive-v1` 求解器认证的无猜棋盘；每个测试房间最多使用 15 张且不重复。
- 左键揭格、右键插旗、中键/左右键组合和弦，以及键盘 Reveal / Flag / Chord。
- 触屏点击揭格、点击数字和弦、350ms 长按插旗、移动取消长按，以及棋盘平移/双指缩放。
- 双层 Canvas 2D 棋盘、typed array 状态、脏格重绘、像素预算、高刷新率输入反馈和高对比主题。
- 同图 Bo3、最多五轮、50ms 终局窗口、180 秒超时、对手 10Hz 进度与一键重赛。
- 单写者房间 Actor、客户端动作幂等、序号补发/快照、状态哈希、限流、背压和 Origin 校验。
- 内存事件回放与 JSON 下载；回放记录客户端遥测和服务端核心动作耗时。
- 匿名会话、短期一次性 WebSocket 票据，以及房间/票据/会话的 TTL 回收。

单人模式完全在本地运行。Phase 0 的 1v1 使用 `client_seed`：客户端即时展开，服务端独立复算。它用于验证手感和直接对抗循环，不具备正式排位的反作弊强度。断线或状态分歧会立即冻结并记为技术 DNF，不提供重连。

根据产品闸门，账号、评级、匹配、正式 `server_secret` 棋盘、2–10 人房、数据库、持久化排行榜、举报/申诉、商城和赛季系统尚未实现；只有真实用户验证通过后才进入后续阶段。

## 本地运行

要求 Node.js 22.12+ 与 pnpm 11。

```bash
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`。默认实时服务为 `http://127.0.0.1:3001`，Vite 会代理 HTTP 与 WebSocket。

端口被占用时可一起覆盖服务端与开发代理：

```bash
H_MINESWEEPER_PORT=3101 \
VITE_DEV_SERVER_URL=http://127.0.0.1:3101 \
pnpm dev
```

可配置项见 [.env.example](./.env.example)。

## 验证

```bash
pnpm check
```

该命令依次执行 strict TypeScript、单元/集成测试和三个 workspace 的生产构建。集成测试覆盖真实 WebSocket 双客户端连续 10 轮、Bo3 重赛、重复动作、终局竞态、15 轮上限、洪泛关闭和闲置资源回收。

浏览器本地性能样本保存在 `globalThis.__HMS_PERF__`：

- `pressNextPaintMs`：按压到下一次 Canvas 绘制。
- `pointerNextPaintMs`：动作触发到包含新棋盘状态的下一次 Canvas 绘制。
- `actionApplyMs`：客户端确定性规则应用耗时。
- `boardFullDrawMs` / `boardDirtyDrawMs`：整盘与脏格绘制耗时。
- `boardOverlayDrawMs`：独立特效层绘制耗时。
- `boardAnimationFrameIntervalMs`：短时棋盘特效的帧间隔。

下载回放中每个 `ACTION` 事件还包含 `serverApplyMs`。这些是实验室样本，不等同于公开 Beta 的跨设备 p95/SLA 证明。

## 工程结构

```text
apps/web             React 19 + Vite 8；菜单/结果页与 Canvas 棋盘
apps/server          Fastify 5 + ws 8；REST、实时网关与房间 Actor
packages/game-core   PRNG、棋盘、规则、求解器、协议与 golden vectors
```
