#!/usr/bin/ucode
// vpnroute: поиск доменов, с которых сайт загружает файлы.
//
//   ucode discover.uc <домен>               открыть https://<домен>/ через VPN и разобрать
//   ucode discover.uc parse <файл> <адрес>  разобрать сохранённую страницу (для проверки)
//
// Страница и несколько её скриптов и стилей скачиваются через SOCKS-вход Xray
// на 127.0.0.1 (probe_port), поэтому открываются и заблокированные сайты.
// Результат — JSON: { domain, url, code, hosts: [ { host, strong, weak } ] }.
//   strong — файл подключён страницей (скрипт, стиль, картинка, шрифт, фрейм);
//   weak   — адрес только упоминается в коде скриптов (часто API или CDN).

'use strict';

import { cursor } from 'uci';
import { popen, readfile, unlink } from 'fs';

const MAX_PAGE = 3 * 1024 * 1024;
const MAX_ASSET = 2 * 1024 * 1024;
const MAX_ASSETS = 5;
// LuCI ждёт ответа около 30 секунд: укладываемся с запасом
const DEADLINE = 22;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

// служебные адреса из разметки, а не загрузки
const NOISE = [ 'w3.org', 'schema.org', 'ogp.me', 'xmlns.com', 'purl.org', 'json-schema.org', 'example.com',
	'example.org', 'localhost', 'mozilla.org', 'whatwg.org', 'reactjs.org', 'react.dev', 'github.com' ];

const re_domain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9]$/;

function sh_quote(s) {
	return "'" + replace(s, /'/g, "'\\''") + "'";
}

function norm_host(h) {
	h = lc(trim(h || ''));
	h = replace(h, /\.$/, '');
	if (!match(h, re_domain))
		return null;
	// локальные и служебные зоны в интернет не ведут
	if (match(h, /\.(local|lan|home|internal|localdomain|localhost|arpa|test|invalid|example|onion)$/))
		return null;
	for (let n in NOISE)
		if (h == n || substr(h, -length(n) - 1) == '.' + n)
			return null;
	return h;
}

function host_of(url) {
	let m = match(url, /^(https?:)?\/\/([^\/:?#"'\\]+)/i);
	return m ? norm_host(m[2]) : null;
}

function origin_of(url) {
	let m = match(url, /^(https?:\/\/[^\/?#]+)/i);
	return m ? m[1] : null;
}

// Адрес ресурса относительно страницы
function resolve(u, base) {
	u = trim(u);
	if (match(u, /^https?:\/\//i))
		return u;
	if (substr(u, 0, 2) == '//')
		return 'https:' + u;
	if (match(u, /^[a-z][a-z0-9+.-]*:/i) || substr(u, 0, 1) == '#' || u == '')
		return null;
	let origin = origin_of(base);
	if (!origin)
		return null;
	if (substr(u, 0, 1) == '/')
		return origin + u;
	let path = substr(base, length(origin));
	path = replace(path, /[?#].*$/, '');
	path = replace(path, /[^\/]*$/, '');
	if (path == '')
		path = '/';
	return origin + path + u;
}

let fetch_no = 0;

function fetch(url, max, timeout, port) {
	if (!match(url, /^https?:\/\/[^[:space:]'"`$\\]+$/))
		return { error: 'недопустимый адрес' };
	let tmp = sprintf('/tmp/vpnroute-discover.%d.%d', time(), ++fetch_no);
	let cmd = sprintf("curl -sS -L --max-redirs 5 --connect-timeout 8 --max-time %d --max-filesize %d " +
		"-A %s -H 'Accept-Language: ru,en;q=0.8' -H 'Accept-Encoding: identity' " +
		"-x socks5h://127.0.0.1:%d -o %s -w '%%{url_effective} %%{http_code}' %s 2>&1",
		timeout, max, sh_quote(UA), port, tmp, sh_quote(url));
	let p = popen(cmd, 'r');
	let out = p ? trim(p.read('all') || '') : '';
	let rc = p ? p.close() : -1;
	let body = readfile(tmp, max) || '';
	unlink(tmp);
	let m = match(out, /([^[:space:]]+) ([0-9]{3})$/);
	if (rc != 0 && !length(body))
		return { error: replace(out, /^curl: \([0-9]+\) /, '') || 'не удалось открыть' };
	return { url: m ? m[1] : url, code: m ? int(m[2]) : 0, body: body };
}

// ---------- разбор ----------

let found = {};
let page_host = null, site = null;

function add(host, kind) {
	if (!host)
		return;
	// домен самого сайта и его поддомены покрывает одна запись
	if (site && (host == site || substr(host, -length(site) - 1) == '.' + site))
		return;
	if (!found[host])
		found[host] = { host: host, strong: 0, weak: 0 };
	found[host][kind]++;
}

// Все адреса вида //host в тексте (в том числе экранированные https:\/\/host)
function scan_text(text, kind) {
	for (let m in match(text, /(https?:)?\\?\/\\?\/([a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*)/gi))
		add(norm_host(m[2]), kind);
}

// Подключаемые ресурсы: теги со ссылками на файлы и url() в стилях
function scan_html(html, base, assets) {
	for (let t in match(html, /<(script|link|img|iframe|source|video|audio|embed|object|image|use)[[:space:]][^>]*>/gi)) {
		let tag = t[0];
		let name = lc(t[1]);
		if (name == 'link' && match(tag, /rel[[:space:]]*=[[:space:]]*["']?(canonical|alternate|next|prev|author|license|search)/i))
			continue;
		for (let a in match(tag, /(src|href|data-src|srcset|data|poster|xlink:href)[[:space:]]*=[[:space:]]*["']?([^"'[:space:]>]+)/gi)) {
			let u = resolve(a[2], base);
			if (!u)
				continue;
			add(host_of(u), 'strong');
			let is_js = name == 'script';
			let is_css = name == 'link' && match(tag, /stylesheet/i);
			if ((is_js || is_css) && length(assets) < 40)
				push(assets, { url: u, css: !!is_css });
		}
	}
	for (let m in match(html, /url\([[:space:]]*["']?([^"')[:space:]]+)/gi))
		add(host_of(resolve(m[1], base) || ''), 'strong');
	for (let m in match(html, /content[[:space:]]*=[[:space:]]*["'](https?:\/\/[^"']+)/gi))
		add(host_of(m[1]), 'strong');

	// встроенные скрипты: адреса API и CDN
	let pos = 0;
	while (true) {
		let i = index(substr(html, pos), '<script');
		if (i < 0)
			break;
		let start = pos + i;
		let gt = index(substr(html, start), '>');
		if (gt < 0)
			break;
		let body_start = start + gt + 1;
		let end = index(substr(html, body_start), '</script');
		if (end < 0)
			break;
		scan_text(substr(html, body_start, end), 'weak');
		pos = body_start + end;
	}
}

function result(extra) {
	let hosts = [];
	for (let h, v in found)
		push(hosts, v);
	hosts = sort(hosts, (a, b) => (b.strong - a.strong) || (b.weak - a.weak) || (a.host < b.host ? -1 : 1));
	let res = { hosts: hosts };
	for (let k, v in extra)
		res[k] = v;
	print(sprintf('%J', res), '\n');
}

// ---------- запуск ----------

if (ARGV[0] == 'parse') {
	let html = readfile(ARGV[1]) || '';
	site = norm_host(host_of(ARGV[2]));
	let assets = [];
	scan_html(html, ARGV[2], assets);
	result({ url: ARGV[2], assets: map(assets, (a) => a.url) });
	exit(0);
}

let domain = norm_host(ARGV[0]);
if (!domain) {
	warn('Использование: vpnroute discover <домен>\n');
	exit(1);
}
site = domain;

let uci = cursor();
uci.load('vpnroute');
let port = int(uci.get('vpnroute', 'main', 'probe_port') || '12702');

let started = time();
let page = fetch(`https://${domain}/`, MAX_PAGE, 10, port);
if (page.error) {
	// часть сайтов открывается только с www
	let alt = fetch(`https://www.${domain}/`, MAX_PAGE, 8, port);
	if (alt.error) {
		result({ domain: domain, error: page.error });
		exit(0);
	}
	page = alt;
}

let final_host = host_of(page.url);
// после переадресации сайт мог оказаться на другом домене
if (final_host && final_host != domain && substr(final_host, -length(domain) - 1) != '.' + domain) {
	add(final_host, 'strong');
	found[final_host].redirect = true;
}

let assets = [];
scan_html(page.body, page.url, assets);

// скрипты и стили: сначала свои (там адреса API), затем чужие
let own = filter(assets, (a) => { let h = host_of(a.url); return h && (h == final_host || h == domain || substr(h, -length(domain) - 1) == '.' + domain); });
let other = filter(assets, (a) => index(own, a) < 0);
let fetched = 0;
for (let a in [ ...own, ...other ]) {
	let left = DEADLINE - (time() - started);
	if (fetched >= MAX_ASSETS || left < 3)
		break;
	let r = fetch(a.url, MAX_ASSET, left < 6 ? left : 6, port);
	if (r.error || !length(r.body))
		continue;
	fetched++;
	if (a.css) {
		for (let m in match(r.body, /url\([[:space:]]*["']?([^"')[:space:]]+)/gi))
			add(host_of(resolve(m[1], r.url) || ''), 'strong');
		for (let m in match(r.body, /@import[[:space:]]+["']([^"']+)/gi))
			add(host_of(resolve(m[1], r.url) || ''), 'strong');
	}
	else {
		scan_text(r.body, 'weak');
	}
}

result({ domain: domain, url: page.url, code: page.code, fetched: fetched });
