# 发布日进到 Cloudflare

本目录应作为 GitHub 仓库根目录，仓库名 **rijin-goals**。完整网站由 Pages（网页和 API）、D1（数据）和独立 Cron Worker（提醒）组成；只上传 `public` 会缺少注册、保存和后台推送。

## 1. 创建数据库

在 Cloudflare 控制台进入 **Storage & databases → D1 → Create database**，名称填 `rijin-goals`。复制 Database ID，将两个文件中的 `REPLACE_WITH_D1_DATABASE_ID` 换成同一个真实 ID：

- 根目录 `wrangler.jsonc`
- `workers/reminders/wrangler.jsonc`

数据库 ID 可以进仓库，推送私钥不能。打开 D1 数据库的 Console，执行根目录 `schema.sql` 全部内容以创建表。也可以在本机登录 Cloudflare 后执行：

```powershell
pnpm install
pnpm exec wrangler login
pnpm d1:remote
```

`schema.sql` 可重复执行，不删除现有数据。网站不会在请求时自动建表。

## 2. 保存到 GitHub

安装并登录 GitHub Desktop，添加本机 `outputs/daybyday` 为本地仓库。如果提示没有 Git 仓库，可以选择在该目录创建。检查文件，创建提交，点击 **Publish repository**，名称填 **rijin-goals**，建议保留 **Keep this code private**。

点击 **View on GitHub**，确认仓库网页中能看到 `public`、`functions`、`src`、`schema.sql`、`workers`、`package.json`、`pnpm-lock.yaml`、`wrangler.jsonc`。不要上传整个工作区、`data/`、`node_modules/`、`.dev.vars`、`.env`、数据库和私钥。

只有 GitHub 网页中能看到代码和提交，才算远程保存完成；本地文件不等于已经保存到 GitHub。

## 3. 连接 Cloudflare Pages

进入 **Workers & Pages → Create application → Pages → Connect to Git**，连接 GitHub 并授权读取 `rijin-goals`，选择该仓库。

| 设置 | 内容 |
| --- | --- |
| Project name | `rijin-goals`（如占用则用控制台允许的其他名称） |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | 留空；如果表单要求非空可填 `echo ready` |
| Build output directory | `public` |
| Root directory | 留空 |
| 环境变量 `NODE_VERSION` | `24` |

以上假设仓库根目录就是当前项目目录。构建系统安装依赖并编译 `functions/`。不要填 `pnpm start` 或 `node server.js`；那是旧版服务器命令。

仓库的 `wrangler.jsonc` 是配置来源，D1 binding 名称必须为 `DB`，连接步骤 1 的数据库。不要将输出目录设成仓库根目录。

发布后使用控制台给出的 `https://<项目名>.pages.dev` 免费地址，不需要购买域名。

先在 Pages 的 Builds & deployments 中关闭非生产分支的自动预览部署；以后需要预览时，给 Preview 环境绑定独立测试数据库和测试密钥，避免预览影响正式数据。

## 4. 设置 Web Push 密钥

本机在项目目录执行一次：

```powershell
pnpm vapid:generate
```

保存生成的公钥和私钥，私钥只在自己终端和 Cloudflare Secret 设置中使用，不要发到聊天、提交到 GitHub，或放到 `public/`。更换密钥后用户需要重新订阅通知。

Pages 项目 **Settings → Variables and Secrets** 的 Production 环境添加：

| 名称 | 内容 |
| --- | --- |
| `VAPID_PUBLIC_KEY` | 普通文本，生成的公钥 |
| `VAPID_PRIVATE_KEY` | Secret，生成的私钥 |
| `VAPID_SUBJECT` | 普通文本，真实联系邮箱，例如 `mailto:你的邮箱` |

保存后重新部署 Pages。未配置时网站会明确显示通知未配置。

## 5. 发布后台提醒 Worker

这一步不可省略；Pages 本身没有本项目所需的 Cron 定时任务。

在 `workers/reminders/wrangler.jsonc` 中将 `VAPID_SUBJECT` 改为同一个真实联系邮箱，确认 D1 Database ID 与 Pages 相同。然后执行：

```powershell
pnpm exec wrangler login
pnpm deploy:reminders
pnpm exec wrangler secret put VAPID_PUBLIC_KEY --config workers/reminders/wrangler.jsonc
pnpm exec wrangler secret put VAPID_PRIVATE_KEY --config workers/reminders/wrangler.jsonc
```

两个 secret 命令分别输入与 Pages 完全相同的公钥和私钥。给 Worker 配置不会自动给 Pages 配置，两个地方都需要设置。

控制台打开 `rijin-goals-reminders`，确认 D1 binding `DB` 和 Cron Trigger `*/5 * * * *` 存在。Cron 使用 UTC 调度，程序内部按用户 IANA 时区判断当地时间和夏令时；通常 18:00 后的下一次调度尝试发送，短暂中断恢复后可在当晚补发，不承诺精确到秒。

Worker 代码后续更新需再次执行 `pnpm deploy:reminders`；Pages 的 Git 自动部署不会自动更新这个独立 Worker。

## 6. 发布后验收

1. 手机和电脑打开控制台提供的 HTTPS 免费网址，确认不是 localhost/127.0.0.1。
2. 注册 A，创建目标、阶段、每日行动，打卡后查看历史；退出再登录确认保存。
3. 注册 B，确认看不到 A 的目标和记录。
4. 设置中核对时区、开启通知并发送测试通知。权限被拒时按页面提示到浏览器站点设置重新授权；iPhone/iPad 可能需要先添加到主屏幕。
5. 保留今天的一项未完成行动，晚上 18:00 关闭网站，观察 Cron 日志和设备通知。当天全部完成时不应提醒。
6. 页面显示“推送服务已接受”只代表服务接受消息，设备关机、网络、省电、浏览器退出及系统通知限制仍可能使通知无法显示。失败或无订阅时必须显示真实情况。

注册失败先检查 D1 `DB` 绑定和建表；没有定时提醒则检查独立 Worker、Cron 和两处相同的 VAPID 配置。

## 本地验证及维护

```powershell
pnpm d1:local
pnpm dev
pnpm test
pnpm exec wrangler pages functions build --outdir=.wrangler/pages-build
pnpm exec wrangler deploy --config workers/reminders/wrangler.jsonc --dry-run
```

本地通知的三个 VAPID 变量放在 `.dev.vars`（不进仓库）。Cloudflare 本地 D1 存在 `.wrangler/`，与旧版 SQLite 分开。测试覆盖账户隔离、打卡/历史、并发调度去重、夏令时、失败重试和订阅失效；真实设备送达仍需上线后验证。

Cloudflare 免费资源有额度上限，请观察 Functions/Worker 和 D1 用量，不能保证永久免费无限使用。定期在 D1 控制台导出或用 `wrangler d1 export` 备份，备份含私人目标和邮箱，不能放入公开仓库。

旧版 `data/daybyday.sqlite` 不会自动导入 D1，旧密码是 scrypt、新版为 PBKDF2。已有真实账号时需另外规划迁移，不能直接覆盖。当前没有邮箱验证或密码找回，面向公众开放前应了解这一限制。

官方参考：[Pages Git 集成](https://developers.cloudflare.com/pages/configuration/git-integration/)、[Pages Functions 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)、[D1 入门](https://developers.cloudflare.com/d1/get-started/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
