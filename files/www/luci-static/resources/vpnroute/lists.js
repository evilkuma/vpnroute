'use strict';
'require baseclass';
'require uci';
'require dom';
'require vpnroute.core as core';

// Сайты и адреса: слева списки, справа записи выбранного списка.
// Свои списки хранятся в uci (list domain / list ip), встроенные — файлами
// в /usr/share/vpnroute/lists, их можно только выключить целиком.

function kindLabel(e) {
	if (e.kind === 'ip')
		return e.value.indexOf('/') > 0 ? _('подсеть') : _('IP-адрес');
	return _('сайт');
}

function countText(entries) {
	const on = entries.filter(function(e) { return e.kind !== 'note' && e.enabled; });
	const d = on.filter(function(e) { return e.kind === 'domain'; }).length;
	const i = on.length - d;
	const off = entries.filter(function(e) { return e.kind !== 'note' && !e.enabled; }).length;
	const parts = [];
	if (d)
		parts.push(core.count(d, _('сайт'), _('сайта'), _('сайтов')));
	if (i)
		parts.push(core.count(i, _('адрес'), _('адреса'), _('адресов')));
	if (!parts.length)
		parts.push(_('пусто'));
	if (off)
		parts.push(_('%d выкл.').format(off));
	return parts.join(', ');
}

// Разбор вставленного текста: по записи на строку или через пробел/запятую,
// после # — комментарий (сохраняется, если запись в строке одна)
function splitPasted(text) {
	const out = [];
	String(text).split(/\r?\n/).forEach(function(line) {
		const i = line.indexOf('#');
		const body = i >= 0 ? line.substring(0, i) : line;
		const comment = i >= 0 ? line.substring(i + 1).trim() : '';
		const tokens = body.split(/[\s,;]+/).filter(Boolean);
		tokens.forEach(function(t) { out.push({ raw: t, comment: tokens.length === 1 ? comment : '' }); });
	});
	return out;
}

return baseclass.extend({
	// ---------- данные ----------

	loadBuiltin: function(ctx) {
		const ids = (ctx.status.builtin || []).map(function(l) { return l.id; }).filter(function(id) { return !ctx.builtinCache[id]; });
		if (!ids.length)
			return Promise.resolve();
		return core.builtinEntries(ids).then(function(res) {
			ids.forEach(function(id, i) { ctx.builtinCache[id] = res[i]; });
		});
	},

	groups: function(ctx) {
		const own = uci.sections('vpnroute', 'list').map(function(s) {
			return { id: s['.name'], name: s.name || s['.name'], enabled: s.enabled !== '0', builtin: false, entries: core.readEntries(s['.name']) };
		});
		const builtin = (ctx.status.builtin || []).map(function(l) {
			return { id: 'builtin:' + l.id, bid: l.id, name: l.name, builtin: true,
				enabled: uci.get('vpnroute', 'main', 'builtin_' + l.id) !== '0',
				entries: ctx.builtinCache[l.id] || [] };
		});
		return { own: own, builtin: builtin, all: own.concat(builtin) };
	},

	// ---------- страница ----------

	render: function(ctx, arg) {
		const self = this;
		this.ctx = ctx;
		return this.loadBuiltin(ctx).then(function() {
			self.selected = arg || self.selected;
			self.left = E('div', { 'class': 'vr-lists' });
			self.right = E('div', { 'class': 'vr-editor' });
			// на телефоне видна одна часть: выбор списка или его записи
			self.split = E('div', { 'class': 'vr-split' + (arg ? ' editing' : '') }, [ self.left, self.right ]);
			self.draw();
			return self.split;
		});
	},

	draw: function() {
		const g = this.groups(this.ctx);
		this.index = core.buildIndex(g.all);
		if (!g.all.some(function(x) { return x.id === this.selected; }, this))
			this.selected = (g.own[0] || g.builtin[0] || {}).id;
		this.drawLeft(g);
		this.drawRight(g);
	},

	select: function(id) {
		this.selected = id;
		history.replaceState(null, '', '#lists/' + encodeURIComponent(id));
		this.split.classList.add('editing');
		this.draw();
		if (window.matchMedia('(max-width: 760px)').matches)
			window.scrollTo(0, this.split.getBoundingClientRect().top + window.scrollY - 80);
		const input = this.right.querySelector('.vr-adder input');
		if (input && window.matchMedia('(min-width: 761px)').matches)
			input.focus();
	},

	drawLeft: function(g) {
		const self = this;
		const row = function(l) {
			const sw = core.switch(l.enabled, function(on) { self.setListEnabled(l, on); }, _('Список «%s» включён').format(l.name));
			sw.addEventListener('click', function(ev) { ev.stopPropagation(); });
			const r = E('li', {
				'class': 'vr-row' + (l.enabled ? '' : ' off'),
				'aria-current': l.id === self.selected ? 'true' : 'false',
				'tabindex': '0',
				'click': function() { self.select(l.id); },
				'keydown': function(ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); self.select(l.id); } }
			}, [
				E('div', { 'class': 'main' }, [ E('div', { 'class': 't' }, l.name), E('div', { 'class': 's' }, countText(l.entries)) ]),
				E('div', { 'class': 'side' }, sw)
			]);
			return r;
		};

		dom.content(this.left, [
			E('h3', {}, _('Мои списки')),
			g.own.length ? E('ul', { 'class': 'vr-rows' }, g.own.map(row)) : E('p', { 'class': 'vr-empty' }, _('Своих списков пока нет.')),
			E('div', { 'class': 'vr-add-list' }, core.button([ core.icon('plus'), _('Новый список') ], function() { return self.createList(); }, 'quiet')),
			g.builtin.length ? E('h3', {}, _('Встроенные')) : '',
			g.builtin.length ? E('ul', { 'class': 'vr-rows' }, g.builtin.map(row)) : ''
		]);
	},

	drawRight: function(g) {
		const l = g.all.filter(function(x) { return x.id === this.selected; }, this)[0];
		if (!l) {
			dom.content(this.right, E('div', { 'class': 'vr-empty' }, [
				E('p', {}, _('Здесь будут записи списка.')),
				core.button(_('Создать список'), L.bind(this.createList, this), 'primary')
			]));
			return;
		}
		const self = this;
		dom.content(this.right, [
			core.button(_('Все списки'), function() {
				self.split.classList.remove('editing');
				history.replaceState(null, '', '#lists');
			}, 'quiet vr-back')
		].concat(l.builtin ? this.builtinEditor(l) : this.ownEditor(l)));
	},

	// ---------- встроенный список ----------

	builtinEditor: function(l) {
		const self = this;
		return [
			E('div', { 'class': 'vr-sh' }, [
				E('h2', {}, l.name),
				E('label', { 'class': 'vr-master' }, [ l.enabled ? _('Включён') : _('Выключен'),
					core.switch(l.enabled, function(on) { self.setListEnabled(l, on); }, _('Список включён')) ])
			]),
			E('p', { 'class': 'vr-note' }, _('Этот список входит в vpnroute и обновляется вместе с ним. Записи в нём менять нельзя, можно выключить весь список. Чего-то не хватает — добавьте в свой список.')),
			this.entryRows(l, true)
		];
	},

	// ---------- свой список ----------

	ownEditor: function(l) {
		const self = this;
		const name = E('input', { 'class': 'vr-input vr-inline rename', 'value': l.name, 'aria-label': _('Название списка'), 'maxlength': '64' });
		name.addEventListener('change', function() {
			const v = name.value.trim();
			if (!v) {
				name.value = l.name;
				return;
			}
			uci.set('vpnroute', l.id, 'name', v);
			l.name = v;
			core.apply().then(function() { self.drawLeft(self.groups(self.ctx)); });
		});
		name.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') name.blur(); });

		return [
			E('div', { 'class': 'vr-sh' }, [
				name,
				E('label', { 'class': 'vr-master' }, [ l.enabled ? _('Включён') : _('Выключен'),
					core.switch(l.enabled, function(on) { self.setListEnabled(l, on); }, _('Список включён')) ]),
				core.iconButton('trash', _('Удалить список'), function() { self.deleteList(l); }, 'danger')
			]),
			l.enabled ? '' : E('p', { 'class': 'vr-note' }, _('Список выключен: его записи сейчас не работают.')),
			this.adder(l),
			this.discovery && this.discovery.list === l.id ? this.discovery.node : '',
			this.entryRows(l, false)
		];
	},

	// Поле добавления: понимает домен, ссылку, IP, подсеть и вставку нескольких строк
	adder: function(l) {
		const self = this;
		let analysis = null, chosen = null, bulk = null;

		const input = E('input', { 'class': 'vr-input', 'type': 'text', 'autocomplete': 'off', 'spellcheck': 'false',
			'placeholder': _('Сайт, ссылка или IP-адрес'), 'aria-label': _('Что добавить') });
		const comment = E('input', { 'class': 'vr-input comment', 'type': 'text', 'maxlength': '80',
			'placeholder': _('Заметка, если нужна'), 'aria-label': _('Заметка') });
		const addBtn = core.button(_('Добавить'), function() { return add(); }, 'primary');
		const hint = E('div', { 'class': 'vr-hint', 'aria-live': 'polite' });

		const describe = function(kind, v) {
			v = core.showDomain(v);
			if (kind === 'domain')
				return _('Через VPN пойдут %s и все его поддомены.').format(v);
			return v.indexOf('/') > 0 ? _('Через VPN пойдёт трафик ко всей подсети %s.').format(v) : _('Через VPN пойдёт трафик к адресу %s.').format(v);
		};

		const coverNote = function(kind, v) {
			const c = core.findCover(self.index, kind, v);
			const sv = core.showDomain(v);
			if (!c)
				return null;
			if (c.list.id === l.id && c.exact)
				return { block: true, node: E('p', {}, c.enabled || !l.enabled
					? _('%s уже есть в этом списке.').format(sv)
					: _('%s уже есть в этом списке, но выключен. Включите его переключателем ниже.').format(sv)) };
			const where = c.list.builtin ? _('во встроенном списке «%s»').format(c.list.name) : _('в списке «%s»').format(c.list.name);
			if (c.enabled)
				return { node: E('p', { 'class': 'muted' }, c.exact
					? _('%s уже идёт через VPN: он есть %s. Добавлять не обязательно.').format(sv, where)
					: _('%s уже идёт через VPN: его покрывает %s %s.').format(sv, core.showDomain(c.value), where)) };
			return { node: E('p', { 'class': 'muted' }, _('%s есть %s, но там он сейчас выключен.').format(core.showDomain(c.value), where)) };
		};

		const update = function() {
			bulk = null;
			analysis = core.analyze(input.value);
			input.classList.toggle('bad', !!(analysis && analysis.error));
			if (!analysis) {
				chosen = null;
				addBtn.disabled = true;
				dom.content(hint, []);
				return;
			}
			if (analysis.error) {
				chosen = null;
				addBtn.disabled = true;
				dom.content(hint, E('p', { 'class': 'bad' }, analysis.error));
				return;
			}
			if (!chosen || !analysis.options.some(function(o) { return o.value === chosen; }))
				chosen = analysis.def;
			drawHint();
		};

		const drawHint = function() {
			const parts = [];
			if (analysis.options.length > 1)
				parts.push(E('div', { 'class': 'vr-choices', 'role': 'group', 'aria-label': _('Что именно добавить') }, analysis.options.map(function(o) {
					return E('button', { 'type': 'button', 'class': 'vr-choice', 'aria-pressed': o.value === chosen ? 'true' : 'false',
						'click': function() { chosen = o.value; drawHint(); input.focus(); } }, [ core.showDomain(o.value), o.note ? E('small', {}, o.note) : '' ]);
				})));
			parts.push(E('p', {}, describe(analysis.kind, chosen)));
			if (analysis.note)
				parts.push(E('p', { 'class': 'muted' }, analysis.note));
			const c = coverNote(analysis.kind, chosen);
			if (c)
				parts.push(c.node);
			addBtn.disabled = !!(c && c.block);
			dom.content(hint, parts);
		};

		// Несколько записей сразу: показываем, что будет добавлено
		const showBulk = function(text) {
			const seen = {};
			bulk = splitPasted(text).map(function(t) {
				const a = core.analyze(t.raw);
				if (!a || a.error)
					return { raw: t.raw, bad: true };
				const v = a.def;
				const c = core.findCover(self.index, a.kind, v);
				const dup = seen[v] || (c && c.list.id === l.id && c.exact);
				seen[v] = true;
				return { raw: t.raw, value: v, kind: a.kind, comment: t.comment, skip: dup, covered: !dup && c && c.enabled ? c : null };
			});
			const good = bulk.filter(function(b) { return !b.bad && !b.skip; });
			addBtn.disabled = !good.length;
			addBtn.textContent = good.length ? _('Добавить %d').format(good.length) : _('Добавить');
			dom.content(hint, [
				E('p', {}, _('Вставлено записей: %d. Будет добавлено: %d.').format(bulk.length, good.length)),
				E('ul', { 'class': 'vr-bulk' }, bulk.map(function(b) {
					if (b.bad)
						return E('li', { 'class': 'bad' }, [ E('span', { 'class': 'k' }, _('не разобрать')), b.raw ]);
					if (b.skip)
						return E('li', { 'class': 'skip' }, [ E('span', { 'class': 'k' }, _('уже есть')), core.showDomain(b.value) ]);
					return E('li', {}, [ E('span', { 'class': 'k' }, b.kind === 'ip' ? _('адрес') : _('сайт')),
						core.showDomain(b.value), b.covered ? E('span', { 'class': 'muted' }, _('уже идёт через VPN')) : '' ]);
				})),
				E('div', {}, core.button(_('Отменить вставку'), function() { reset(); }, 'quiet'))
			]);
		};

		const reset = function() {
			input.value = '';
			comment.value = '';
			bulk = null;
			analysis = null;
			addBtn.textContent = _('Добавить');
			update();
			input.focus();
		};

		const add = function() {
			let items;
			if (bulk)
				items = bulk.filter(function(b) { return !b.bad && !b.skip; }).map(function(b) {
					return { value: b.value, kind: b.kind, comment: b.comment };
				});
			else if (analysis && !analysis.error && chosen)
				items = [ { value: chosen, kind: analysis.kind, comment: comment.value.trim() } ];
			if (!items || !items.length)
				return;
			const n = self.addEntries(l, items);
			reset();
			if (n > 1)
				core.toast(_('Добавлено записей: %d').format(n));
			// у одного сайта ищем, с каких ещё доменов он загружает файлы
			if (items.length === 1 && items[0].kind === 'domain')
				self.discover(l, items[0].value);
			return core.apply();
		};

		input.addEventListener('input', update);
		input.addEventListener('keydown', function(ev) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				if (!addBtn.disabled)
					add();
			}
			else if (ev.key === 'Escape') {
				reset();
			}
		});
		comment.addEventListener('keydown', function(ev) { if (ev.key === 'Enter' && !addBtn.disabled) add(); });
		input.addEventListener('paste', function(ev) {
			const text = (ev.clipboardData || window.clipboardData).getData('text');
			if (splitPasted(text).length > 1) {
				ev.preventDefault();
				input.value = '';
				showBulk(text);
			}
		});
		addBtn.disabled = true;

		return E('div', { 'class': 'vr-adder' }, [ E('div', { 'class': 'line' }, [ input, comment, addBtn ]), hint ]);
	},

	// ---------- связанные домены ----------

	// Сайт открывается на роутере через VPN, из страницы и её скриптов
	// собираются домены, с которых загружаются файлы.
	discover: function(l, domain) {
		const self = this;
		const node = E('div', { 'class': 'vr-discover', 'aria-live': 'polite' });
		const d = { list: l.id, domain: domain, node: node };
		this.discovery = d;
		const shown = core.showDomain(domain);
		const close = function() {
			node.remove();
			if (self.discovery === d)
				self.discovery = null;
		};
		dom.content(node, [
			E('p', { 'class': 'vr-busy' }, _('Открываю %s через VPN и смотрю, с каких ещё доменов он загружает файлы. Это займёт до полуминуты.').format(shown)),
			E('div', { 'class': 'row-actions' }, core.button(_('Не ждать'), close, 'quiet'))
		]);
		this.right.querySelectorAll('.vr-discover').forEach(function(n) { n.remove(); });
		const adder = this.right.querySelector('.vr-adder');
		if (adder)
			adder.after(node);

		return core.runJson([ 'discover', domain ]).then(function(res) {
			if (self.discovery === d)
				self.drawDiscovery(l, d, res, close);
		}).catch(function(e) {
			if (self.discovery === d)
				self.drawDiscovery(l, d, { error: e.message, hosts: [] }, close);
		});
	},

	drawDiscovery: function(l, d, res, close) {
		const self = this;
		const shown = core.showDomain(d.domain);
		if (res.error) {
			dom.content(d.node, [
				E('p', {}, _('Не получилось открыть %s через VPN: %s').format(shown, res.error)),
				E('p', { 'class': 'muted small' }, _('Проверьте, что VPN работает и сайт открывается. Другие домены сайта можно найти записью трафика во вкладке «Диагностика».')),
				E('div', { 'class': 'row-actions' }, core.button(_('Закрыть'), close, 'quiet'))
			]);
			return;
		}

		// Хосты объединяются по сайту (cdn.discordapp.com → discordapp.com).
		// Общие облака предлагаются точным адресом: весь cloudfront.net в VPN не нужен.
		const SHARED = [ 'cloudfront.net', 'amazonaws.com', 'akamaized.net', 'akamaihd.net', 'fastly.net', 'azureedge.net',
			'azurefd.net', 'googleusercontent.com', 'appspot.com', 'b-cdn.net', 'cdn77.org', 'edgekey.net', 'edgesuite.net',
			'website-files.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'r2.dev' ];
		const COMMON = [ 'google.com', 'googleapis.com', 'gstatic.com', 'googletagmanager.com', 'google-analytics.com',
			'doubleclick.net', 'googlesyndication.com', 'youtube.com', 'ytimg.com', 'facebook.com', 'facebook.net', 'instagram.com',
			'x.com', 'twitter.com', 'tiktok.com', 'yandex.ru', 'yandex.net', 'yastatic.net', 'vk.com', 'userapi.com', 'mail.ru',
			'cloudflare.com', 'cloudflareinsights.com', 'jsdelivr.net', 'unpkg.com', 'recaptcha.net', 'hcaptcha.com',
			'hotjar.com', 'sentry.io', 'apple.com', 'microsoft.com', 'yadro.ru' ];
		const suffix = function(h, list) {
			return list.filter(function(s) { return h === s || h.slice(-s.length - 1) === '.' + s; })[0];
		};
		const brand = d.domain.split('.').slice(-2)[0];
		const related = function(site) {
			const label = site.split('.')[0];
			return brand.length >= 4 && (label.indexOf(brand) >= 0 || (label.length >= 4 && brand.indexOf(label) >= 0));
		};

		const groups = {}, order = [];
		(res.hosts || []).forEach(function(h) {
			const shared = suffix(h.host, SHARED);
			const a = core.analyze(h.host);
			const site = shared || !a || a.error ? h.host : a.def;
			let g = groups[site];
			if (!g) {
				g = groups[site] = { site: site, hosts: [], strong: 0, weak: 0, redirect: false };
				order.push(g);
			}
			g.hosts.push(h.host);
			g.strong += h.strong;
			g.weak += h.weak;
			g.redirect = g.redirect || !!h.redirect;
		});

		const fresh = [], covered = [];
		order.forEach(function(g) {
			if (g.site === d.domain)
				return;
			const c = core.findCover(self.index, 'domain', g.site);
			if (c && c.enabled) {
				covered.push(g);
				return;
			}
			g.related = g.redirect || related(g.site);
			g.common = !g.related && suffix(g.site, COMMON);
			fresh.push(g);
		});
		const loads = fresh.filter(function(g) { return g.strong > 0; });
		const mentions = fresh.filter(function(g) { return g.strong === 0; });

		const boxes = [];
		const addBtn = core.button(_('Добавить выбранные'), function() { return addChecked(); }, 'primary');
		const count = function() {
			const n = boxes.filter(function(b) { return b.input.checked; }).length;
			addBtn.textContent = n ? _('Добавить выбранные: %d').format(n) : _('Добавить выбранные');
			addBtn.disabled = !n;
		};
		const item = function(g) {
			const input = E('input', { 'type': 'checkbox' });
			input.checked = !!g.related;
			input.addEventListener('change', count);
			boxes.push({ input: input, g: g });
			let note = '';
			if (g.redirect)
				note = _('сайт переадресует сюда');
			else if (g.related)
				note = _('похоже, тот же сайт');
			else if (g.common)
				note = _('общий сервис, обычно работает и напрямую');
			const hosts = g.hosts.filter(function(h) { return h !== g.site; });
			return E('li', {}, E('label', {}, [
				input,
				E('span', {}, [
					E('span', { 'class': 't' }, core.showDomain(g.site)), ' ',
					note ? E('span', { 'class': 'note' + (g.related ? ' route' : '') }, note) : '', ' ',
					hosts.length ? E('small', {}, hosts.slice(0, 3).join(', ') + (hosts.length > 3 ? _(' и ещё %d').format(hosts.length - 3) : '')) : ''
				])
			]));
		};

		const addChecked = function() {
			const picked = boxes.filter(function(b) { return b.input.checked; }).map(function(b) {
				return { value: b.g.site, kind: 'domain', comment: _('для %s').format(shown) };
			});
			if (!picked.length)
				return;
			const n = self.addEntries(l, picked);
			close();
			core.toast(_('Добавлено доменов: %d').format(n));
			return core.apply();
		};

		const names = function(list) { return list.map(function(g) { return core.showDomain(g.site); }).join(', '); };
		const parts = [];
		if (!fresh.length) {
			parts.push(E('p', {}, covered.length
				? _('Другие домены %s уже идут через VPN: %s.').format(shown, names(covered))
				: _('На странице %s не нашлось файлов с других доменов. Если сайт всё равно открывается не полностью, запишите его трафик во вкладке «Диагностика».').format(shown)));
			parts.push(E('div', { 'class': 'row-actions' }, core.button(_('Закрыть'), close, 'quiet')));
			dom.content(d.node, parts);
			return;
		}

		parts.push(E('p', {}, [ E('b', {}, _('%s загружает файлы и с других доменов.').format(shown)), ' ',
			_('Если сайт открывается не полностью, добавьте их тоже. Отмечены те, что похожи на сам сайт.') ]));
		if (loads.length)
			parts.push(E('h3', {}, _('Файлы страницы')), E('ul', { 'class': 'vr-picks' }, loads.map(item)));
		if (mentions.length)
			parts.push(E('details', {}, [
				E('summary', {}, _('Упоминаются в скриптах: %d').format(mentions.length)),
				E('p', { 'class': 'muted small' }, _('Обычно это адреса для данных, статистики и рекламы. Добавляйте, если без них что-то не работает.')),
				E('ul', { 'class': 'vr-picks' }, mentions.map(item))
			]));
		if (covered.length)
			parts.push(E('p', { 'class': 'muted small' }, _('Уже идут через VPN: %s.').format(names(covered))));
		parts.push(E('div', { 'class': 'row-actions' }, [ addBtn, core.button(_('Не нужно'), close, 'quiet') ]));
		count();
		dom.content(d.node, parts);
	},

	addEntries: function(l, items) {
		const entries = core.readEntries(l.id);
		const added = [];
		items.forEach(function(it) {
			// выключенная такая же запись — включить её, а не дублировать
			const old = entries.filter(function(e) { return e.kind === it.kind && e.value === it.value; })[0];
			if (old) {
				old.enabled = true;
				if (it.comment)
					old.comment = it.comment;
			}
			else {
				entries.unshift({ value: it.value, comment: it.comment || '', enabled: true, kind: it.kind, store: it.kind });
			}
			added.push(it.value);
		});
		core.writeEntries(l.id, entries);
		this.flash = added;
		this.draw();
		return added.length;
	},

	entryRows: function(l, readonly) {
		const self = this;
		const entries = l.entries.filter(function(e) { return e.kind !== 'note'; });
		if (!entries.length)
			return E('div', { 'class': 'vr-empty' }, readonly ? _('Список пуст.') : [
				E('p', {}, [ E('b', {}, _('Список пуст. ')), _('Впишите сайт или IP-адрес в поле выше. Можно вставить сразу много строк, например из заметок.') ])
			]);

		const list = E('ul', { 'class': 'vr-rows' });
		const flash = this.flash || [];
		this.flash = null;

		const drawRows = function(q) {
			q = (q || '').toLowerCase();
			dom.content(list, entries.filter(function(e) {
				return !q || e.value.indexOf(q) >= 0 || core.showDomain(e.value).indexOf(q) >= 0 || (e.comment || '').toLowerCase().indexOf(q) >= 0;
			}).map(function(e) {
				const side = [];
				const shown = core.showDomain(e.value);
				let note = '';
				// поле заметки: сразу, если она есть, иначе по кнопке
				const noteInput = function() {
					const n = E('input', { 'class': 'note', 'type': 'text', 'value': e.comment || '', 'maxlength': '80',
						'placeholder': _('Заметка'), 'aria-label': _('Заметка к %s').format(shown) });
					n.addEventListener('change', function() {
						e.comment = n.value.trim();
						self.saveEntries(l, false);
					});
					n.addEventListener('keydown', function(ev) { if (ev.key === 'Enter' || ev.key === 'Escape') n.blur(); });
					return n;
				};
				if (readonly) {
					note = e.comment ? E('div', { 'class': 's' }, e.comment) : '';
				}
				else {
					if (e.kind === 'domain')
						side.push(core.iconButton('search', _('Найти, с каких ещё доменов загружается %s').format(shown), function() {
							self.discover(l, e.value);
							self.right.scrollIntoView({ block: 'start', behavior: 'smooth' });
						}));
					if (e.comment) {
						note = noteInput();
						// пустое место вместо кнопки заметки: значки в строках стоят ровно
						side.push(E('span', { 'class': 'vr-slot' }));
					}
					else
						side.push(core.iconButton('edit', _('Добавить заметку'), function(ev) {
							const n = noteInput();
							row.querySelector('.main').appendChild(n);
							ev.currentTarget.remove();
							n.focus();
						}));
					side.push(core.switch(e.enabled, function(on) {
						e.enabled = on;
						row.classList.toggle('off', !on);
						self.saveEntries(l, true);
					}, _('%s через VPN').format(shown)));
					side.push(core.iconButton('trash', _('Удалить %s').format(shown), function() { self.deleteEntry(l, e); }));
				}
				const lead = readonly ? '' : side.splice(side.length - 2, 1)[0];
				const row = E('li', { 'class': 'vr-row vr-entry' + (e.enabled ? '' : ' off') + (flash.indexOf(e.value) >= 0 ? ' flash' : '') }, [
					lead,
					E('div', { 'class': 'main' }, [
						E('div', { 'class': 't', 'title': shown !== e.value ? e.value : null }, [ shown, ' ', E('span', { 'class': 'kind' }, kindLabel(e)) ]),
						note
					]),
					E('div', { 'class': 'side' }, side)
				]);
				return row;
			}));
		};
		drawRows('');

		const parts = [];
		if (entries.length > 8) {
			const search = E('input', { 'class': 'vr-input', 'type': 'search', 'placeholder': _('Найти в списке'), 'aria-label': _('Найти в списке') });
			search.addEventListener('input', function() { drawRows(search.value.trim()); });
			parts.push(E('div', { 'class': 'vr-filter' }, [ search, E('span', { 'class': 'muted small' }, countText(l.entries)) ]));
		}
		parts.push(list);
		return E('div', {}, parts);
	},

	// ---------- изменения ----------

	// Записать записи списка из l.entries; redrawLeft — обновить счётчики слева
	saveEntries: function(l, redrawLeft) {
		const self = this;
		core.writeEntries(l.id, l.entries);
		if (redrawLeft) {
			const g = this.groups(this.ctx);
			this.index = core.buildIndex(g.all);
			this.drawLeft(g);
		}
		return core.apply();
	},

	deleteEntry: function(l, e) {
		const self = this;
		const pos = l.entries.indexOf(e);
		l.entries.splice(pos, 1);
		core.writeEntries(l.id, l.entries);
		this.draw();
		core.apply();
		core.toast(_('%s удалён из списка').format(core.showDomain(e.value)), '', { label: _('Вернуть'), fn: function() {
			const entries = core.readEntries(l.id);
			entries.splice(Math.min(pos, entries.length), 0, e);
			core.writeEntries(l.id, entries);
			self.flash = [ e.value ];
			self.draw();
			core.apply();
		} });
	},

	setListEnabled: function(l, on) {
		if (l.builtin)
			uci.set('vpnroute', 'main', 'builtin_' + l.bid, on ? '1' : '0');
		else
			uci.set('vpnroute', l.id, 'enabled', on ? '1' : '0');
		this.draw();
		return core.apply().then(L.bind(this.ctx.refresh, this.ctx));
	},

	createList: function() {
		const self = this;
		const name = E('input', { 'class': 'vr-input', 'type': 'text', 'maxlength': '64', 'placeholder': _('Например: Работа') });
		const create = function() {
			const v = name.value.trim();
			if (!v) {
				name.classList.add('bad');
				name.focus();
				return false;
			}
			const sid = uci.add('vpnroute', 'list');
			uci.set('vpnroute', sid, 'name', v);
			uci.set('vpnroute', sid, 'enabled', '1');
			self.selected = sid;
			self.draw();
			return core.apply().then(function() {
				self.selected = uci.resolveSID('vpnroute', sid) || sid;
				history.replaceState(null, '', '#lists/' + encodeURIComponent(self.selected));
				self.draw();
			});
		};
		name.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); overlayAction(); } });
		const close = core.modal(_('Новый список'), [
			core.field(_('Название'), name, _('Списки удобны, чтобы включать и выключать группы сайтов разом.'))
		], [
			{ label: _('Отмена'), cls: 'quiet' },
			{ label: _('Создать'), cls: 'primary', fn: create }
		]);
		const overlayAction = function() { if (create() !== false) close(); };
	},

	deleteList: function(l) {
		const self = this;
		const n = l.entries.filter(function(e) { return e.kind !== 'note'; }).length;
		core.modal(_('Удалить список «%s»?').format(l.name), [
			E('p', {}, n ? _('Вместе со списком удалятся записи: %d. Их трафик пойдёт напрямую.').format(n) : _('Список пуст.'))
		], [
			{ label: _('Отмена'), cls: 'quiet' },
			{ label: _('Удалить'), cls: 'primary', fn: function() {
				uci.remove('vpnroute', l.id);
				self.selected = null;
				history.replaceState(null, '', '#lists');
				self.draw();
				return core.apply().then(L.bind(self.ctx.refresh, self.ctx));
			} }
		]);
	},

	// ---------- окно «Добавить в VPN» для других разделов ----------

	// Добавить домен или IP в один из своих списков (из обзора и диагностики)
	addDialog: function(ctx, value) {
		const self = this;
		return this.loadBuiltin(ctx).then(function() {
			const g = self.groups(ctx);
			const index = core.buildIndex(g.all);
			const a = core.analyze(value);
			if (!a || a.error) {
				core.toast(a ? a.error : _('Пустой адрес'), 'err');
				return;
			}
			let chosen = a.def;
			const info = E('div', {});
			const choices = E('div', { 'class': 'vr-choices' });
			const drawInfo = function() {
				dom.content(choices, a.options.length > 1 ? a.options.map(function(o) {
					return E('button', { 'type': 'button', 'class': 'vr-choice', 'aria-pressed': o.value === chosen ? 'true' : 'false',
						'click': function() { chosen = o.value; drawInfo(); } }, [ core.showDomain(o.value), o.note ? E('small', {}, o.note) : '' ]);
				}) : []);
				const c = core.findCover(index, a.kind, chosen);
				dom.content(info, c && c.enabled
					? E('p', { 'class': 'vr-note route' }, _('%s уже идёт через VPN: его покрывает %s в списке «%s».').format(core.showDomain(chosen), core.showDomain(c.value), c.list.name))
					: E('p', { 'class': 'muted' }, a.kind === 'domain' ? _('Через VPN пойдут %s и все его поддомены.').format(core.showDomain(chosen)) : _('Через VPN пойдёт трафик к %s.').format(chosen)));
			};
			drawInfo();

			const select = E('select', { 'class': 'vr-select' }, g.own.map(function(l) {
				return E('option', { 'value': l.id }, l.name + (l.enabled ? '' : ' ' + _('(выключен)')));
			}).concat([ E('option', { 'value': '' }, _('Новый список…')) ]));
			const newName = E('input', { 'class': 'vr-input', 'type': 'text', 'placeholder': _('Название нового списка'), 'hidden': g.own.length ? '' : null });
			if (!g.own.length)
				select.value = '';
			select.addEventListener('change', function() { newName.hidden = select.value !== ''; });

			core.modal(_('Пустить через VPN'), [
				choices, info,
				core.field(_('В какой список'), E('div', { 'style': 'display:grid;gap:8px' }, [ select, newName ])),
				E('p', { 'class': 'muted small' }, _('Браузер может какое-то время помнить старый адрес сайта. Если не заработает сразу, перезапустите его.'))
			], [
				{ label: _('Отмена'), cls: 'quiet' },
				{ label: _('Добавить'), cls: 'primary', fn: function() {
					let sid = select.value;
					if (!sid) {
						sid = uci.add('vpnroute', 'list');
						uci.set('vpnroute', sid, 'name', newName.value.trim() || _('Мои адреса'));
						uci.set('vpnroute', sid, 'enabled', '1');
					}
					const entries = core.readEntries(sid);
					const old = entries.filter(function(e) { return e.value === chosen; })[0];
					if (old)
						old.enabled = true;
					else
						entries.unshift({ value: chosen, comment: '', enabled: true, kind: a.kind, store: a.kind });
					core.writeEntries(sid, entries);
					const listName = uci.get('vpnroute', sid, 'name');
					return core.apply().then(function() {
						core.toast(_('%s добавлен в список «%s»').format(core.showDomain(chosen), listName));
						return ctx.refresh();
					});
				} }
			]);
		});
	},

	// ---------- проверка «куда пойдёт сайт» (обзор и диагностика) ----------

	checker: function(ctx, text) {
		const self = this;
		const input = E('input', { 'class': 'vr-input', 'type': 'text', 'spellcheck': 'false', 'placeholder': _('Сайт или IP-адрес'), 'aria-label': _('Сайт или IP-адрес') });
		const out = E('div', { 'class': 'vr-result', 'aria-live': 'polite' });
		const go = function() {
			const raw = input.value.trim();
			if (!raw)
				return;
			const a = core.analyze(raw);
			const v = a && !a.error ? a.value : raw;
			dom.content(out, E('p', { 'class': 'muted' }, _('Проверяю…')));
			return core.run([ 'check', v ]).then(function(text) {
				const direct = /: напрямую/.test(text);
				dom.content(out, E('div', { 'class': 'vr-note' + (direct ? '' : ' route') }, [
					E('p', {}, text),
					direct && a && !a.error ? E('div', { 'class': 'row-actions' }, core.button(_('Пустить через VPN'), function() {
						return self.addDialog(ctx, v);
					}, 'primary')) : ''
				]));
			}).catch(function(e) {
				dom.content(out, E('p', { 'class': 'vr-note alert' }, e.message));
			});
		};
		input.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') go(); });
		return E('section', { 'class': 'vr-section' }, [
			E('div', { 'class': 'vr-sh' }, [ E('h2', {}, _('Куда пойдёт сайт')), E('p', {}, text) ]),
			E('div', { 'class': 'vr-check' }, [ input, core.button(_('Проверить'), go) ]),
			out
		]);
	}
});
