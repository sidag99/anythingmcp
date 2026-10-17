# 分支预览环境（Preview Environments）

本文定义两个仓库——`sidag99/anythingmcp`（生产 https://anythingmcp.flowerchatting.com）与
`Jaiaaryan/captianmuqiMCP`（生产 https://amcp.flowerchatting.com）——"每个分支一个可访问实例"的方案。
仓库侧文件已就位：`deploy/previews/`、`.github/workflows/deploy-preview.yml`、
`packages/frontend/src/components/branch-switcher.tsx`、`src/app/layout.tsx` 的挂载。
服务器侧 `amcp-deploy` 的 preview 模式由 FlowerChat 主控会话实现，本文只定义契约。

## 目标

- 推送任意非 `main` 分支后几分钟内得到一个独立 HTTPS 地址，与生产完全隔离（独立 origin、数据库、密钥）。
- 删除分支即销毁实例；长期未重新部署的实例按 TTL 自动回收。
- 两个生产站点与所有预览之间可一键跳转（顶部切换栏、404 页的下拉框）。
- 不触碰现有生产部署链路（`docker-image.yml` / `deploy-self.yml` 与 `amcp-deploy` 的生产模式）。
- Cloud 与普通 self-hosted 部署不受影响：`PREVIEW_INDEX_URL` 未设置时切换栏渲染 `null`，其余文件只在预览主机上使用。

## 命名

| 项 | 规则 | 例 |
|---|---|---|
| repo | 仓库名小写 | `anythingmcp`、`captianmuqimcp` |
| slug | 分支名小写；每段 `[^a-z0-9]+` → `-`；去首尾 `-`；截到 30 字符后再去尾 `-` | `feat/SSO-Login` → `feat-sso-login` |
| host | `anythingmcp-<slug>.flowerchatting.com` / `amcp-<slug>.flowerchatting.com` | |
| instance | `<repo>-<slug>` | `anythingmcp-feat-sso-login` |
| compose project | 等于 instance，因此容器名为 `<instance>-app`、`<instance>-postgres` | |

slug 必须匹配 `^[a-z0-9][a-z0-9-]{0,29}$`。`main` 永远不预览：workflow 用 `branches-ignore: [main]`
拦截 push，`meta` job 再拒绝 slug 为空或等于 `main` 的情况（覆盖 `workflow_dispatch`）。
HOST_PREFIX 由服务器配置决定（见下）：`anythingmcp` 仓库是 `anythingmcp-`，`captianmuqimcp` 仓库是 `amcp-`。

## 架构

```
浏览器
  │  *.flowerchatting.com 通配 DNS，Cloudflare 橙云
  ▼
FlowerChat 主机 nginx（一个 server 块）
  server_name ~^(anythingmcp|amcp)-[a-z0-9-]+\.flowerchatting\.com$ previews.flowerchatting.com;
  if ($fc_cf_ok = 0) { return 444; }        只接受来自 Cloudflare 的连接
  Origin CA 证书
  location / → proxy_pass http://127.0.0.1:3100
  ▼
Traefik v3（deploy/previews/docker-compose.yml，文件 provider 监听 /dynamic，watch: true）
  ├─ Host(`<host>`) → <instance>-app:3000 / :4000（外部网络 amcp-previews）
  ├─ /__previews/、/__void/、previews.flowerchatting.com → previews-static（nginx:1.27-alpine）
  └─ 其余任何 Host → previews-static → 404 页
```

nginx 反代参数：`proxy_http_version 1.1`、`Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto https`、
`Connection ""`、`proxy_buffering off`、`proxy_cache off`、`gzip off`，读写超时 3600s（MCP 的 SSE/流式响应需要）。
Traefik 只监听 `127.0.0.1:3100`，所以 `forwardedHeaders.insecure: true` 是安全的；
`respondingTimeouts.writeTimeout: 0s` 同样是为长连接。

预览实例容器挂在外部网络 `amcp-previews` 上，不发布任何宿主端口（`preview.override.yml` 中 `ports: !reset []`），
只有 Traefik 能访问它们。

## 路由规则

`deploy/previews/dynamic/00-static.yml`（固定，随路由器一起安装）：

- `previews-index`：`PathPrefix(/__previews/) || PathPrefix(/__void/)`，priority 1000 → `previews-static`。
  优先级最高，所以在任何预览主机名下都能同源读到 `index.json` 与 404 页的静态资源。
- `previews-home`：`Host(previews.flowerchatting.com)`，priority 100 → `previews-static`。
- `previews-void`：`HostRegexp(.+)`，priority 1 → `previews-static`，兜底 404。

`deploy/previews/instance.yml.tmpl`（每实例用 `INSTANCE`、`HOST` 渲染为 `/home/amcp/previews/dynamic/<instance>.yml`）：

- `<instance>-backend`：`Host(<host>)` 且路径匹配 `^/(api|mcp|health|\.well-known|auth|sso)(/|$)`
  或 OAuth 端点 `^/(authorize|token|register|callback|revoke|userinfo)$`，priority 50 → `http://<instance>-app:4000`。
- `<instance>-frontend`：`Host(<host>)`，priority 10 → `http://<instance>-app:3000`。

## 404 页

`deploy/previews/static/404.html`，由 `static/nginx.conf` 作为 `error_page 404` 返回：HTTP 状态仍是 404，带 `noindex`。

- 浅灰背景 + 生成的虚空图 `void.jpg`（`/__void/void.jpg`，`Cache-Control: public, max-age=86400`）+ 品牌图标。
- 按 `navigator.languages` 选 en/zh/de/ja 文案（"你来到了虚空……"），并写回 `<html lang>`。
- "前往 branch" 下拉框从同源 `/__previews/index.json` 读分支列表，按 repo 分 `optgroup`，生产条目加"(生产)"；
  index 为空或读不到时下拉框保持隐藏。
- 只影响预览主机名：`flowerchatting.com` 主域名与两个生产站点各有自己的 nginx server 块，不经过这条链路。

## 顶部切换栏（BranchSwitcher）

- 组件 `packages/frontend/src/components/branch-switcher.tsx`，在 `src/app/layout.tsx` 的 `<Providers>` 内作为第一个子元素渲染：
  `<BranchSwitcher indexUrl={process.env.PREVIEW_INDEX_URL} />`。
- layout 已是 `export const dynamic = 'force-dynamic'`，`process.env.PREVIEW_INDEX_URL` 在请求时读取（与 `GTM_ID` 同一模式），
  所以同一镜像在生产与预览中都能用，差别只在容器的环境变量。
- 值：`https://previews.flowerchatting.com/__previews/index.json`。
  nginx 对 `/__previews/` 加 `Access-Control-Allow-Origin: *` 与 `Cache-Control: no-store`；组件用 `cache: 'no-store'` 请求。
- index 只含分支名、URL、commit、时间，不含密钥；组件只在已登录（`useAuth().user` 非空）时渲染；少于两个条目不渲染。
- 当前实例由 `window.location.host` 与条目 URL 的 host 匹配得到，匹配不到时显示占位项"…"；
  切换即 `window.location.assign(url)`（跨 origin，不能走客户端路由）。选中项有 `commit` 时在右侧用等宽字体显示前 7 位。

## index.json 格式

```json
{
  "generatedAt": "2026-10-17T08:00:00Z",
  "entries": [
    {"repo":"anythingmcp","branch":"main","url":"https://anythingmcp.flowerchatting.com","production":true},
    {"repo":"captianmuqimcp","branch":"main","url":"https://amcp.flowerchatting.com","production":true},
    {"repo":"anythingmcp","branch":"feat/sso-login","url":"https://anythingmcp-feat-sso-login.flowerchatting.com",
     "commit":"1a2b3c4","updatedAt":"2026-10-17T07:58:12Z"}
  ]
}
```

- 生产条目来自 `/home/amcp/previews/prod.json`（模板 `deploy/previews/prod.json.example`）。
- 预览条目来自 `/home/amcp/previews/instances/<instance>/meta.json`，每个文件就是一个条目对象。
- `deploy/previews/gen-index.sh` 拼接后写入 `/home/amcp/previews/public/__previews/index.json`：
  先写 `.tmp`，用 `python3 -m json.tool` 校验，再 `mv` 原子替换。`public/` 以只读方式挂进 `previews-static`。

## 服务器端：amcp-deploy 的 preview 模式（契约）

现有 `amcp-deploy` 只有生产模式（`deploy <tag> <actor>`）。需要新增 preview 模式，由 FlowerChat 主控会话实现。

### 钥匙与配置

`~amcp/.ssh/authorized_keys` 新增两把钥匙，强制命令带上仓库名：

```
restrict,command="/usr/local/sbin/amcp-deploy preview:anythingmcp" ssh-ed25519 AAAA…
restrict,command="/usr/local/sbin/amcp-deploy preview:captianmuqimcp" ssh-ed25519 AAAA…
```

`/etc/amcp-deploy/preview-<repo>.conf`（以 anythingmcp 为例；captianmuqimcp 的
`IMAGE_REPO=ghcr.io/jaiaaryan/captianmuqimcp`、`HOST_PREFIX=amcp-`）：

```
REPO_URL=https://github.com/sidag99/anythingmcp.git
IMAGE_REPO=ghcr.io/sidag99/anythingmcp
HOST_PREFIX=anythingmcp-
DIR_BASE=/home/amcp/previews/instances
OVERRIDE=/etc/amcp-deploy/preview.override.yml
MAX_PREVIEWS=3
TTL_DAYS=7
```

`OVERRIDE` 文件内容即仓库里的 `deploy/previews/preview.override.yml`：固定镜像为 `${IMAGE_REPO}:${APP_TAG}`、
清空端口、加入 `amcp-previews` 网络、资源上限、日志轮转、注入 `NODE_MAX_OLD_SPACE_MB` 与 `PREVIEW_INDEX_URL`。

### 调用协议

- stdin 第一行是 GHCR 令牌（workflow 传 `secrets.GITHUB_TOKEN`）；destroy 时为 `-`。
- `SSH_ORIGINAL_COMMAND`：`deploy <slug> <tag> <actor> <branch>` 或 `destroy <slug>`。
- 参数校验，任一不符即拒绝（退出码 1，审计 `outcome=rejected`）：

| 参数 | 正则 |
|---|---|
| slug | `^[a-z0-9][a-z0-9-]{0,29}$` |
| tag | `^sha-[0-9a-f]{7,40}$` |
| actor | `^[A-Za-z0-9._-]{1,64}$` |
| branch | `^[A-Za-z0-9._/-]{1,100}$` |

- 另外两条：slug 必须等于 slugify(branch)（与 workflow 同一算法）；
  tag 里的 commit 必须可从 `origin/<branch>` 到达（`git fetch` 后 `git merge-base --is-ancestor`），防止用别的提交冒充该分支。

### deploy 步骤

1. `docker network inspect amcp-previews`，不存在则 `docker network create`。
2. 建实例目录 `$DIR_BASE/<instance>`。
3. 写 `.env`：首次生成并持久保留 `JWT_SECRET`、`ENCRYPTION_KEY`、`COOKIE_SECRET`、`NEXTAUTH_SECRET`、`POSTGRES_PASSWORD`；
   每次重写 `COMPOSE_PROJECT_NAME=<instance>`、`IMAGE_REPO`、`APP_TAG`、
   `SERVER_URL` / `FRONTEND_URL` / `NEXT_PUBLIC_API_URL` / `NEXTAUTH_URL` / `CORS_ORIGIN` = `https://<host>`、
   `MCP_AUTH_MODE=oauth2`、`ALLOW_OPEN_REGISTRATION=true`、`NODE_MAX_OLD_SPACE_MB=512`、`PREVIEW_INDEX_URL`。
4. 从仓库该 commit 取出 `docker-compose.yml`（`git show <sha>:docker-compose.yml`）放到实例目录：分支自己的 compose 定义生效，
   `app`/`postgres` 的名字与 healthcheck 都来自它。
5. compose 静态检查（基于 `docker compose config` 的输出，不激活任何 profile，所以 `caddy`/`motis` 不在内）：
   不得有 `privileged`、`docker.sock`、宿主路径挂载、`network_mode: host`、`cap_add`；
   不得发布宿主端口——override 的 `ports: !reset []` 已清空 `app` 的端口，这里只是兜底。
6. `docker login ghcr.io -u <actor> --password-stdin` → `docker compose pull` → `docker logout`。
7. `docker compose -f docker-compose.yml -f $OVERRIDE up -d --no-build`。
8. 等容器健康：镜像自带 `HEALTHCHECK`（`Dockerfile`，`wget /health`，start-period 120s），
   仓库 compose 里 `app` 的 healthcheck 会覆盖它，两者都反映在 `docker inspect -f '{{.State.Health.Status}}' <instance>-app`；
   轮询到 `healthy` 为止，最长 240s；超时则把 `compose logs --tail` 写进审计并以退出码 1 失败，实例保留以便排查。
9. 用 `envsubst` 从 `instance.yml.tmpl` 渲染 `/home/amcp/previews/dynamic/<instance>.yml`，Traefik watch 自动加载。
10. 写 `meta.json`：`{"repo","branch","url","commit","updatedAt"}`。
11. 运行 `gen-index.sh`。
12. 清理旧镜像：该 `IMAGE_REPO` 下没有任何容器引用的 tag。
13. 审计日志一行：`ts=… mode=preview repo=… instance=<instance> tag=… actor=… outcome=ok`。

新实例且现有预览数已达 `MAX_PREVIEWS` 时拒绝：退出码 2，stderr 列出现有预览（instance、branch、updatedAt），不做任何改动。
重新部署已有实例不受该上限影响。

### destroy

`docker compose down -v` → 删除实例目录 → 删除 `dynamic/<instance>.yml` → `gen-index.sh` → 审计一行。
slug 对应实例不存在时视为成功（幂等；分支删除事件可能重复）。

### TTL

root 的每日 cron 遍历 `instances/*/meta.json`，`updatedAt` 早于 `TTL_DAYS` 天（即超过 7 天没有重新部署）的实例走 destroy。

## 资源与容量

| 容器 | 内存（memswap 同值） | CPU |
|---|---|---|
| `<instance>-app` | 768m | 0.5 |
| `<instance>-postgres` | 256m | 0.25 |
| `amcp-previews-traefik` | 128m | 0.25 |
| `amcp-previews-static` | 32m | 0.1 |

主机约 5.3 GB 可用：3 个预览约 3 GB，路由器 160 MB，其余留给生产。因此 `MAX_PREVIEWS=3`。
`NODE_MAX_OLD_SPACE_MB=512` 让 Node 堆留在 768m 限制内。

## 安全

- 预览与生产完全隔离：独立 origin（cookie / OAuth 不互通）、独立 Postgres、独立密钥、不发布宿主端口、只经 Traefik 进入。
- 分支代码在 amcp 用户的 rootless Docker 内运行；compose 静态检查阻止提权、挂 socket、挂宿主目录。
- 部署钥匙 `restrict,command=` 强制命令，CI 无法在服务器上执行任意命令；参数严格正则；commit 必须属于该分支。
- `GITHUB_TOKEN` 经 stdin 传递，只用于 `docker login`，不落盘。
- 预览对公网可达且开放注册（`ALLOW_OPEN_REGISTRATION=true`），第一个注册者成为该预览的管理员——见开放问题。
- `index.json` 无需认证即可读，公开暴露分支名；不含任何密钥。

## CI 侧仓库配置

| 名称 | 类型 | 说明 |
|---|---|---|
| `PREVIEW_SSH_KEY` | secret | 每仓库一把独立 ed25519 私钥，公钥进 authorized_keys 并带 `preview:<repo>` 强制命令 |
| `DEPLOY_HOST` | var | 复用现有 |
| `DEPLOY_USER` | var | `amcp`，复用现有 |
| `DEPLOY_KNOWN_HOSTS` | var | 复用现有 |

`.github/workflows/deploy-preview.yml`（两仓库相同）：触发 push（`branches-ignore: [main]`）、delete、workflow_dispatch；
concurrency `preview-<branch>` 且 `cancel-in-progress`；`meta` 算 slug，`build` 推 `ghcr.io/<owner>/<repo>:sha-<7>` 与 `:preview-<slug>`，
`deploy` 走 `deploy <slug> <tag> <actor> <branch>`，`destroy`（只在分支删除时）走 `destroy <slug>`。

## 落地顺序

1. 主控（FlowerChat 会话）：通配 DNS `*.flowerchatting.com` → nginx server 块 → 把 `deploy/previews/` 安装到 `/home/amcp/previews`
   （`docker network create amcp-previews`、`compose up -d`、写 `prod.json`、首次 `gen-index.sh`）→ `amcp-deploy` preview 模式与两个 conf
   → authorized_keys 两把钥匙 → 生产 override 加 `PREVIEW_INDEX_URL`（生产站点的切换栏才会出现）。
2. 用户：把两个仓库的 workflow、`branch-switcher.tsx`、`layout.tsx` 改动推到 `main`；在两个仓库各添加 `PREVIEW_SSH_KEY`。
3. 推一个测试分支验证：Actions 绿 → `https://anythingmcp-<slug>.flowerchatting.com` 可注册登录 → 切换栏出现并能跳到生产
   → 删分支后同一地址返回 404 页且下拉框不再列出它。

## 开放问题

1. 是否用 Cloudflare Access 保护 `*-<slug>.flowerchatting.com`，彻底解决"公网可注册、首个注册者是管理员"。
2. 预览是否需要密码（可在 `instance.yml.tmpl` 加 Traefik basicAuth middleware），以及这与 MCP 客户端的 OAuth 流程是否冲突。
3. TTL 天数：7 天是否合适；是否改按最后访问时间而非最后部署时间。
4. 是否允许 `workflow_dispatch` 重部署：目前允许且与 push 同一路径；是否要限制为有写权限的人。
