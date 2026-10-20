# 日进

把长期愿望，走成今天的一小步。

**当前推荐部署：Cloudflare Pages + Pages Functions + D1 + Cron Worker。** 连接 GitHub、创建数据库、设置通知与发布步骤见 [CLOUDFLARE.md](CLOUDFLARE.md)。仓库名使用 `rijin-goals`。Cloudflare 不运行 `server.js`，也不读取本地 SQLite 文件。下方 VPS 部分保留为旧版参考。

## 本地体验

需要 Node.js 24 或更高版本，正式容器使用 Node.js 24。

```powershell
cd outputs/daybyday
pnpm install
pnpm d1:local
pnpm dev
```

打开终端显示的本地地址，注册一个账号即可使用。Cloudflare 本地 D1 数据存放在 `.wrangler/`，与旧版 `data/daybyday.sqlite` 分开。使用 `pnpm legacy:dev` 可运行旧版 Node 服务。通知密钥与线上发布方式见部署指南。

## 已包含

- 邮箱注册与登录，Cloudflare 版密码使用带随机盐的 PBKDF2-SHA256 哈希保存；登录会话使用 HttpOnly/Secure Cookie。旧 Node 版仍使用 scrypt，已有用户数据不能直接导入 D1，需另做迁移。
- 每个账号独立的长期目标、阶段、日常行动、打卡记录、时区和推送订阅。
- 长期目标拆解为阶段，并将每日行动关联到目标或阶段。
- 一键完成 / 恢复、月历回看和逐日行动记录。
- Service Worker + Push API + VAPID Web Push。Cloudflare Cron Worker 每 5 分钟检查，在账户 IANA 时区当地 18:00 后发现未完成行动时尝试推送；全部完成或没有行动时不发送。D1 原子领取发送任务，推送服务接受后按用户当地日期去重；失败约 10 分钟后重试，404/410 订阅会清除，自动处理夏令时。推送服务接受消息并不等于操作系统必定显示通知。独立 Worker 需按部署指南发布，Pages 单独上线不会产生定时提醒。

## 原 VPS 部署参考

已提供 `Dockerfile`、`compose.yaml`、`Caddyfile`、`.env.example`、部署脚本及在线数据备份。正式服务器接入和数据迁移见 [DEPLOY.md](DEPLOY.md)。当前本地预览不等于已经上线的公共网站；正式运行需要 HTTPS 域名和持续运行的服务器。

1. 使用提供的 Caddy HTTPS 反向代理配置；生产模式要求 `PUBLIC_ORIGIN` 和 `VAPID_SUBJECT`。应用默认不信任代理头，部署配置只对隔离在 Caddy 后方的应用启用信任，按固定公开来源校验请求并设置 `Secure` Cookie。
2. 让服务监听代理可访问的地址（例如 `HOST=127.0.0.1`，`PORT=4173`），由进程管理器设置自动重启和日志轮转。
3. 设置 `VAPID_SUBJECT` 为真实的联系地址，例如 `mailto:ops@your-domain.example`。VAPID 密钥首次启动时保存在 SQLite 的 `app_settings` 表，请持久化并定期备份整个数据库；不要删除密钥记录，否则已保存的浏览器订阅将失效。
4. 用 HTTPS 正式域名注册账号、授予浏览器通知权限，并在“设置”里开启 18:00 提醒。用户可以随时关闭。系统通知开关、省电策略、离线状态或推送厂商服务都可能影响最终显示。

部署前还应接入反向代理限流、账号找回/邮箱验证、监控与异地备份，并根据面向用户的地区完成隐私说明及数据保留策略。当前版本不收集账号邮箱的验证凭据，也没有第三方分析追踪。
