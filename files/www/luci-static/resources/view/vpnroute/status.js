'use strict';
'require view';
'require fs';
'require ui';
'require dom';

const CLI = '/usr/bin/vpnroute';

function run(args) {
	return fs.exec(CLI, args).then(function(res) {
		const out = (res.stdout || '').trim();
		if (res.code !== 0)
			throw new Error((res.stderr || out || ('код ' + res.code)).trim());
		return out;
	});
}

function badge(ok, yes, no) {
	return E('span', {
		'class': 'label',
		'style': 'padding:2px 8px;border-radius:4px;color:#fff;background:' + (ok ? '#2e7d32' : '#c62828')
	}, ok ? yes : no);
}

return view.extend({
	load: function() {
		return run([ 'status-json' ]).then(JSON.parse).catch(function(e) {
			return { error: e.message };
		});
	},

	loadUpdate: function() {
		return run([ 'update', 'status' ]).then(JSON.parse).catch(function(e) {
			return { error: e.message };
		});
	},

	refreshUpdate: function() {
		return this.loadUpdate().then(L.bind(function(up) {
			dom.content(this.updateBox, this.renderUpdate(up));
			return up;
		}, this));
	},

	checkUpdate: function() {
		// при ошибке check завершается с кодом 1, текст ошибки есть в состоянии
		return run([ 'update', 'check' ]).catch(function() {}).then(L.bind(this.refreshUpdate, this));
	},

	installUpdate: function(up) {
		if (!confirm(_('Установить версию %s? Интернет пропадёт на несколько секунд, страница перезагрузится сама.').format(up.latest)))
			return;
		return run([ 'update', 'install' ]).then(L.bind(function() {
			this.pollUpdate(up.latest);
		}, this)).catch(function(e) {
			ui.addNotification(null, E('p', e.message), 'danger');
		});
	},

	// Во время установки rpcd перезапускается, поэтому отдельные запросы
	// могут не пройти: продолжаем опрашивать
	pollUpdate: function(target) {
		const self = this;
		const tick = function() {
			self.refreshUpdate().then(function(up) {
				if (up.error && !up.installed)
					return setTimeout(tick, 2000);
				if (up.installing || up.result === 'running')
					return setTimeout(tick, 2000);
				if (up.result === 'ok' && up.installed === target) {
					ui.addNotification(null, E('p', _('Установлена версия %s, перезагружаю страницу').format(target)), 'info');
					setTimeout(function() { location.reload(); }, 3000);
				}
			}).catch(function() { setTimeout(tick, 2000); });
		};
		setTimeout(tick, 2000);
	},

	renderUpdate: function(up) {
		const rows = [];
		const fmt = function(ts) { return ts ? new Date(ts * 1000).toLocaleString() : _('ещё не проверялось'); };
		const busy = up.installing || up.result === 'running';

		rows.push(E('p', {}, [
			_('Установлена версия: '), E('strong', up.installed || _('неизвестна')),
			E('small', { 'style': 'opacity:.7;margin-left:12px' }, _('последняя проверка: ') + fmt(up.checked))
		]));

		if (up.error && !busy)
			rows.push(E('div', { 'class': 'alert-message warning' }, up.error));

		if (busy) {
			rows.push(E('div', { 'class': 'alert-message notice' }, _('Идёт установка обновления…')));
		}
		else if (up.available) {
			rows.push(E('div', { 'class': 'alert-message notice' }, [
				E('strong', _('Доступна версия %s').format(up.latest)),
				up.notes ? E('pre', { 'style': 'white-space:pre-wrap;margin:8px 0 0' }, up.notes) : ''
			]));
			rows.push(E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'installUpdate', up)
			}, _('Обновить до %s').format(up.latest)));
			rows.push(' ');
		}
		else if (up.result === 'ok' && up.finished) {
			rows.push(E('p', { 'class': 'cbi-value-description' }, _('Обновление установлено: ') + fmt(up.finished)));
		}

		if (!busy)
			rows.push(E('button', {
				'class': 'cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(this, 'checkUpdate')
			}, _('Проверить обновления')));

		if (up.log && (busy || up.result === 'error'))
			rows.push(E('pre', { 'style': 'max-height:250px;overflow:auto;white-space:pre-wrap;margin-top:8px' }, up.log));

		return E('div', {}, rows);
	},

	refresh: function() {
		return this.load().then(L.bind(function(st) {
			dom.content(document.getElementById('vpnroute-status'), this.renderStatus(st));
		}, this));
	},

	toggleDevice: function(dev) {
		return run([ 'device', dev.id, dev.enabled ? 'off' : 'on' ])
			.then(L.bind(function(out) {
				ui.addNotification(null, E('p', out), 'info');
				return this.refresh();
			}, this))
			.catch(function(e) {
				ui.addNotification(null, E('p', e.message), 'danger');
			});
	},

	renderStatus: function(st) {
		if (st.error)
			return E('div', { 'class': 'alert-message warning' }, _('Не удалось получить состояние: ') + st.error);

		const summary = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', 'width': '33%' }, _('Маршрутизация')), E('td', { 'class': 'td left' }, badge(st.enabled, _('включена'), _('выключена'))) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, 'Xray'), E('td', { 'class': 'td left' }, [ badge(st.running, _('работает'), _('остановлен')), ' ', E('small', st.version || '') ]) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('Правила nftables')), E('td', { 'class': 'td left' }, badge(st.rules, _('применены'), _('не применены'))) ])
		]);

		const servers = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th' }, _('Сервер')), E('th', { 'class': 'th' }, _('Адрес')), E('th', { 'class': 'th' }, _('Транспорт')), E('th', { 'class': 'th' }, _('Включён')) ])
		].concat(st.servers.map(function(s) {
			return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td' }, s.name), E('td', { 'class': 'td' }, s.address), E('td', { 'class': 'td' }, s.transport), E('td', { 'class': 'td' }, s.enabled ? _('да') : _('нет')) ]);
		})));

		const lists = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th' }, _('Список')), E('th', { 'class': 'th' }, _('Доменов')), E('th', { 'class': 'th' }, _('IP и подсетей')), E('th', { 'class': 'th' }, _('Включён')) ])
		].concat((st.builtin || []).map(function(l) {
			return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td' }, [ l.name, ' ', E('small', { 'style': 'opacity:.6' }, _('встроенный')) ]), E('td', { 'class': 'td' }, String(l.domains)), E('td', { 'class': 'td' }, String(l.ips)), E('td', { 'class': 'td' }, l.enabled ? _('да') : _('нет')) ]);
		})).concat(st.lists.map(function(l) {
			return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td' }, l.name), E('td', { 'class': 'td' }, String(l.domains)), E('td', { 'class': 'td' }, String(l.ips)), E('td', { 'class': 'td' }, l.enabled ? _('да') : _('нет')) ]);
		})));

		const devices = st.devices.length ? E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th' }, _('Устройство')), E('th', { 'class': 'th' }, 'MAC'), E('th', { 'class': 'th' }, _('Весь трафик')), E('th', { 'class': 'th' }, '') ])
		].concat(st.devices.map(L.bind(function(d) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, d.name),
				E('td', { 'class': 'td' }, d.mac),
				E('td', { 'class': 'td' }, badge(d.enabled, _('через VPN'), _('как обычно'))),
				E('td', { 'class': 'td' }, E('button', {
					'class': 'cbi-button ' + (d.enabled ? 'cbi-button-reset' : 'cbi-button-apply'),
					'click': ui.createHandlerFn(this, 'toggleDevice', d)
				}, d.enabled ? _('Выключить VPN') : _('Включить VPN')))
			]);
		}, this)))) : E('p', { 'class': 'cbi-value-description' }, _('Устройства не добавлены. Добавьте их на странице «Настройки».'));

		return E('div', {}, [
			E('h3', _('Общее')), summary,
			E('h3', _('Устройства')), devices,
			E('h3', _('Серверы')), servers,
			E('h3', _('Списки')), lists
		]);
	},

	renderCheck: function() {
		const input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'example.com или 1.2.3.4', 'style': 'width:20em' });
		const output = E('pre', { 'style': 'margin-top:8px;white-space:pre-wrap' }, '');
		const go = function() {
			const v = input.value.trim();
			if (!v)
				return;
			output.textContent = _('Проверяю…');
			return run([ 'check', v ]).then(function(out) {
				output.textContent = out;
			}).catch(function(e) {
				output.textContent = e.message;
			});
		};
		input.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') go(); });

		return E('div', {}, [
			E('h3', _('Проверка домена или IP')),
			E('div', {}, [ input, ' ', E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, go) }, _('Проверить')) ]),
			output
		]);
	},

	renderLogs: function() {
		const output = E('pre', { 'style': 'max-height:300px;overflow:auto;white-space:pre-wrap' }, '');
		return E('div', {}, [
			E('h3', _('Журнал')),
			E('button', {
				'class': 'cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(this, function() {
					return run([ 'logs', '100' ]).then(function(out) {
						output.textContent = out || _('Записей нет');
					}).catch(function(e) {
						output.textContent = e.message;
					});
				})
			}, _('Показать последние записи')),
			output
		]);
	},

	render: function(st) {
		const box = this.updateBox = E('div', { 'id': 'vpnroute-update' }, E('em', _('Загрузка…')));
		this.refreshUpdate().then(L.bind(function(up) {
			// страницу открыли во время установки
			if (up.installing || up.result === 'running')
				this.pollUpdate(up.latest);
		}, this));

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', _('VPN-маршрутизация: состояние')),
			E('div', { 'id': 'vpnroute-status' }, this.renderStatus(st)),
			E('h3', _('Версия и обновления')), box,
			this.renderCheck(),
			this.renderLogs()
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
