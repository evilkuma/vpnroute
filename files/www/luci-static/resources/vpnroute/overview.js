'use strict';
'require baseclass';
'require uci';
'require dom';
'require vpnroute.core as core';
'require vpnroute.lists as lists';

// Обзор: схема путей трафика, быстрые переключатели устройств,
// проверка сайта и сообщение об обновлении.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
	const el = document.createElementNS(NS, tag);
	Object.keys(attrs).forEach(function(k) { el.setAttribute(k, attrs[k]); });
	return el;
}

return baseclass.extend({
	render: function(ctx) {
		this.ctx = ctx;
		const st = ctx.status || {};
		const parts = [];

		if (st.error)
			parts.push(E('div', { 'class': 'vr-note alert' }, _('Не удалось узнать состояние роутера: %s').format(st.error)));

		parts.push(this.notices(st));
		parts.push(this.mimic(st));
		parts.push(this.devices());
		parts.push(lists.checker(ctx, _('Впишите сайт или ссылку, чтобы узнать, откроется он через VPN или напрямую.')));
		this.updateBox = E('div');
		parts.push(this.updateBox);
		this.loadUpdate();
		return E('div', {}, parts);
	},

	mounted: function() {
		const self = this;
		this.drawLines();
		if (!this.onResize) {
			this.onResize = function() { self.drawLines(); };
			window.addEventListener('resize', this.onResize);
		}
	},

	leave: function() {
		if (this.onResize) {
			window.removeEventListener('resize', this.onResize);
			this.onResize = null;
		}
	},

	// ---------- что требует внимания ----------

	notices: function(st) {
		const self = this;
		const box = E('div', { 'style': 'margin-bottom:20px' });
		const servers = (st.servers || []).filter(function(s) { return s.enabled; });
		if (!servers.length) {
			box.appendChild(E('div', { 'class': 'vr-note route' }, [
				E('p', {}, _('Сервер не добавлен. Пока его нет, сайты из списков не пойдут через VPN.')),
				E('div', { 'class': 'row-actions' }, core.button(_('Добавить сервер'), function() { self.ctx.go('servers'); }, 'primary'))
			]));
		}
		else if (!st.enabled) {
			box.appendChild(E('div', { 'class': 'vr-note' }, [
				E('p', {}, _('Маршрутизация выключена: весь трафик идёт напрямую, мимо VPN.')),
				E('div', { 'class': 'row-actions' }, core.button(_('Включить маршрутизацию'), function() {
					core.setStatus('busy', _('Включаю…'));
					return core.run([ 'enable' ]).then(function() {
						core.setStatus('done', _('Маршрутизация включена'));
						return self.ctx.refresh();
					}).then(function() { self.ctx.rerender(); }).catch(function(e) { core.toast(e.message, 'err'); });
				}, 'primary'))
			]));
		}
		else if (!st.running || !st.rules) {
			box.appendChild(E('div', { 'class': 'vr-note alert' }, [
				E('p', {}, !st.running
					? _('Xray не запущен, поэтому сайты из списков не открываются. Причина обычно видна в журнале.')
					: _('Правила маршрутизации не применены: трафик идёт мимо VPN.')),
				E('div', { 'class': 'row-actions' }, [
					core.button(_('Перезапустить'), function() {
						core.setStatus('busy', _('Перезапускаю…'));
						return core.run([ 'restart' ]).then(function() { return self.ctx.refresh(); })
							.then(function() { core.setStatus('done', _('Перезапущено')); self.ctx.rerender(); })
							.catch(function(e) { core.setStatus('err', _('Не получилось')); core.toast(e.message, 'err'); });
					}, 'primary'),
					core.button(_('Открыть журнал'), function() { self.ctx.go('diag/log'); }, 'quiet')
				])
			]));
		}
		return box.childNodes.length ? box : '';
	},

	// ---------- схема ----------

	mimic: function(st) {
		const self = this;
		const enabled = !!st.enabled;
		const working = enabled && st.running && st.rules;
		const servers = (st.servers || []).filter(function(s) { return s.enabled; });

		let lamp = 'vr-lamp', state;
		if (!enabled)
			state = _('Маршрутизация выключена');
		else if (working) {
			lamp += ' ok';
			state = _('Работает');
		}
		else {
			lamp += ' bad';
			state = st.running ? _('Правила не применены') : _('Xray не запущен');
		}

		// что идёт через VPN
		const chips = [];
		(st.builtin || []).filter(function(l) { return l.enabled; }).forEach(function(l) {
			chips.push(E('a', { 'class': 'vr-chip on', 'href': '#lists/builtin:' + l.id }, l.name));
		});
		(st.lists || []).filter(function(l) { return l.enabled && (l.domains + l.ips) > 0; }).forEach(function(l) {
			chips.push(E('a', { 'class': 'vr-chip on', 'href': '#lists/' + encodeURIComponent(l.id) }, [ l.name, ' ', E('span', { 'class': 'muted' }, String(l.domains + l.ips)) ]));
		});
		(st.devices || []).filter(function(d) { return d.enabled; }).forEach(function(d) {
			chips.push(E('a', { 'class': 'vr-chip on', 'href': '#devices' }, _('%s целиком').format(d.name)));
		});
		const offLists = (st.builtin || []).concat(st.lists || []).filter(function(l) { return !l.enabled; }).length;

		const serverText = servers.length
			? (servers.length === 1 ? _('сервер %s').format(servers[0].name) : _('серверы: %s').format(servers.map(function(s) { return s.name; }).join(', ')))
			: _('сервер не добавлен');

		this.mimicEl = E('div', { 'class': 'vr-mimic' }, [
			E('div', { 'class': 'vr-station' }, [
				E('div', { 'class': 'name' }, _('Роутер')),
				E('div', { 'class': 'state' }, [ E('span', { 'class': lamp }), state ])
			]),
			E('div', { 'class': 'vr-track vpn' + (enabled ? '' : ' off'), 'data-track': 'vpn' }, [
				E('div', { 'class': 'title' }, [
					E('h2', {}, _('Через VPN')),
					E('a', { 'href': '#servers', 'class': 'muted' }, serverText)
				]),
				E('div', { 'class': 'what' }, chips.length ? chips : [ E('span', { 'class': 'muted' }, _('Ничего не выбрано. Добавьте сайты в разделе «Сайты и адреса».')) ]),
				offLists ? E('p', { 'class': 'small muted', 'style': 'margin-top:6px' }, [
					E('a', { 'href': '#lists', 'class': 'muted' }, core.count(offLists, _('список выключен'), _('списка выключены'), _('списков выключено')))
				]) : ''
			]),
			E('div', { 'class': 'vr-track direct', 'data-track': 'direct' }, [
				E('div', { 'class': 'title' }, [ E('h2', {}, _('Напрямую')) ]),
				E('p', { 'class': 'muted' }, enabled ? _('Всё остальное: сайты не из списков, устройства без режима «весь трафик через VPN».') : _('Сейчас весь трафик.'))
			])
		]);
		this.lit = working;
		return this.mimicEl;
	},

	// Пути от роутера к двум направлениям: подсвечен путь через VPN
	drawLines: function() {
		const box = this.mimicEl;
		if (!box || !box.isConnected)
			return;
		const old = box.querySelector('svg');
		if (old)
			old.remove();
		if (window.matchMedia('(max-width: 760px)').matches)
			return;
		const b = box.getBoundingClientRect();
		const station = box.querySelector('.vr-station').getBoundingClientRect();
		const svg = svgEl('svg', { 'aria-hidden': 'true' });
		const sx = station.left - b.left + Math.min(station.width - 24, box.querySelector('.vr-station .name').getBoundingClientRect().width + 24);
		const sy = station.top - b.top + station.height / 2;
		const fork = station.right - b.left + 10;
		const lines = [];
		box.querySelectorAll('.vr-track').forEach(function(t) {
			const h2 = t.querySelector('h2').getBoundingClientRect();
			const ty = h2.top - b.top + h2.height / 2;
			const tx = t.getBoundingClientRect().left - b.left + 44;
			const r = Math.min(14, Math.abs(ty - sy) / 2);
			const dir = ty < sy ? -1 : 1;
			const d = Math.abs(ty - sy) < 2
				? 'M' + sx + ' ' + sy + ' H' + tx
				: 'M' + sx + ' ' + sy + ' H' + (fork - r) + ' Q' + fork + ' ' + sy + ' ' + fork + ' ' + (sy + dir * r) +
				  ' V' + (ty - dir * r) + ' Q' + fork + ' ' + ty + ' ' + (fork + r) + ' ' + ty + ' H' + tx;
			lines.push({ d: d, lit: t.getAttribute('data-track') === 'vpn' && this.lit, end: [ tx, ty ] });
		}, this);
		// подсвеченный путь рисуется поверх
		lines.sort(function(a, c) { return a.lit - c.lit; }).forEach(function(l) {
			svg.appendChild(svgEl('path', { 'd': l.d, 'class': 'vr-svg-line' + (l.lit ? ' lit' : '') }));
			svg.appendChild(svgEl('circle', { 'cx': l.end[0], 'cy': l.end[1], 'r': 6, 'class': 'vr-svg-node' }));
		});
		svg.appendChild(svgEl('circle', { 'cx': sx, 'cy': sy, 'r': 7, 'class': 'vr-svg-node' }));
		box.insertBefore(svg, box.firstChild);
	},

	// ---------- устройства ----------

	devices: function() {
		const self = this;
		const devs = uci.sections('vpnroute', 'device');
		const head = E('div', { 'class': 'vr-sh' }, [
			E('h2', {}, _('Устройства')),
			E('div', { 'class': 'vr-actions' }, E('a', { 'href': '#devices', 'class': 'muted' }, devs.length ? _('Все устройства') : _('Выбрать устройства')))
		]);
		if (!devs.length)
			return E('section', { 'class': 'vr-section' }, [ head,
				E('p', { 'class': 'muted' }, _('Можно пустить через VPN весь трафик отдельного устройства, например телевизора.')) ]);
		return E('section', { 'class': 'vr-section' }, [ head, E('ul', { 'class': 'vr-rows' }, devs.map(function(s) {
			const h = self.ctx.hosts[String(s.mac || '').toUpperCase()];
			return E('li', { 'class': 'vr-row' }, [
				E('div', { 'class': 'main' }, [
					E('div', { 'class': 't' }, s.name || s.mac),
					E('div', { 'class': 's' }, s.enabled === '1' ? _('весь трафик через VPN') : _('через VPN только сайты из списков') + (h ? '' : ', ' + _('сейчас не в сети')))
				]),
				E('div', { 'class': 'side' }, core.switch(s.enabled === '1', function(on) {
					uci.set('vpnroute', s['.name'], 'enabled', on ? '1' : '0');
					core.apply().then(function() { return self.ctx.refresh(); }).then(function() { self.ctx.rerender(); });
				}, _('Весь трафик %s через VPN').format(s.name || s.mac)))
			]);
		})) ]);
	},


	// ---------- обновление ----------

	loadUpdate: function() {
		const self = this;
		core.runJson([ 'update', 'status' ]).then(function(up) {
			if (up.available && !up.installing)
				dom.content(self.updateBox, E('section', { 'class': 'vr-section' }, E('div', { 'class': 'vr-note route' }, [
					E('p', {}, _('Вышла новая версия vpnroute: %s.').format(up.latest)),
					E('div', { 'class': 'row-actions' }, core.button(_('Подробнее и установить'), function() { self.ctx.go('settings'); }))
				])));
		}).catch(function() {});
	}
});
