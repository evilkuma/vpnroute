'use strict';
'require baseclass';
'require uci';
'require dom';
'require vpnroute.core as core';

// Серверы: добавление по ссылке vless://, разбор параметров на лету.
// UUID из ссылки нигде не показывается.

const FINGERPRINTS = [ 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized' ];
const TRANSPORTS = [ 'tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp' ];

function parseLink(link) {
	const m = String(link || '').trim().match(/^vless:\/\/([^@]+)@(\[[^\]]+\]|[^:\/?#]+):(\d+)[^?#]*(?:\?([^#]*))?(?:#(.*))?$/);
	if (!m)
		return null;
	const q = {};
	(m[4] || '').split('&').forEach(function(kv) {
		const i = kv.indexOf('=');
		if (i > 0)
			try { q[kv.substring(0, i)] = decodeURIComponent(kv.substring(i + 1)); } catch (e) { q[kv.substring(0, i)] = kv.substring(i + 1); }
	});
	let name = '';
	try { name = decodeURIComponent(m[5] || ''); } catch (e) { name = m[5] || ''; }
	return { host: m[2], port: m[3], type: q.type || 'tcp', security: q.security || 'none', sni: q.sni || '', fp: q.fp || '',
		flow: q.flow || '', path: q.path || '', name: name, q: q };
}

function setParam(link, key, value) {
	const i = link.indexOf('?');
	const hashAt = link.indexOf('#');
	const base = i >= 0 ? link.substring(0, i) : (hashAt >= 0 ? link.substring(0, hashAt) : link);
	const hash = hashAt >= 0 ? link.substring(hashAt) : '';
	const query = i >= 0 ? link.substring(i + 1, hashAt >= 0 ? hashAt : undefined) : '';
	const parts = query.split('&').filter(function(kv) { return kv && kv.split('=')[0] !== key; });
	if (value)
		parts.push(key + '=' + encodeURIComponent(value));
	return base + (parts.length ? '?' + parts.join('&') : '') + hash;
}

function summary(p) {
	if (!p)
		return _('ссылка не распознана');
	const sec = { tls: 'TLS', reality: 'Reality', none: _('без шифрования') }[p.security] || p.security;
	const parts = [ p.host + ':' + p.port, p.type === 'raw' ? 'tcp' : p.type, sec ];
	if (p.fp)
		parts.push(_('отпечаток %s').format(p.fp));
	return parts.join(', ');
}

return baseclass.extend({
	render: function(ctx) {
		this.ctx = ctx;
		this.box = E('div');
		this.draw();
		return this.box;
	},

	draw: function() {
		const self = this;
		const servers = uci.sections('vpnroute', 'server');
		const enabled = servers.filter(function(s) { return s.enabled !== '0'; }).length;

		dom.content(this.box, E('section', { 'class': 'vr-section' }, [
			E('div', { 'class': 'vr-sh' }, [
				E('h2', {}, _('Серверы')),
				E('div', { 'class': 'vr-actions' }, core.button([ core.icon('plus'), _('Добавить сервер') ], function() { self.edit(null); }, servers.length ? '' : 'primary')),
				E('p', {}, enabled > 1
					? _('Включено несколько серверов: роутер сам выбирает самый быстрый из доступных и переключается, если сервер перестал отвечать.')
					: _('Ссылку vless:// возьмите в панели своего сервера, в карточке пользователя.'))
			]),
			servers.length ? E('ul', { 'class': 'vr-rows' }, servers.map(L.bind(this.row, this)))
				: E('div', { 'class': 'vr-empty' }, [ E('p', {}, [ E('b', {}, _('Серверов нет. ')), _('Пока сервер не добавлен, через VPN ничего не пойдёт.') ]) ])
		]));
	},

	row: function(s) {
		const self = this;
		const p = parseLink(s.link);
		const json = !!(s.outbound_json && s.outbound_json.trim());
		const on = s.enabled !== '0';
		return E('li', { 'class': 'vr-row' + (on ? '' : ' off') }, [
			E('div', { 'class': 'main' }, [
				E('div', { 'class': 't' }, s.name || s['.name']),
				E('div', { 'class': 's' }, json ? _('своя настройка Xray (JSON)') : summary(p))
			]),
			E('div', { 'class': 'side' }, [
				core.switch(on, function(v) {
					uci.set('vpnroute', s['.name'], 'enabled', v ? '1' : '0');
					self.draw();
					core.apply().then(L.bind(self.ctx.refresh, self.ctx));
				}, _('Сервер «%s» включён').format(s.name)),
				core.iconButton('edit', _('Изменить'), function() { self.edit(s); }),
				core.iconButton('trash', _('Удалить'), function() { self.remove(s); })
			])
		]);
	},

	edit: function(s) {
		const self = this;
		const name = E('input', { 'class': 'vr-input', 'type': 'text', 'maxlength': '40', 'value': s ? (s.name || '') : '', 'placeholder': _('Например: Финляндия') });
		const link = E('textarea', { 'class': 'vr-textarea', 'rows': '3', 'spellcheck': 'false', 'placeholder': 'vless://…' }, s ? (s.link || '') : '');
		const fp = E('select', { 'class': 'vr-select' });
		const preview = E('div');
		const json = E('textarea', { 'class': 'vr-textarea', 'rows': '6', 'spellcheck': 'false', 'placeholder': '{ "protocol": "vless", … }' }, s ? (s.outbound_json || '') : '');
		const err = E('p', { 'class': 'muted small' });

		const drawPreview = function() {
			const p = parseLink(link.value);
			link.classList.toggle('bad', !!link.value.trim() && !p);
			if (!link.value.trim()) {
				dom.content(preview, []);
				return;
			}
			if (!p) {
				dom.content(preview, E('p', { 'class': 'muted' }, _('Ссылка не распознана. Ожидается vless://…@адрес:порт?параметры')));
				return;
			}
			if (!name.value.trim() && p.name)
				name.value = p.name;
			const rows = [
				[ _('Адрес'), p.host + ':' + p.port ],
				[ _('Транспорт'), p.type + (p.path ? ', путь ' + p.path : '') ],
				[ _('Защита'), p.security + (p.sni ? ', SNI ' + p.sni : '') ]
			];
			if (p.flow)
				rows.push([ 'Flow', p.flow ]);
			const notes = [];
			if (TRANSPORTS.indexOf(p.type) < 0)
				notes.push(E('p', { 'class': 'vr-note alert' }, _('Транспорт «%s» роутер не поддерживает.').format(p.type)));
			dom.content(preview, [
				E('dl', { 'class': 'vr-kv' }, rows.map(function(r) { return [ E('dt', {}, r[0]), E('dd', {}, r[1]) ]; }).reduce(function(a, b) { return a.concat(b); }, []))
			].concat(notes));
			dom.content(fp, [ E('option', { 'value': '' }, p.fp ? _('как в ссылке (%s)').format(p.fp) : _('не задан (chrome)')) ].concat(FINGERPRINTS.map(function(f) {
				return E('option', { 'value': f }, f);
			})));
			fp.value = '';
		};
		link.addEventListener('input', drawPreview);
		drawPreview();

		const advanced = E('details', { 'open': s && s.outbound_json ? '' : null }, [
			E('summary', { 'class': 'small' }, _('Своя настройка Xray')),
			core.field(_('Outbound в JSON'), json, _('Необязательно. Если заполнено, используется вместо ссылки.'))
		]);

		core.modal(s ? _('Сервер «%s»').format(s.name || '') : _('Новый сервер'), [
			core.field(_('Ссылка'), link),
			preview,
			core.field(_('Название'), name),
			core.field(_('Отпечаток браузера'), fp, _('Под какой браузер маскируется подключение. Если провайдер режет VPN, попробуйте firefox или safari.')),
			advanced,
			err
		], [
			{ label: _('Отмена'), cls: 'quiet' },
			{ label: s ? _('Сохранить') : _('Добавить'), cls: 'primary', fn: function() {
				let l = link.value.trim();
				const j = json.value.trim();
				if (!l && !j) {
					err.textContent = _('Вставьте ссылку vless:// из панели сервера.');
					link.focus();
					return false;
				}
				if (l && !parseLink(l)) {
					err.textContent = _('Ссылка не распознана. Скопируйте её из панели сервера целиком.');
					link.focus();
					return false;
				}
				if (j) {
					try { JSON.parse(j); } catch (e) {
						err.textContent = _('В JSON ошибка: %s').format(e.message);
						advanced.open = true;
						json.focus();
						return false;
					}
				}
				if (l && fp.value)
					l = setParam(l, 'fp', fp.value);
				const p = parseLink(l);
				const sid = s ? s['.name'] : uci.add('vpnroute', 'server');
				uci.set('vpnroute', sid, 'name', name.value.trim() || (p && p.name) || (p ? p.host : _('Сервер')));
				if (l)
					uci.set('vpnroute', sid, 'link', l);
				else
					uci.unset('vpnroute', sid, 'link');
				if (j)
					uci.set('vpnroute', sid, 'outbound_json', j);
				else
					uci.unset('vpnroute', sid, 'outbound_json');
				if (!s)
					uci.set('vpnroute', sid, 'enabled', '1');
				self.draw();
				return core.apply().then(L.bind(self.ctx.refresh, self.ctx)).then(function() {
					core.toast(s ? _('Сервер сохранён') : _('Сервер добавлен'));
				});
			} }
		]);
	},

	remove: function(s) {
		const self = this;
		const others = uci.sections('vpnroute', 'server').filter(function(x) { return x['.name'] !== s['.name'] && x.enabled !== '0'; }).length;
		core.modal(_('Удалить сервер «%s»?').format(s.name || ''), [
			E('p', {}, others ? _('Трафик пойдёт через оставшиеся серверы.') : _('Других включённых серверов нет: сайты из списков перестанут открываться через VPN.'))
		], [
			{ label: _('Отмена'), cls: 'quiet' },
			{ label: _('Удалить'), cls: 'primary', fn: function() {
				uci.remove('vpnroute', s['.name']);
				self.draw();
				return core.apply().then(L.bind(self.ctx.refresh, self.ctx));
			} }
		]);
	}
});
