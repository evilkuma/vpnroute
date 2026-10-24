#!/bin/sh
# Полное отключение IPv6 на роутере OpenWrt (однократно, на роутере).
# Вдобавок к блокировке IPv6 в vpnroute: устройства не получают IPv6-адреса
# и AAAA-записи, поэтому не пытаются ходить по IPv6.

log() { echo "[ipv6] $*"; }

# Интерфейс wan6 не поднимать
if uci -q get network.wan6 >/dev/null; then
	uci set network.wan6.auto='0'
fi
# Не раздавать IPv6-префикс в локальную сеть
uci -q delete network.lan.ip6assign
uci -q delete network.globals.ula_prefix

# Без RA и DHCPv6 в локальной сети
uci set dhcp.lan.ra='disabled'
uci set dhcp.lan.dhcpv6='disabled'
uci -q delete dhcp.lan.ndp

# dnsmasq не отдаёт AAAA-записи
uci set dhcp.@dnsmasq[0].filter_aaaa='1'

uci commit network
uci commit dhcp

/etc/init.d/odhcpd restart 2>/dev/null
/etc/init.d/dnsmasq restart
/etc/init.d/network reload

log "IPv6 отключён. Устройствам может понадобиться переподключиться к сети."
