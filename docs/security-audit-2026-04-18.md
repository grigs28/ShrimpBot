# ShrimpBot 安全审计报告

**审计日期**: 2026-04-18
**项目版本**: v1.0.0
**审计工具**: Trail of Bits Skills + Claude Code 并行审计 Agent

---

## 总览

| 审计领域 | Critical | High | Medium | Low |
|---------|:---:|:---:|:---:|:---:|
| 认证与凭据 | 2 | 4 | 5 | 3 |
| 注入与输入验证 | 2 | 1 | 6 | 5 |
| 网络与 API | 1 | 5 | 15 | 7 |
| 配置与供应链 | 3 | 7 | 8 | 3 |
| **合计** | **8** | **17** | **34** | **18** |

---

## 最紧急的 5 个问题

| # | 问题 | 位置 | 风险 |
|---|------|------|------|
| 1 | bypassPermissions 全自动批准 | executor.ts:179 | Claude 可执行任意命令，无需确认（已知，设计决策） |
| 2 | PPTX 预览命令注入 | file-routes.ts:90 | execSync 拼接 shell 命令，可 RCE |
| 3 | tar 解包命令注入 + Zip-Slip | skills-installer.ts:123 | 恶意 tar 包可解压到任意目录 |
| 4 | 密钥文件权限 644 | .env, bots.json | 所有用户可读 API Token 和 AppSecret |
| 5 | /memory 路由绕过认证 | http-server.ts:111 | 未授权可访问所有记忆数据 |

## 修复优先级

### P0 立即修复
1. chmod 600 .env bots.json 并轮换已暴露密钥
2. 修复 PPTX 预览命令注入 -> execFileSync
3. 修复 tar 解包注入 -> node-tar
4. 移除 /memory 路由的认证豁免

### P1 尽快修复
5. Token 比较改用 crypto.timingSafeEqual()
6. Memory 服务器默认绑定 127.0.0.1
7. 日志中移除完整 Token
8. npm override 修复 protobufjs 和 axios 漏洞
9. Docker 添加非 root 用户

### P2 计划修复
10. 添加 API 速率限制
11. 添加安全响应头
12. 限制 CORS 来源
13. Session 文件加密
14. 迁移 xlsx 到 exceljs

完整详细报告请查看各审计 Agent 输出。
