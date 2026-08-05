# A2 PermissionRequest 审批 + 选项 设计（Phase B）

**日期**：2026-08-05
**状态**：设计待审阅
**架构**：hub 转发（保留 Docker web-server hub + Code咪 bridge 连接）
**关联**：A2.2（hook-settings PermissionRequest type:http 已注册）、调研（cc-remote-approval 模式）

---

## 1. 目标

1. **审批**：Bash/Write 危险操作 → 飞书 allow/deny 卡片（替代 `--dangerously-skip-permissions` 全开 + 正则 DANGEROUS_PATTERNS）
2. **选项**：AskUserQuestion → 飞书**结构化选项按钮**（替代 PTY 正则 containsNumberedOptions 误判）
3. 统一走 **PermissionRequest hook**（结构化，不再正则猜 TUI 文本）
4. 保留 hub 多咪架构（hook POST hub，hub WS 转发 Code咪）

## 2. 权限模型（等效 bypass，只 AskUserQuestion 发飞书）

- pty-manager：**去掉 `--dangerously-skip-permissions`**（default 模式，PermissionRequest hook 可触发）
- ApprovalGate 判断（hub 端）：
  - **AskUserQuestion** → 转发飞书选项卡片（用户回复）
  - **其他所有工具**（Bash/Write/Read/危险命令）→ **自动 allow**（等价 bypass 不审批）
- 效果：行为等价 `--dangerously-skip-permissions`（不审批/不拦截危险），但 AskUserQuestion 走结构化 hook → 飞书选项

## 3. 数据流（hub 转发）

```
claude 任意工具调用 → PermissionRequest hook(type:http) POST hub/api/hook/approval?bot=Code咪
hub:
  收 {tool_name, tool_input, tool_use_id}
  ApprovalGate 判断：
    ├─ tool_name='AskUserQuestion'
    │    → WS {type:'approval-request', kind:'question', toolUseId, questions} 给 Code咪
    │    → await Promise（5min 超时）
    └─ 其他工具 → 立即返回 allow（等价 bypass，不审批）
Code咪 feishu-bridge:
  收 WS approval-request(kind:'question')
    → 飞书 🟡选项卡片（问题 + 1.xxx 2.xxx + "回复编号/选项名"）
    → pendingApprovals Map<toolUseId, resolve>
    → 用户飞书回复"1"或选项名 → WS {type:'approval-response', toolUseId, answers} 回 hub
hub:
  收 approval-response → resolve Promise
    → HTTP 返回 {behavior:'allow', updatedInput:{questions, answers}}
  超时 5min → 默认 deny（fail-closed，AskUserQuestion 不应静默 allow 未知选项）
```

## 4. ApprovalGate 判断（纯函数，可单测）

新增 `src/sdk/approval-gate.ts`：
```typescript
// 等效 bypass：只 AskUserQuestion 转发飞书，其他全 allow（不审批）
function classify(toolName: string, _input: Record<string,unknown>): 'allow' | 'question' {
  if (toolName === 'AskUserQuestion') return 'question';
  return 'allow';  // 其他全 allow（等价 --dangerously-skip-permissions）
}
```

## 5. 组件改动

| 文件 | 改动 |
|---|---|
| `pty-manager.ts` | **去掉 `--dangerously-skip-permissions`**（default 模式；ApprovalGate 等效 bypass）|
| `hook-settings.ts` | PermissionRequest type:http（**A2.2 已做**）|
| `src/sdk/approval-gate.ts`（新） | classify：AskUserQuestion→question，其他→allow（纯函数 + 单测）|
| `web-server.ts`（hub） | `/api/hook/approval` 端点（classify → question 转发 / 其他 allow）+ Promise Map + WS `approval-response` 收 |
| `web-server.ts`（Code咪 bridge 端） | WS 收 `approval-request` → 转发 feishu-bridge；发 `approval-response` 回 hub |
| `feishu-bridge.ts` | 审批/选项卡片渲染 + `pendingApprovals` Map + 飞书回复路由（allow/deny 或选项 answers）+ 超时 |

## 6. hub↔Code咪 WS 协议（新消息类型）

```typescript
// hub → Code咪
{ type: 'approval-request', kind: 'approval'|'question', toolUseId, botName,
  toolName?, input?, questions? }

// Code咪 → hub
{ type: 'approval-response', toolUseId, botName,
  decision?: 'allow'|'deny', answers?: Record<string,string> }
```

## 7. 错误/超时

| 场景 | 处理 |
|---|---|
| 审批/选项 5min 无回复 | deny（fail-closed）|
| Code咪 断开（WS 断） | hub pending Promise reject → deny |
| ApprovalGate classify 异常 | deny |
| hook http timeout（300s） | > 审批 5min，覆盖 |
| 安全判断分歧（acceptEdits 已 allow 但 hook 又来） | hook 优先（acceptEdits 不触发的工具才到 hook）|

## 8. 测试

- `approval-gate.test.ts`：classify 各工具/命令（安全/危险/AskUserQuestion）单测
- `web-server` /api/hook/approval：安全 allow（即时）/ 危险转发（mock WS）
- `feishu-bridge`：审批/选项卡片 + pendingApprovals + 超时
- 集成：实机飞书发危险命令 + AskUserQuestion，验证 hub↔Code咪 转发 + 飞书卡片 + answers 注入

## 9. 迁移

- 去掉 PTY 路径 `containsNumberedOptions`/`isYesNoQuestion` 选项检测（hook 取代）
- `DANGEROUS_PATTERNS` 迁到 ApprovalGate
- feature flag：可加 `APPROVAL_HOOK_MODE=true` 控制（false 时回退 bypass + 正则）

## 10. 开放问题

1. 飞书选项交互：文本回复（"回复 1/红"）vs 飞书卡片按钮（card.action.trigger，需新增 WS 事件处理）？文本简单，按钮体验好。
2. acceptEdits 下文件编辑不触发 hook（自动 allow）—— 若要文件编辑也审批，改 default 模式（全 hook）。
3. SDK 模式（SDK_EVENT_MODE=true）的 ApprovalGate：SDK 用 canUseTool（已就绪），A2 主要 PTY 路径（hook）。两者共用 ApprovalGate.classify。
