#!/usr/bin/ucode
// vpnroute: диагностика трафика одного устройства.
//
//   ucode trace.uc run <ip> <секунды>   сбор данных (запускает служба vpnroute-trace)
//   ucode trace.uc devices              список устройств локальной сети в JSON
//
// Раз в секунду читает таблицу соединений ядра (/proc/net/nf_conntrack) и
// журнал DNS-запросов dnsmasq (включается на время сеанса), определяет
// статус каждого соединения и пишет результат в /tmp/vpnroute-trace/state.json.

'use strict';

import { cursor } from 'uci';
import { readfile, writefile, rename, mkdir, open, unlink } from 'fs';

const STATE_DIR = '/tmp/vpnroute-trace';
const STATE_FILE = STATE_DIR + '/state.json';
const DNS_LOG = '/var/run/dnsmasq/vpnroute-trace.log';
const MAX_FLOWS = 1500;
const MAX_DNS = 800;

const FAKE_NET = [ 0xc6120000, 15 ];   // 198.18.0.0/15
const LOCAL_NETS = [
	[ 0x00000000, 8 ], [ 0x0a000000, 8 ], [ 0x64400000, 10 ], [ 0x7f000000, 8 ],
	[ 0xa9fe0000, 16 ], [ 0xac100000, 12 ], [ 0xc0a80000, 16 ], [ 0xe0000000, 4 ],
	[ 0xf0000000, 4 ]
];

// ---------- вспомогательные ----------

function ip2int(s) {
	let m = match(s, /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/);
	if (!m)
		return null;
	return (int(m[1]) << 24) | (int(m[2]) << 16) | (int(m[3]) << 8) | int(m[4]);
}

function in_net(n, net) {
	if (n == null)
		return false;
	let bits = net[1];
	let mask = (bits == 0) ? 0 : ((0xffffffff << (32 - bits)) & 0xffffffff);
	return (n & mask) == (net[0] & mask);
}

function in_any(n, nets) {
	for (let net in nets)
		if (in_net(n, net))
			return true;
	return false;
}

function aslist(v) {
	if (v == null)
		return [];
	return type(v) == 'array' ? v : [ v ];
}

function leases() {
	let res = [];
	let seen = {};
	for (let line in split(readfile('/tmp/dhcp.leases') || '', '\n')) {
		let f = split(trim(line), ' ');
		if (length(f) < 4)
			continue;
		let mac = lc(f[1]);
		push(res, { ip: f[2], mac: mac, name: (f[3] == '*') ? '' : f[3] });
		seen[f[2]] = true;
	}
	// устройства со статическими адресами — из таблицы ARP
	for (let line in split(readfile('/proc/net/arp') || '', '\n')) {
		let f = split(replace(trim(line), /\s+/g, ' '), ' ');
		if (length(f) < 6 || f[0] == 'IP' || seen[f[0]] || f[3] == '00:00:00:00:00:00')
			continue;
		if (!match(f[5], /^br-/))
			continue;
		push(res, { ip: f[0], mac: lc(f[3]), name: '' });
		seen[f[0]] = true;
	}
	return res;
}

// ---------- режим devices ----------

if (ARGV[0] == 'devices') {
	print(sprintf('%J', leases()), '\n');
	exit(0);
}

if (ARGV[0] != 'run' || !ARGV[1] || !ARGV[2]) {
	warn('usage: trace.uc run <ip> <seconds> | devices\n');
	exit(1);
}

// ---------- режим run ----------

let dev_ip = ARGV[1];
let duration = int(ARGV[2]);
let started = time();
let ends = started + duration;

let dev = { ip: dev_ip, mac: '', name: '' };
for (let l in leases())
	if (l.ip == dev_ip)
		dev = l;

// Что идёт через VPN: служебные адреса FakeDNS, IP из списков,
// или всё, если устройство в режиме «весь трафик через VPN»
let uci = cursor();
uci.load('vpnroute');

let vpn_nets = [];
uci.foreach('vpnroute', 'list', (s) => {
	if (s.enabled == '0')
		return;
	for (let a in aslist(s.ip)) {
		let m = match(trim(split(a, '#')[0]), /^([0-9.]+)(\/([0-9]+))?$/);
		if (m && ip2int(m[1]) != null)
			push(vpn_nets, [ ip2int(m[1]), m[3] ? int(m[3]) : 32 ]);
	}
});

let dev_all_vpn = false;
uci.foreach('vpnroute', 'device', (s) => {
	if (s.enabled == '1' && lc(s.mac || '') == dev.mac && dev.mac != '')
		dev_all_vpn = true;
});
let vpn_enabled = uci.get('vpnroute', 'main', 'enabled') == '1';

function route_of(dst) {
	let n = ip2int(dst);
	if (in_any(n, LOCAL_NETS))
		return 'local';
	if (!vpn_enabled)
		return 'direct';
	if (dev_all_vpn || in_net(n, FAKE_NET) || in_any(n, vpn_nets))
		return 'vpn';
	return 'direct';
}

// ---------- состояние сеанса ----------

let flows = {};        // ключ соединения -> запись
let flow_order = [];   // ключи в порядке появления
let next_id = 1;

let dns_rows = [];     // запросы в порядке появления
let dns_by_serial = {};
let ip_names = {};     // адрес -> домен (по ответам DNS этому устройству)

let dns_off = 0;
let dns_tail = '';

// ---------- журнал DNS ----------

function dns_row_add(serial, t, qtype, name) {
	let r = { t: t, name: name, qtype: qtype, answer: '', st: 'wait', route: 'direct' };
	dns_by_serial[serial] = r;
	push(dns_rows, r);
	if (length(dns_rows) > MAX_DNS) {
		let old = shift(dns_rows);
		for (let k, v in dns_by_serial)
			if (v === old)
				delete dns_by_serial[k];
	}
}

function dns_line(line) {
	// Oct 24 18:04:02 dnsmasq[1]: 5 192.168.2.1/60642 reply www.github.com is 1.2.3.4
	let m = match(line, /dnsmasq\[[0-9]+\]: ([0-9]+) ([0-9.]+)\/[0-9]+ (\S+) (\S+) (is|from|to) (.+)$/);
	if (!m || m[2] != dev_ip)
		return;

	let serial = m[1], action = m[3], name = lc(m[4]), value = trim(m[6]);
	let qm = match(action, /^query\[(.+)\]$/);
	if (qm) {
		// записываем только A-запросы: AAAA, HTTPS и прочие только шумят
		if (qm[1] == 'A')
			dns_row_add(serial, time(), qm[1], name);
		return;
	}

	let r = dns_by_serial[serial];
	if (!r)
		return;

	if (action == 'forwarded') {
		r.route = match(value, /^127\.0\.0\.1#/) ? 'vpn' : 'direct';
		return;
	}

	if (action == 'reply' || action == 'cached' || action == 'config') {
		if (value == '<CNAME>')
			return;
		if (ip2int(value) != null) {
			r.answer = r.answer ? `${r.answer}, ${value}` : value;
			r.st = 'ok';
			ip_names[value] = r.name;
			if (in_net(ip2int(value), FAKE_NET))
				r.route = 'vpn';
			return;
		}
		// NXDOMAIN, NODATA, SERVFAIL, REFUSED…
		let code = lc(value);
		if (action == 'config' && code == 'nxdomain')
			r.st = 'blocked';           // заблокировано настройками роутера (DoH и т. п.)
		else if (index(code, 'nodata') == 0)
			r.st = (r.st == 'ok') ? 'ok' : 'nodata';
		else if (r.st != 'ok')
			r.st = code;
	}
}

function read_dns() {
	let f = open(DNS_LOG, 'r');
	if (!f)
		return;
	f.seek(dns_off);
	let chunk = f.read('all');
	f.close();
	if (!chunk || chunk == '')
		return;
	dns_off += length(chunk);
	let lines = split(dns_tail + chunk, '\n');
	dns_tail = pop(lines);   // последняя строка может быть неполной
	for (let l in lines)
		dns_line(l);
}

// ---------- таблица соединений ----------

function parse_ct(line) {
	// поля разделены несколькими пробелами
	let tok = split(trim(line), /\s+/);
	if (length(tok) < 6)
		return null;
	let proto = tok[2];
	if (proto != 'tcp' && proto != 'udp')
		return null;

	let c = { proto: proto, state: (proto == 'tcp') ? tok[5] : '', unreplied: false };
	let seen = {};
	for (let t in tok) {
		if (t == '[UNREPLIED]') {
			c.unreplied = true;
			continue;
		}
		let i = index(t, '=');
		if (i <= 0)
			continue;
		let k = substr(t, 0, i), v = substr(t, i + 1);
		if (k == 'src' || k == 'dst' || k == 'sport' || k == 'dport' || k == 'packets' || k == 'bytes') {
			// первое вхождение — исходное направление, второе — ответное
			let dir = seen[k] ? 'r' : 'o';
			seen[k] = true;
			c[dir + k] = v;
		}
	}
	return c;
}

// В ucode функция должна быть объявлена до места вызова
function classify_raw(f, now) {
	let age = now - f.t0;

	if (f.proto == 'tcp') {
		if (f.state == 'SYN_SENT' || (f.unreplied && f.dpk == 0))
			return (age >= 3) ? 'no_reply' : 'active';
		if (f.state == 'CLOSE' && f.down < 2000 && f.up > 0 && (f.t1 - f.t0) < 15)
			return 'reset';
		if (f.dport == 443 && f.down >= 12288 && f.down <= 24576 &&
		    now - f.down_changed >= 15 && f.state != 'TIME_WAIT')
			return 'stall';
		return 'ok';
	}

	// UDP
	if (f.dpk == 0)
		return (age >= 3) ? ((f.dport == 443) ? 'quic' : 'no_reply') : 'active';
	return 'ok';
}

function classify(f, now) {
	if (f.route == 'local')
		return 'local';
	let st = classify_raw(f, now);
	// Соединения через VPN держит сам Xray на роутере: сброс там значит
	// «закрыто Xray или приложением», а зависание — не замедление провайдера
	if (f.route == 'vpn') {
		if (st == 'reset')
			return 'closed';
		if (st == 'stall')
			return 'ok';
	}
	return st;
}

function read_ct(now) {
	let data = readfile('/proc/net/nf_conntrack');
	if (!data)
		return;
	let needle = ` src=${dev_ip} `;
	let live = {};

	for (let line in split(data, '\n')) {
		if (index(line, needle) < 0)
			continue;
		let c = parse_ct(line);
		if (!c || c.osrc != dev_ip)
			continue;

		let key = `${c.proto} ${c.osport} ${c.odst} ${c.odport}`;
		live[key] = true;
		let f = flows[key];
		if (!f) {
			f = {
				id: next_id++, t0: now, t1: now, proto: c.proto,
				dst: c.odst, dport: int(c.odport),
				domain: ip_names[c.odst] || '',
				up: 0, down: 0, upk: 0, dpk: 0,
				state: '', unreplied: false, down_changed: now,
				route: route_of(c.odst), st: 'active'
			};
			flows[key] = f;
			push(flow_order, key);
			if (length(flow_order) > MAX_FLOWS)
				delete flows[shift(flow_order)];
		}

		let down = int(c.rbytes || 0);
		if (down != f.down)
			f.down_changed = now;
		f.up = int(c.obytes || 0);
		f.down = down;
		f.upk = int(c.opackets || 0);
		f.dpk = int(c.rpackets || 0);
		f.state = c.state;
		f.unreplied = c.unreplied;
		f.t1 = now;
		if (f.domain == '' && ip_names[f.dst])
			f.domain = ip_names[f.dst];
		f.st = classify(f, now);
	}

	// соединения, которых уже нет в таблице: статус фиксируется,
	// «ещё не ясно» превращается в окончательный
	for (let key in flow_order) {
		let f = flows[key];
		if (f && !live[key] && f.st == 'active')
			f.st = classify(f, now + 3);
	}
}

// ---------- запись результата ----------

function save(ended) {
	let fl = [];
	for (let key in flow_order) {
		let f = flows[key];
		if (f)
			push(fl, [ f.id, f.t0, f.t1, f.proto, f.dst, f.dport, f.domain, f.up, f.down, f.route, f.st ]);
	}
	let dn = [];
	let now = time();
	for (let r in dns_rows) {
		if (r.st == 'wait' && now - r.t >= 5)
			r.st = 'no_answer';
		push(dn, [ r.t, r.name, r.answer, r.route, r.st ]);
	}
	let state = {
		v: 1,
		device: dev,
		all_vpn: dev_all_vpn,
		started: started,
		ends: ends,
		updated: now,
		ended: ended,
		flows: fl,
		dns: dn
	};
	writefile(STATE_FILE + '.tmp', sprintf('%J', state));
	rename(STATE_FILE + '.tmp', STATE_FILE);
}

// ---------- основной цикл ----------

mkdir(STATE_DIR);
let tick = 0;
while (time() < ends) {
	let now = time();
	read_dns();
	read_ct(now);
	if (tick % 2 == 0)
		save(false);
	tick++;
	sleep(1000);
}

read_dns();
read_ct(time());
save(true);

// Время вышло: выключить журнал DNS и остановить службу
system('/usr/bin/vpnroute trace stop --from-collector >/dev/null 2>&1');
