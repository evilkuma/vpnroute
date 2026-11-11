'use strict';
'require baseclass';
'require uci';
'require dom';
'require vpnroute.core as core';

// Настройки: изменения копятся и применяются кнопкой внизу.
// Внизу же версия vpnroute и обновление.

const DNS_PRESETS = [
	[ 'https://1.1.1.1/dns-query', 'Cloudflare' ],
	[ 'https://8.8.8.8/dns-query', 'Google' ],
	[ 'https://9.9.9.9/dns-query', 'Quad9' ]
];
const INTERVALS = [ [ '10s', _('10 секунд') ], [ '15s', _('15 секунд') ], [ '30s', _('30 секунд') ], [ '60s', _('1 минута') ] ];
const LOG_LEVELS = [ [ 'error', _('только ошибки') ], [ 'warning', _('ошибки и предупреждения') ], [ 'info', _('подробно') ], [ 'debug', _('отладка, очень подробно') ] ];

const DEFAULTS = {
	fallback_direct: '0', probe_url: 'https://www.gstatic.com/generate_204', probe_interval: '15s',
	dns_upstream: 'https://1.1.1.1/dns-query', dns_hijack: '1', block_dot: '1', block_doh: '1', block_ipv6: '1',
	log_level: 'warning', lan_iface: 'br-lan', tproxy_port: '12701', dns_port: '1053', fwmark: '0x40000', route_table: '107'
};

function checkPort(v) {
	return /^\d+$/.test(v) && +v >= 1 && +v <= 65535 ? null : _('порт от 1 до 65535');
}

const CHECKS = {
	probe_url: function(v) { return /^https?:\/\/[^\s\/]+/.test(v) ? null : _('нужен адрес вида https://…'); },
	dns_upstream: function(v) { return /^(https|tcp|udp|quic\+local|https\+local):\/\/\S+$|^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? null : _('нужен адрес вида https://1.1.1.1/dns-query или IP'); },
	tproxy_port: checkPort,
	dns_port: checkPort,
	fwmark: function(v) { return /^(0x[0-9a-fA-F]+|\d+)$/.test(v) ? null : _('число, например 0x40000'); },
	route_table: function(v) { return /^\d+$/.test(v) && +v >= 1 && +v <= 252 ? null : _('число от 1 до 252'); },
	lan_iface: function(v) { return /^[\w.@-]+(\s*,\s*[\w.@-]+)*$/.test(v) ? null : _('имена через запятую, например br-lan'); }
};

return baseclass.extend({
	render: function(ctx) {
		this.ctx = ctx;
		this.load();
		this.box = E('div');
		this.draw();
		return this.box;
	},

	leave: function() {
		if (this.isDirty())
			core.toast(_('Изменения в настройках не сохранены'), 'err');
	},

	load: function() {
		const v = {};
		Object.keys(DEFAULTS).forEach(function(k) {
			let x = uci.get('vpnroute', 'main', k);
			if (Array.isArray(x))
				x = x.join(', ');
			v[k] = x == null || x === '' ? DEFAULTS[k] : x;
		});
		this.saved = Object.assign({}, v);
		this.values = v;
		this.errors = {};
	},

	isDirty: function() {
		return Object.keys(this.values).some(function(k) { return this.values[k] !== this.saved[k]; }, this);
	},

	set: function(k, v) {
		this.values[k] = v;
		const err = CHECKS[k] ? CHECKS[k](v) : null;
		if (err)
			this.errors[k] = err;
		else
			delete this.errors[k];
		this.drawBar();
	},

	// ---------- элементы ----------

	toggle: function(k, title, text) {
		const self = this;
		return E('div', { 'class': 'vr-setting' }, [
			E('div', { 'class': 'text' }, [ E('div', { 'class': 't' }, title), E('div', { 'class': 's' }, text) ]),
			E('div', { 'class': 'ctl sw' }, core.switch(this.values[k] === '1', function(on) { self.set(k, on ? '1' : '0'); }, title))
		]);
	},

	textField: function(k, title, text, attrs) {
		const self = this;
		const input = E('input', Object.assign({ 'class': 'vr-input', 'type': 'text', 'value': this.values[k], 'spellcheck': 'false', 'aria-label': title }, attrs || {}));
		const err = E('div', { 'class': 's', 'style': 'color:var(--alert)' });
		input.addEventListener('input', function() {
			self.set(k, input.value.trim());
			input.classList.toggle('bad', !!self.errors[k]);
			err.textContent = self.errors[k] || '';
		});
		return E('div', { 'class': 'vr-setting' }, [
			E('div', { 'class': 'text' }, [ E('div', { 'class': 't' }, title), E('div', { 'class': 's' }, text), err ]),
			E('div', { 'class': 'ctl' }, input)
		]);
	},

	selectField: function(k, title, text, options) {
		const self = this;
		const opts = options.slice();
		if (!opts.some(function(o) { return o[0] === self.values[k]; }))
			opts.push([ this.values[k], this.values[k] ]);
		const sel = E('select', { 'class': 'vr-select', 'aria-label': title }, opts.map(function(o) {
			return E('option', { 'value': o[0] }, o[1]);
		}));
		sel.value = this.values[k];
		sel.addEventListener('change', function() { self.set(k, sel.value); });
		return E('div', { 'class': 'vr-setting' }, [
			E('div', { 'class': 'text' }, [ E('div', { 'class': 't' }, title), E('div', { 'class': 's' }, text) ]),
			E('div', { 'class': 'ctl' }, sel)
		]);
	},

	// DNS: готовые варианты или свой адрес
	dnsField: function() {
		const self = this;
		const k = 'dns_upstream';
		const preset = DNS_PRESETS.some(function(p) { return p[0] === self.values[k]; });
		const sel = E('select', { 'class': 'vr-select', 'aria-label': _('DNS-сервер') },
			DNS_PRESETS.map(function(p) { return E('option', { 'value': p[0] }, p[1]); }).concat([ E('option', { 'value': '' }, _('Свой адрес…')) ]));
		const custom = E('input', { 'class': 'vr-input', 'type': 'text', 'spellcheck': 'false', 'value': preset ? '' : this.values[k],
			'placeholder': 'https://…/dns-query', 'hidden': preset ? '' : null, 'aria-label': _('Адрес DNS-сервера') });
		sel.value = preset ? this.values[k] : '';
		sel.addEventListener('change', function() {
			custom.hidden = sel.value !== '';
			if (sel.value)
				self.set(k, sel.value);
			else
				custom.focus();
		});
		custom.addEventListener('input', function() {
			self.set(k, custom.value.trim());
			custom.classList.toggle('bad', !!self.errors[k]);
		});
		return E('div', { 'class': 'vr-setting' }, [
			E('div', { 'class': 'text' }, [
				E('div', { 'class': 't' }, _('DNS-сервер для сайтов через VPN')),
				E('div', { 'class': 's' }, _('Через него Xray узнаёт адреса сайтов из списков. Запросы идут через VPN, а если VPN недоступен — напрямую.'))
			]),
			E('div', { 'class': 'ctl', 'style': 'flex-direction:column;gap:6px' }, [ sel, custom ])
		]);
	},

	draw: function() {
		const self = this;
		this.bar = E('div');
		dom.content(this.box, [
			E('section', { 'class': 'vr-section' }, [
				E('div', { 'class': 'vr-sh' }, E('h2', {}, _('Если VPN недоступен'))),
				this.toggle('fallback_direct', _('Пускать сайты из списков напрямую'),
					_('Когда ни один сервер не отвечает. Сайты, заблокированные провайдером, всё равно не откроются, но остальные будут работать. Если выключено, сайты из списков не откроются, пока VPN не вернётся.')),
				this.selectField('probe_interval', _('Как часто проверять серверы'),
					_('Сервер считается недоступным после четырёх неудачных проверок подряд.'), INTERVALS),
				this.textField('probe_url', _('Адрес для проверки'), _('Короткая страница, которую роутер открывает через VPN, чтобы убедиться, что сервер работает.'))
			]),
			E('section', { 'class': 'vr-section' }, [
				E('div', { 'class': 'vr-sh' }, [
					E('h2', {}, _('DNS и защита от обхода')),
					E('p', {}, _('Роутер узнаёт, какие сайты открывают устройства, по их DNS-запросам. Если устройство спрашивает DNS в обход роутера, сайты из списков пойдут мимо VPN.'))
				]),
				this.dnsField(),
				this.toggle('dns_hijack', _('Перехватывать DNS-запросы устройств'),
					_('Запросы к любым DNS-серверам на порт 53 роутер обрабатывает сам. Нужно для устройств с вписанным вручную DNS, например 8.8.8.8.')),
				this.toggle('block_doh', _('Отключить «безопасный DNS» в браузерах'),
					_('Блокирует известные серверы DNS-over-HTTPS. Браузеры заметят это и будут спрашивать DNS у роутера.')),
				this.toggle('block_dot', _('Блокировать DNS-over-TLS'),
					_('Закрывает порт 853. На Android это «Частный DNS»: телефон вернётся к DNS роутера.')),
				this.toggle('block_ipv6', _('Не пускать IPv6 в интернет'),
					_('vpnroute работает только с IPv4. Без этой защиты сайты с IPv6-адресами могут пойти мимо VPN.'))
			]),
			E('section', { 'class': 'vr-section' }, [
				E('div', { 'class': 'vr-sh' }, E('h2', {}, _('Журнал'))),
				this.selectField('log_level', _('Что записывать в журнал Xray'), _('Журнал смотрите во вкладке «Диагностика». Подробный журнал нужен только для поиска проблем.'), LOG_LEVELS)
			]),
			E('details', { 'class': 'vr-details vr-section' }, [
				E('summary', {}, _('Технические параметры')),
				E('p', { 'class': 'muted small', 'style': 'margin:6px 0 12px' }, _('Менять нужно, только если они конфликтуют с другими программами на роутере.')),
				this.textField('lan_iface', _('Интерфейсы локальной сети'), _('Трафик с этих интерфейсов проходит через vpnroute. Несколько — через запятую.')),
				this.textField('tproxy_port', _('Порт перехвата (TPROXY)'), _('Внутренний порт Xray для трафика устройств.'), { 'inputmode': 'numeric' }),
				this.textField('dns_port', _('Порт DNS Xray'), _('Внутренний порт, на который dnsmasq отправляет запросы сайтов из списков.'), { 'inputmode': 'numeric' }),
				this.textField('fwmark', _('Метка пакетов'), _('fwmark, которым помечается трафик для VPN.')),
				this.textField('route_table', _('Таблица маршрутизации'), _('Номер таблицы для помеченного трафика.'), { 'inputmode': 'numeric' })
			]),
			this.updates(),
			this.bar
		]);
		this.drawBar();
	},

	drawBar: function() {
		if (!this.bar)
			return;
		const self = this;
		const errs = Object.keys(this.errors).length;
		if (!this.isDirty()) {
			dom.content(this.bar, []);
			return;
		}
		dom.content(this.bar, E('div', { 'class': 'vr-savebar' }, [
			E('span', {}, errs ? _('Исправьте отмеченные поля') : _('Есть несохранённые изменения')),
			core.button(_('Отменить'), function() { self.load(); self.draw(); }, 'quiet'),
			core.button(_('Сохранить и применить'), function() { return self.save(); }, '', errs ? { 'disabled': '' } : {})
		]));
	},

	save: function() {
		const self = this;
		Object.keys(this.values).forEach(function(k) {
			if (self.values[k] === self.saved[k])
				return;
			if (k === 'lan_iface')
				uci.set('vpnroute', 'main', k, self.values[k].split(/\s*,\s*/).filter(Boolean));
			else
				uci.set('vpnroute', 'main', k, self.values[k]);
		});
		return core.apply().then(function() {
			self.saved = Object.assign({}, self.values);
			self.drawBar();
			core.toast(_('Настройки сохранены и применены'));
		});
	},

	// ---------- версия и обновления ----------

	updates: function() {
		const self = this;
		const box = E('div', {}, E('p', { 'class': 'muted' }, _('Загрузка…')));
		const load = function() {
			return core.runJson([ 'update', 'status' ]).catch(function(e) { return { error: e.message }; }).then(function(up) {
				dom.content(box, self.drawUpdate(up, load));
				// во время установки rpcd перезапускается, отдельные запросы не проходят
				if (up.installing || up.result === 'running' || (self.waitFor && up.installed !== self.waitFor && up.result !== 'error'))
					setTimeout(load, 2000);
				else if (self.waitFor && up.installed === self.waitFor && up.result === 'ok') {
					core.toast(_('Установлена версия %s, страница перезагрузится').format(up.installed));
					setTimeout(function() { location.reload(); }, 2500);
				}
				return up;
			});
		};
		load();
		return E('section', { 'class': 'vr-section' }, [ E('div', { 'class': 'vr-sh' }, E('h2', {}, _('Версия и обновления'))), box ]);
	},

	drawUpdate: function(up, reload) {
		const self = this;
		const fmt = function(ts) { return ts ? new Date(ts * 1000).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : _('ещё не проверялось'); };
		const busy = up.installing || up.result === 'running';
		const parts = [
			E('p', {}, [ _('Установлена версия '), E('b', {}, up.installed || _('неизвестна')), '. ', E('span', { 'class': 'muted' }, _('Последняя проверка: %s.').format(fmt(up.checked))) ])
		];
		if (busy) {
			parts.push(E('p', { 'class': 'vr-note route' }, _('Идёт установка обновления. Интернет может пропасть на несколько секунд.')));
		}
		else if (up.available) {
			parts.push(E('div', { 'class': 'vr-note route' }, [
				E('p', {}, E('b', {}, _('Доступна версия %s').format(up.latest))),
				up.notes ? E('pre', { 'class': 'vr-pre', 'style': 'max-height:200px' }, up.notes) : '',
				E('div', { 'class': 'row-actions' }, core.button(_('Установить %s').format(up.latest), function() {
					return new Promise(function(resolve) {
						core.modal(_('Установить версию %s?').format(up.latest), [
							E('p', {}, _('Интернет пропадёт на несколько секунд, затем страница перезагрузится сама.'))
						], [
							{ label: _('Отмена'), cls: 'quiet', fn: function() { resolve(); } },
							{ label: _('Установить'), cls: 'primary', fn: function() {
								self.waitFor = up.latest;
								return core.run([ 'update', 'install' ]).then(function() { setTimeout(reload, 1500); resolve(); })
									.catch(function(e) { core.toast(e.message, 'err'); resolve(); });
							} }
						]);
					});
				}, 'primary'))
			]));
		}
		if (up.error && !busy)
			parts.push(E('p', { 'class': 'vr-note alert' }, up.error));
		if (!busy)
			parts.push(E('div', { 'class': 'row-actions', 'style': 'margin-top:10px' }, core.button([ core.icon('refresh'), _('Проверить обновления') ], function() {
				return core.run([ 'update', 'check' ]).catch(function() {}).then(reload);
			})));
		if (up.log && (busy || up.result === 'error'))
			parts.push(E('pre', { 'class': 'vr-pre' }, up.log));
		return parts;
	}
});
