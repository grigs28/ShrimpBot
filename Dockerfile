# ShrimpBot WebServer Hub — 独立 Web 服务（仅 Web UI + Hook API）
# 不启动 PTY/飞书；各 sbot 实例通过 --web-host 连接本 hub（多咪架构）
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 仅需 node_modules（含静态 import 的 node-pty；hub 不 spawn claude）+ dist 编译产物
COPY package.json ./
COPY node_modules ./node_modules
COPY dist ./dist

# 非 root 运行
RUN chown -R node:node /app
USER node
ENV HOME=/home/node

EXPOSE 5554

# web-server 模式：Web UI + Hook API hub，无需 claude CLI / 飞书凭证
CMD ["node", "dist/index.js", "--web-server"]
