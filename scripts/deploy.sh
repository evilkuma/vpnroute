#!/bin/sh
# Отправка vpnroute на роутер и установка (Linux, macOS, Git Bash).
#   ./scripts/deploy.sh [адрес_роутера] [--no-install] [--no-deps]

set -e

ROUTER=192.168.2.1
INSTALL=1
FLAGS=""
for a in "$@"; do
	case "$a" in
		--no-install) INSTALL=0 ;;
		--no-deps) FLAGS="--no-deps" ;;
		*) ROUTER="$a" ;;
	esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="root@$ROUTER"

echo "[deploy] копирование на $TARGET"
tar -czf - -C "$REPO" files scripts | ssh "$TARGET" \
	'rm -rf /tmp/vpnroute && mkdir -p /tmp/vpnroute && tar -xzf - -C /tmp/vpnroute'

if [ "$INSTALL" = 1 ]; then
	echo "[deploy] установка"
	ssh "$TARGET" "sh /tmp/vpnroute/scripts/install.sh $FLAGS"
fi
echo "[deploy] готово"
