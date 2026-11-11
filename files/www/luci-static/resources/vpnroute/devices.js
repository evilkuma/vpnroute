'use strict';
'require baseclass';
'require uci';
'require dom';
'require vpnroute.core as core';

// Устройства: все устройства сети в одном списке. Переключатель включает
// «весь трафик через VPN». Устройство попадает в настройки при первом включении.

const reMac = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

function normMac(m) {
	return String(m || '').trim().toUpperCase().replace(/-/g, ':');
}

function hostName(h) {
	return h && h.name ? h.name.replace(/\.lan$/, '') : '';
}

return baseclass.extend({
	render: function(ctx) {
		this.ctx = ctx;
		this.box = E('div');
		this.draw();
		return this.box;
	},

	items: function() {
		const hosts = this.ctx.hosts || {};
		const seen = {};
		const items = uci.sections('vpnroute', 'device').map(function(s) {
			const mac = normMac(s.mac);
			seen[mac] = true;
			const h = hosts[mac] || hosts[mac.toLowerCase()];
			return { sid: s['.name'], name: s.name || hostName(h) || mac, mac: mac, enabled: s.enabled === '1',
				ip: h && h.ipaddrs && h.ipaddrs[0], online: !!h };
		});
		Object.keys(hosts).forEach(function(m) {
			const mac = normMac(m);
			const h = hosts[m];
			if (seen[mac] || !h.ipaddrs || !h.ipaddrs.length)
				return;
			seen[mac] = true;
			items.push({ sid: null, name: hostName(h), mac: mac, enabled: false, ip: h.ipaddrs[0], online: true });
		});
		return items;
	},

	draw: function() {
		const self = this;
		const items = this.items();
		const on = items.filter(function(i) { return i.enabled; });
		const rest = items.filter(function(i) { return !i.enabled; }).sort(function(a, b) {
			// сохранённые и с именем — выше, безымянные — в конце
			return (!!b.sid - !!a.sid) || (!!b.name - !!a.name) || (a.name || a.mac).localeCompare(b.name || b.mac);
		});

		dom.content(this.box, [
			E('section', { 'class': 'vr-section' }, [
				E('div', { 'class': 'vr-sh' }, [
					E('h2', {}, _('Весь трафик через VPN')),
					E('p', {}, _('Обычно через VPN идут только сайты из списков. Включите устройство, чтобы через VPN шло всё подряд: удобно для телевизоров и приставок.'))
				]),
				on.length ? E('ul', { 'class': 'vr-rows' }, on.map(L.bind(this.row, this)))
					: E('p', { 'class': 'vr-empty' }, _('Таких устройств нет. Включите нужное в списке ниже.'))
			]),
			E('section', { 'class': 'vr-section' }, [
				E('div', { 'class': 'vr-sh' }, [
					E('h2', {}, _('Остальные устройства')),
					E('div', { 'class': 'vr-actions' }, core.button([ core.icon('plus'), _('По MAC-адресу') ], function() { self.addByMac(); }, 'quiet'))
				]),
				rest.length ? E('ul', { 'class': 'vr-rows' }, rest.map(L.bind(this.row, this)))
					: E('p', { 'class': 'vr-empty' }, _('Роутер пока не видит других устройств.'))
			])
		]);
	},

	row: function(d) {
		const self = this;
		let title;
		if (d.sid) {
			title = E('input', { 'class': 'vr-inline', 'type': 'text', 'value': d.name, 'maxlength': '40', 'aria-label': _('Название устройства') });
			title.addEventListener('change', function() {
				const v = title.value.trim();
				if (!v) {
					title.value = d.name;
					return;
				}
				uci.set('vpnroute', d.sid, 'name', v);
				d.name = v;
				core.apply();
			});
			title.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') title.blur(); });
		}
		else {
			title = d.name || E('span', { 'class': 'muted' }, _('Без имени'));
		}

		const info = [];
		if (d.ip)
			info.push(d.ip);
		info.push(d.mac);
		if (!d.online)
			info.push(_('сейчас не в сети'));

		const side = [ core.switch(d.enabled, function(on) { self.toggle(d, on); }, _('Весь трафик %s через VPN').format(d.name || d.mac)) ];
		if (d.sid && !d.enabled)
			side.push(core.iconButton('trash', _('Забыть устройство'), function() { self.forget(d); }));

		return E('li', { 'class': 'vr-row vr-device' }, [
			E('div', { 'class': 'main' }, [ E('div', { 'class': 't' }, title), E('div', { 'class': 's' }, info.join(', ')) ]),
			E('div', { 'class': 'side' }, side)
		]);
	},

	toggle: function(d, on) {
		if (!d.sid) {
			d.sid = uci.add('vpnroute', 'device');
			uci.set('vpnroute', d.sid, 'name', d.name || d.mac);
			uci.set('vpnroute', d.sid, 'mac', d.mac);
		}
		uci.set('vpnroute', d.sid, 'enabled', on ? '1' : '0');
		this.draw();
		return core.apply().then(L.bind(this.ctx.refresh, this.ctx)).then(function() {
			core.toast(on ? _('%s: весь трафик через VPN').format(d.name || d.mac) : _('%s: через VPN только сайты из списков').format(d.name || d.mac));
		});
	},

	forget: function(d) {
		uci.remove('vpnroute', d.sid);
		this.draw();
		return core.apply();
	},

	addByMac: function() {
		const self = this;
		const mac = E('input', { 'class': 'vr-input', 'type': 'text', 'placeholder': 'AA:BB:CC:DD:EE:FF', 'spellcheck': 'false' });
		const name = E('input', { 'class': 'vr-input', 'type': 'text', 'maxlength': '40', 'placeholder': _('Например: телевизор') });
		const err = E('p', { 'class': 'muted small' });
		core.modal(_('Добавить устройство'), [
			core.field(_('MAC-адрес'), mac, _('Нужен, если устройство сейчас выключено. MAC можно посмотреть в настройках сети устройства.')),
			core.field(_('Название'), name),
			err
		], [
			{ label: _('Отмена'), cls: 'quiet' },
			{ label: _('Добавить и включить'), cls: 'primary', fn: function() {
				const m = normMac(mac.value);
				if (!reMac.test(m)) {
					mac.classList.add('bad');
					err.textContent = _('MAC-адрес записывается как шесть пар символов через двоеточие: AA:BB:CC:DD:EE:FF.');
					mac.focus();
					return false;
				}
				const exists = self.items().filter(function(i) { return i.mac === m; })[0];
				if (exists && exists.sid) {
					err.textContent = _('Это устройство уже есть в списке: «%s».').format(exists.name);
					return false;
				}
				return self.toggle({ sid: null, mac: m, name: name.value.trim() || m }, true);
			} }
		]);
	}
});
