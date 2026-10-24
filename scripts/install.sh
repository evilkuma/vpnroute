#!/bin/sh
# vpnroute: установка на роутер OpenWrt (24.10 с opkg или 25.12+ с apk).
# Запускается на роутере из распакованной копии репозитория:
#   sh /tmp/vpnroute/scripts/install.sh [--no-deps]

set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
FILES="$SRC/files"
DEPS="xray-core kmod-nft-tproxy ip-full ucode ucode-mod-uci ucode-mod-fs"
SERVERS_FILE=/etc/vpnroute/dnsmasq.servers
NO_DEPS=0

for a in "$@"; do
	case "$a" in
		--no-deps) NO_DEPS=1 ;;
	esac
done

log() { echo "[vpnroute] $*"; }
die() { echo "[vpnroute] ОШИБКА: $*" >&2; exit 1; }

[ -d "$FILES" ] || die "не найден каталог $FILES"
[ "$(id -u)" = 0 ] || die "нужны права root"

# ---------- зависимости ----------
if [ "$NO_DEPS" = 0 ]; then
	if command -v apk >/dev/null 2>&1; then
		log "менеджер пакетов: apk"
		missing=""
		for p in $DEPS; do apk info -e "$p" >/dev/null 2>&1 || missing="$missing $p"; done
		if [ -n "$missing" ]; then
			log "устанавливаю:$missing"
			apk update
			# shellcheck disable=SC2086
			apk add $missing
		fi
	elif command -v opkg >/dev/null 2>&1; then
		log "менеджер пакетов: opkg"
		missing=""
		for p in $DEPS; do opkg list-installed | grep -q "^$p " || missing="$missing $p"; done
		if [ -n "$missing" ]; then
			log "устанавливаю:$missing"
			opkg update
			# shellcheck disable=SC2086
			opkg install $missing
		fi
	else
		die "не найден ни apk, ни opkg"
	fi
fi

command -v xray >/dev/null 2>&1 || die "xray не установлен"
log "версия Xray: $(xray version 2>/dev/null | head -n1)"

# Штатная служба пакета xray-core нам не нужна: Xray запускает vpnroute
if [ -x /etc/init.d/xray ]; then
	/etc/init.d/xray stop 2>/dev/null || true
	/etc/init.d/xray disable 2>/dev/null || true
fi

# ---------- файлы ----------
log "копирую файлы"
( cd "$FILES" && find . -type f ) | while read -r f; do
	f="${f#./}"
	if [ "$f" = "etc/config/vpnroute" ] && [ -f /etc/config/vpnroute ]; then
		log "сохраняю существующие настройки /etc/config/vpnroute"
		continue
	fi
	mkdir -p "/$(dirname "$f")"
	# убрать возможные переводы строк Windows
	tr -d '\r' < "$FILES/$f" > "/$f"
done

chmod 755 /etc/init.d/vpnroute /usr/bin/vpnroute /usr/share/vpnroute/gen.uc /usr/share/vpnroute/status.uc

# ---------- dnsmasq ----------
mkdir -p /etc/vpnroute
[ -f "$SERVERS_FILE" ] || : > "$SERVERS_FILE"

current="$(uci -q get dhcp.@dnsmasq[0].serversfile || true)"
if [ -n "$current" ] && [ "$current" != "$SERVERS_FILE" ]; then
	die "в dnsmasq уже задан serversfile=$current; уберите его или перенесите записи вручную"
fi
if [ "$current" != "$SERVERS_FILE" ]; then
	log "подключаю $SERVERS_FILE к dnsmasq"
	uci set dhcp.@dnsmasq[0].serversfile="$SERVERS_FILE"
	uci commit dhcp
	/etc/init.d/dnsmasq restart
fi

# ---------- LuCI ----------
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd restart

# ---------- служба ----------
/etc/init.d/vpnroute enable
if [ "$(uci -q get vpnroute.main.enabled)" = 1 ]; then
	log "перезапускаю службу"
	/etc/init.d/vpnroute restart
else
	log "маршрутизация выключена: добавьте сервер и включите её в LuCI (Службы → VPN-маршрутизация) или командой «vpnroute enable»"
fi

# Предупреждение про программное ускорение (flow offloading)
if [ "$(uci -q get firewall.@defaults[0].flow_offloading)" = 1 ]; then
	log "внимание: включено flow offloading; если трафик из списков пойдёт мимо туннеля, отключите его"
fi

log "готово"
