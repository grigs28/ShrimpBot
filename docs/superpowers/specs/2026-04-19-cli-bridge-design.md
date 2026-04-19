# ShrimpBot CLI Bridge 设计文档

日期：2026-04-19

## 目标

让 Claude Code CLI 终端和飞书聊天实现**双向实时同步**——终端用户和飞书用户看到完全一致的对话内容，都能发送消息并看到回复。`shrimpbot-bridge` 作为 ShrimpBot 的可选附加组件，不改动现有功能。

## 架构

```
终端1: shrimpbot-bridge --chat oc_aaa1  ──spawn──>  claude CLI ──┐
终端2: shrimpbot-bridge --pick          ──spawn──>  claude CLI ──┤──> ShrimpBot API <──> 飞书
终端3: (无终端，飞书直接触发)             ──SDK───>  claude SDK ──┘
```

两种入口，统一出口：

| 入口 | 引擎 | 说明 |
|------|------|------|
| `shrimpbot-bridge --chat <chatId>` | CLI 桥接 | 终端手动启动，指定飞书聊天 |
| `shrimpbot-bridge --pick` | CLI 桥接 | 终端启动，交互选择聊天 |
| 飞书直接发消息（无 bridge 绑定） | SDK headless | 走现有 ShrimpBot 处理流程 |

## 双向同步规则

**核心原则：终端看到的 = 飞书看到的（完全一致）**

### Claude Code 输出 → 双端

Claude 的回复、工具调用、状态变化：
- 终端：原生显示（stream-json 解析后保持可读格式）
- 飞书：卡片同步更新

### 飞书用户消息 → 双端

飞书发来的消息写入 Claude Code stdin，同时在终端显示：
- 终端显示：`[飞书] 张三：帮我查下错误日志`
- 飞书显示：正常用户消息气泡

### 终端用户输入 → 双端

终端输入的消息 Claude 正常处理，同时转发到飞书：
- 终端显示：用户正常输入
- 飞书显示：`[终端] grigs：也看下最近的提交`

### 效果示例

```
终端视角：
  [飞书] 张三：帮我查下错误日志
  Claude：我来查一下...   Grep "ERROR" ./logs/
  [终端] grigs：也看下最近的提交
  Claude：好的...         Bash git log --oneline -5

飞书视角（完全相同）：
  张三：帮我查下错误日志
  Claude：我来查一下...   Grep "ERROR" ./logs/
  [终端] grigs：也看下最近的提交
  Claude：好的...         Bash git log --oneline -5
```

## 路由逻辑

飞书收到消息时的处理流程：

1. 查找是否有 `shrimpbot-bridge` 绑定了该 chatId
2. 有绑定 → 通过 ShrimpBot API 转发到对应终端的 bridge → 写入 stdin
3. 无绑定 → 走现有 SDK headless 模式处理（现有功能不受影响）

## 组件设计

### 新增文件

```
src/bridge/
  cli-bridge.ts          # shrimpbot-bridge 主逻辑
  stream-json-parser.ts  # stream-json 行解析器
  terminal-ui.ts         # 终端输出渲染（保持原始可读 + 标注消息来源）
src/api/
  bridge-routes.ts       # 新增 API 路由：bridge 注册/消息转发
```

### cli-bridge.ts 核心流程

```
启动 → 连接 ShrimpBot API → 注册 chatId 绑定
  → spawn claude --output-format stream-json
  → 并行处理：
    1. stdout → StreamJSONParser →
       a. 终端原生显示（TerminalUI 渲染）
       b. 关键事件 POST 到 ShrimpBot API → 飞书卡片更新
    2. SSE /bridge/messages/:chatId → 飞书消息 →
       a. 终端显示 "[飞书] xxx"
       b. 写入 claude stdin
  → 退出时解除绑定
```

### 启动参数

```bash
# 直接指定 chatId
shrimpbot-bridge --chat oc_aaa1

# 交互选择
shrimpbot-bridge --pick

# 指定 ShrimpBot API 地址（默认 localhost:9100）
shrimpbot-bridge --api http://192.168.0.18:9100 --chat oc_aaa1
```

### 交互选择流程 (--pick)

1. GET `/bridge/chats` 获取可用的飞书聊天列表
2. 终端显示编号列表供用户选择
3. 选择后注册绑定并启动

### API 路由（新增）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/bridge/register` | POST | bridge 注册 chatId 绑定 |
| `/bridge/unregister` | POST | bridge 退出时解除绑定 |
| `/bridge/messages/:chatId` | GET (SSE) | 飞书消息推送给 bridge（长连接） |
| `/bridge/events/:chatId` | POST | bridge 向 ShrimpBot 发送 Claude 输出事件 |
| `/bridge/chats` | GET | 获取可绑定的飞书聊天列表 |
| `/bridge/status` | GET | 查看当前所有 bridge 绑定状态 |

### StreamJSONParser

逐行解析 `--output-format stream-json` 输出，提取：

| stream-json type | 处理 |
|------------------|------|
| `assistant` (text) | 终端显示 + 飞书卡片文本更新 |
| `assistant` (tool_use) | 终端显示工具名 + 飞书卡片工具调用状态 |
| `assistant` (tool_result) | 标记工具完成 |
| `result` | 终端显示结果摘要 + 飞书完成卡片 |
| `stream_event` (content_block_delta) | 流式文本追加 |
| `system` | 捕获 session_id |

### 安全性

- bridge 注册需要 API secret 认证
- 每个 chatId 只能被一个 bridge 绑定（重复注册返回错误）
- bridge 心跳：每 10 秒发送心跳，超时 30 秒无心跳视为断开，自动解除绑定
- 断开后该 chatId 的消息回退到 SDK headless 模式

### 多 chatId 管理

- 每个 `shrimpbot-bridge` 进程绑定一个 chatId，对应一个 Claude Code CLI 进程
- 多个 bridge 进程可以同时运行，各自独立
- 进程退出时自动解除绑定

## 现有模块影响

### 不需要改动

- 飞书事件处理 (`feishu/event-handler.ts`)
- 飞书消息发送 (`feishu/message-sender.ts`, `feishu/feishu-sender-adapter.ts`)
- 飞书卡片构建 (`feishu/card-builder.ts`)
- 调度器 (`scheduler/task-scheduler.ts`)
- 记忆服务 (`memory/`)
- Wiki 同步 (`sync/doc-sync.ts`)
- Telegram/Wechat 适配器
- 会话注册 (`session/session-registry.ts`)

### 需要改动

| 文件 | 改动内容 |
|------|----------|
| `bridge/message-bridge.ts` | 路由逻辑：先查 bridge 绑定，有则通过 API 转发，无则走 SDK |
| `api/http-server.ts` | 挂载 bridge 路由 |
| `package.json` | 新增 `shrimpbot-bridge` bin 入口 |

## 改动量估计

- 新增约 400-500 行（cli-bridge + parser + terminal-ui + bridge-routes）
- 改动现有约 50-80 行（message-bridge 路由 + http-server 挂载 + package.json）
