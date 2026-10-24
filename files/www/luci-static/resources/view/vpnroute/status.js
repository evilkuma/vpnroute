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
		].concat(st.lists.map(function(l) {
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
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', _('VPN-маршрутизация: состояние')),
			E('div', { 'id': 'vpnroute-status' }, this.renderStatus(st)),
			this.renderCheck(),
			this.renderLogs()
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
