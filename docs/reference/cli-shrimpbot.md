# shrimpbot CLI

The `shrimpbot` command manages the ShrimpBot service lifecycle.

## Installation

Installed automatically by the ShrimpBot installer to `~/.local/bin/shrimpbot`.

## Commands

```bash
shrimpbot update                      # pull latest code, rebuild, restart
shrimpbot start                       # start with PM2
shrimpbot stop                        # stop
shrimpbot restart                     # restart
shrimpbot logs                        # view live logs
shrimpbot status                      # PM2 process status
```

## Update

`shrimpbot update` is the recommended way to update ShrimpBot. It performs:

1. `git pull` — fetch latest code
2. `npm install && npm run build` — rebuild
3. `pm2 restart` — restart the service

All in one command.
