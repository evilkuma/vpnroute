'use strict';
'require baseclass';
'require dom';
'require poll';
'require vpnroute.core as core';
'require vpnroute.lists as lists';

// Диагностика: куда пойдёт сайт, запись трафика устройства, журнал.

const MAX_ROWS = 400;

// tone: ok — работает, bad — проблема, warn — возможная проблема, пусто — нейтрально
const STATUS = {
	ok:        { tone: 'ok',   text: _('Работает') },
	active:    { tone: 'warn', text: _('Устанавливается') },
	no_reply:  { tone: 'bad',  text: _('Нет ответа'), problem: true },
	reset:     { tone: 'bad',  text: _('Сброс соединения'), problem: true },
	stall:     { tone: 'warn', text: _('Зависание на ~16 КБ'), problem: true },
	quic:      { tone: 'warn', text: _('QUIC без ответа'), problem: true },
	closed:    { tone: '',     text: _('Закрыто (VPN)') },
	local:     { tone: '',     text: _('Локальная сеть') },
	wait:      { tone: 'warn', text: _('DNS: ждём ответ') },
	nxdomain:  { tone: 'bad',  text: _('DNS: домен не найден'), problem: true },
	servfail:  { tone: 'bad',  text: _('DNS: ошибка сервера'), problem: true },
	refused:   { tone: 'bad',  text: _('DNS: отказ'), problem: true },
	no_answer: { tone: 'bad',  text: _('DNS: нет ответа'), problem: true },
	nodata:    { tone: '',     text: _('DNS: нет записи') },
	blocked:   { tone: '',     text: _('Заблокировано роутером') }
};

// Чем больше, тем «хуже» статус: так выбирается статус группы
const SEVERITY = { local: 0, nodata: 0, blocked: 1, ok: 1, closed: 1, active: 2, wait: 2, quic: 3, stall: 4, reset: 5, no_reply: 5, no_answer: 5, refused: 5, servfail: 5, nxdomain: 6 };

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

return baseclass.extend({
	filters: { problems: false, route: 'all', proto: 'all', search: '', hideLocal: true, group: true },

	render: function(ctx, arg) {
		const self = this;
		this.ctx = ctx;
		return Promise.all([
			core.runJson([ 'trace', 'devices' ]).catch(function() { return []; }),
			core.runJson([ 'trace', 'dump' ]).catch(function() { return { running: false, state: null }; })
		]).then(function(res) {
			self.devices = res[0] || [];
			self.data = res[1] || { running: false, state: null };
			self.logSection = self.logs();
			const page = E('div', {}, [ lists.checker(ctx, _('Проверка по спискам и DNS роутера: через VPN или напрямую.')), self.trace(), self.logSection ]);
			self.scrollTo = arg === 'log';
			return page;
		});
	},

	mounted: function() {
		this.update();
		if (this.data && this.data.running)
			this.startPolling();
		if (this.scrollTo && this.logSection) {
			this.logSection.scrollIntoView({ block: 'start' });
			this.loadLogs();
		}
	},

	leave: function() {
		this.stopPolling();
	},


	// ---------- запись трафика ----------

	trace: function() {
		const self = this;
		const cur = this.data.state && this.data.state.device ? this.data.state.device.ip : '';
		this.devSelect = E('select', { 'class': 'vr-select', 'aria-label': _('Устройство') },
			[ E('option', { 'value': '' }, _('Выберите устройство')) ].concat(this.devices.map(function(d) {
				return E('option', { 'value': d.ip, 'selected': d.ip === cur ? '' : null }, (d.name || _('без имени')) + ', ' + d.ip);
			})));
		this.durSelect = E('select', { 'class': 'vr-select', 'aria-label': _('Длительность') }, [
			E('option', { 'value': '5' }, _('5 минут')),
			E('option', { 'value': '15', 'selected': '' }, _('15 минут')),
			E('option', { 'value': '30' }, _('30 минут')),
			E('option', { 'value': '60' }, _('1 час'))
		]);
		this.toggleBtn = core.button(_('Начать запись'), function() { return self.toggle(); }, 'primary');
		this.summary = E('div', { 'style': 'margin:10px 0 16px' });
		this.table = E('div');

		const seg = E('div', { 'class': 'vr-seg', 'role': 'group', 'aria-label': _('Что показать') }, [ [ false, _('Все') ], [ true, _('Только проблемы') ] ].map(function(o) {
			const b = E('button', { 'type': 'button', 'aria-pressed': self.filters.problems === o[0] ? 'true' : 'false' }, o[1]);
			b.addEventListener('click', function() {
				self.filters.problems = o[0];
				seg.querySelectorAll('button').forEach(function(x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
				self.update();
			});
			return b;
		}));

		const mkSelect = function(key, label, options) {
			const sel = E('select', { 'class': 'vr-select', 'aria-label': label }, options.map(function(o) {
				return E('option', { 'value': o[0], 'selected': self.filters[key] === o[0] ? '' : null }, o[1]);
			}));
			sel.addEventListener('change', function() { self.filters[key] = sel.value; self.update(); });
			return sel;
		};
		const mkCheck = function(key, label) {
			const cb = E('input', { 'type': 'checkbox' });
			cb.checked = !!self.filters[key];
			cb.addEventListener('change', function() { self.filters[key] = cb.checked; self.update(); });
			return E('label', { 'class': 'vr-check-label' }, [ cb, label ]);
		};
		const search = E('input', { 'class': 'vr-input', 'type': 'search', 'placeholder': _('Домен или IP'), 'aria-label': _('Найти'), 'style': 'width:180px' });
		search.addEventListener('input', function() { self.filters.search = search.value.trim().toLowerCase(); self.update(); });

		return E('section', { 'class': 'vr-section' }, [
			E('div', { 'class': 'vr-sh' }, [
				E('h2', {}, _('Запись трафика устройства')),
				E('p', {}, _('Куда подключается устройство, через VPN или напрямую, и что не открывается. Статусы показывают вероятную причину по поведению соединения, а не точный диагноз.'))
			]),
			E('div', { 'class': 'vr-toolbar' }, [ this.devSelect, this.durSelect, this.toggleBtn ]),
			this.summary,
			E('div', { 'class': 'vr-toolbar' }, [
				seg,
				mkSelect('route', _('Путь'), [ [ 'all', _('Любой путь') ], [ 'direct', _('Напрямую') ], [ 'vpn', _('Через VPN') ] ]),
				mkSelect('proto', _('Протокол'), [ [ 'all', _('Все протоколы') ], [ 'tcp', 'TCP' ], [ 'udp', 'UDP' ], [ 'dns', 'DNS' ] ]),
				search,
				mkCheck('group', _('По доменам')),
				mkCheck('hideLocal', _('Без локальной сети'))
			]),
			this.table,
			E('details', { 'class': 'vr-details' }, [
				E('summary', {}, _('Что означают статусы')),
				E('dl', { 'class': 'vr-legend', 'style': 'margin-top:10px' }, [
					[ 'no_reply', _('Запрос ушёл, ответа нет: блокировка по IP или сервер недоступен.') ],
					[ 'reset', _('Соединение закрылось сразу после начала: типично для блокировки по имени сайта.') ],
					[ 'stall', _('Пришло 12–24 КБ, и данные перестали идти: признак замедления у провайдера.') ],
					[ 'quic', _('UDP на порт 443 без ответа. Браузер обычно переходит на TCP, это не всегда проблема.') ],
					[ 'nxdomain', _('DNS провайдера не вернул адрес сайта.') ],
					[ 'blocked', _('Роутер блокирует намеренно, например серверы «безопасного DNS».') ],
					[ 'closed', _('Соединение через VPN закрыто приложением или Xray. Обычно не проблема.') ]
				].map(function(r) {
					return [ E('dt', {}, E('span', { 'class': 'vr-st ' + STATUS[r[0]].tone }, STATUS[r[0]].text)), E('dd', {}, r[1]) ];
				}).reduce(function(a, b) { return a.concat(b); }, []))
			])
		]);
	},

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
		if (f.problems && !(STATUS[r.st] && STATUS[r.st].problem))
			return false;
		if (f.search && (r.domain || '').indexOf(f.search) < 0 && (r.dst || '').indexOf(f.search) < 0)
			return false;
		return true;
	},

	grouped: function(rows) {
		const groups = {}, order = [];
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

	statusCell: function(st, stats) {
		const s = STATUS[st] || { tone: '', text: st };
		const parts = [ E('span', { 'class': 'vr-st ' + s.tone }, s.text) ];
		if (stats) {
			const other = Object.keys(stats).filter(function(k) { return k !== st; }).map(function(k) {
				return (STATUS[k] ? STATUS[k].text : k) + ': ' + stats[k];
			});
			if (other.length)
				parts.push(E('small', {}, other.join(', ')));
		}
		return parts;
	},

	renderTable: function() {
		const self = this;
		const rows = this.rows().filter(L.bind(this.matches, this)).sort(function(a, b) { return b.t - a.t; });
		const items = this.filters.group ? this.grouped(rows) : rows;
		if (!items.length)
			return E('p', { 'class': 'vr-empty' }, this.data && this.data.state ? _('Под выбранные условия ничего не подходит.') : _('Выберите устройство и начните запись, затем откройте на нём то, что не работает.'));

		const routeName = function(r) {
			return r === 'vpn' ? _('VPN') : (r === 'local' ? _('локальная сеть') : _('напрямую'));
		};
		const body = items.slice(0, MAX_ROWS).map(function(r) {
			const group = r.kind === 'group';
			const routes = group ? Object.keys(r.routes) : [ r.route ];
			const proto = group ? Object.keys(r.protos).join(', ').toUpperCase() : r.proto.toUpperCase();
			let addr = r.dst ? (r.dport ? r.dst + ':' + r.dport : r.dst) : '—';
			if (group && r.count > 1)
				addr += ', ' + core.count(r.count, _('соединение'), _('соединения'), _('соединений'));
			const traffic = (r.up == null && r.down == null) || (group && !r.protos.tcp && !r.protos.udp) ? '—' : fmtBytes(r.up) + ' / ' + fmtBytes(r.down);
			const target = r.domain || r.dst;
			const canAdd = target && target !== '?' && !/^198\.1[89]\./.test(target) && !(routes.length === 1 && (routes[0] === 'vpn' || routes[0] === 'local'));
			return E('tr', { 'class': STATUS[r.st] && STATUS[r.st].problem ? 'problem' : '' }, [
				E('td', { 'class': 'nw' }, fmtTime(group ? r.t1 : r.t)),
				E('td', { 'class': 'addr' }, r.domain || E('span', { 'class': 'muted' }, _('неизвестен'))),
				E('td', { 'class': 'addr' }, addr),
				E('td', { 'class': 'nw' }, proto),
				E('td', { 'class': 'nw' }, traffic),
				E('td', { 'class': 'nw' }, routes.length > 1 ? _('разный') : routeName(routes[0])),
				E('td', {}, self.statusCell(r.st, group ? r.stats : null)),
				E('td', {}, canAdd ? core.iconButton('plus', _('Пустить %s через VPN').format(target), function() { return lists.addDialog(self.ctx, target); }) : '')
			]);
		});

		return E('div', {}, [
			E('p', { 'class': 'muted small', 'style': 'margin-bottom:6px' }, items.length > MAX_ROWS
				? _('Показано %d из %d. Уточните условия.').format(MAX_ROWS, items.length)
				: (this.filters.group ? _('Доменов: %d, записей: %d').format(items.length, rows.length) : _('Записей: %d').format(rows.length))),
			E('div', { 'class': 'vr-table-wrap' }, E('table', { 'class': 'vr-table' }, [
				E('thead', {}, E('tr', {}, [ _('Время'), _('Домен'), _('Адрес'), _('Протокол'), _('Отправлено / получено'), _('Путь'), _('Статус'), '' ].map(function(t) { return E('th', {}, t); }))),
				E('tbody', {}, body)
			]))
		]);
	},

	renderSummary: function() {
		const d = this.data || {};
		const st = d.state;
		if (d.error)
			return E('p', { 'class': 'vr-note alert' }, _('Запись прервалась из-за ошибки: %s').format(d.error));
		if (d.running && st) {
			const dev = st.device || {};
			return E('p', {}, [
				E('span', { 'class': 'vr-rec' }, _('Идёт запись')), ' ',
				_('%s, осталось %s.').format(dev.name ? dev.name + ' (' + dev.ip + ')' : dev.ip, fmtLeft(st.ends - Math.floor(Date.now() / 1000))),
				st.all_vpn ? E('span', { 'class': 'muted' }, ' ' + _('У устройства весь трафик идёт через VPN.')) : ''
			]);
		}
		if (d.running)
			return E('p', {}, E('span', { 'class': 'vr-rec' }, _('Запись начинается…')));
		if (st) {
			const dev = st.device || {};
			return E('p', { 'class': 'muted' }, _('Последняя запись: %s, %s – %s.').format(dev.name || dev.ip,
				new Date(st.started * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }), fmtTime(st.updated)));
		}
		return '';
	},

	update: function() {
		if (!this.table || !this.table.isConnected)
			return;
		dom.content(this.summary, this.renderSummary());
		dom.content(this.table, this.renderTable());
		const running = this.data && this.data.running;
		this.toggleBtn.textContent = running ? _('Остановить запись') : _('Начать запись');
		this.toggleBtn.className = 'vr-btn ' + (running ? '' : 'primary');
		this.devSelect.disabled = this.durSelect.disabled = !!running;
	},

	refresh: function() {
		return core.runJson([ 'trace', 'dump' ]).then(L.bind(function(d) {
			this.data = d;
			this.update();
			if (!d.running)
				this.stopPolling();
		}, this)).catch(function() {});
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
			return core.run([ 'trace', 'stop' ]).then(L.bind(this.refresh, this));
		const ip = this.devSelect.value;
		if (!ip) {
			core.toast(_('Выберите устройство, трафик которого записать'), 'err');
			this.devSelect.focus();
			return;
		}
		return core.run([ 'trace', 'start', ip, this.durSelect.value ]).then(L.bind(function() {
			this.data = { running: true, state: null };
			this.update();
			this.startPolling();
		}, this)).catch(function(e) { core.toast(e.message, 'err'); });
	},

	// ---------- журнал ----------

	logs: function() {
		const self = this;
		this.logOut = E('pre', { 'class': 'vr-pre', 'hidden': '' });
		return E('section', { 'class': 'vr-section', 'id': 'vr-log' }, [
			E('div', { 'class': 'vr-sh' }, [
				E('h2', {}, _('Журнал')),
				E('div', { 'class': 'vr-actions' }, core.button([ core.icon('refresh'), _('Показать последние записи') ], function() { return self.loadLogs(); })),
				E('p', {}, _('Сообщения vpnroute и Xray. Подробность журнала Xray меняется в настройках.'))
			]),
			this.logOut
		]);
	},

	loadLogs: function() {
		const out = this.logOut;
		return core.run([ 'logs', '150' ]).then(function(text) {
			out.hidden = false;
			out.textContent = text || _('Записей нет');
			out.scrollTop = out.scrollHeight;
		}).catch(function(e) {
			out.hidden = false;
			out.textContent = e.message;
		});
	}
});
