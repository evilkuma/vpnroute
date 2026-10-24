'use strict';
'require view';
'require fs';
'require ui';
'require dom';
'require poll';
'require uci';

const CLI = '/usr/bin/vpnroute';
const MAX_ROWS = 400;

const STATUS = {
	ok:        { icon: '✅', text: 'Работает' },
	active:    { icon: '⏳', text: 'Устанавливается' },
	no_reply:  { icon: '⛔', text: 'Нет ответа', problem: true },
	reset:     { icon: '⛔', text: 'Сброс соединения', problem: true },
	stall:     { icon: '⚠️', text: 'Зависание ~16 КБ', problem: true },
	quic:      { icon: '⚠️', text: 'QUIC без ответа', problem: true },
	closed:    { icon: '·',  text: 'Закрыто (VPN)' },
	local:     { icon: '·',  text: 'Локальная сеть' },
	wait:      { icon: '⏳', text: 'DNS: ждём ответ' },
	nxdomain:  { icon: '⛔', text: 'DNS: домен не найден', problem: true },
	servfail:  { icon: '⛔', text: 'DNS: ошибка сервера', problem: true },
	refused:   { icon: '⛔', text: 'DNS: отказ', problem: true },
	no_answer: { icon: '⛔', text: 'DNS: нет ответа', problem: true },
	nodata:    { icon: '·',  text: 'DNS: нет записи' },
	blocked:   { icon: '🚫', text: 'Заблокировано роутером' }
};

// Чем больше, тем «хуже» статус: так выбирается статус группы
const SEVERITY = { local: 0, nodata: 0, blocked: 1, ok: 1, closed: 1, active: 2, wait: 2, quic: 3, stall: 4, reset: 5, no_reply: 5, no_answer: 5, refused: 5, servfail: 5, nxdomain: 6 };

const STATUS_FILTERS = [
	[ 'all', 'Все' ],
	[ 'problems', 'Только проблемы' ],
	[ 'no_reply', 'Нет ответа' ],
	[ 'reset', 'Сброс соединения' ],
	[ 'stall', 'Зависание' ],
	[ 'quic', 'QUIC без ответа' ],
	[ 'dns_err', 'Ошибки DNS' ],
	[ 'ok', 'Работает' ]
];

function run(args) {
	return fs.exec(CLI, args).then(function(res) {
		const out = (res.stdout || '').trim();
		if (res.code !== 0)
			throw new Error((res.stderr || out || ('код ' + res.code)).trim());
		return out;
	});
}

function fmtBytes(n) {
	if (n == null)
		return '—';
	if (n < 1024)
		return n + ' Б';
	if (n < 1048576)
		return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
	return (n / 1048576).toFixed(1) + ' МБ';
}

function fmtTime(t) {
	return new Date(t * 1000).toLocaleTimeString('ru-RU');
}

function fmtLeft(sec) {
	sec = Math.max(0, sec);
	return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function isIp(s) {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(s || '');
}

// Варианты для добавления в список: домен и его родительские домены
function candidates(value) {
	if (isIp(value)) {
		const p = value.split('.');
		return { list: [ value, p[0] + '.' + p[1] + '.' + p[2] + '.0/24' ], def: value };
	}
	const parts = value.split('.');
	const list = [];
	for (let i = 0; i < parts.length - 1; i++)
		list.push(parts.slice(i).join('.'));
	// по умолчанию — домен второго уровня (или третьего для com.ru, co.uk и т. п.)
	let def = parts.slice(-2).join('.');
	if (parts.length > 2 && [ 'com', 'net', 'org', 'co', 'gov', 'edu', 'ac' ].indexOf(parts[parts.length - 2]) >= 0)
		def = parts.slice(-3).join('.');
	return { list: list, def: def };
}

return view.extend({
	data: null,
	devices: [],
	filters: { status: 'all', route: 'all', proto: 'all', search: '', hideLocal: true, group: true },

	load: function() {
		return Promise.all([
			uci.load('vpnroute'),
			run([ 'trace', 'devices' ]).then(JSON.parse).catch(function() { return []; }),
			run([ 'trace', 'dump' ]).then(JSON.parse).catch(function() { return { running: false, state: null }; })
		]);
	},

	// ---------- данные ----------

	rows: function() {
		const st = this.data && this.data.state;
		if (!st)
			return [];
		const rows = [];
		(st.flows || []).forEach(function(f) {
			rows.push({ kind: 'flow', t: f[1], t1: f[2], proto: f[3], dst: f[4], dport: f[5], domain: f[6], up: f[7], down: f[8], route: f[9], st: f[10] });
		});
		(st.dns || []).forEach(function(d) {
			rows.push({ kind: 'dns', t: d[0], t1: d[0], proto: 'dns', dst: d[2], dport: null, domain: d[1], up: null, down: null, route: d[3], st: d[4] });
		});
		return rows;
	},

	matches: function(r) {
		const f = this.filters;
		if (f.hideLocal && r.route === 'local')
			return false;
		if (f.route !== 'all' && r.route !== f.route)
			return false;
		if (f.proto !== 'all' && r.proto !== f.proto)
			return false;
		if (f.status === 'problems' && !(STATUS[r.st] && STATUS[r.st].problem))
			return false;
		if (f.status === 'dns_err' && !(r.kind === 'dns' && STATUS[r.st] && STATUS[r.st].problem))
			return false;
		if ([ 'all', 'problems', 'dns_err' ].indexOf(f.status) < 0 && r.st !== f.status)
			return false;
		if (f.search) {
			const q = f.search.toLowerCase();
			if ((r.domain || '').indexOf(q) < 0 && (r.dst || '').indexOf(q) < 0)
				return false;
		}
		return true;
	},

	grouped: function(rows) {
		const groups = {};
		const order = [];
		rows.forEach(function(r) {
			const key = r.domain || r.dst || '?';
			let g = groups[key];
			if (!g) {
				g = groups[key] = { kind: 'group', key: key, domain: r.domain, dst: r.dst, dport: r.dport, t: r.t, t1: r.t1,
					protos: {}, up: 0, down: 0, routes: {}, st: r.st, count: 0, stats: {} };
				order.push(g);
			}
			g.count++;
			g.protos[r.proto] = true;
			g.routes[r.route] = true;
			g.up += r.up || 0;
			g.down += r.down || 0;
			g.t = Math.min(g.t, r.t);
			g.t1 = Math.max(g.t1, r.t1);
			g.stats[r.st] = (g.stats[r.st] || 0) + 1;
			if ((SEVERITY[r.st] || 0) > (SEVERITY[g.st] || 0))
				g.st = r.st;
			if (!g.dst && r.dst)
				g.dst = r.dst;
		});
		return order;
	},

	// ---------- отрисовка ----------

	statusCell: function(st, stats) {
		const s = STATUS[st] || { icon: '?', text: st };
		const el = E('span', { 'title': s.text }, [ s.icon, ' ', s.text ]);
		if (stats) {
			const parts = Object.keys(stats).filter(function(k) { return k !== st; }).map(function(k) {
				return (STATUS[k] ? STATUS[k].text : k) + ': ' + stats[k];
			});
			if (parts.length)
				return E('span', {}, [ el, E('br'), E('small', { 'style': 'opacity:.7' }, parts.join(', ')) ]);
		}
		return el;
	},

	addButton: function(value) {
		if (!value || value === '?' || /^198\.1[89]\./.test(value))
			return '';
		return E('button', {
			'class': 'cbi-button cbi-button-add',
			'style': 'padding:0 8px',
			'title': _('Добавить в список VPN'),
			'click': ui.createHandlerFn(this, 'showAddModal', value)
		}, '+');
	},

	renderTable: function() {
		const self = this;
		let rows = this.rows().filter(L.bind(this.matches, this));
		rows.sort(function(a, b) { return b.t - a.t; });

		const total = rows.length;
		let items = this.filters.group ? this.grouped(rows) : rows;
		const shown = items.slice(0, MAX_ROWS);

		const head = E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('Время')),
			E('th', { 'class': 'th' }, _('Домен')),
			E('th', { 'class': 'th' }, _('Адрес')),
			E('th', { 'class': 'th' }, _('Прот.')),
			E('th', { 'class': 'th' }, _('↑ / ↓')),
			E('th', { 'class': 'th' }, _('Путь')),
			E('th', { 'class': 'th' }, _('Статус')),
			E('th', { 'class': 'th' }, '')
		]);

		const body = shown.map(function(r) {
			const group = r.kind === 'group';
			const proto = group ? Object.keys(r.protos).join(', ').toUpperCase() : r.proto.toUpperCase();
			const routes = group ? Object.keys(r.routes) : [ r.route ];
			const route = routes.length > 1 ? _('смешанный') : (routes[0] === 'vpn' ? 'VPN' : (routes[0] === 'local' ? _('локальный') : _('напрямую')));
			let addr = r.dst ? (r.dport ? r.dst + ':' + r.dport : r.dst) : '—';
			if (group && r.count > 1)
				addr += ' ' + _('(соединений: %d)').format(r.count);
			const traffic = (r.up == null && r.down == null) || (group && !r.protos.tcp && !r.protos.udp)
				? '—' : fmtBytes(r.up) + ' / ' + fmtBytes(r.down);
			const target = r.domain || r.dst;

			return E('tr', { 'class': 'tr' + (STATUS[r.st] && STATUS[r.st].problem ? ' cbi-rowstyle-2' : '') }, [
				E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, fmtTime(group ? r.t1 : r.t)),
				E('td', { 'class': 'td', 'style': 'word-break:break-all' }, r.domain || E('em', { 'style': 'opacity:.6' }, _('неизвестен'))),
				E('td', { 'class': 'td', 'style': 'word-break:break-all' }, addr),
				E('td', { 'class': 'td' }, proto),
				E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, traffic),
				E('td', { 'class': 'td' }, route),
				E('td', { 'class': 'td' }, self.statusCell(r.st, group ? r.stats : null)),
				E('td', { 'class': 'td' }, routes.indexOf('vpn') >= 0 && routes.length === 1 ? '' : self.addButton(target))
			]);
		});

		const note = items.length > MAX_ROWS
			? E('p', { 'class': 'cbi-value-description' }, _('Показано %d из %d. Уточните фильтры.').format(MAX_ROWS, items.length))
			: E('p', { 'class': 'cbi-value-description' }, this.filters.group
				? _('Групп: %d, записей: %d').format(items.length, total)
				: _('Записей: %d').format(total));

		if (!body.length)
			return E('div', {}, [ E('p', { 'style': 'padding:1em 0' }, this.data && this.data.state ? _('Нет записей под выбранные фильтры') : _('Записей пока нет')) ]);

		return E('div', {}, [ note, E('table', { 'class': 'table' }, [ head ].concat(body)) ]);
	},

	renderSummary: function() {
		const d = this.data || {};
		const st = d.state;
		if (d.error)
			return E('div', { 'class': 'alert-message warning' },
				_('Запись прервалась из-за ошибки: %s').format(d.error));
		if (d.running && st) {
			const dev = st.device || {};
			return E('span', {}, [
				E('strong', { 'style': 'color:#c62828' }, '● ' + _('Идёт запись')), ' — ',
				(dev.name || dev.ip) + (dev.name ? ' (' + dev.ip + ')' : ''),
				', ' + _('осталось %s').format(fmtLeft(st.ends - Math.floor(Date.now() / 1000))),
				st.all_vpn ? ' — ' + _('у устройства включён режим «весь трафик через VPN»') : ''
			]);
		}
		if (st) {
			const dev = st.device || {};
			return E('span', {}, _('Последний сеанс: %s, %s – %s').format(
				dev.name || dev.ip, new Date(st.started * 1000).toLocaleString('ru-RU'), fmtTime(st.updated)));
		}
		return E('span', {}, _('Сеансов ещё не было'));
	},

	refresh: function() {
		return run([ 'trace', 'dump' ]).then(JSON.parse).then(L.bind(function(d) {
			this.data = d;
			this.update();
			if (!d.running)
				this.stopPolling();
		}, this)).catch(function() {});
	},

	update: function() {
		const summary = document.getElementById('vrt-summary');
		const table = document.getElementById('vrt-table');
		if (!summary || !table)
			return;
		dom.content(summary, this.renderSummary());
		dom.content(table, this.renderTable());
		const btn = document.getElementById('vrt-toggle');
		if (btn) {
			const running = this.data && this.data.running;
			btn.textContent = running ? _('■ Остановить') : _('▶ Начать запись');
			btn.className = 'cbi-button ' + (running ? 'cbi-button-reset' : 'cbi-button-apply');
		}
	},

	startPolling: function() {
		if (!this.pollFn) {
			this.pollFn = L.bind(this.refresh, this);
			poll.add(this.pollFn, 2);
		}
	},

	stopPolling: function() {
		if (this.pollFn) {
			poll.remove(this.pollFn);
			this.pollFn = null;
		}
	},

	toggle: function() {
		if (this.data && this.data.running)
			return run([ 'trace', 'stop' ]).then(L.bind(this.refresh, this));

		const ip = document.getElementById('vrt-device').value;
		const min = document.getElementById('vrt-duration').value;
		if (!ip) {
			ui.addNotification(null, E('p', _('Выберите устройство')), 'warning');
			return;
		}
		return run([ 'trace', 'start', ip, min ]).then(L.bind(function() {
			this.data = { running: true, state: null };
			this.update();
			this.startPolling();
		}, this)).catch(function(e) {
			ui.addNotification(null, E('p', e.message), 'danger');
		});
	},

	// ---------- окно «Добавить в список» ----------

	showAddModal: function(value) {
		const self = this;
		const c = candidates(value);
		const lists = uci.sections('vpnroute', 'list');

		const radios = c.list.map(function(v) {
			return E('label', { 'style': 'display:block;margin:4px 0' }, [
				E('input', { 'type': 'radio', 'name': 'vrt-cand', 'value': v, 'checked': v === c.def ? '' : null }), ' ',
				E('code', {}, v),
				v === c.def ? E('small', { 'style': 'opacity:.7' }, ' — ' + _('рекомендуется')) : ''
			]);
		});

		const select = E('select', { 'class': 'cbi-input-select', 'id': 'vrt-list' },
			lists.map(function(s) {
				return E('option', { 'value': s['.name'] }, (s.name || s['.name']) + (s.enabled === '0' ? ' ' + _('(выключен)') : ''));
			}).concat([ E('option', { 'value': 'new' }, _('➕ Новый список…')) ]));

		const newName = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'id': 'vrt-newname', 'placeholder': _('Название нового списка'), 'style': 'display:none;margin-top:6px' });
		select.addEventListener('change', function() { newName.style.display = select.value === 'new' ? '' : 'none'; });
		if (!lists.length) {
			select.value = 'new';
			newName.style.display = '';
		}

		ui.showModal(_('Добавить в список VPN'), [
			E('p', {}, isIp(value)
				? _('Трафик к этому адресу пойдёт через VPN.')
				: _('Домен покрывает все свои поддомены. Обычно достаточно основного домена сайта.')),
			E('div', { 'style': 'margin:8px 0 12px' }, radios),
			E('label', { 'style': 'display:block;font-weight:bold' }, _('Список')),
			select,
			newName,
			E('p', { 'class': 'cbi-value-description', 'style': 'margin-top:10px' },
				_('После добавления браузер или приложение может какое-то время помнить старый адрес. Если не заработает сразу — перезапустите его.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('Отмена')), ' ',
				E('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						const checked = document.querySelector('input[name="vrt-cand"]:checked');
						const val = checked ? checked.value : c.def;
						const target = select.value;
						const args = [ 'list-add', target, val ];
						if (target === 'new')
							args.push(newName.value.trim() || _('Новый список'));
						return run(args).then(function(out) {
							ui.hideModal();
							ui.addNotification(null, E('p', out), 'info');
							uci.unload('vpnroute');
							return uci.load('vpnroute');
						}).catch(function(e) {
							ui.addNotification(null, E('p', e.message), 'danger');
						});
					})
				}, _('Добавить'))
			])
		]);
	},

	// ---------- страница ----------

	render: function(res) {
		const self = this;
		this.devices = res[1] || [];
		this.data = res[2] || { running: false, state: null };

		const cur = this.data.state && this.data.state.device ? this.data.state.device.ip : '';
		const devSelect = E('select', { 'class': 'cbi-input-select', 'id': 'vrt-device' },
			[ E('option', { 'value': '' }, _('— выберите устройство —')) ].concat(this.devices.map(function(d) {
				return E('option', { 'value': d.ip, 'selected': d.ip === cur ? '' : null },
					(d.name || _('без имени')) + ' — ' + d.ip + ' (' + d.mac + ')');
			})));

		const durSelect = E('select', { 'class': 'cbi-input-select', 'id': 'vrt-duration' }, [
			E('option', { 'value': '5' }, _('5 минут')),
			E('option', { 'value': '15', 'selected': '' }, _('15 минут')),
			E('option', { 'value': '30' }, _('30 минут')),
			E('option', { 'value': '60' }, _('60 минут'))
		]);

		const mkSelect = function(key, options) {
			const sel = E('select', { 'class': 'cbi-input-select' }, options.map(function(o) {
				return E('option', { 'value': o[0], 'selected': self.filters[key] === o[0] ? '' : null }, o[1]);
			}));
			sel.addEventListener('change', function() { self.filters[key] = sel.value; self.update(); });
			return sel;
		};

		const mkCheck = function(key, label) {
			const cb = E('input', { 'type': 'checkbox', 'checked': self.filters[key] ? '' : null });
			cb.addEventListener('change', function() { self.filters[key] = cb.checked; self.update(); });
			return E('label', { 'style': 'margin-right:1em;white-space:nowrap' }, [ cb, ' ', label ]);
		};

		const search = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('домен или IP'), 'style': 'width:14em' });
		search.addEventListener('input', function() { self.filters.search = search.value.trim(); self.update(); });

		const field = function(label, el) {
			return E('span', { 'style': 'display:inline-block;margin:0 1em 6px 0' }, [ E('span', { 'style': 'margin-right:4px' }, label), el ]);
		};

		const page = E('div', { 'class': 'cbi-map' }, [
			E('h2', _('Диагностика трафика')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Запись всех соединений одного устройства: куда оно подключается, через VPN или напрямую и что не работает. ' +
				  'Статусы определяются по поведению соединения и показывают вероятную причину, а не точный диагноз.')),

			E('div', { 'class': 'cbi-section' }, [
				E('div', {}, [
					field(_('Устройство'), devSelect),
					field(_('Длительность'), durSelect),
					E('button', { 'id': 'vrt-toggle', 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'toggle') }, _('▶ Начать запись'))
				]),
				E('div', { 'id': 'vrt-summary', 'style': 'margin-top:8px' })
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('div', {}, [
					field(_('Статус'), mkSelect('status', STATUS_FILTERS)),
					field(_('Путь'), mkSelect('route', [ [ 'all', 'Все' ], [ 'direct', 'Напрямую' ], [ 'vpn', 'VPN' ] ])),
					field(_('Протокол'), mkSelect('proto', [ [ 'all', 'Все' ], [ 'tcp', 'TCP' ], [ 'udp', 'UDP' ], [ 'dns', 'DNS' ] ])),
					field(_('Поиск'), search)
				]),
				E('div', {}, [
					mkCheck('group', _('Группировать по домену')),
					mkCheck('hideLocal', _('Скрыть локальный трафик'))
				]),
				E('div', { 'id': 'vrt-table', 'style': 'margin-top:8px' })
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Что означают статусы')),
				E('ul', {}, [
					E('li', {}, _('⛔ Нет ответа — запрос на соединение ушёл, ответа нет: блокировка по IP или сервер недоступен.')),
					E('li', {}, _('⛔ Сброс соединения — соединение закрылось сразу после начала: типично для блокировки по имени сайта (DPI).')),
					E('li', {}, _('⚠️ Зависание ~16 КБ — пришло 12–24 КБ и данные перестали идти: признак замедления оборудованием провайдера.')),
					E('li', {}, _('⚠️ QUIC без ответа — UDP на порт 443 без ответа. Браузер обычно переходит на TCP, это не всегда проблема.')),
					E('li', {}, _('⛔ DNS: домен не найден / ошибка — DNS провайдера не вернул адрес.')),
					E('li', {}, _('🚫 Заблокировано роутером — например, DoH-серверы, которые роутер блокирует намеренно.')),
					E('li', {}, _('· Закрыто (VPN) — соединение через VPN закрыто Xray или самим приложением. Обычно не проблема.'))
				])
			])
		]);

		requestAnimationFrame(function() {
			self.update();
			if (self.data.running)
				self.startPolling();
		});

		return page;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
