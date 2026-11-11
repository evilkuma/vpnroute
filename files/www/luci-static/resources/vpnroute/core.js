'use strict';
'require baseclass';
'require fs';
'require uci';
'require rpc';

// Общие части интерфейса vpnroute: команды роутеру, сохранение настроек,
// разбор записей списков, подсказки при вводе, окна и сообщения.

const CLI = '/usr/bin/vpnroute';
const LISTS_DIR = '/usr/share/vpnroute/lists';

const callCommit = rpc.declare({ object: 'uci', method: 'commit', params: [ 'config' ] });
const callHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });

const reDomain = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$/;
const reIp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
// Домены второго уровня, на которых регистрируют сайты (example.com.ru, example.co.uk)
const SLD = [ 'com', 'net', 'org', 'co', 'gov', 'edu', 'ac', 'msk', 'spb' ];

const ICONS = {
	trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
	plus: 'M12 5v14M5 12h14',
	edit: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
	search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4',
	close: 'M6 6l12 12M18 6L6 18',
	refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
	probe: 'M3 12h4l3-7 4 14 3-7h4'
};

let statusEl = null, statusTimer = null;
let applyTimer = null, applyChain = Promise.resolve(), applyWaiters = [];

function ipToInt(a) {
	const p = a.split('.').map(Number);
	return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n) {
	return [ n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255 ].join('.');
}

function parseCidr(v) {
	const m = String(v).match(reIp);
	if (!m || [ m[1], m[2], m[3], m[4] ].some(function(o) { return +o > 255; }))
		return null;
	const pfx = m[5] != null ? +m[5] : 32;
	if (pfx > 32)
		return null;
	const mask = pfx === 0 ? 0 : (0xffffffff << (32 - pfx)) >>> 0;
	const net = (ipToInt(m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4]) & mask) >>> 0;
	return { net: net, pfx: pfx, mask: mask, text: pfx === 32 ? intToIp(net) : intToIp(net) + '/' + pfx };
}

// Домен из того, что вставили: ссылка, *.домен, домен с портом, кириллица
function cleanDomain(raw) {
	let d = String(raw).trim().toLowerCase();
	d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@\/]*@/, '');
	d = d.replace(/[\/?#].*$/, '').replace(/:\d+$/, '');
	d = d.replace(/^\*?\./, '').replace(/\.$/, '');
	if (/[^\x00-\x7f]/.test(d)) {
		try { d = new URL('http://' + d).hostname; } catch (e) { return null; }
	}
	return reDomain.test(d) ? d : null;
}

// Основной домен сайта: example.com из m.video.example.com, example.co.uk
function siteDomain(d) {
	const p = d.split('.');
	if (p.length > 2 && SLD.indexOf(p[p.length - 2]) >= 0)
		return p.slice(-3).join('.');
	return p.slice(-2).join('.');
}

// Punycode (RFC 3492): xn--… обратно в кириллицу, только для показа
function punyDecode(input) {
	const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
	const out = [];
	let i = 0, n = 128, bias = 72;
	let basic = input.lastIndexOf('-');
	if (basic < 0)
		basic = 0;
	for (let j = 0; j < basic; j++)
		out.push(input.charCodeAt(j));
	for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length;) {
		const oldi = i;
		let w = 1;
		for (let k = base; ; k += base) {
			if (idx >= input.length)
				throw new Error('punycode');
			const c = input.charCodeAt(idx++);
			const digit = c - 48 < 10 ? c - 22 : (c - 65 < 26 ? c - 65 : (c - 97 < 26 ? c - 97 : base));
			if (digit >= base)
				throw new Error('punycode');
			i += digit * w;
			const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
			if (digit < t)
				break;
			w *= base - t;
		}
		const len = out.length + 1;
		let delta = oldi === 0 ? Math.floor((i - oldi) / damp) : (i - oldi) >> 1;
		delta += Math.floor(delta / len);
		let k = 0;
		while (delta > ((base - tMin) * tMax) >> 1) {
			delta = Math.floor(delta / (base - tMin));
			k += base;
		}
		bias = k + Math.floor((base - tMin + 1) * delta / (delta + skew));
		n += Math.floor(i / len);
		i %= len;
		out.splice(i++, 0, n);
	}
	return String.fromCodePoint.apply(null, out);
}

function showDomain(d) {
	if (String(d).indexOf('xn--') < 0)
		return d;
	return String(d).split('.').map(function(l) {
		if (l.indexOf('xn--') !== 0)
			return l;
		try { return punyDecode(l.substring(4)); } catch (e) { return l; }
	}).join('.');
}

function svgIcon(name) {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(ns, 'path');
	path.setAttribute('d', ICONS[name]);
	svg.appendChild(path);
	return svg;
}

return baseclass.extend({
	CLI: CLI,

	// ---------- команды роутеру ----------

	run: function(args) {
		return fs.exec(CLI, args).then(function(res) {
			const out = (res.stdout || '').trim();
			if (res.code !== 0)
				throw new Error((res.stderr || out || ('код ' + res.code)).trim());
			return out;
		});
	},

	runJson: function(args) {
		return this.run(args).then(JSON.parse);
	},

	hostHints: function() {
		return callHostHints().catch(function() { return {}; });
	},

	// Встроенные списки: файлы с записями и комментариями
	builtinEntries: function(ids) {
		return Promise.all(ids.map(function(id) {
			return fs.read(LISTS_DIR + '/' + id + '.list').then(function(text) {
				const entries = [];
				String(text || '').split('\n').forEach(function(line) {
					if (/^\s*#/.test(line) || !line.trim())
						return;
					const i = line.indexOf('#');
					const value = (i >= 0 ? line.substring(0, i) : line).trim();
					if (value)
						entries.push({ value: value, comment: i >= 0 ? line.substring(i + 1).trim() : '', enabled: true,
							kind: reIp.test(value) ? 'ip' : 'domain' });
				});
				return entries;
			}).catch(function() { return []; });
		}));
	},

	// ---------- сохранение ----------

	// Строка состояния в шапке: «Применяю…», «Применено», ошибка
	bindStatus: function(el) {
		statusEl = el;
	},

	setStatus: function(kind, text) {
		if (!statusEl)
			return;
		clearTimeout(statusTimer);
		statusEl.className = 'vr-saving ' + (kind || '');
		statusEl.textContent = text || '';
		if (kind === 'done')
			statusTimer = setTimeout(function() {
				statusEl.className = 'vr-saving';
				statusEl.textContent = '';
			}, 2500);
	},

	// Сохранить изменения uci, записать их и применить. Частые переключения
	// собираются в одно применение.
	apply: function() {
		const self = this;
		return new Promise(function(resolve, reject) {
			applyWaiters.push({ resolve: resolve, reject: reject });
			self.setStatus('busy', _('Применяю…'));
			clearTimeout(applyTimer);
			applyTimer = setTimeout(function() {
				const waiters = applyWaiters;
				applyWaiters = [];
				applyChain = applyChain.then(function() {
					return uci.save()
						.then(function() { return callCommit('vpnroute'); })
						.then(function() { return self.run([ 'apply' ]); })
						.then(function() {
							self.setStatus('done', _('Применено'));
							waiters.forEach(function(w) { w.resolve(); });
						})
						.catch(function(e) {
							self.setStatus('err', _('Не применилось'));
							self.toast(_('Не удалось применить: %s').format(e.message), 'err');
							waiters.forEach(function(w) { w.reject(e); });
						});
				});
			}, 350);
		});
	},

	// ---------- записи списков ----------

	// Строка списка: «домен», «домен # комментарий», выключенная — «#off домен».
	// Строки с # vpnroute пропускает, поэтому выключенная запись не работает.
	parseEntry: function(raw) {
		let s = String(raw).trim(), enabled = true;
		const off = s.match(/^#off\s+(.*)$/);
		if (off) {
			enabled = false;
			s = off[1];
		}
		else if (s.charAt(0) === '#') {
			return { kind: 'note', raw: raw };
		}
		const i = s.indexOf('#');
		const value = (i >= 0 ? s.substring(0, i) : s).trim();
		return { value: value, comment: i >= 0 ? s.substring(i + 1).trim() : '', enabled: enabled };
	},

	formatEntry: function(e) {
		if (e.kind === 'note')
			return e.raw;
		return (e.enabled ? '' : '#off ') + e.value + (e.comment ? ' # ' + e.comment.replace(/[\r\n]/g, ' ') : '');
	},

	readEntries: function(sid) {
		const self = this;
		const out = [];
		[ 'domain', 'ip' ].forEach(function(kind) {
			let v = uci.get('vpnroute', sid, kind);
			if (v == null)
				return;
			(Array.isArray(v) ? v : [ v ]).forEach(function(raw) {
				const e = self.parseEntry(raw);
				e.kind = e.kind === 'note' ? 'note' : kind;
				e.store = kind;
				out.push(e);
			});
		});
		return out;
	},

	writeEntries: function(sid, entries) {
		const self = this;
		[ 'domain', 'ip' ].forEach(function(kind) {
			const lines = entries.filter(function(e) { return e.store === kind; }).map(function(e) { return self.formatEntry(e); });
			if (lines.length)
				uci.set('vpnroute', sid, kind, lines);
			else
				uci.unset('vpnroute', sid, kind);
		});
	},

	// ---------- разбор ввода ----------

	// Что ввели: домен или IP, к какому виду привести и что предложить.
	// Возвращает { kind, value, options: [{ value, note }], def, error, note }.
	analyze: function(raw) {
		const s = String(raw || '').trim();
		if (!s)
			return null;

		if (/^[\d.\/\s]+$/.test(s)) {
			const c = parseCidr(s.replace(/\s/g, ''));
			if (!c)
				return { error: _('Это не похоже на IP-адрес. Пример: 149.154.167.99 или 149.154.160.0/20') };
			const res = { kind: 'ip', value: c.text, def: c.text, options: [] };
			if (c.pfx === 32) {
				const net24 = intToIp((c.net & 0xffffff00) >>> 0) + '/24';
				res.options = [
					{ value: c.text, note: _('только этот адрес') },
					{ value: net24, note: _('256 соседних адресов') }
				];
			}
			else {
				const typed = s.replace(/\s/g, '');
				res.options = [ { value: c.text, note: _('%d адресов').format(Math.pow(2, 32 - c.pfx)) } ];
				if (typed !== c.text)
					res.note = _('Подсеть записана как %s: так её понимает роутер.').format(c.text);
			}
			return res;
		}

		const d = cleanDomain(s);
		if (!d)
			return { error: _('Не получается разобрать адрес. Пример: youtube.com или https://www.youtube.com/watch') };

		const site = siteDomain(d);
		const parts = d.split('.');
		const options = [];
		for (let i = 0; i < parts.length - 1; i++) {
			const v = parts.slice(i).join('.');
			if (v.split('.').length < site.split('.').length)
				break;
			options.push({ value: v, note: v === site ? _('весь сайт') : (i === 0 ? _('только этот поддомен') : '') });
		}
		const res = { kind: 'domain', value: d, def: d, options: options };
		// www и другие поддомены обычно не нужны: основной домен покрывает их
		if (d !== site)
			res.def = /^(www|m|mobile)\./.test(d) ? d.replace(/^(www|m|mobile)\./, '') : site;
		if (res.def !== d && options.length === 1)
			options.unshift({ value: res.def, note: _('весь сайт') });
		return res;
	},

	// Где уже есть запись, покрывающая value: { list, entry, exact }
	findCover: function(index, kind, value) {
		if (kind === 'domain') {
			let d = value;
			while (d.indexOf('.') > 0) {
				const hit = index.domains[d];
				if (hit)
					return { list: hit.list, value: d, enabled: hit.enabled, exact: d === value };
				d = d.substring(d.indexOf('.') + 1);
			}
			return null;
		}
		const c = parseCidr(value);
		if (!c)
			return null;
		for (let i = 0; i < index.ips.length; i++) {
			const n = index.ips[i];
			if (n.pfx <= c.pfx && ((c.net & n.mask) >>> 0) === n.net)
				return { list: n.list, value: n.text, enabled: n.enabled, exact: n.pfx === c.pfx };
		}
		return null;
	},

	// Указатель всех записей: { domains: { домен: {list} }, ips: [ {net, mask, list} ] }
	buildIndex: function(groups) {
		const idx = { domains: {}, ips: [] };
		groups.forEach(function(g) {
			g.entries.forEach(function(e) {
				if (e.kind === 'note' || !e.value)
					return;
				const on = g.enabled && e.enabled;
				if (e.kind === 'ip') {
					const c = parseCidr(e.value);
					if (c)
						idx.ips.push({ net: c.net, mask: c.mask, pfx: c.pfx, text: c.text, list: g, enabled: on });
				}
				else {
					const d = cleanDomain(e.value);
					// включённая запись важнее выключенной
					if (d && (!idx.domains[d] || (on && !idx.domains[d].enabled)))
						idx.domains[d] = { list: g, enabled: on };
				}
			});
		});
		return idx;
	},

	cleanDomain: cleanDomain,
	showDomain: showDomain,
	parseCidr: parseCidr,

	// ---------- элементы интерфейса ----------

	icon: svgIcon,

	button: function(label, fn, cls, attrs) {
		const b = E('button', Object.assign({ 'type': 'button', 'class': 'vr-btn ' + (cls || '') }, attrs || {}), label);
		b.addEventListener('click', function(ev) {
			const r = fn(ev);
			if (r && typeof r.then === 'function') {
				b.disabled = true;
				r.then(function() { b.disabled = false; }, function() { b.disabled = false; });
			}
		});
		return b;
	},

	iconButton: function(name, title, fn, cls) {
		return this.button(svgIcon(name), fn, 'icon quiet ' + (cls || ''), { 'title': title, 'aria-label': title });
	},

	switch: function(checked, onChange, label, big) {
		const input = E('input', { 'type': 'checkbox', 'role': 'switch', 'aria-label': label || '' });
		input.checked = !!checked;
		input.addEventListener('change', function() { onChange(input.checked, input); });
		return E('label', { 'class': 'vr-switch' + (big ? ' big' : ''), 'title': label || '' }, [ input, E('span') ]);
	},

	toast: function(text, kind, action) {
		let box = document.querySelector('.vr-toasts');
		if (!box) {
			box = E('div', { 'class': 'vr-toasts vr-layer', 'role': 'status', 'aria-live': 'polite' });
			document.body.appendChild(box);
		}
		const t = E('div', { 'class': 'vr-toast ' + (kind || '') }, [ E('span', {}, text) ]);
		let timer;
		const close = function() { clearTimeout(timer); t.remove(); };
		if (action)
			t.appendChild(E('button', { 'type': 'button', 'click': function() { close(); action.fn(); } }, action.label));
		box.appendChild(t);
		timer = setTimeout(close, action ? 7000 : (kind === 'err' ? 8000 : 3500));
		return close;
	},

	// Окно: body — узел или массив, actions — [{ label, fn, cls }].
	// fn может вернуть false, чтобы окно не закрылось, или промис.
	modal: function(title, body, actions) {
		const prev = document.activeElement;
		const overlay = E('div', { 'class': 'vr-overlay vr-layer' });
		const close = function() {
			overlay.remove();
			document.removeEventListener('keydown', onKey);
			if (prev && prev.focus)
				prev.focus();
		};
		const onKey = function(ev) { if (ev.key === 'Escape') close(); };
		const foot = E('div', { 'class': 'foot' });
		const dialog = E('div', { 'class': 'vr-dialog', 'role': 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
			E('h2', {}, title), E('div', { 'class': 'body' }, body), foot
		]);
		(actions || [ { label: _('Закрыть') } ]).forEach(function(a) {
			foot.appendChild(this.button(a.label, function() {
				const r = a.fn ? a.fn() : null;
				if (r === false)
					return;
				if (r && typeof r.then === 'function')
					return r.then(function(ok) { if (ok !== false) close(); });
				close();
			}, a.cls || ''));
		}, this);
		overlay.appendChild(dialog);
		overlay.addEventListener('mousedown', function(ev) { if (ev.target === overlay) close(); });
		document.addEventListener('keydown', onKey);
		document.body.appendChild(overlay);
		const first = dialog.querySelector('input, select, textarea') || foot.lastChild;
		if (first)
			first.focus();
		return close;
	},

	field: function(label, control, hint) {
		return E('label', { 'class': 'vr-field' }, [ E('span', {}, label), control, hint ? E('small', {}, hint) : '' ]);
	},

	plural: function(n, one, few, many) {
		const m10 = n % 10, m100 = n % 100;
		if (m10 === 1 && m100 !== 11)
			return one;
		if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14))
			return few;
		return many;
	},

	count: function(n, one, few, many) {
		return n + ' ' + this.plural(n, one, few, many);
	}
});
