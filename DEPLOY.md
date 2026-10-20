# 将「日进」迁到正式服务器

当前交付的是可部署版本。只有代码上传、数据导入、域名和 HTTPS 检查均完成之后，才算真正上线。尚未提供服务器连接信息，因此此刻没有新的公网网址。

## 需要的接入信息

- 一台可通过 SSH 登录的 Linux 服务器，以及已安装的 Docker Engine / Compose 插件。
- 一个域名或子域名，例如 `goals.example.com`，其 A 记录指向服务器公网 IPv4；只有服务器真正支持 IPv6 时才配置 AAAA 记录。
- 一个真实联系邮箱，用于证书和 Web Push 的 VAPID 联系信息。

如果由 Codex 代为操作，提供服务器地址、SSH 用户名、端口及可用密钥的本机路径即可；不要在聊天里粘贴密码或私钥。没有服务器时，先选定并登录托管平台，再接入其部署渠道。

## 服务器上运行

上传本目录的源代码，排除 `node_modules`、`data`、`backups` 和 `.env`。数据库不要放在公开代码仓库、镜像或静态资源目录。

在服务器的项目目录中复制 `.env.example` 为 `.env`，填写域名（仅主机名）和联系邮箱。确保云安全组和主机防火墙允许 TCP 80 / 443；如使用 HTTP/3，可另外允许 UDP 443。不用开放应用内部的 4173 端口。

```sh
cp .env.example .env
# 用编辑器填写 .env 中的 DOMAIN 和 ADMIN_EMAIL
bash scripts/deploy.sh
```

应用与 HTTPS 入口均设置 `restart: unless-stopped`，服务器重启后随 Docker 恢复。应用以普通用户运行，数据库、推送密钥和证书分别保存在 Docker 卷中。日志设置大小和数量上限。后台每 30 秒检查用户时区下的 18:00 提醒，服务器需持续运行并能访问浏览器推送服务。

`TRUST_PROXY=1` 仅适用于这里提供的隔离部署：应用没有公开端口，Caddy 会覆写客户端 IP 及转发头。若更换网络结构，不要把应用直接暴露到公网并继续信任任意代理。`PUBLIC_ORIGIN` 固定为正式 HTTPS 地址，用于来源校验和安全 Cookie。

## 迁移当前数据

迁移前暂停本地写入，避免备份完成后还有新记录留在旧站。应使用 SQLite 在线备份，不能在服务运行时仅复制 `.sqlite` 而遗漏 WAL。以下操作会保留账号、目标、历史、时区及 VAPID 密钥，并仅在迁移副本中清除属于旧网址的登录会话、推送订阅和提醒开启状态；本地原数据库不会改变。

本地先创建一致的备份文件：

```sh
node scripts/backup.js /private/path/rijin-migration.sqlite --new-origin
```

使用 SCP 等安全方式把备份传到服务器，再在服务器项目目录中执行：

```sh
docker compose build
docker compose stop app
# 如果服务器已有数据，先保留一份服务器数据库备份；不要直接覆盖。
# 下面的导入会在数据库已存在时拒绝执行。
docker compose run --rm --no-deps --user root \
  -v /private/path/rijin-migration.sqlite:/migration.sqlite:ro \
  --entrypoint sh app -c 'test ! -e /app/data/daybyday.sqlite && cp /migration.sqlite /app/data/daybyday.sqlite && chown node:node /app/data/daybyday.sqlite'
bash scripts/deploy.sh
```

新域名下用户需重新登录并重新启用通知。浏览器的通知权限、Service Worker 和推送订阅属于原来的网址，不会自动转移；原账号的提醒开关也不能代表新域名已经获得通知权限。正式切换时停止旧站的提醒调度，避免两个服务器同时发送。上线后以新网址为唯一写入入口。

## 备份与恢复

运行中的数据库可用以下命令备份，文件名不会覆盖已有快照：

```sh
docker compose exec -T app node scripts/backup.js
```

备份保存在 `app_backups` 持久卷，但同机卷无法应对整机丢失。用主机计划任务定期执行备份，再将快照加密复制到另一台机器或私有对象存储。恢复前停止应用、保留原数据，再把经过校验的快照放回 `app_data` 卷并恢复 `node` 用户的所有权。不要使用 `docker compose down -v`，它会删除持久卷。

## 上线验收

1. 在服务器之外访问 `https://正式域名/api/health` 和首页，确认 HTTPS 证书有效。
2. 两个浏览器分别注册两个账号，验证目标、打卡、历史互不可见。
3. 添加目标后重启应用，确认仍可登录且数据仍在。
4. 在受支持的浏览器开启通知并发送测试，检查推送服务是否接受；关闭网站后也应尝试。权限被拒、浏览器退出后的系统策略、网络和推送服务可达性都可能阻止展示，不能据此宣称已经送达。
5. 验证时区设置及当天未完成行动的后台调度。不能用页面内计时器或单次前台弹窗替代关闭网页后的测试。

本机没有 Docker，因此当前仅验证了 Node 生产模式、代理安全、账号隔离、重启持久化及备份；镜像构建、证书签发、服务器自动恢复和公网推送需要在目标服务器上完成。

部署配置依据：[Caddy 反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Docker Compose 文档](https://docs.docker.com/compose/)。
