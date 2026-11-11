#!/bin/sh
# vpnroute: удаление с роутера.
#   sh uninstall.sh          — удалить, сохранив /etc/config/vpnroute
#   sh uninstall.sh --purge  — удалить вместе с настройками
# Пакеты (xray-core и др.) не удаляются.

PURGE=0
[ "$1" = "--purge" ] && PURGE=1

log() { echo "[vpnroute] $*"; }

[ -x /usr/bin/vpnroute ] && /usr/bin/vpnroute trace stop >/dev/null 2>&1
rm -f /etc/init.d/vpnroute-trace
rm -rf /tmp/vpnroute-trace

if [ -x /etc/init.d/vpnroute ]; then
	/etc/init.d/vpnroute stop
	/etc/init.d/vpnroute disable
fi

if [ "$(uci -q get dhcp.@dnsmasq[0].serversfile)" = "/etc/vpnroute/dnsmasq.servers" ]; then
	uci -q delete dhcp.@dnsmasq[0].serversfile
	uci commit dhcp
	/etc/init.d/dnsmasq restart
fi

rm -f /etc/init.d/vpnroute /usr/bin/vpnroute /etc/hotplug.d/iface/90-vpnroute /etc/hotplug.d/dhcp/90-vpnroute
rm -rf /usr/share/vpnroute /var/etc/vpnroute /etc/vpnroute /www/luci-static/resources/view/vpnroute /www/luci-static/resources/vpnroute /tmp/vpnroute-update
if grep -q 'vpnroute update check' /etc/crontabs/root 2>/dev/null; then
	sed -i '/vpnroute update check/d' /etc/crontabs/root
	/etc/init.d/cron restart 2>/dev/null
fi
rm -f /usr/share/luci/menu.d/luci-app-vpnroute.json /usr/share/rpcd/acl.d/luci-app-vpnroute.json
[ "$PURGE" = 1 ] && rm -f /etc/config/vpnroute

rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd restart

log "удалено$([ "$PURGE" = 1 ] && echo ' вместе с настройками')"
