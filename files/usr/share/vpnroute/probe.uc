#!/usr/bin/ucode
// vpnroute: открывается ли сайт без VPN.
//
//   ucode probe.uc <домен>
//
// Адрес сайта узнаётся у DNS провайдера (как его узнало бы устройство без VPN;
// DNS роутера для сайтов из списков отдаёт служебные адреса FakeDNS).
// Затем https://<домен>/ открывается напрямую и параллельно через VPN
// (SOCKS-вход Xray), чтобы отличить блокировку от недоступного сайта.
// Результат — JSON: { domain, direct_ok, vpn_ok, text, steps: [ { name, ok, text } ], … }.

'use strict';

import { cursor } from 'uci';
import { popen, readfile } from 'fs';

const TIMEOUT = 10;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
// чтобы заметить «зависание», качаем больше 16 КБ, если страница такая большая
const RANGE_BYTES = 65536;
const re_domain = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$/;

function sh(cmd) {
	let p = popen(cmd, 'r');
	if (!p)
		return '';
	let out = p.read('all') || '';
	p.close();
	return trim(out);
}

function isp_dns() {
	let res = [];
	for (let line in split(readfile('/tmp/resolv.conf.d/resolv.conf.auto') || '', '\n')) {
		let m = match(line, /^nameserver[[:space:]]+([0-9.]+)/);
		if (m && m[1] != '127.0.0.1')
			push(res, m[1]);
	}
	return res;
}

// Первый IPv4-адрес из ответа nslookup (после строки Name:)
function resolve(domain, server) {
	let out = sh(`nslookup ${domain} ${server} 2>&1`);
	let seen = false;
	for (let line in split(out, '\n')) {
		if (match(line, /^Name:/))
			seen = true;
		let m = seen && match(line, /^Address[^:]*:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
		if (m)
			return { ip: m[1] };
	}
	let err = match(out, /(NXDOMAIN|SERVFAIL|REFUSED|timed out|no servers could be reached)/i);
	return { error: err ? err[1] : 'нет ответа' };
}

// Запуск curl: возвращает процесс, чтобы прямую проверку и проверку через VPN
// можно было вести одновременно
function curl_start(domain, extra) {
	let cmd = sprintf("curl -sS -o /dev/null --max-time %d --connect-timeout 7 -r 0-%d -A '%s' " +
		"-w '%%{http_code} %%{time_connect} %%{time_appconnect} %%{time_total} %%{size_download} %%{redirect_url}' %s 'https://%s/' 2>&1; echo \" rc=$?\"",
		TIMEOUT, RANGE_BYTES - 1, UA, extra, domain);
	return popen(cmd, 'r');
}

function curl_finish(p) {
	let out = p ? trim(p.read('all') || '') : '';
	if (p)
		p.close();
	let rcm = match(out, /rc=([0-9]+)$/);
	let rc = rcm ? int(rcm[1]) : 1;
	out = trim(replace(out, /rc=[0-9]+$/, ''));
	// curl пишет ошибку в начале, а -w в конце одной строкой
	let err = match(out, /curl: \(([0-9]+)\) ([^\n]*)/);
	let w = match(out, /([0-9]{3}) ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9]+) ?([^[:space:]]*)$/);
	let r = {
		rc: rc,
		code: w ? int(w[1]) : 0,
		connect: w ? +w[2] : 0,
		tls: w ? +w[3] : 0,
		total: w ? +w[4] : 0,
		bytes: w ? int(w[5]) : 0,
		redirect: w ? w[6] : ''
	};
	if (err)
		r.error = err[2];
	r.ok = rc == 0 && r.code > 0;
	// на каком шаге оборвалось
	if (r.ok)
		r.stage = 'ok';
	else if (r.connect == 0)
		r.stage = rc == 28 ? 'no_reply' : 'connect';
	else if (r.tls == 0)
		r.stage = (rc == 35 || rc == 56 || rc == 52) ? 'reset' : 'tls_timeout';
	else
		r.stage = rc == 28 ? (r.bytes >= 10240 && r.bytes <= 30720 ? 'stall' : 'slow') : 'broken';
	return r;
}

// Страница-заглушка провайдера: переадресация на «warning», «blocked» и т. п.
function stub_page(r) {
	return r.redirect && match(r.redirect, /(warning|block|zapret|rkn|eais|restrict|forbidden)/i);
}

let domain = lc(trim(ARGV[0] || ''));
domain = replace(domain, /^[a-z]+:\/\//, '');
domain = replace(domain, /[\/:?#].*$/, '');
if (!match(domain, re_domain)) {
	warn('Использование: vpnroute probe <домен>\n');
	exit(1);
}

let uci = cursor();
uci.load('vpnroute');
let port = int(uci.get('vpnroute', 'main', 'probe_port') || '12702');

// через VPN — сразу, пока идёт проверка напрямую
let vpn_p = curl_start(domain, `-x socks5h://127.0.0.1:${port}`);

let servers = isp_dns();
let dns = { servers: servers };
for (let s in servers) {
	let r = resolve(domain, s);
	if (r.ip) {
		dns.ip = r.ip;
		break;
	}
	dns.error = r.error;
}
// DNS провайдера не отдал адрес — проверяем соединение с адресом от публичного DNS
let ip = dns.ip;
if (!ip) {
	let r = resolve(domain, '8.8.8.8');
	ip = r.ip;
	dns.fallback = r.ip;
}

let direct = { stage: 'no_ip' };
if (ip)
	direct = curl_finish(curl_start(domain, `--noproxy '*' --resolve '${domain}:443:${ip}'`));
direct.ip = ip;
let vpn = curl_finish(vpn_p);

// ---------- вывод: шаги и итог ----------

function sec(x) {
	if (x < 1)
		return sprintf('%d мс', x * 1000);
	return replace(sprintf('%.1f', x), '.', ',') + ' с';
}

let steps = [];
let reasons = [];

if (dns.ip)
	push(steps, { name: 'DNS провайдера', ok: true, text: `адрес ${dns.ip}` });
else {
	push(steps, { name: 'DNS провайдера', ok: false, text: `не отдаёт адрес (${dns.error || 'нет ответа'})` + (dns.fallback ? `, дальше проверяем по адресу от публичного DNS ${dns.fallback}` : '') });
	push(reasons, 'DNS провайдера не отдаёт адрес сайта');
}

if (direct.stage == 'no_ip') {
	push(steps, { name: 'Соединение', ok: false, text: 'не проверено: адрес сайта не нашёлся и у публичного DNS' });
}
else if (direct.stage == 'no_reply' || direct.stage == 'connect') {
	push(steps, { name: 'Соединение', ok: false, text: 'сервер не отвечает' });
	push(reasons, 'сервер не отвечает напрямую, похоже на блокировку по IP-адресу');
}
else {
	push(steps, { name: 'Соединение', ok: true, text: sec(direct.connect) });
	if (direct.stage == 'reset' || direct.stage == 'tls_timeout') {
		push(steps, { name: 'Шифрование (TLS)', ok: false, text: direct.stage == 'reset' ? 'соединение сбрасывается' : 'ответа нет' });
		push(reasons, 'шифрованное подключение не проходит, похоже на блокировку по имени сайта');
	}
	else {
		push(steps, { name: 'Шифрование (TLS)', ok: true, text: sec(direct.tls) });
		if (direct.stage == 'stall') {
			push(steps, { name: 'Загрузка', ok: false, text: sprintf('пришло %d КБ, дальше данные встали', direct.bytes / 1024) });
			push(reasons, 'данные перестают идти после ~16 КБ, похоже на замедление');
		}
		else if (direct.ok && (stub_page(direct) || direct.code == 451)) {
			push(steps, { name: 'Загрузка', ok: false, text: 'страница блокировки провайдера' });
			push(reasons, 'провайдер показывает страницу блокировки');
		}
		else if (direct.ok) {
			push(steps, { name: 'Загрузка', ok: true, text: `ответ ${direct.code} за ${sec(direct.total)}` });
		}
		else {
			push(steps, { name: 'Загрузка', ok: false, text: direct.error || 'ошибка' });
			push(reasons, 'страница не загружается');
		}
	}
}

push(steps, vpn.ok
	? { name: 'Через VPN', ok: true, text: `ответ ${vpn.code} за ${sec(vpn.total)}`, vpn: true }
	: { name: 'Через VPN', ok: false, text: vpn.error || 'не открылся', vpn: true });

let direct_ok = !length(reasons);
let text;
if (direct_ok)
	text = 'Открывается напрямую. VPN для этого сайта сейчас не нужен.';
else {
	let r = join(', ', reasons);
	text = 'Напрямую не открывается: ' + r + '.';
	text += vpn.ok ? ' Через VPN открывается.' : ' Через VPN тоже не открылся: возможно, сайт сейчас недоступен.';
}

print(sprintf('%J', { domain: domain, direct_ok: direct_ok, vpn_ok: vpn.ok, text: text, steps: steps, dns: dns, direct: direct, vpn: vpn }), '\n');
