#!/bin/sh
# vpnroute: удаление с роутера.
#   sh uninstall.sh          — удалить, сохранив /etc/config/vpnroute
#   sh uninstall.sh --purge  — удалить вместе с настройками
# Пакеты (xray-core и др.) не удаляются.

PURGE=0
[ "$1" = "--purge" ] && PURGE=1

log() { echo "[vpnroute] $*"; }

if [ -x /etc/init.d/vpnroute ]; then
	/etc/init.d/vpnroute stop
	/etc/init.d/vpnroute disable
fi

if [ "$(uci -q get dhcp.@dnsmasq[0].serversfile)" = "/etc/vpnroute/dnsmasq.servers" ]; then
	uci -q delete dhcp.@dnsmasq[0].serversfile
	uci commit dhcp
	/etc/init.d/dnsmasq restart
fi

rm -f /etc/init.d/vpnroute /usr/bin/vpnroute /etc/hotplug.d/iface/90-vpnroute
rm -rf /usr/share/vpnroute /var/etc/vpnroute /etc/vpnroute /www/luci-static/resources/view/vpnroute
rm -f /usr/share/luci/menu.d/luci-app-vpnroute.json /usr/share/rpcd/acl.d/luci-app-vpnroute.json
[ "$PURGE" = 1 ] && rm -f /etc/config/vpnroute

rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd restart

log "удалено$([ "$PURGE" = 1 ] && echo ' вместе с настройками')"
