#!/usr/bin/ucode
// vpnroute: проверка и установка обновлений с GitHub.
//
//   update.uc check    узнать последнюю версию (VERSION в ветке main)
//   update.uc status   состояние в JSON (для LuCI)
//   update.uc run      скачать релиз по тегу vX.Y.Z и установить
//                      (запускается в фоне командой «vpnroute update install»)
//
// Последняя версия берётся из файла VERSION в ветке main через
// raw.githubusercontent.com, а не через API GitHub: у API лимит запросов на
// внешний IP, а за CGNAT его делят многие абоненты. Код скачивается строго по
// тегу, поэтому незаконченные правки из main на роутер не попадают.

'use strict';

import { cursor } from 'uci';
import { readfile, writefile, mkdir, lsdir, stat } from 'fs';

const VERSION_FILE = '/usr/share/vpnroute/VERSION';
const DIR = '/tmp/vpnroute-update';
const STATE = DIR + '/state.json';
const LOG = DIR + '/install.log';
const PID = DIR + '/install.pid';
const SRC = DIR + '/src';

let uci = cursor();
let repo = uci.get('vpnroute', 'main', 'update_repo') || 'evilkuma/vpnroute';
const RAW = `https://raw.githubusercontent.com/${repo}`;
const CODELOAD = `https://codeload.github.com/${repo}/tar.gz/refs/tags`;

mkdir(DIR);

function parse_ver(s) {
	let m = match(trim(s || ''), /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/);
	return m ? [ int(m[1]), int(m[2]), int(m[3]) ] : null;
}

// -1, 0, 1; неизвестная версия считается самой старой
function cmp_ver(a, b) {
	let x = parse_ver(a) || [ 0, 0, 0 ], y = parse_ver(b) || [ 0, 0, 0 ];
	for (let i = 0; i < 3; i++)
		if (x[i] != y[i])
			return x[i] < y[i] ? -1 : 1;
	return 0;
}

function installed() {
	let v = trim(readfile(VERSION_FILE) || '');
	return parse_ver(v) ? v : null;
}

function load_state() {
	try {
		return json(readfile(STATE) || '{}') || {};
	}
	catch (e) {
		return {};
	}
}

function save_state(st) {
	writefile(STATE + '.tmp', sprintf('%J', st));
	system([ 'mv', STATE + '.tmp', STATE ]);
}

function fetch(url, out) {
	return system([ 'uclient-fetch', '-q', '-T', '20', '-O', out, url ]) == 0;
}

function log(msg) {
	let f = readfile(LOG) || '';
	writefile(LOG, f + msg + '\n');
}

// Разделы CHANGELOG.md с версиями из (from, to]
function notes(changelog, from, to) {
	let out = [], take = false;
	for (let line in split(changelog, '\n')) {
		let m = match(line, /^## +v?([0-9]+\.[0-9]+\.[0-9]+)/);
		if (m)
			take = cmp_ver(m[1], from) > 0 && cmp_ver(m[1], to) <= 0;
		if (take)
			push(out, line);
	}
	return trim(join('\n', out));
}

function installing_pid() {
	let pid = trim(readfile(PID) || '');
	return (pid != '' && stat(`/proc/${pid}`)) ? pid : null;
}

function cmd_check() {
	let st = load_state();
	let cur = installed();
	st.checked = time();
	delete st.error;

	let tmp = DIR + '/VERSION';
	if (!fetch(`${RAW}/main/files/usr/share/vpnroute/VERSION`, tmp)) {
		st.error = 'Не удалось получить версию с GitHub: нет связи или в ветке main нет файла VERSION';
		print(`Ошибка: ${st.error}\n`);
		save_state(st);
		return 1;
	}
	let latest = trim(readfile(tmp) || '');
	if (!parse_ver(latest)) {
		st.error = `На GitHub некорректная версия «${latest}»`;
		print(`Ошибка: ${st.error}\n`);
		save_state(st);
		return 1;
	}

	st.latest = latest;
	st.available = cmp_ver(latest, cur) > 0;
	st.notes = '';
	if (st.available) {
		// заодно проверяем, что тег релиза существует
		let cl = DIR + '/CHANGELOG.md';
		if (!fetch(`${RAW}/v${latest}/CHANGELOG.md`, cl)) {
			st.available = false;
			st.error = `Версия ${latest} объявлена, но релиз v${latest} на GitHub не найден`;
		}
		else
			st.notes = notes(readfile(cl) || '', cur, latest);
	}
	save_state(st);

	if (st.error)
		print(`Ошибка: ${st.error}\n`);
	else if (st.available)
		print(`Доступна версия ${latest}, установлена ${cur || 'неизвестная'}\n\n${st.notes}\n`);
	else
		print(`Установлена последняя версия ${cur}\n`);
	return st.error ? 1 : 0;
}

function cmd_status() {
	let st = load_state();
	st.installed = installed();
	st.installing = installing_pid() != null;
	if (st.available && cmp_ver(st.latest, st.installed) <= 0)
		st.available = false;
	let l = readfile(LOG);
	if (l != null)
		st.log = join('\n', slice(split(trim(l), '\n'), -30));
	print(sprintf('%J', st), '\n');
	return 0;
}

function fail(st, msg) {
	log('ОШИБКА: ' + msg);
	st.result = 'error';
	st.error = msg;
	st.finished = time();
	save_state(st);
	system([ 'rm', '-rf', SRC, DIR + '/src.tgz', PID ]);
	return 1;
}

// PID-файл пишет start-stop-daemon (см. «vpnroute update install»),
// он же не даёт запустить второе обновление параллельно
function cmd_run() {
	writefile(LOG, '');
	let st = load_state();
	let from = installed();
	let ver = st.latest;
	st.result = 'running';
	st.started = time();
	delete st.error;
	save_state(st);

	if (!parse_ver(ver) || cmp_ver(ver, from) <= 0)
		return fail(st, 'нет версии для установки, сначала проверьте обновления');

	log(`Обновление ${from || 'неизвестной версии'} → ${ver}`);
	log(`Скачиваю ${CODELOAD}/v${ver}`);
	system([ 'rm', '-rf', SRC ]);
	mkdir(SRC);
	if (!fetch(`${CODELOAD}/v${ver}`, DIR + '/src.tgz'))
		return fail(st, 'не удалось скачать релиз');
	if (system([ 'tar', '-xzf', DIR + '/src.tgz', '-C', SRC ]) != 0)
		return fail(st, 'не удалось распаковать архив');

	let top = lsdir(SRC);
	let root = (top && length(top) == 1) ? `${SRC}/${top[0]}` : null;
	if (!root || !stat(root + '/scripts/install.sh'))
		return fail(st, 'в архиве нет scripts/install.sh');
	let got = trim(readfile(root + '/files/usr/share/vpnroute/VERSION') || '');
	if (got != ver)
		return fail(st, `в архиве версия «${got}», ожидалась ${ver}`);

	log('Устанавливаю');
	// установщик перезапускает rpcd и службу vpnroute; этот процесс отвязан от них
	if (system(`sh '${root}/scripts/install.sh' >>'${LOG}' 2>&1`) != 0)
		return fail(st, 'установщик завершился с ошибкой, подробности в журнале');

	st = load_state();
	st.result = 'ok';
	st.available = false;
	st.finished = time();
	st.notes = '';
	save_state(st);
	log(`Готово: установлена версия ${installed()}`);
	system([ 'rm', '-rf', SRC, DIR + '/src.tgz', PID ]);
	return 0;
}

switch (ARGV[0]) {
case 'check':
	exit(cmd_check());
case 'status':
	exit(cmd_status());
case 'run':
	exit(cmd_run());
default:
	warn('usage: update.uc check | status | run\n');
	exit(1);
}
