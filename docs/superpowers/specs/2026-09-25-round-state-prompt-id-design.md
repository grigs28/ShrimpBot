# 轮次状态统一与 prompt_id 识别设计（cron 计划任务轮次可见性修复）

日期：2026-09-25
状态：已批准（对话内设计评审通过）

## 背景与问题

用户通过飞书给 bot（Log咪）布置"每小时监控 xx"，claude 在会话内建立 CronCreate 计划任务。
任务触发时用户在飞书上看不到任何输出。

实机日志定性（2026-09-25，已排除双进程干扰）：

- 10:15 用户消息 → flags 复位 → 10:16 轮 🟢+📢 正常
- 11:16 / 12:16 cron 轮 → `completionHandled=true`（残留）→ Stop 定稿跳过、Notification 静默丢弃
- 12:57 终端输入 → flags 复位 → 13:16 cron 轮 🟢+📢 正常

**规律：cron 轮只有紧跟用户交互后的第一轮可见，连续第二轮起隐身。**

## 根因

轮次状态的复位只挂在两个**输入侧**入口（`dispatchToClaude` / `handleExternalCommand`，
两处为散弹式修改产生的重复代码，git blame 可证）。cron 轮不经任何输入路径 →
状态无人复位 → 三条对外可见通路全被门闩挡住：

| 通路 | 门闩 | 行号（设计时） |
|---|---|---|
| Stop 定稿 | `!completionHandled` | handleHookEvent:1316 / doFinalPatch:1459 |
| Notification | `!notificationSent` | handleHookEvent:1351 |
| 流式累积 | `!completionHandled` | handleClaudeResponse:761 |

PostToolUse/SubagentStop 虽然"有输出"（patch 旧卡），但改的是上一轮的旧卡片，不产生新消息提醒。

## 方案：prompt_id 轮次识别 + 统一轮次入口

Claude Code 的 hook 载荷（Stop/Notification/PostToolUse/PostToolUseFailure）携带
`prompt_id`，**逐轮变化**（transcript JSONL 中 promptId 每轮一个新 UUID，已验证；
hub `/api/hook` 原样转发完整 body，远端 bot 可拿到 → 18 生产零改动）。

### 新增 `src/pty/round-state.ts` —— `RoundState`（纯逻辑，仿 ReadyGate 模式）

```ts
type RoundVerdict = 'new-external' | 'same' | 'recorded';
class RoundState {
  observeHookPromptId(promptId: string | undefined, roundActive: boolean): RoundVerdict;
}
```

判定表：

| 条件 | 返回 |
|---|---|
| 无 prompt_id（旧 CLI 降级） | `'same'`（行为退回现状） |
| 轮次进行中（`roundActive=true`，即 `claudeBusy`） | 记录 id，`'recorded'` |
| 无轮次 + id 与当前相同（迟到的同轮 hook） | `'same'` |
| 无轮次 + id 不同（cron 等外部发起的新轮次） | 记录 id，`'new-external'` |

`claudeBusy` 保持唯一事实源（不新造状态，只新造判据）。

### `FeishuBridge` 接线

1. **`beginRound()`**：抽取合并两处重复的 10 行复位 + 2 个 timer 清理；
   `dispatchToClaude` / `handleExternalCommand` 改为一行调用（各自保留差异部分）。
2. **`handleHookEvent` 入口**：对 Stop/Notification/PostToolUse/PostToolUseFailure
   观察 `prompt_id`（**排除 SubagentStop**——它可能在轮次结束数分钟后迟到，
   实测 13:19:34 的 SubagentStop 晚于 13:16:24 的 Stop；**排除 SessionStart**——非轮次事件）。
   判定 `'new-external'` → `onExternalRoundBegin(targetChatId)`。
3. **`onExternalRoundBegin`**：`beginRound()` + 非 clone 发思考卡（新卡 → 飞书有通知）
   + `claudeBusy=true` + 120s busyTimer（镜像 `handleExternalCommand` 尾部）。
   不改 `responseChatId`（cron 无来源会话，沿用最近活跃会话）。
4. **`HookEvent` 类型**补 `prompt_id?: string`。

### 防误判分析

| 场景 | 结论 |
|---|---|
| 飞书/终端发起的轮次 | `claudeBusy=true` 时首个 hook 到达 → `'recorded'`，不误触发 |
| 队列续投 | `processQueue → dispatchToClaude` 走完整入口 |
| yes/no 自动通过延续 | 不设 completionHandled；id 变化时轮次进行中 → 只记录 |
| 迟到的同轮 hook（轮次已结束） | id 相同 → `'same'` |
| patchCard 竞态（思考卡未建时 PostToolUse 先到） | `currentCardId=null` → 自动降级发新卡（已有行为） |
| SDK 模式 | 不在本次范围（独立生命周期，另行处理） |

## 修复前后对照

| 事件 | 现在（连续 cron 轮） | 改后 |
|---|---|---|
| PostToolUse（首个到达） | patch 数小时前的旧卡 | 触发新轮识别 → 发新思考卡 |
| Stop | completionHandled=true → 跳过 | false → doFinalPatch → 🟢 |
| Notification | 静默丢弃 | 📢 独立卡 |
| 流式累积 | 被挡 | 恢复累积 |

## 测试计划

- 单测（TDD）：`src/pty/__tests__/round-state.test.ts` —— 判定表全覆盖 + 用户轮/迟到
  hook/cron 轮的完整序列
- 回归：全量 vitest（53 例）保持绿；`tsc --noEmit` 干净
- 实机验收：重启目标 bot（Log咪）→ **先发一条飞书消息**（过 `firstMessageReceived`
  守卫并完成一轮；注意：刚重启且无用户消息时该守卫会拦下全部 hook，这是既有
  启动噪声抑制，本修复不改变）→ 之后**不做任何用户交互**，连续两个整点
  （如 00:16、01:16）日志应出现 `思考卡 → 最终 patch 🟢`、
  `Hook Stop: completionHandled=false`、`📢 通知`。判别点：修复前第一个整点
  可见、第二个起隐身；修复后两个都可见。飞书端实际收到卡片由用户确认。

## 范围外

`/api/send` 与 Web 命令面板的多行问题、80ms 标定、SDK 模式轮次、
`claudeBusy` 误清竞态——均维持现状。

## 改动面

新增 `src/pty/round-state.ts` + 测试；修改 `feishu-bridge.ts`（约 40 行）、
`types/index.ts`（1 行）。hub、18 生产、其他咪零改动；本地重启目标 bot 即生效。
