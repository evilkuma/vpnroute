'use strict';
'require view';
'require form';
'require uci';
'require network';

const reDomain = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const reIp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/;

function stripComment(line) {
	const i = line.indexOf('#');
	return (i >= 0 ? line.substring(0, i) : line).trim();
}

function splitLines(value) {
	return String(value || '').split(/\r?\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l !== ''; });
}

function checkDomain(line) {
	let d = stripComment(line).toLowerCase();
	if (d === '')
		return null;
	d = d.replace(/^[a-z]+:\/\//, '').replace(/[\/:?].*$/, '').replace(/^\*?\./, '').replace(/\.$/, '');
	return reDomain.test(d) ? null : _('некорректный домен «%s» (кириллические домены вводите в punycode, xn--…)').format(stripComment(line));
}

function checkIp(line) {
	const v = stripComment(line);
	if (v === '')
		return null;
	const m = v.match(reIp);
	if (!m || [ m[1], m[2], m[3], m[4] ].some(function(o) { return +o > 255; }) || (m[6] != null && +m[6] > 32))
		return _('некорректный адрес «%s» (ожидается 1.2.3.4 или 1.2.3.0/24)').format(v);
	return null;
}

function countEntries(v) {
	if (v == null)
		return 0;
	return (Array.isArray(v) ? v : [ v ]).filter(function(l) { return stripComment(l) !== ''; }).length;
}

// Многострочное поле, которое хранится в UCI как список (list domain / list ip)
function listOption(s, key, title, descr, check) {
	const o = s.option(form.TextValue, key, title, descr);
	o.modalonly = true;
	o.rows = 14;
	o.monospace = true;
	o.cfgvalue = function(sid) {
		const v = uci.get('vpnroute', sid, key);
		return Array.isArray(v) ? v.join('\n') : (v || '');
	};
	o.validate = function(sid, value) {
		const lines = splitLines(value);
		for (let i = 0; i < lines.length; i++) {
			const err = check(lines[i]);
			if (err)
				return _('Строка %d: %s').format(i + 1, err);
		}
		return true;
	};
	o.write = function(sid, value) {
		const lines = splitLines(value);
		if (lines.length)
			uci.set('vpnroute', sid, key, lines);
		else
			uci.unset('vpnroute', sid, key);
	};
	o.remove = function(sid) {
		uci.unset('vpnroute', sid, key);
	};
	return o;
}

function summarizeLink(link) {
	const m = String(link || '').match(/^vless:\/\/[^@]*@(\[[^\]]+\]|[^:\/?#]+):(\d+)[^?#]*\??([^#]*)/);
	if (!m)
		return '—';
	const q = {};
	m[3].split('&').forEach(function(kv) {
		const i = kv.indexOf('=');
		if (i > 0)
			q[kv.substring(0, i)] = decodeURIComponent(kv.substring(i + 1));
	});
	return '%s:%s (%s/%s)'.format(m[1], m[2], q.type || 'tcp', q.security || 'none');
}

return view.extend({
	load: function() {
		return network.getHostHints();
	},

	render: function(hosts) {
		let m, s, o;

		m = new form.Map('vpnroute', _('VPN-маршрутизация'),
			_('Трафик к доменам и адресам из списков идёт через VPN-туннель (Xray), остальной — напрямую. ' +
			  'Для отдельных устройств можно пустить весь трафик через VPN.'));

		// ---------- Основные настройки ----------
		s = m.section(form.NamedSection, 'main', 'main', _('Основные настройки'));
		s.addremove = false;
		s.tab('general', _('Общие'));
		s.tab('dns', _('DNS и защита'));
		s.tab('advanced', _('Дополнительно'));

		o = s.taboption('general', form.Flag, 'enabled', _('Включить маршрутизацию'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'fallback_direct', _('Напрямую при недоступности VPN'),
			_('Если ни один сервер не отвечает, трафик из списков пойдёт напрямую. Иначе он будет недоступен.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'probe_url', _('Адрес для проверки серверов'));
		o.default = 'https://www.gstatic.com/generate_204';
		o.placeholder = o.default;

		o = s.taboption('general', form.Value, 'probe_interval', _('Интервал проверки'), _('Например: 30s, 1m, 5m'));
		o.default = '1m';
		o.placeholder = o.default;

		o = s.taboption('general', form.ListValue, 'log_level', _('Подробность журнала Xray'));
		o.value('error', 'error');
		o.value('warning', 'warning');
		o.value('info', 'info');
		o.value('debug', 'debug');
		o.default = 'warning';

		o = s.taboption('dns', form.Value, 'dns_upstream', _('DNS-сервер для Xray'),
			_('Используется для запросов самого Xray. Ходит через туннель, а при его недоступности — напрямую.'));
		o.default = 'https://1.1.1.1/dns-query';
		o.placeholder = o.default;

		o = s.taboption('dns', form.Flag, 'dns_hijack', _('Перехватывать все DNS-запросы'),
			_('Запросы устройств к любым DNS-серверам на порт 53 перенаправляются на роутер.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('dns', form.Flag, 'block_dot', _('Блокировать DNS-over-TLS/QUIC'),
			_('Закрывает порт 853, чтобы устройства не обходили DNS роутера.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('dns', form.Flag, 'block_doh', _('Блокировать известные DoH-серверы'),
			_('Браузеры перестанут использовать «безопасный DNS» в обход роутера.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('dns', form.Flag, 'block_ipv6', _('Блокировать IPv6 из локальной сети'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('advanced', form.DynamicList, 'lan_iface', _('Интерфейсы локальной сети'));
		o.default = 'br-lan';
		o.placeholder = 'br-lan';

		o = s.taboption('advanced', form.Value, 'tproxy_port', _('Порт TPROXY'));
		o.datatype = 'port';
		o.default = '12701';
		o.placeholder = o.default;

		o = s.taboption('advanced', form.Value, 'dns_port', _('Порт DNS Xray'));
		o.datatype = 'port';
		o.default = '1053';
		o.placeholder = o.default;

		o = s.taboption('advanced', form.Value, 'fwmark', _('Метка пакетов (fwmark)'));
		o.default = '0x40000';
		o.placeholder = o.default;

		o = s.taboption('advanced', form.Value, 'route_table', _('Таблица маршрутизации'));
		o.datatype = 'range(1,252)';
		o.default = '107';
		o.placeholder = o.default;

		// ---------- Серверы ----------
		s = m.section(form.GridSection, 'server', _('Серверы'),
			_('Вставьте ссылку vless:// из панели вашего сервера. Если серверов несколько, используется самый быстрый из доступных.'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.modaltitle = _('Сервер');

		o = s.option(form.Value, 'name', _('Название'));
		o.rmempty = false;

		o = s.option(form.DummyValue, '_addr', _('Адрес'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return uci.get('vpnroute', sid, 'outbound_json') ? 'JSON' : summarizeLink(uci.get('vpnroute', sid, 'link'));
		};

		o = s.option(form.Flag, 'enabled', _('Включён'));
		o.default = '1';
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.TextValue, 'link', _('Ссылка VLESS'), _('Поддерживаются транспорты tcp, ws, grpc, httpupgrade, xhttp и защита tls/reality.'));
		o.modalonly = true;
		o.rows = 4;
		o.monospace = true;
		o.validate = function(sid, v) {
			v = String(v || '').trim();
			if (v === '')
				return true;
			return /^vless:\/\/[^@]+@(\[[^\]]+\]|[^:\/?#]+):\d+/.test(v) ? true : _('Ожидается ссылка вида vless://uuid@адрес:порт?параметры');
		};

		o = s.option(form.TextValue, 'outbound_json', _('Outbound в формате JSON'),
			_('Необязательно. Если заполнено, используется вместо ссылки. Для нестандартных настроек Xray.'));
		o.modalonly = true;
		o.rows = 8;
		o.monospace = true;
		o.validate = function(sid, v) {
			if (!v || !String(v).trim())
				return true;
			try {
				JSON.parse(v);
				return true;
			}
			catch (e) {
				return _('Некорректный JSON: %s').format(e.message);
			}
		};

		// ---------- Списки ----------
		s = m.section(form.GridSection, 'list', _('Списки'),
			_('Домены указываются без «www» и «*.»: example.com включает все поддомены. По одной записи в строке, после # можно писать комментарий.'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.modaltitle = _('Список');

		o = s.option(form.Value, 'name', _('Название'));
		o.rmempty = false;

		o = s.option(form.Flag, 'enabled', _('Включён'));
		o.default = '1';
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.DummyValue, '_domains', _('Доменов'));
		o.modalonly = false;
		o.textvalue = function(sid) { return String(countEntries(uci.get('vpnroute', sid, 'domain'))); };

		o = s.option(form.DummyValue, '_ips', _('IP и подсетей'));
		o.modalonly = false;
		o.textvalue = function(sid) { return String(countEntries(uci.get('vpnroute', sid, 'ip'))); };

		listOption(s, 'domain', _('Домены'), _('Например: youtube.com'), checkDomain);
		listOption(s, 'ip', _('IP-адреса и подсети'), _('Например: 149.154.160.0/20'), checkIp);

		// ---------- Устройства ----------
		s = m.section(form.GridSection, 'device', _('Устройства «весь трафик через VPN»'),
			_('Отмеченные устройства отправляют в туннель весь трафик, включая DNS. Быстро переключать можно на странице «Состояние».'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.modaltitle = _('Устройство');

		o = s.option(form.Value, 'name', _('Название'));
		o.rmempty = false;

		o = s.option(form.Value, 'mac', _('MAC-адрес'));
		o.datatype = 'macaddr';
		o.rmempty = false;
		hosts.getMACHints().forEach(function(h) {
			o.value(h[0], h[1] ? '%s (%s)'.format(h[0], h[1]) : h[0]);
		});

		o = s.option(form.Flag, 'enabled', _('Через VPN'));
		o.default = '0';
		o.rmempty = false;
		o.editable = true;

		return m.render();
	}
});
