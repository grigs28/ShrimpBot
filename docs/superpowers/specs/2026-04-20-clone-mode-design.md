# --clone 模式设计

## 目标

添加 `--clone` 参数，让飞书端显示与终端完全一致的内容。修复多行文本只显示最后一行的问题。

## 根因

`output-parser.ts` 流式事件返回当前单行 `text`，不返回累积的 `accumulatedText`。`feishu-bridge.ts` 的流式定时器每次重置，前面的行全部丢失。

## 修复方案

### 1. OutputParser 返回累积文本

流式事件（`isComplete=false`）返回 `accumulatedText`（累积全部内容）而非当前单行。

### 2. 新增 `--clone` CLI 参数

- 无 `--clone`：现有逻辑不变
- 有 `--clone`：飞书用 `post` 类型 + `tag: "md"` 发送完整累积文本，支持代码块、列表渲染

### 3. clone 模式发送

- 用飞书 `post` 富文本（`tag: "md"`）发送，支持 Markdown 格式
- 一条消息发完整回复，不逐行发
- 超长文本（>30KB）自动分片
- clone 模式也自动通过 yes/no

### 4. 数据流

```
修复前：每行单独发，前面行丢失
修复后：累积全部文本，完成时一条发完
```

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/pty/output-parser.ts` | 流式事件返回 accumulatedText |
| `src/pty/feishu-bridge.ts` | clone 模式用 post+md 发送 |
| `src/index.ts` | 添加 --clone 参数 |
