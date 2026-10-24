#!/usr/bin/ucode
// vpnroute: состояние системы в JSON (для страницы «Состояние» в LuCI).

'use strict';

import { cursor } from 'uci';
import { popen } from 'fs';

function sh(cmd) {
	let p = popen(cmd, 'r');
	if (!p)
		return '';
	let out = p.read('all');
	p.close();
	return trim(out || '');
}

function aslist(v) {
	if (v == null)
		return [];
	return type(v) == 'array' ? v : [ v ];
}

function count_entries(v) {
	let n = 0;
	for (let l in aslist(v))
		if (trim(split(l, '#')[0]) != '')
			n++;
	return n;
}

let uci = cursor();
uci.load('vpnroute');

let res = {
	enabled: uci.get('vpnroute', 'main', 'enabled') == '1',
	running: sh('pidof xray') != '',
	rules: system('nft list table inet vpnroute >/dev/null 2>&1') == 0,
	version: split(sh('xray version 2>/dev/null'), '\n')[0] || '',
	servers: [],
	lists: [],
	devices: []
};

uci.foreach('vpnroute', 'server', (s) => {
	let m = match(s.link || '', /^vless:\/\/[^@]*@(\[[^\]]+\]|[^:\/?#]+):([0-9]+)[^?#]*\??([^#]*)/);
	let q = (m && m[3]) ? m[3] : '';
	let t = match(q, /(^|&)type=([^&]*)/);
	let sec = match(q, /(^|&)security=([^&]*)/);
	push(res.servers, {
		id: s['.name'],
		name: s.name || s['.name'],
		enabled: s.enabled != '0',
		address: m ? `${m[1]}:${m[2]}` : (s.outbound_json ? 'JSON' : '?'),
		transport: (t ? t[2] : 'tcp') + '/' + (sec ? sec[2] : 'none')
	});
});

uci.foreach('vpnroute', 'list', (s) => {
	push(res.lists, {
		id: s['.name'],
		name: s.name || s['.name'],
		enabled: s.enabled != '0',
		domains: count_entries(s.domain),
		ips: count_entries(s.ip)
	});
});

uci.foreach('vpnroute', 'device', (s) => {
	push(res.devices, {
		id: s['.name'],
		name: s.name || s['.name'],
		mac: s.mac || '',
		enabled: s.enabled == '1'
	});
});

print(sprintf('%J', res), '\n');
