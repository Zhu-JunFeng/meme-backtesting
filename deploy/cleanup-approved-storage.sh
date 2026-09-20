#!/bin/sh
set -eu
# Fixed targets from the 2026-09-21 storage audit. No global prune, volumes,
# database files, current images, swap, or unrelated applications are touched.
exec 9>/run/lock/meme-backtest-batch.lock
flock -w 900 9
df -B1 /
docker system df

# Preserve the immediately preceding release as an explicit rollback set.
for item in web:8aff374db18d worker:bad99c3142cc api:dee12a4f8359; do
  service=${item%%:*}
  id=${item#*:}
  if docker image inspect "$id" >/dev/null 2>&1; then
    docker image tag "$id" "meme-backtesting-$service:rollback-a8af51d"
  fi
done

set -- fa334cc49529 c6abf638d6ff a90ca0efef22 \
  3ffd5f924995 9ec1e68b9647 c80b42116b9c \
  f888d80ef615 d5740e4e1ecb b52ce8d42ffe \
  627c899c3de0 8ae6ede3126a b54821247f01 \
  6e9d67af2a09 57037a0e177a 364c5f81e4ab \
  b6b8beff6069 ae179e2119c5 c8c5341f91b8 \
  3787a665b0af 30c044ec4794 23a313cc8f4e \
  fa2aae200681 670498e93b01 8fc49b6b3590 \
  c8bad95e337e 4a998d5ae0ff 16f44a3c0bc5 \
  d9e2e2f17f7b 0a295e54edf4 738de7a13161 \
  06db8eea2675 c54dbf7b44f6 ead22b4e4e96 \
  d84894d74832 e5a34bedba99 9f0911a5f301 \
  6a810c07d46b 30d2f7a596c7 a9187b53fd7e \
  66df394c1ce4 bc8a5aaf0b6a 2fd3e3c42d0e \
  2abf64a906ae 30720477a4f5 880d78251b35 \
  978cc6a41acc 97b310068a89 e08949188dfb \
  466b81e72b2e f51318fb2fa2 6a04d873f4eb \
  957c875fb9d4 df5099811ea7 94b4d7e1c456 \
  3ecaf2f2ebd2 20a1516142b4 d6fc98135cff \
  122e62d6eac2 191f5a5a78e5 0e3721a45b9f

# Validate the entire allowlist before deleting anything.
for id do
  if ! docker image inspect "$id" >/dev/null 2>&1; then continue; fi
  tags=$(docker image inspect -f '{{json .RepoTags}}' "$id")
  case "$tags" in null|'[]') ;; *) echo "Refusing tagged image $id: $tags" >&2; exit 1;; esac
  [ -z "$(docker ps -aq --filter "ancestor=$id")" ] || { echo "Refusing referenced image $id" >&2; exit 1; }
  docker image inspect -f '{{.Id}} {{.Created}}' "$id"
done
for id do
  # Docker also removes this image's unused, untagged ancestors, stopping at
  # shared/referenced/tagged layers. Never force removal or prune globally.
  if docker image inspect "$id" >/dev/null 2>&1; then docker image rm "$id"; fi
done

core=/var/lib/systemd/coredump/core.node.0.09bcb0d477c544b99d1c09add0a2479f.15112.1789890802000000.zst
if [ -f "$core" ] && [ ! -L "$core" ]; then
  stat "$core"
  rm -- "$core"
fi
df -B1 /
docker system df
docker ps --format 'table {{.Names}}\t{{.Status}}'
