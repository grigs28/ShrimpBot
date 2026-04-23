# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ShrimpBot is a Feishu (Lark) ↔ Claude Code real-time bridge. It spawns Claude Code via PTY and synchronizes I/O across three endpoints: terminal (TUI passthrough), Feishu (interactive cards), and Web (browser terminal via WebSocket).

## Build & Development Commands

```bash
npm run build       # tsc compile + npm link (creates global `sbot` CLI)
npm run dev         # build then run `node dist/index.js`
npm run start       # run compiled dist/index.js
npm test            # vitest run (excludes e2e tests)
npm run test:e2e    # vitest run src/pty/__tests__/e2e-pty.test.ts
```

## Architecture

### Entry Point (`src/index.ts`)

Parses CLI args, loads config, and dispatches to one of four modes:

- **Bridge mode** (`FEISHU_MODE=bridge`, default when `.sbot` exists): `FeishuBridge` — PTY + Feishu WSClient + Web terminal
- **Single mode** (`FEISHU_MODE=single`): Legacy `MCPServer` via stdio (deprecated in practice)
- **Master mode** (`FEISHU_MODE=master`): Multi-bot process manager (`src/master.ts`)
- **Web-only mode** (`--web` without Feishu creds): PTY + Web terminal, no Feishu
- **Standalone Web server** (`--web-server`): Only Web UI + Hook API, no PTY/Feishu

### Core Components

| File | Role |
|------|------|
| `src/pty/feishu-bridge.ts` | Main orchestrator. Manages PTY lifecycle, Feishu WSClient, message queue, interactive card flow, and yes/no auto-approval. |
| `src/pty/pty-manager.ts` | Wraps `node-pty`. Spawns `claude --dangerously-skip-permissions`, handles raw data streaming, auto-restart with backoff, and event emission (`response` / `question` / `exit`). |
| `src/pty/output-parser.ts` | Parses PTY raw ANSI output via `ghostty-opentui` to extract meaningful text. Filters TUI noise (borders, status bars, progress indicators). Detects `●` completion marker and yes/no questions. |
| `src/pty/web-server.ts` | Express + WebSocket server on port 5554. Serves browser terminal UI. Two WS endpoints: `/` for browsers, `/ws/bot` for sbot providers. Proxies PTY data and hook events between local/remote instances. |
| `src/pty/hook-settings.ts` | Auto-writes `.claude/settings.local.json` hook config so Claude Code emits `Stop`/`Notification`/`PostToolUseFailure` events to `POST /api/hook`. |
| `src/config.ts` | Config loader. Reads `~/.shrimpbot/bots.json` (all bot creds), `~/.shrimpbot/config.json` (active bot + chatIds), and `.sbot` (project-level env vars). |
| `src/setup.ts` | Interactive `sbot init` wizard. Lets user select/register bots and choose Feishu chats. |

### Config Hierarchy (highest to lowest priority)

1. CLI args (`--app-id`, `--app-secret`, `--chat`, etc.)
2. Environment variables
3. `~/.shrimpbot/config.json` (activeBotName, chatIds)
4. `~/.shrimpbot/bots.json` (bot registry: name, appId, appSecret)
5. `.sbot` file in project root (FEISHU_MODE, CLAUDE_CWD)

**Never read or write `.env`.** Project config lives in `.sbot` only.

### Three-Endpoint Sync (Critical)

All three endpoints share a single Claude Code PTY instance. Any change to data flow must preserve this invariant.

**Display (Claude output → all three endpoints simultaneously):**
- **Terminal**: PTY raw ANSI data written to `process.stdout` via `rawListeners` in passthrough mode (`process.stdin.setRawMode(true)`).
- **Web**: PTY raw ANSI data broadcast via WebSocket to all browser clients (rendered by xterm.js).
- **Feishu**: PTY data goes through `OutputParser.parse()` to extract clean text, then sent as interactive cards (non-clone: 🔵 thinking → 🟢 complete / 🟡 options / 🔴 error) or plain text (clone mode).

**Operation (any endpoint input → Claude):**
- **Terminal stdin** → `pty.writeRaw()` → PTY
- **Web WebSocket** → `pty.writeRaw()` → PTY
- **Feishu message** → `pty.send()` (with `markNewRound()`) → PTY
- **API `POST /api/send`** → `pty.writeRaw()` → PTY

**Rules:**
- No duplication: each endpoint receives content exactly once. Feishu uses incremental diff (`lastSentTextMap`); completion sends only remaining delta.
- No omission: `firstMessageReceived` is set to `true` when any endpoint receives its first real text input. Only after this flag is set does Claude output get forwarded to Feishu (prevents startup noise from being sent).
- Format adaptation: Terminal and Web get raw ANSI; Feishu gets parsed plain text.

### Message Flow

```
Feishu WSClient → FeishuBridge.handleFeishuMessage()
  → messageQueue (if claudeBusy) OR dispatchToClaude()
  → PTYManager.send() → node-pty → Claude Code

Claude Code output → PTYManager.onData()
  → rawListeners (terminal + Web broadcast)
  → OutputParser.parse() → response/question events
  → FeishuBridge.handleClaudeResponse() → Feishu card/text
```

### Hook Events

Claude Code hooks (`Stop`, `Notification`, `PostToolUseFailure`) POST to `/api/hook`. In non-clone mode, `Stop` reads `transcript_path` to extract the final assistant message and patches the Feishu card. This is a fallback when PTY parsing misses completion.

### Multi-Bot / Multi-Chat

- `sbot init` registers bots in `~/.shrimpbot/bots.json`. Active bot is saved to `config.json`.
- New chats are auto-discovered and saved to `config.json`.
- Messages are queued per-bot; `claudeBusy` flag prevents concurrent Claude invocations.
- Dangerous patterns (`rm -rf`, `drop table`, etc.) block auto-approval even for yes/no questions.

## Testing

- Unit tests: `src/pty/__tests__/output-parser.test.ts` — tests parser noise filtering, completion detection, yes/no detection.
- E2E test: `src/pty/__tests__/e2e-pty.test.ts` — spawns real `claude` PTY, sends a message, verifies response extraction. Requires Claude Code CLI installed at `/home/grigs/.local/bin/claude`.

## Key Files for Debugging

- `~/.shrimpbot/logs/shrimpbot-YYYY-MM-DD.log` — all logs including PTY raw data (debug level)
- `/tmp/shrimpbot-debug.log` — MCP server notification debug (legacy mode)
- `.claude/settings.local.json` — Claude Code hooks configuration

## Important Conventions

- All git commit messages must be in Chinese.
- Do not push to remote unless explicitly instructed by the user.
- When project files change, update the NOTICE file accordingly.
- The `sbot` CLI is globally linked after `npm run build`.
