# shrimpbot CLI

`shrimpbot` 命令管理 ShrimpBot 服务生命周期。

## 安装

ShrimpBot 安装器自动安装到 `~/.local/bin/shrimpbot`。

## 命令

```bash
shrimpbot update                      # 拉取最新代码，重新构建，重启
shrimpbot start                       # 启动（PM2）
shrimpbot stop                        # 停止
shrimpbot restart                     # 重启
shrimpbot logs                        # 查看实时日志
shrimpbot status                      # PM2 进程状态
```

## 更新

`shrimpbot update` 是推荐的更新方式。它依次执行：

1. `git pull` — 拉取最新代码
2. `npm install && npm run build` — 重新构建
3. `pm2 restart` — 重启服务

一条命令搞定。
