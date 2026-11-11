'use strict';
'require view';
'require uci';
'require dom';
'require vpnroute.core as core';
'require vpnroute.overview as overview';
'require vpnroute.lists as lists';
'require vpnroute.devices as devices';
'require vpnroute.servers as servers';
'require vpnroute.diag as diag';
'require vpnroute.settings as settings';

// vpnroute: одна страница с вкладками вместо стандартных форм LuCI.
// Вкладка выбирается по адресу: #lists, #lists/my, #devices…

const PAGES = [
	{ id: 'overview', label: _('Обзор'), mod: overview },
	{ id: 'lists', label: _('Сайты и адреса'), mod: lists },
	{ id: 'devices', label: _('Устройства'), mod: devices },
	{ id: 'servers', label: _('Серверы'), mod: servers },
	{ id: 'diag', label: _('Диагностика'), mod: diag },
	{ id: 'settings', label: _('Настройки'), mod: settings }
];

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('vpnroute'),
			core.runJson([ 'status-json' ]).catch(function(e) { return { error: e.message, servers: [], builtin: [], lists: [], devices: [] }; }),
			core.hostHints()
		]);
	},

	render: function(data) {
		if (!document.querySelector('link[data-vpnroute]'))
			document.head.appendChild(E('link', { 'rel': 'stylesheet', 'href': L.resource('vpnroute/app.css'), 'data-vpnroute': '' }));

		const self = this;
		const ctx = this.ctx = {
			status: data[1],
			hosts: data[2],
			builtinCache: {},
			go: function(path) { location.hash = path; },
			refresh: function() { return self.refreshStatus(); },
			rerender: function() { return self.show(); }
		};

		const saving = E('span', { 'class': 'vr-saving', 'role': 'status', 'aria-live': 'polite' });
		core.bindStatus(saving);

		this.master = core.switch(uci.get('vpnroute', 'main', 'enabled') === '1', function(on, input) {
			input.disabled = true;
			core.setStatus('busy', on ? _('Включаю…') : _('Выключаю…'));
			return core.run([ on ? 'enable' : 'disable' ]).then(function() {
				uci.unload('vpnroute');
				return uci.load('vpnroute');
			}).then(function() {
				core.setStatus('done', on ? _('Маршрутизация включена') : _('Маршрутизация выключена'));
				return self.refreshStatus();
			}).catch(function(e) {
				input.checked = !on;
				core.setStatus('err', _('Не получилось'));
				core.toast(e.message, 'err');
			}).then(function() { input.disabled = false; });
		}, _('Маршрутизация'), true);

		this.tabs = E('nav', { 'class': 'vr-tabs', 'aria-label': _('Разделы') }, PAGES.map(function(p) {
			return E('a', { 'href': '#' + p.id, 'data-page': p.id }, p.label);
		}));
		this.main = E('div', { 'class': 'vr-main' });

		window.addEventListener('hashchange', function() { self.show(); });

		const root = E('div', { 'class': 'vr' }, [
			E('div', { 'class': 'vr-head' }, [
				E('h1', {}, _('VPN-маршрутизация')),
				saving,
				E('label', { 'class': 'vr-master' }, [ _('Маршрутизация'), this.master ])
			]),
			this.tabs,
			this.main
		]);

		requestAnimationFrame(function() { self.show(); });
		return root;
	},

	route: function() {
		const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
		const i = h.indexOf('/');
		const id = i >= 0 ? h.substring(0, i) : h;
		const page = PAGES.filter(function(p) { return p.id === id; })[0] || PAGES[0];
		return { page: page, arg: i >= 0 ? h.substring(i + 1) : '' };
	},

	show: function() {
		const r = this.route();
		this.tabs.querySelectorAll('a').forEach(function(a) {
			if (a.getAttribute('data-page') === r.page.id)
				a.setAttribute('aria-current', 'page');
			else
				a.removeAttribute('aria-current');
		});
		document.querySelectorAll('.vr-overlay').forEach(function(o) { o.remove(); });
		if (this.current && this.current.leave)
			this.current.leave();
		this.current = r.page.mod;
		dom.content(this.main, E('p', { 'class': 'muted' }, _('Загрузка…')));
		return Promise.resolve(r.page.mod.render(this.ctx, r.arg)).then(L.bind(function(node) {
			if (this.route().page === r.page)
				dom.content(this.main, node);
			if (r.page.mod.mounted)
				r.page.mod.mounted(this.ctx);
		}, this)).catch(L.bind(function(e) {
			dom.content(this.main, E('div', { 'class': 'vr-note alert' }, _('Раздел не открылся: %s').format(e.message)));
		}, this));
	},

	refreshStatus: function() {
		return core.runJson([ 'status-json' ]).then(L.bind(function(st) {
			this.ctx.status = st;
			this.master.querySelector('input').checked = !!st.enabled;
			return st;
		}, this)).catch(function() {});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
