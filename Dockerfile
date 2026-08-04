# ShrimpBot — 飞书↔Claude Code 桥接（SDK_EVENT_MODE 架构）
# 本地 build 后整体复制到 18（18 无法访问外网）
FROM node:24-slim

# 装运行依赖（curl=hook 必需，git=claude 常用，ca-certificates=HTTPS）
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Claude Code CLI（native 单文件二进制 288MB，SDK query() 内部 spawn claude 子进程）
COPY claude-bin /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

# 项目依赖（node_modules 已含 node24 编译的 node-pty/ghostty-opentui native binding）+ 编译产物
COPY package.json ./
COPY node_modules ./node_modules
COPY dist ./dist

# 非 root 运行（claude --dangerously-skip-permissions 拒绝 root/sudo）
RUN chown -R node:node /app
USER node
ENV HOME=/home/node

EXPOSE 5554

# 运行时注入：SDK_EVENT_MODE / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / FEISHU_*
CMD ["node", "dist/index.js"]
