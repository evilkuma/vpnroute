// vpnroute: встроенные списки из /usr/share/vpnroute/lists/*.list.
//
// Они входят в состав программы и обновляются вместе с ней. Файл — одна
// запись в строке (домен, IP или подсеть), после # комментарий, первая строка
// «# name: Название». Выключенный список отмечается в настройках опцией
// main.builtin_<id> = '0', поэтому списки из новых версий включены сразу.

'use strict';

import { readfile, lsdir } from 'fs';

const DIR = '/usr/share/vpnroute/lists';

export function builtin_lists(uci) {
	let res = [];
	for (let f in sort(lsdir(DIR) || [])) {
		let m = match(f, /^([a-z0-9_]+)\.list$/);
		if (!m)
			continue;
		let id = m[1];
		let l = { id: id, name: id, enabled: uci.get('vpnroute', 'main', 'builtin_' + id) != '0', domains: [], ips: [] };
		for (let line in split(readfile(`${DIR}/${f}`) || '', '\n')) {
			let n = match(line, /^#\s*name:\s*(.+)$/);
			if (n) {
				l.name = trim(n[1]);
				continue;
			}
			let i = index(line, '#');
			let v = trim(i >= 0 ? substr(line, 0, i) : line);
			if (v == '')
				continue;
			push(match(v, /^[0-9.\/]+$/) ? l.ips : l.domains, v);
		}
		push(res, l);
	}
	return res;
};
