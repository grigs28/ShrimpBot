# ShrimpBot 架构升级设计：PTY 正则逆向 → Claude Agent SDK 结构化

**日期**：2026-08-04
**状态**：设计待审阅
**关联**：`spike/SPIKE-REPORT.md`（能力验证，三假设全部实机通过）

---

## 1. 背景与动机

ShrimpBot 当前是"飞书↔Claude Code 三端实时桥"，核心机制是用 node-pty 启动 `claude --dangerously-skip-permissions`，再用 30+ 条正则**逆向解析 TUI 文本**（`output-parser.ts`）提取干净内容喂给飞书。

经 2026-08-04 的 Claude Code 功能调研 + SDK 能力 spike，确认：

- **PTY 正则逆向是脆弱过渡方案**：作者注释自承"待 xterm/headless 修复后切换"。Claude Code 每改一版 TUI，解析就可能失灵。git 历史有大量"修 doFinalPatch/修增量 diff/修解析"补丁佐证。
- **Claude Code 已提供结构化正解**：`PermissionRequest` hook、`canUseTool` 回调、`stream-json` 事件流、`--resume`/`sessionStore` 会话恢复，均为官方支持。
- **PTY 已无法支撑审批**：v2.x 的权限提示，PTY stdin 无法响应（调研确认）。当前 `--dangerously-skip-permissions` 全开权限 + 正则猜 yes/no + 硬编码危险模式，安全形同虚设。
- **Spike 实机验证**：SDK 路线三假设全部成立（见 SPIKE-REPORT.md）。

**部署约束**：本机=开发，192.168.0.18=生产（+认证网关 `:5566`），交付=本地 docker build 推 18。SDK 主路径无 node-pty 依赖，天然适合容器。

## 2. 目标与非目标

**目标**：
1. 飞书端从"正则解析 PTY 文本"切换为"消费 SDK 结构化事件"，消除脆弱性。
2. 权限审批从"正则猜 yes/no + 硬编码危险模式"升级为"SDK `canUseTool` 结构化远程审批"。
3. 支持断线会话恢复（`session_id` + `--resume`），重启不丢上下文。
4. 终端 PTY TUI 透传体验保留不变（用户核心体验）。
5. 渐进迁移，每阶段可独立上线、可 feature-flag 回退。

**非目标**（本期不做）：
- 全量重写 Web 端 xterm（raw 广播保留）。
- 迁移到 MCP Channel 协议（研究预览，跟踪但不依赖）。
- master 多进程模式重构（仍走 legacy，独立议题）。
- 修复现有 WS 零认证/session secret 硬编码（独立安全议题，可并行处理但不属本次架构升级范围）。

## 3. 目标架构（终态形态）

**核心思想**：数据流的"权威源"从 PTY 切换为 SDK，三端按各自特性消费。单一 session jsonl 是唯一会话真相。

```
                        ┌─────────────────────────────────┐
                        │   SDKSession (新增·权威源)        │
                        │  query() stream-json 事件流       │
                        │  canUseTool → 飞书审批卡片         │
                        │  session_id → 断线 --resume       │
                        └──────────┬──────────────────────┬┘
                                   │ 结构化事件            │ session jsonl
                  ┌────────────────┼──────────────────────┼──────┐
                  ▼                ▼                       ▼      
           ┌──────────┐     ┌──────────┐           ┌────────────────┐
           │ 飞书端    │     │ Web 端    │           │ 终端端          │
           │ (消费事件) │     │ (xterm)   │           │ (PTY TUI 透传)  │
           │ 卡片/审批  │     │ raw 广播   │           │ --resume 接管   │
           └──────────┘     └──────────┘           └────────────────┘
```

**三端职责**：
- **飞书端**：纯消费 SDK 事件。`assistant` 文本→卡片，`tool_use`/`tool_result`→工具状态，`canUseTool`→审批卡片，`result`→完成卡片+成本。零正则。
- **Web 端**：xterm raw 广播保留（实时 TUI 体验）；权威状态（卡片/审批）来自 SDK 事件，不再依赖 buffer 解析。
- **终端端**：保留 PTY TUI 透传（体验不变），通过 `--resume <session_id>` 接续 SDK 会话上下文。

**关键不变量**：单一 session jsonl 是唯一会话真相。SDK 是主写入者；终端 PTY 通过 resume 只读消费上下文，不并发写同一 session。

## 4. 组件拆分

现有 `FeishuBridge`（1415 行）职责过载。拆为单一职责单元：

| 组件 | 职责 | 替代/依赖 |
|---|---|---|
| **`SDKSession`** *(新·核心)* | 封装 `query()`，产出结构化事件流；持有 `session_id`；管理 `canUseTool` 审批门；断线 `--resume` | 替代 `PTYManager` 在飞书/Web 路径的角色 |
| **`ApprovalGate`** *(新)* | `canUseTool` 回调实现：渲染飞书审批卡片→`await` 用户点击→返回 allow/deny；高危工具 `disallowedTools` 底线；超时默认 deny | 替代 yes/no 正则 + `DANGEROUS_PATTERNS` |
| **`FeishuCardRenderer`** *(重构)* | 纯函数：SDK 事件→飞书卡片/文本。无状态、可单测 | 从 FeishuBridge 抽出，输入从"PTY 文本"变"SDK 事件" |
| **`MessageRouter`** *(重构)* | 多群路由、消息队列、claudeBusy 并发控制 | 从 FeishuBridge 抽出，逻辑不变 |
| **`PTYTerminal`** *(瘦身后保留)* | 仅终端 TUI 透传 + `--resume` 接续；不再解析、不再喂飞书 | `PTYManager` 去掉 OutputParser，瘦身到 ~100 行 |
| **`WebServer`** *(渐进改造)* | xterm raw 广播保留；审批状态/卡片来自 SDK 事件 | 结构不变，数据源切换 |
| **`OutputParser`** *(废弃)* | SDK 路线不再需要 | 删除或降级为终端 fallback |

**设计原则**：`SDKSession` 是唯一与 Claude 交互的权威通道；`FeishuCardRenderer`、`ApprovalGate` 是可独立测试的无副作用单元，解决现有"1400 行核心 0 单测"痛点。

## 5. 数据流与审批流

### 5.1 正常对话流（飞书消息→Claude→飞书）
```
飞书消息 → MessageRouter.dispatch()
  → SDKSession.send(text)           // 不再写 PTY
  → query() 流式产出事件:
      assistant/text  → FeishuCardRenderer → 🔵思考卡片(流式更新)
      tool_use        → 🛠 执行中: Bash: ls -la
      tool_result     → ✅ 完成
      canUseTool触发  → ApprovalGate → 🟡审批卡片(允许/拒绝按钮)
      result          → 🟢完成卡片 + 💰成本
```

### 5.2 远程审批流（canUseTool 为核心）
```
SDK canUseTool(Write, {file_path, content}, ctx) 触发
  → ApprovalGate 渲染飞书卡片: displayName + 路径 + 内容预览
  → await 飞书用户点击 [允许]/[拒绝]   // Promise 挂起，SDK 自动等待
  → 允许 → {behavior:'allow'}
  → 拒绝 → {behavior:'deny', message:"用户拒绝"}  // 反馈给 Claude
  → 超时(5分钟) → 默认 deny + 飞书提示"审批超时已拒绝"
```
**触发可靠性**：spike 发现 canUseTool 仅在"权限流 fall through 到 prompt"时触发，网关自动放行的工具不触发。对策：高危工具（rm/sudo/docker/dd 等）列入 `disallowedTools` 强制走 prompt + canUseTool 双保险；常规工具走 canUseTool 自然触发。

### 5.3 三端输入统一
所有输入（飞书/Web/终端/API）经 `MessageRouter → SDKSession.send()`。终端 PTY 输入通过 `--resume` 共享同一 session，但**终端直接写 PTY、SDK 不重复发**——靠 session jsonl 的单一写入者原则防重复。

**并发边界（待开放问题 #2 定稿，暂行规则）**：同一时刻只有一个"turn 写入者"。飞书/Web/API 消息进入时，SDKSession 持有写入权，终端 PTY 处于"只读 TUI 视图"模式（用户键入暂存或提示"Claude 处理中"）；SDK turn 结束（result 事件）后释放写入权，终端恢复可键入。这避免两端并发写同一 turn 导致 session jsonl 冲突。

### 5.4 断线恢复
`SDKSession` 持久化 `session_id`（到 `~/.shrimpbot/sessions/<bot>.json`），进程重启后 `query({resume: sessionId})` 恢复，飞书旧卡片继续 patch（持久化 `currentCardId`）。

## 6. 错误处理（spike 踩坑对策）

| 场景 | 处理 |
|---|---|
| query throw（限流/认证 403） | catch → 🔴错误卡片 + 指数退避重试（复用现有 WS 重连模式） |
| `result.subtype=success` 但文本含错误 | 校验 result 文本是否含 "API Error/403/usage limit"，是则当错误 |
| 审批超时 | 默认 deny（fail-closed，安全优先） |
| session resume 失败 | 降级为新会话 + 飞书提示"会话已重置" |
| cwd 不一致导致 resume 找不到 | SDKSession 与 PTYTerminal 启动时锁定同一 cwd，启动期校验 |
| 并发写同一 session | 单一写入者原则：SDK 主写，终端 PTY 仅读上下文 |

## 7. 迁移策略（渐进、可回退）

```
阶段 A：引入 SDKSession + FeishuCardRenderer（并行运行，PTY 路线不动）
        feature flag SDK_EVENT_MODE 切换飞书数据源；旧 output-parser 作 fallback
阶段 B：ApprovalGate 上线，canUseTool 接管审批
        危险命令从正则 DANGEROUS_PATTERNS 迁到 disallowedTools + canUseTool
阶段 C：终端 PTY 接 --resume，瘦身 PTYManager（去 OutputParser）
        验证三端 session 一致性
阶段 D：废弃 OutputParser，删旧 doFinalPatch/增量 diff；容器化（SDK 主镜像无 node-pty）
```
每阶段独立上线、feature-flag 回退，不一次性推翻现有可用系统。

## 8. 测试策略

- `FeishuCardRenderer`、`ApprovalGate`：纯函数/可注入，单测覆盖（SDK 事件 mock → 卡片输出；审批超时/deny/allow 各路径）。
- `SDKSession`：用 spike 同款实机脚本扩展为集成测试（真实 SDK + 沙箱 cwd）。
- 保留现有 `output-parser.test.ts` 直到阶段 D 删除。
- 新增：三端 session 一致性测试（SDK 写入 → PTY resume 读到同一上下文）。

## 9. 开放问题（需用户决策）

1. **审批 UX**：飞书审批卡片用交互按钮（需注册 `card.action.trigger` 回调，现有代码未用）还是文本回复"允许/拒绝"？按钮体验好但需新增飞书回调处理。
2. **终端 PTY 与 SDK 并发的边界**：用户在终端直接键入时，SDK 端是否暂停事件消费？需明确"谁拥有当前 turn 写入权"的协议。
3. **session 持久化粒度**：每 bot 一个 session，还是每飞书会话（chat）一个 session？影响多群并发模型。
4. **`--bare` 模式取舍**：SDK 是否用 `--bare`（不加载 hooks/skills/CLAUDE.md，启动快、隔离）？还是保留自动发现（复用用户配置）？
