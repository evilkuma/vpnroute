#!/usr/bin/ucode
// vpnroute: генератор конфигураций из /etc/config/vpnroute.
//
// Создаёт:
//   /var/etc/vpnroute/xray.json     — конфигурация Xray
//   /var/etc/vpnroute/vpnroute.nft  — правила nftables (таблица inet vpnroute)
//   /etc/vpnroute/dnsmasq.servers   — какие домены dnsmasq отправляет в Xray
//
// В stdout печатает, какие файлы изменились: xray, nft, dnsmasq.
// Флаги:
//   --print  вывести xray.json в stdout, ничего не записывая
//   --clear  очистить файл для dnsmasq (используется при выключении)

'use strict';

import { cursor } from 'uci';
import { readfile, writefile, rename, mkdir } from 'fs';

const RUN_DIR = '/var/etc/vpnroute';
const XRAY_FILE = RUN_DIR + '/xray.json';
const NFT_FILE = RUN_DIR + '/vpnroute.nft';
const DNSMASQ_DIR = '/etc/vpnroute';
const DNSMASQ_FILE = DNSMASQ_DIR + '/dnsmasq.servers';

// Диапазон «служебных» адресов FakeDNS. Трафик на него всегда идёт в Xray.
const FAKE_POOL = '198.18.0.0/15';

// Локальные и служебные сети: никогда не отправляются в туннель.
const BYPASS4 = [
	'0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
	'169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16',
	'224.0.0.0/4', '240.0.0.0/4'
];

// Известные DoH-серверы и «канарейка» Firefox. Им отвечаем «домен не найден»,
// чтобы браузеры не обходили DNS роутера.
const DOH_HOSTS = [
	'use-application-dns.net',
	'dns.google', 'dns64.dns.google',
	'cloudflare-dns.com', 'mozilla.cloudflare-dns.com', 'chrome.cloudflare-dns.com',
	'1dot1dot1dot1.cloudflare-dns.com', 'one.one.one.one',
	'dns.quad9.net', 'dns9.quad9.net', 'dns10.quad9.net', 'dns11.quad9.net',
	'doh.opendns.com', 'doh.familyshield.opendns.com',
	'dns.adguard.com', 'dns.adguard-dns.com', 'dns-unfiltered.adguard.com',
	'doh.dns.sb', 'dns.nextdns.io', 'doh.cleanbrowsing.org',
	'dns.mullvad.net', 'doh.mullvad.net', 'common.dot.dns.yandex.net'
];

let print_only = index(ARGV, '--print') >= 0;
let clear_only = index(ARGV, '--clear') >= 0;

// ---------- вспомогательные функции ----------

function aslist(v) {
	if (v == null)
		return [];
	return type(v) == 'array' ? v : [ v ];
}

function bool(v, def) {
	if (v == null || v == '')
		return def;
	return v == '1' || v == 'true' || v == 'on' || v == 'yes';
}

function strip_comment(line) {
	let i = index(line, '#');
	return trim(i >= 0 ? substr(line, 0, i) : line);
}

function urldecode(s) {
	if (s == null)
		return '';
	return replace(s, /%([0-9A-Fa-f]{2})/g, (m, h) => chr(hex(h)));
}

function is_ipv4(s) {
	return match(s, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/) != null;
}

function norm_domain(d) {
	d = lc(strip_comment(d));
	d = replace(d, /^[a-z]+:\/\//, '');
	d = replace(d, /[\/:?].*$/, '');
	d = replace(d, /^\*?\./, '');
	d = replace(d, /\.$/, '');
	if (match(d, /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/))
		return d;
	return null;
}

// Возвращает адрес или подсеть с обнулёнными битами хоста (nft этого требует).
function norm_ip(s) {
	s = strip_comment(s);
	let m = match(s, /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(\/([0-9]{1,2}))?$/);
	if (!m)
		return null;
	let o = [ int(m[1]), int(m[2]), int(m[3]), int(m[4]) ];
	for (let x in o)
		if (x > 255)
			return null;
	let pfx = (m[6] != null && m[6] != '') ? int(m[6]) : 32;
	if (pfx > 32)
		return null;
	let n = (o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3];
	let mask = (pfx == 0) ? 0 : ((0xffffffff << (32 - pfx)) & 0xffffffff);
	n = n & mask;
	let a = sprintf('%d.%d.%d.%d', (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
	return (pfx == 32) ? a : `${a}/${pfx}`;
}

function norm_mac(s) {
	s = lc(trim(s || ''));
	return match(s, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/) ? s : null;
}

// Записать файл, только если содержимое изменилось.
// inplace: перезаписать тот же файл, не заменяя его. Нужно для файла dnsmasq:
// dnsmasq работает в ujail, куда смонтирован конкретный файл, и после замены
// продолжал бы читать старый, удалённый.
function put(path, data, inplace) {
	if (readfile(path) == data)
		return false;
	if (inplace) {
		writefile(path, data);
	}
	else {
		writefile(path + '.tmp', data);
		rename(path + '.tmp', path);
	}
	return true;
}

// ---------- разбор ссылки vless:// ----------

function parse_vless(link) {
	let m = match(trim(link || ''),
		/^vless:\/\/([^@]+)@(\[[^\]]+\]|[^:\/?#]+):([0-9]+)\/?(\?[^#]*)?(#.*)?$/);
	if (!m)
		return null;

	let q = {};
	if (m[4] != null && m[4] != '') {
		for (let kv in split(substr(m[4], 1), '&')) {
			if (kv == '')
				continue;
			let i = index(kv, '=');
			let k = (i < 0) ? kv : substr(kv, 0, i);
			let v = (i < 0) ? '' : substr(kv, i + 1);
			q[urldecode(k)] = urldecode(v);
		}
	}

	return {
		uuid: urldecode(m[1]),
		host: replace(m[2], /^\[|\]$/g, ''),
		port: int(m[3]),
		q: q
	};
}

function build_outbound(tag, s) {
	if (s.outbound_json != null && trim(s.outbound_json) != '') {
		let o;
		try {
			o = json(s.outbound_json);
		}
		catch (e) {
			warn(`vpnroute: сервер ${s['.name']}: некорректный JSON outbound\n`);
			return null;
		}
		o.tag = tag;
		return o;
	}

	let p = parse_vless(s.link);
	if (!p) {
		warn(`vpnroute: сервер ${s['.name']}: не удалось разобрать ссылку vless://\n`);
		return null;
	}

	let q = p.q;
	let net = q.type || 'tcp';
	let sec = q.security || 'none';
	let sni = q.sni || q.host || (is_ipv4(p.host) ? null : p.host);

	let user = { id: p.uuid, encryption: q.encryption || 'none' };
	if (q.flow)
		user.flow = q.flow;

	let ss = { network: net, security: sec };

	if (sec == 'tls') {
		let tls = { fingerprint: q.fp || 'chrome' };
		if (sni)
			tls.serverName = sni;
		if (q.alpn)
			tls.alpn = split(q.alpn, ',');
		if (q.allowInsecure == '1' || q.allowInsecure == 'true' || q.insecure == '1')
			tls.allowInsecure = true;
		ss.tlsSettings = tls;
	}
	else if (sec == 'reality') {
		let r = {
			fingerprint: q.fp || 'chrome',
			publicKey: q.pbk || '',
			shortId: q.sid || '',
			spiderX: q.spx || ''
		};
		if (sni)
			r.serverName = sni;
		ss.realitySettings = r;
	}

	if (net == 'ws') {
		ss.wsSettings = { path: q.path || '/' };
		if (q.host)
			ss.wsSettings.host = q.host;
	}
	else if (net == 'grpc') {
		ss.grpcSettings = { serviceName: q.serviceName || '', multiMode: q.mode == 'multi' };
	}
	else if (net == 'httpupgrade') {
		ss.httpupgradeSettings = { path: q.path || '/' };
		if (q.host)
			ss.httpupgradeSettings.host = q.host;
	}
	else if (net == 'xhttp' || net == 'splithttp') {
		let x = { path: q.path || '/', mode: q.mode || 'auto' };
		if (q.host)
			x.host = q.host;
		if (q.extra) {
			try {
				x.extra = json(q.extra);
			}
			catch (e) {
				warn(`vpnroute: сервер ${s['.name']}: параметр extra не является JSON, пропущен\n`);
			}
		}
		ss.network = 'xhttp';
		ss.xhttpSettings = x;
	}
	else if ((net == 'tcp' || net == 'raw') && q.headerType == 'http') {
		ss.tcpSettings = {
			header: {
				type: 'http',
				request: {
					path: [ q.path || '/' ],
					headers: { Host: q.host ? split(q.host, ',') : [] }
				}
			}
		};
	}

	return {
		tag: tag,
		protocol: 'vless',
		settings: { vnext: [ { address: p.host, port: p.port, users: [ user ] } ] },
		streamSettings: ss,
		_host: p.host
	};
}

// ---------- чтение настроек ----------

let uci = cursor();
uci.load('vpnroute');

function opt(name, def) {
	let v = uci.get('vpnroute', 'main', name);
	return (v == null || v == '') ? def : v;
}

mkdir(RUN_DIR);
mkdir(DNSMASQ_DIR);

if (clear_only) {
	if (put(DNSMASQ_FILE, '', true))
		print('dnsmasq\n');
	exit(0);
}

let tp_port = int(opt('tproxy_port', '12701'));
let dns_port = int(opt('dns_port', '1053'));
let fwmark = opt('fwmark', '0x40000');
let lan_ifaces = aslist(opt('lan_iface', 'br-lan'));
let dns_upstream = opt('dns_upstream', 'https://1.1.1.1/dns-query');
let fallback = bool(opt('fallback_direct', '1'), true);
let dns_hijack = bool(opt('dns_hijack', '1'), true);
let block_dot = bool(opt('block_dot', '1'), true);
let block_doh = bool(opt('block_doh', '1'), true);
let block_ipv6 = bool(opt('block_ipv6', '1'), true);
let loglevel = opt('log_level', 'warning');

if (!match(fwmark, /^(0x[0-9a-fA-F]+|[0-9]+)$/))
	die('vpnroute: некорректный fwmark\n');

// Списки доменов и IP
let domains = [], ips = [];
uci.foreach('vpnroute', 'list', (s) => {
	if (!bool(s.enabled, true))
		return;
	for (let d in aslist(s.domain)) {
		if (strip_comment(d) == '')
			continue;
		let n = norm_domain(d);
		if (n)
			push(domains, n);
		else
			warn(`vpnroute: список ${s['.name']}: пропущен домен «${d}»\n`);
	}
	for (let a in aslist(s.ip)) {
		if (strip_comment(a) == '')
			continue;
		let n = norm_ip(a);
		if (n)
			push(ips, n);
		else
			warn(`vpnroute: список ${s['.name']}: пропущен адрес «${a}»\n`);
	}
});
domains = sort(uniq(domains));
ips = sort(uniq(ips));

// Устройства, весь трафик которых идёт в туннель
let macs = [];
uci.foreach('vpnroute', 'device', (s) => {
	if (!bool(s.enabled, false))
		return;
	let m = norm_mac(s.mac);
	if (m)
		push(macs, m);
	else
		warn(`vpnroute: устройство ${s['.name']}: некорректный MAC\n`);
});
macs = sort(uniq(macs));

// Серверы
let proxies = [], server_hosts = [];
uci.foreach('vpnroute', 'server', (s) => {
	if (!bool(s.enabled, true))
		return;
	let o = build_outbound('proxy-' + s['.name'], s);
	if (!o)
		return;
	if (o._host && !is_ipv4(o._host))
		push(server_hosts, lc(o._host));
	delete o._host;
	push(proxies, o);
});
server_hosts = uniq(server_hosts);

// Хост DoH-сервера (если указан именем) тоже исключаем из перехвата
let up_host = match(dns_upstream, /^[a-z+]+:\/\/([^\/:]+)/);
if (up_host && !is_ipv4(up_host[1]))
	push(server_hosts, lc(up_host[1]));

// Домен локальной сети (обычно lan)
let lan_domain = 'lan';
uci.load('dhcp');
uci.foreach('dhcp', 'dnsmasq', (s) => {
	if (s.domain)
		lan_domain = s.domain;
	return false;
});

// ---------- конфигурация Xray ----------

let local_domains = [ 'domain:' + lan_domain, 'domain:local', 'domain:home.arpa', 'domain:in-addr.arpa' ];
for (let h in server_hosts)
	push(local_domains, 'full:' + h);

let dns = {
	tag: 'dns-internal',
	queryStrategy: 'UseIPv4',
	servers: [
		// локальные имена и адреса серверов — через dnsmasq роутера
		{ address: '127.0.0.1', port: 53, domains: local_domains, skipFallback: true },
		// запросы от dnsmasq (домены из списков) и от устройств «всё в туннель»
		'fakedns',
		// собственные запросы Xray (например, при работе напрямую)
		dns_upstream
	]
};

let outbounds = [
	{ tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } }
];
for (let p in proxies)
	push(outbounds, p);
push(outbounds, { tag: 'block', protocol: 'blackhole' });
push(outbounds, { tag: 'dns-out', protocol: 'dns' });

let target;
let use_balancer = false;
if (length(proxies) == 0) {
	warn('vpnroute: нет включённых серверов, трафик из списков пойдёт напрямую\n');
	target = { outboundTag: 'direct' };
}
else if (length(proxies) == 1 && !fallback) {
	target = { outboundTag: proxies[0].tag };
}
else {
	target = { balancerTag: 'vpn' };
	use_balancer = true;
}

let final_rule = { type: 'field', inboundTag: [ 'dns-internal', 'tproxy-in' ] };
for (let k, v in target)
	final_rule[k] = v;

let routing = {
	domainStrategy: 'AsIs',
	rules: [
		{ type: 'field', inboundTag: [ 'dns-in' ], outboundTag: 'dns-out' },
		// «служебный» адрес без известного домена (например, после перезапуска Xray)
		{ type: 'field', ip: [ FAKE_POOL ], outboundTag: 'block' },
		{ type: 'field', ip: BYPASS4, outboundTag: 'direct' },
		final_rule
	]
};

if (use_balancer) {
	let b = { tag: 'vpn', selector: [ 'proxy-' ], strategy: { type: 'leastPing' } };
	if (fallback)
		b.fallbackTag = 'direct';
	routing.balancers = [ b ];
}

let xray = {
	log: { loglevel: loglevel, access: 'none', dnsLog: false },
	dns: dns,
	fakedns: [ { ipPool: FAKE_POOL, poolSize: 65535 } ],
	inbounds: [
		{
			tag: 'dns-in',
			listen: '0.0.0.0',
			port: dns_port,
			protocol: 'dokodemo-door',
			settings: { address: '1.1.1.1', port: 53, network: 'tcp,udp' }
		},
		{
			tag: 'tproxy-in',
			listen: '0.0.0.0',
			port: tp_port,
			protocol: 'dokodemo-door',
			settings: { network: 'tcp,udp', followRedirect: true },
			streamSettings: { sockopt: { tproxy: 'tproxy' } },
			sniffing: { enabled: true, destOverride: [ 'fakedns' ], metadataOnly: true }
		}
	],
	outbounds: outbounds,
	routing: routing
};

if (use_balancer) {
	xray.observatory = {
		subjectSelector: [ 'proxy-' ],
		probeUrl: opt('probe_url', 'https://www.gstatic.com/generate_204'),
		probeInterval: opt('probe_interval', '1m'),
		enableConcurrency: true
	};
}

let xray_text = sprintf('%.J', xray) + '\n';

if (print_only) {
	print(xray_text);
	exit(0);
}

// ---------- правила nftables ----------

function nft_set(name, typ, flags, elems) {
	let s = `\tset ${name} {\n\t\ttype ${typ};\n`;
	if (flags)
		s += `\t\tflags ${flags};\n\t\tauto-merge;\n`;
	if (length(elems))
		s += `\t\telements = { ${join(', ', elems)} }\n`;
	return s + '\t}\n';
}

let lan = join(', ', map(lan_ifaces, (i) => `"${i}"`));

let nft = 'table inet vpnroute\ndelete table inet vpnroute\n\n';
nft += 'table inet vpnroute {\n';
nft += nft_set('bypass4', 'ipv4_addr', 'interval', BYPASS4);
nft += nft_set('dst4', 'ipv4_addr', 'interval', ips);
// «devices» в nftables — зарезервированное слово, поэтому tunnel_macs
nft += nft_set('tunnel_macs', 'ether_addr', null, macs);

nft += '\n\tchain pre_mangle {\n';
nft += '\t\ttype filter hook prerouting priority mangle; policy accept;\n';
nft += `\t\tiifname != { ${lan} } return\n`;
nft += '\t\tmeta nfproto != ipv4 return\n';
nft += '\t\tmeta l4proto != { tcp, udp } return\n';
nft += '\t\tip daddr @bypass4 return\n';
if (dns_hijack)
	nft += '\t\tth dport 53 return\n';
nft += `\t\tip daddr ${FAKE_POOL} goto to_proxy\n`;
nft += '\t\tip daddr @dst4 goto to_proxy\n';
nft += '\t\tether saddr @tunnel_macs goto to_proxy\n';
nft += '\t}\n';

nft += '\n\tchain to_proxy {\n';
nft += `\t\tmeta l4proto tcp tproxy ip to :${tp_port} meta mark set ${fwmark} accept\n`;
nft += `\t\tmeta l4proto udp tproxy ip to :${tp_port} meta mark set ${fwmark} accept\n`;
nft += '\t}\n';

nft += '\n\tchain pre_dns {\n';
nft += '\t\ttype nat hook prerouting priority dstnat - 5; policy accept;\n';
nft += `\t\tiifname != { ${lan} } return\n`;
nft += '\t\tmeta nfproto != ipv4 return\n';
// redirect с портом требует явного протокола в том же правиле
for (let proto in [ 'udp', 'tcp' ])
	nft += `\t\t${proto} dport 53 ether saddr @tunnel_macs redirect to :${dns_port}\n`;
if (dns_hijack)
	for (let proto in [ 'udp', 'tcp' ])
		nft += `\t\t${proto} dport 53 redirect to :53\n`;
nft += '\t}\n';

if (block_ipv6 || block_dot) {
	nft += '\n\tchain fwd_filter {\n';
	nft += '\t\ttype filter hook forward priority filter - 5; policy accept;\n';
	nft += `\t\tiifname != { ${lan} } return\n`;
	if (block_ipv6)
		nft += '\t\tmeta nfproto ipv6 reject\n';
	if (block_dot) {
		nft += '\t\ttcp dport 853 reject with tcp reset\n';
		nft += '\t\tudp dport 853 reject\n';
	}
	nft += '\t}\n';
}

nft += '}\n';

// ---------- файл для dnsmasq ----------

let dm = '# vpnroute: файл создаётся автоматически, не редактируйте\n';
for (let d in domains)
	dm += `server=/${d}/127.0.0.1#${dns_port}\n`;
// Адреса серверов и DoH-сервера Xray всегда резолвим обычным путём
for (let h in server_hosts)
	dm += `server=/${h}/#\n`;
if (block_doh)
	for (let h in DOH_HOSTS)
		if (index(server_hosts, h) < 0)
			dm += `server=/${h}/\n`;

// ---------- запись ----------

if (put(XRAY_FILE, xray_text))
	print('xray\n');
if (put(NFT_FILE, nft))
	print('nft\n');
if (put(DNSMASQ_FILE, dm, true))
	print('dnsmasq\n');
