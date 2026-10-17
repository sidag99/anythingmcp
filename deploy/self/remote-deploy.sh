#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=/home/ubuntu/anythingmcp
IMAGE_REPO=ghcr.io/sidag99/anythingmcp
HEALTH_URL=http://127.0.0.1:4000/health
KEEP_IMAGES=3          # 本地保留最近几个镜像，供回滚
HEALTH_WAIT=240        # 秒。后端启动要加载完整连接器目录，冷启动可能超过 90 秒

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "FATAL: $*" >&2; exit 1; }

prune_old_images() {
  # 按创建时间倒序、按镜像 ID 去重，保留前 KEEP_IMAGES 个，其余删除。正在使用的删不掉，忽略即可。
  sudo docker images "$IMAGE_REPO" --format '{{.CreatedAt}}\t{{.ID}}' \
    | sort -r | awk -F'\t' '!seen[$2]++ {print $2}' \
    | tail -n +"$((KEEP_IMAGES + 1))" \
    | xargs -r sudo docker rmi -f >/dev/null 2>&1 || true
}

main() {
  # 1. 参数来自 SSH_ORIGINAL_COMMAND。关掉通配符展开，再按空白切分，然后逐个用正则校验。
  set -f
  # shellcheck disable=SC2206
  local argv=(${SSH_ORIGINAL_COMMAND:-$*})
  set +f
  [[ "${argv[0]:-}" == "deploy" ]] || die "用法: deploy <镜像tag> <GHCR用户名>；收到: '${SSH_ORIGINAL_COMMAND:-$*}'"
  local tag="${argv[1]:-}" user="${argv[2]:-}"
  [[ "$tag"  =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "镜像 tag 不合法"
  [[ "$user" =~ ^[A-Za-z0-9._-]{1,64}$  ]] || die "GHCR 用户名不合法"
  local image="$IMAGE_REPO:$tag"

  # 2. 令牌只从标准输入读一行；不进参数、不进日志
  local token=""
  IFS= read -r token || true
  [[ -n "$token" ]] || die "标准输入里没有 GHCR 令牌"

  cd "$REPO_DIR"

  # 3. 仓库对齐到 origin/main（强制命令已经 pull 过一次，这里是幂等保险）
  GIT_TERMINAL_PROMPT=0 git fetch -q origin main
  git merge -q --ff-only origin/main || die "服务器上的 main 与 origin/main 分叉了，需要人工处理"
  local head; head="$(git rev-parse --short=7 HEAD)"
  if [[ "$tag" != "sha-$head" ]]; then
    log "WARN: 镜像 tag 是 $tag，仓库 HEAD 是 $head（多半有更新的 push 紧随其后，那一次会再部署）"
  fi
  log "部署 $image（仓库 HEAD $head）"

  # 4. compose override 指向仓库里的版本化副本；APP_TAG 写进 .env，手工 compose 也用同一镜像
  ln -sfn deploy/self/docker-compose.self.yml docker-compose.override.yml
  if grep -q '^APP_TAG=' .env; then
    sed -i "s|^APP_TAG=.*|APP_TAG=$tag|" .env
  else
    printf 'APP_TAG=%s\n' "$tag" >> .env
  fi

  # 5. 拉镜像：登录 → pull → 立刻登出
  printf '%s\n' "$token" | sudo docker login ghcr.io -u "$user" --password-stdin >/dev/null
  trap 'sudo docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  sudo docker compose pull -q app
  sudo docker logout ghcr.io >/dev/null 2>&1 || true
  trap - EXIT

  # 6. 切换容器。--no-build：服务器永远不编译。只重建镜像或配置变了的服务，postgres 不动。
  sudo docker compose up -d --no-build

  # 7. 等后端健康
  local waited=0
  until curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; do
    if (( waited >= HEALTH_WAIT )); then
      sudo docker compose logs --no-color --tail=80 app >&2 || true
      die "后端 ${HEALTH_WAIT}s 内没有变健康"
    fi
    sleep 5; waited=$((waited + 5))
  done
  log "后端健康（等待约 ${waited}s）"

  # 8. 汇报并清理旧镜像
  sudo docker compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'
  prune_old_images
  log "完成"
}

main "$@"
