/* Leads module (list + lead page), person first. Internally still named leads2*; it replaced the earlier Leads screens.
   LIST  – a paged table only (the lead list is expected to pass 100,000 rows). Filter → sort → slice one page;
           only that page is rendered. In the real build the same query string (tab, filters, s, sort, dir, page, size)
           goes to the API, which does the filtering, sorting and LIMIT/OFFSET in SQL on indexed columns.
   DETAIL – the main lead page (status, follow-up, Email / Call / Meeting / Research composer, timeline) with the
           person's profile on top: LinkedIn, headline, summary, experience, education, skills, languages.
   Profile data is entered by the team; nothing is fetched from LinkedIn. */
(function () {
  const { esc, fmtDate, rel, badge, prio, userLabel, opts, I, modal, toast, form, tile } = UI;
  const db = () => Store.db;
  const CLOSED = ['Won', 'Lost', 'Not Relevant'];
  const SIZES = [25, 50, 100];
  const fullName = (ct) => (ct ? (ct.firstName + ' ' + (ct.lastName || '')).trim() : '');
  const li = (ct, lg) => (ct && ct.linkedin ? '<a class="li-btn' + (lg ? ' lg' : '') + '" href="' + UI.href(ct.linkedin) + '" target="_blank" rel="noopener" title="Open LinkedIn profile" aria-label="LinkedIn profile">' + I.linkedin + (lg ? 'LinkedIn profile' : '') + '</a>' : (lg ? '<span class="li-btn lg off">' + I.linkedin + 'No LinkedIn yet</span>' : ''));
  const completeness = (ct) => { if (!ct) return 0; const checks = [ct.linkedin, ct.headline, ct.location, ct.about, ct.experience && ct.experience.length, ct.education && ct.education.length, ct.skills && ct.skills.length, ct.email, ct.mobile || ct.phone]; return Math.round(checks.filter(Boolean).length / checks.length * 100); };
  const qs = (o) => Object.keys(o).filter((k) => o[k] !== '' && o[k] !== undefined && o[k] !== null).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
  const FOLD_KEY = 'dait-l2-fold';
  const fold = (() => { try { return Object.assign({ profile: false, composer: false }, JSON.parse(localStorage.getItem(FOLD_KEY) || '{}')); } catch (e) { return { profile: false, composer: false }; } })();
  const saveFold = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify(fold)); } catch (e) { /* storage blocked: state lasts for this visit only */ } };
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const picked = new Set(); // leads ticked for the mailer; kept while paging, sorting and filtering
  const num = (n) => Number(n).toLocaleString('en-GB');

  /* ---------- list: table only, one page rendered ---------- */
  V.leads2List = function (q) {
    q = q || {}; const me = Store.currentUser(); const t = Store.today(); const tab = q.tab || 'all';
    const cmap = new Map(); db().contacts.forEach((c) => cmap.set(c.id, c)); // one pass; never a lookup per row per contact
    const ctOf = (l) => (l.contactId ? cmap.get(l.contactId) || null : null);
    const all = db().leads.filter((l) => !l.archived);
    let rows = all;
    if (tab === 'mine') rows = rows.filter((l) => l.assignedTo === me.id);
    const overdueIds = new Set(db().tasks.filter((x) => Store.isOverdue(x)).map((x) => x.leadId));
    if (tab === 'leads') rows = rows.filter((l) => l.type === 'Lead');
    if (tab === 'prospects') rows = rows.filter((l) => l.type === 'Prospect');
    if (tab === 'overdue') rows = rows.filter((l) => overdueIds.has(l.id) || (l.followUp && l.followUp < t && !CLOSED.includes(l.status)));
    ['status', 'source', 'country', 'type'].forEach((k) => { if (q[k]) rows = rows.filter((l) => l[k] === q[k]); });
    if (q.assigned) rows = rows.filter((l) => (q.assigned === 'none' ? !l.assignedTo : l.assignedTo === q.assigned));
    if (q.days) { const since = Store.addDays(t, -Number(q.days)); rows = rows.filter((l) => l.createdAt.slice(0, 10) >= since); }
    if (q.s) { const s = q.s.toLowerCase(); rows = rows.filter((l) => { const c = ctOf(l); return (l.id + ' ' + l.companyName + ' ' + (l.city || '') + ' ' + l.country + ' ' + (l.email || '') + (c ? ' ' + fullName(c) + ' ' + (c.designation || '') + ' ' + (c.headline || '') + ' ' + (c.email || '') + ' ' + (c.skills || []).join(' ') + ' ' + (c.experience || []).map((e) => e.company).join(' ') : '')).toLowerCase().includes(s); }); }
    const PRI = { High: '1', Medium: '2', Low: '3' };
    const KEYS = { id: (l) => l.id.replace(/\d+/, (n) => n.padStart(9, '0')), company: (l) => l.companyName, name: (l) => fullName(ctOf(l)), country: (l) => l.country, type: (l) => l.type, source: (l) => l.source, status: (l) => l.status, priority: (l) => PRI[l.priority] || '9', owner: (l) => (l.assignedTo ? Store.userName(l.assignedTo) : ''), followUp: (l) => l.followUp, created: (l) => l.createdAt };
    const sort = KEYS[q.sort] ? q.sort : 'created'; const dir = q.dir === 'asc' || q.dir === 'desc' ? q.dir : (sort === 'created' ? 'desc' : 'asc');
    const key = KEYS[sort]; const mul = dir === 'asc' ? 1 : -1;
    rows = rows.map((l) => [key(l) || '', l]).sort((a, b) => { if (!a[0] && b[0]) return 1; if (a[0] && !b[0]) return -1; const x = String(a[0]).toLowerCase(); const y = String(b[0]).toLowerCase(); return x < y ? -mul : x > y ? mul : (a[1].createdAt < b[1].createdAt ? 1 : -1); }).map((p) => p[1]); // empty values last
    const size = SIZES.includes(Number(q.size)) ? Number(q.size) : 50; const total = rows.length; const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(pages, Math.max(1, parseInt(q.page, 10) || 1)); const from = (page - 1) * size; const pageRows = rows.slice(from, from + size);
    const link = (patch) => '#/leads?' + qs(Object.assign({}, q, patch));
    const tabBtn = (k, label, n, cls) => '<a class="tab' + (tab === k ? ' on' : '') + '" href="' + link({ tab: k === 'all' ? '' : k, page: '' }) + '">' + label + ' <span class="n ' + (cls || '') + '">' + num(n) + '</span></a>';
    const weekAgo = Store.addDays(t, -7); const newWeek = all.filter((l) => l.createdAt.slice(0, 10) >= weekAgo);
    const sel = (name, list, label, blank) => '<select class="chip" name="' + name + '" aria-label="' + label + '">' + opts(list, q[name] || '', blank) + '</select>';
    const th = (k, label) => '<th' + (sort === k ? ' aria-sort="' + (dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + '><a href="' + link({ sort: k, dir: sort === k && dir === 'asc' ? 'desc' : 'asc', page: '' }) + '" title="Sort by ' + label + '">' + label + (sort === k ? '<span class="ar">' + (dir === 'asc' ? '▲' : '▼') + '</span>' : '') + '</a></th>';
    // Same columns as the Leads table (Lead ID first), plus the LinkedIn icon beside the contact person.
    const row = (l) => { const c = ctOf(l); const name = fullName(c); const over = l.followUp && l.followUp < t && !CLOSED.includes(l.status);
      return '<tr data-go="#/leads/' + l.id + '"' + (picked.has(l.id) ? ' class="sel"' : '') + '><td class="ck"><input type="checkbox" data-sel="' + l.id + '"' + (picked.has(l.id) ? ' checked' : '') + ' aria-label="Select ' + l.id + '"></td><td><a href="#/leads/' + l.id + '" style="font-weight:600">' + l.id + '</a></td><td class="ell"><a href="#/leads/' + l.id + '" style="color:var(--text);font-weight:600">' + esc(l.companyName) + '</a></td><td class="nm">' + (name ? '<span class="n">' + esc(name) + '</span>' : '<span class="dim">No contact yet</span>') + li(c) + '</td><td>' + esc(l.country) + '</td><td>' + badge(l.type) + '</td><td>' + esc(l.source) + (l.importBatch ? ' · batch #' + esc(l.importBatch) : '') + '</td><td>' + badge(l.status) + '</td><td>' + prio(l.priority) + '</td><td>' + userLabel(l.assignedTo) + '</td><td>' + (l.followUp ? (over ? '<span style="color:var(--bad-fg);font-weight:600">' + fmtDate(l.followUp) + ' · overdue</span>' : fmtDate(l.followUp)) : '<span class="dim">—</span>') + '</td><td style="color:var(--muted)">' + fmtDate(l.createdAt) + '</td></tr>'; };
    const cfg = db().config;
    const pbtn = (label, p, off) => '<a class="btn sm" href="' + link({ page: p }) + '"' + (off ? ' aria-disabled="true" tabindex="-1"' : '') + '>' + label + '</a>';
    const pager = '<div class="pager"><span>' + (total ? num(from + 1) + '–' + num(Math.min(total, from + size)) + ' of ' + num(total) : '0 leads') + '</span><span class="grow"></span><label>Rows <select class="chip" name="size" aria-label="Rows per page" style="height:30px">' + opts(SIZES, size) + '</select></label>' + pbtn('« First', 1, page === 1) + pbtn('‹ Prev', page - 1, page === 1) + '<label>Page <input class="in" type="number" name="page" min="1" max="' + pages + '" value="' + page + '" aria-label="Go to page"> of ' + num(pages) + '</label>' + pbtn('Next ›', page + 1, page === pages) + pbtn('Last »', pages, page === pages) + '</div>';
    const html = topbar('Leads', 'Inbound leads and researched prospects, one module', '<label class="search">' + I.search + '<span class="sr">Search leads</span><input type="search" name="s" value="' + esc(q.s || '') + '" placeholder="Search company, contact, email…"></label><button class="btn" data-act="import">Import CSV</button><a class="btn primary" href="#/leads/new">' + I.plus + 'New lead</a>') +
      '<div class="page"><div class="tiles t3">' +
      tile('New this week', num(newWeek.length), num(newWeek.filter((l) => l.source === 'Website Contact Form').length) + ' from website form', 'ok') +
      tile('Follow-ups due today', num(db().tasks.filter((x) => Store.isToday(x)).length), num(db().tasks.filter((x) => Store.isOverdue(x)).length) + ' overdue', 'bad', '#/tasks') +
      tile('Unassigned', num(all.filter((l) => !l.assignedTo).length), 'mostly CSV + Google Places prospects', '', '#/leads?assigned=none') +
      '</div><div class="card flush l2"><div class="tabs">' + tabBtn('all', 'All leads', all.length) + tabBtn('leads', 'Leads', all.filter((l) => l.type === 'Lead').length) + tabBtn('prospects', 'Prospects', all.filter((l) => l.type === 'Prospect').length) + tabBtn('mine', 'My leads', all.filter((l) => l.assignedTo === me.id).length) + tabBtn('overdue', 'Overdue follow-ups', all.filter((l) => overdueIds.has(l.id)).length, 'bad') + '</div>' +
      '<form class="filters" id="leads2Filters">' + sel('status', cfg.leadStatuses, 'Status', 'Status: Any') + sel('source', cfg.leadSources, 'Source', 'Source: Any') + sel('country', cfg.countries, 'Country', 'Country: Any') + sel('assigned', db().users.map((u) => ({ value: u.id, label: u.name })).concat([{ value: 'none', label: 'Unassigned' }]), 'Assigned to', 'Assigned: Any') + sel('type', cfg.leadTypes, 'Lead type', 'Lead type: Any') + sel('days', [{ value: 7, label: 'Created: Last 7 days' }, { value: 30, label: 'Created: Last 30 days' }, { value: 90, label: 'Created: Last 90 days' }], 'Created', 'Created: Any time') + (['status', 'source', 'country', 'assigned', 'type', 'days', 's'].some((k) => q[k]) ? '<a class="btn sm" href="' + link({ status: '', source: '', country: '', assigned: '', type: '', days: '', s: '', page: '' }) + '">Clear</a>' : '') + '<div class="grow"></div><span style="font-size:12.5px;color:var(--muted)">Showing ' + num(total) + ' of ' + num(all.length) + '</span></form>' +
      '<div class="mbulk"><span data-selcount></span><span class="grow"></span><button type="button" class="btn sm" data-act="clearsel">Clear</button><button type="button" class="btn sm primary" data-act="mailer">' + I.send + 'Send via mailer</button></div>' +
      '<div class="tbl"><table><thead><tr><th class="ck"><input type="checkbox" data-selall aria-label="Select all leads on this page"></th>' + th('id', 'Lead ID') + th('company', 'Company name') + th('name', 'Contact person') + th('country', 'Country') + th('type', 'Type') + th('source', 'Source') + th('status', 'Status') + th('priority', 'Priority') + th('owner', 'Assigned to') + th('followUp', 'Next follow-up') + th('created', 'Created') + '</tr></thead><tbody>' + (pageRows.map(row).join('') || '<tr><td colspan="12"><div class="empty">No leads match these filters.</div></td></tr>') + '</tbody></table></div>' + pager + '</div></div>';
    return { html, mount(el) {
      const f = el.querySelector('#leads2Filters'); f.addEventListener('change', () => { location.hash = link(Object.assign(form(f), { page: '' })); });
      const s = el.querySelector('[name=s]'); s.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = link({ s: s.value.trim(), page: '' }); });
      el.querySelector('.pager [name=size]').addEventListener('change', (e) => { location.hash = link({ size: e.target.value, page: '' }); });
      const pg = el.querySelector('.pager [name=page]'); pg.addEventListener('change', () => { location.hash = link({ page: Math.min(pages, Math.max(1, parseInt(pg.value, 10) || 1)) }); });
      el.querySelector('[data-act=import]').addEventListener('click', () => V.importCsv());
      // tick boxes → "Send via mailer"
      const gate = V.mailerGate(); const bulk = el.querySelector('.mbulk'); const allBox = el.querySelector('[data-selall]'); const boxes = () => [...el.querySelectorAll('[data-sel]')];
      const sync = () => { [...picked].forEach((id) => { if (!Store.lead(id)) picked.delete(id); }); const n = picked.size; bulk.classList.toggle('on', n > 0); bulk.querySelector('[data-selcount]').innerHTML = '<strong>' + n + '</strong> selected' + (gate && n ? ' · <span class="dim">' + esc(gate) + ' <a href="#/settings">Open Settings</a></span>' : ''); const mb = bulk.querySelector('[data-act=mailer]'); mb.disabled = !!gate || !n; mb.title = gate || ''; const bs = boxes(); allBox.checked = bs.length > 0 && bs.every((b) => b.checked); allBox.indeterminate = !allBox.checked && bs.some((b) => b.checked); };
      const setRow = (b, on) => { b.checked = on; if (on) picked.add(b.dataset.sel); else picked.delete(b.dataset.sel); b.closest('tr').classList.toggle('sel', on); };
      el.querySelector('tbody').addEventListener('change', (e) => { const b = e.target.closest('[data-sel]'); if (b) { setRow(b, b.checked); sync(); } });
      allBox.addEventListener('change', () => { boxes().forEach((b) => setRow(b, allBox.checked)); sync(); });
      bulk.querySelector('[data-act=clearsel]').addEventListener('click', () => { picked.clear(); boxes().forEach((b) => setRow(b, false)); sync(); });
      bulk.querySelector('[data-act=mailer]').addEventListener('click', () => V.mailerWizard([...picked], () => picked.clear()));
      sync();
      el.querySelector('tbody').addEventListener('click', (e) => { if (e.target.closest('a') || e.target.closest('td.ck')) return; const tr = e.target.closest('tr[data-go]'); if (tr) location.hash = tr.dataset.go; }); // one listener for the whole page of rows
    } };
  };

  /* ---------- detail: main lead page + person profile ---------- */
  V.leads2Detail = function (id, tab) {
    const l = Store.lead(id); if (!l) return { html: topbar('Lead not found') + '<div class="page"><div class="empty">No lead with id ' + esc(id) + '. <a href="#/leads">Back to leads</a></div></div>' };
    tab = ['followup', 'email', 'call'].includes(tab) ? tab : 'followup'; // bottom card here: Follow-up | Emails | Calls
    const base = V.leadDetail(id, tab === 'call' ? 'call' : 'email'); // status stepper, follow-up, composer (email/call/meeting/research), timeline, side cards
    const ct = Store.contact(l.contactId); const c = Store.company(l.companyId);
    const name = fullName(ct) || l.companyName; const pct = completeness(ct);
    const lastAct = db().activities.filter((a) => a.leadId === id && ['call', 'email', 'meeting'].includes(a.type)).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const fact = (label, value) => '<div><dt>' + label + '</dt><dd>' + (value || '<span class="dim">—</span>') + '</dd></div>';
    const lastTxt = lastAct ? esc(({ call: 'Call', email: 'Email', meeting: 'Meeting' })[lastAct.type]) + ' · ' + rel(lastAct.at) : '';
    const header = topbar(id,
      '<span class="l2line">Lead created: <b>' + fmtDate(l.createdAt) + '</b><i>|</i>Last contact: <b>' + (lastTxt || '—') + '</b></span>',
      '<div class="hdr-actions"><button class="btn primary" data-compose="email">' + I.send + 'Email</button>' + (ct ? '<button class="btn" data-act="editp">' + I.edit + 'Edit profile</button>' : '') + '</div>');
    const span = (x) => (x.from || '') + ' – ' + (x.to || 'Present');
    const facts = '<dl class="l2facts">' + fact('Lead source', esc(l.source)) + fact('Lead status', badge(l.status)) + fact('Lead type', badge(l.type)) + fact('Priority', prio(l.priority)) +
      fact('Industry', c && c.industry ? esc(c.industry) : '') + fact('Segment', c && c.category ? esc(c.category) : '') + fact('Company size', c && c.employeeRange ? esc(c.employeeRange) + ' employees' : '') + fact('Time zone', c && c.timezone ? esc(c.timezone) : '') + '</dl>';
    const tel = (n, kind) => '<a href="tel:' + esc(n.replace(/\s+/g, '')) + '">' + I.phoneC + esc(n) + ' <small>' + kind + '</small></a>';
    const phones = ct ? [ct.mobile && tel(ct.mobile, 'mobile'), ct.phone && tel(ct.phone, 'office')].filter(Boolean) : [];
    const person = ct ? '<div class="pinfo"><div class="prow"><div class="ptop"><div class="pnm"><h2 style="font-size:19px;margin:0">' + esc(name) + '</h2>' + badge(ct.type) + (ct.primary ? badge('Primary contact', 'b-purple2') : '') + (l.doNotEmail || ct.unsubscribedAt ? badge('Do not email', 'b-bad') : '') + '</div>' +
      '<div class="phead">' + esc(ct.headline || ct.designation || '') + '</div>' +
      '<div class="pmeta">' + (c ? '<a href="#/companies/' + c.id + '">' + esc(c.name) + '</a>' : esc(l.companyName)) + (ct.department ? ' · ' + esc(ct.department) : '') + (ct.location ? ' · ' + esc(ct.location) : '') + '</div>' + '</div>' + '<span class="l2pie" role="img" aria-label="Profile ' + pct + '% complete" title="Profile ' + pct + '% complete' + (pct < 100 ? ' · missing: ' + esc([!ct.linkedin && 'LinkedIn', !ct.headline && 'headline', !ct.location && 'location', !ct.about && 'summary', !(ct.experience || []).length && 'experience', !(ct.education || []).length && 'education', !(ct.skills || []).length && 'skills', !ct.email && 'email', !(ct.mobile || ct.phone) && 'phone'].filter(Boolean).join(', ')) : '') + '" style="--p:' + pct + '"><b>' + pct + '%</b></span>' + '</div>' +
      '<div class="pcontacts">' + li(ct, true) + (phones[0] || '') + (ct.email ? '<a href="mailto:' + esc(ct.email) + '">' + I.mailC + esc(ct.email) + '</a>' : '') + (phones[1] || '') + '</div>' + facts +
      (ct.about ? '<p class="pabout">' + esc(ct.about) + '</p>' : '') + '</div>' : '<div class="pinfo"><h2 style="font-size:19px;margin:0">' + esc(l.companyName) + '</h2><div class="note info">No contact person on this lead yet. Add one from the Contact card on the right and the profile will appear here.</div>' + facts + '</div>';
    const sec = (title, body, action) => '<section class="card" style="gap:10px"><div style="display:flex;align-items:center"><h2>' + title + '</h2><div class="grow"></div>' + action + '</div>' + body + '</section>';
    const none = (s) => '<div class="dim" style="font-size:12.5px">' + s + '</div>';
    const xpCol = ct ? '<div class="l2col"><div class="l2h"><span>Experience</span></div>' + ((ct.experience || []).length ? '<div class="xp">' + ct.experience.map((e) => '<div class="xpi' + (!e.to ? ' now' : '') + '"><div class="xpdot"></div><div><strong>' + esc(e.title) + '</strong><div>' + esc(e.company) + (!e.to ? ' ' + badge('Current', 'b-ok') : '') + '</div><div class="dim" style="font-size:12px">' + esc(span(e)) + '</div>' + (e.description ? '<div class="xpd">' + esc(e.description) + '</div>' : '') + '</div></div>').join('') + '</div>' : none('No experience recorded yet. Add it from Edit profile.')) + '</div>' : '';
    const profile = ct ? sec('Skills & languages', '<div class="sks">' + ((ct.skills || []).map((s) => '<span class="sk">' + esc(s) + '</span>').join('') || none('No skills yet')) + '</div><div class="sks">' + ((ct.languages || []).map((s) => '<span class="sk lang">' + esc(s) + '</span>').join('') || none('No languages yet')) + '</div>', '<button class="btn xs" data-act="editp">Edit</button>') : '';
    // Build on the main lead page: swap the header, put the profile on top, replace the small contact card with the profile cards.
    let html = base.html; const h = html.indexOf('</header>'); if (h < 0) return base;
    html = header + html.slice(h + 9);
    let ctrl2 = ''; // the main page's follow-up / owner / priority / type / status / tasks strip; shown under the Follow-up tab
    { // one box: person (70%) | experience (30%)
      const cut = (o, c) => { const a = html.indexOf(o); const b = html.indexOf(c); return a >= 0 && b > a ? html.slice(a + o.length, b) : ''; };
      const st = cut('<!--l2:st-->', '<!--/l2:st-->'); const ctrl = cut('<!--l2:ctrl-->', '<!--/l2:ctrl-->').replace(/<div class="quick">.*?<\/div>/, ''); // no Tomorrow / +4 days / Next week shortcuts here
      ctrl2 = ctrl.replace(/(<select[^>]*name="status"[^>]*>)([\s\S]*?)(<\/select>)/, (m, a, o, z) => a + o + ['Lost', 'Not Relevant'].filter((x) => !o.includes('value="' + x + '"')).map((x) => '<option value="' + x + '"' + (l.status === x ? ' selected' : '') + '>' + x + '</option>').join('') + z);
      const a = html.indexOf('<!--l2:top-->'); const e = html.indexOf('<!--/l2:ctrl-->'); const b = e >= 0 ? html.indexOf('</section>', e) : -1;
      if (a >= 0 && b > a && ctrl) html = html.slice(0, a) + '<section class="card flush l2sec' + (fold.profile ? ' is-closed' : '') + '"><div class="l2tb"><button type="button" class="l2tog" data-fold="profile" aria-expanded="' + !fold.profile + '" aria-controls="l2prof" title="Show or hide the profile">' + CHEV + '<span class="l2tt">Profile</span><span class="l2sum"><b>' + esc(name) + '</b>' + (ct && ct.designation ? '<span>' + esc(ct.designation) + '</span>' : '') + (ct ? '<span>' + esc(l.companyName) + '</span>' : '') + badge(l.status) + prio(l.priority) + (ct && (ct.mobile || ct.phone) ? '<span>' + esc(ct.mobile || ct.phone) + '</span>' : '') + '</span></button><button type="button" class="btn xs l2focus" data-act="focusmail" title="Hide the profile and jump to the email box">' + I.mailC + 'Focus on email</button></div><div class="l2fold" id="l2prof"><div class="l2foldin"><div class="l2box' + (ct ? '' : ' two') + '">' + (st.includes('class="stepper"') ? '' : '<div class="l2full">' + st + '</div>') + '<div class="l2col">' + person + '</div>' + xpCol + '</div></div></div></section>' + html.slice(b + 10);
    }
    { // side column: company card first (without the initials tile), then Skills & languages in place of the small contact card
      const a = html.indexOf('<!--l2:cc-->'); const b = html.indexOf('<!--/l2:cc-->'); const c1 = html.indexOf('<!--l2:co-->'); const c2 = html.indexOf('<!--/l2:co-->');
      if (a >= 0 && b > a && c1 >= b && c2 > c1) { const co = html.slice(c1, c2).replace(/<span class="logo[^"]*">[^<]*<\/span>/, ''); html = html.slice(0, a) + (ct ? co + profile : html.slice(a, b) + co) + html.slice(c2); }
    }
    { const a = html.indexOf('<!--l2:rs-->'); const b = html.indexOf('<!--/l2:rs-->'); if (a >= 0 && b > a) html = html.slice(0, a) + html.slice(b); } // no Research & links card here
    { const a = html.indexOf('<details class="card"'); const b = a >= 0 ? html.indexOf('</details>', a) : -1; if (b > a) html = html.slice(0, a) + html.slice(b + 10); } // no Details card here
    html = html.replace(new RegExp('<a class="tab[^"]*" href="#/leads/' + id + '/(?:all|meeting|research|system)">[\\s\\S]*?</a>', 'g'), '');
    { // Follow-up tab first; its panel holds the lead controls. The controls stay in the page on every tab (hidden) because the page's handlers need them.
      const openTasks = db().tasks.filter((x) => x.leadId === id && !x.done).length; const isFu = tab === 'followup';
      const t0 = html.indexOf('<!--l2:tl-->');
      if (t0 >= 0) { let seg = html.slice(t0);
        seg = seg.replace('<section class="card flush">', '<section class="card flush l2tl">');
        if (isFu) seg = seg.replace('<a class="tab on"', '<a class="tab"');
        seg = seg.replace('<a class="tab', '<a class="tab' + (isFu ? ' on' : '') + '" href="#/leads/' + id + '/followup">Follow-up <span class="n">' + openTasks + '</span></a><a class="tab');
        seg = seg.replace('<!--l2:tlb-->', '<div class="l2fu"' + (isFu ? '' : ' hidden') + '>' + ctrl2 + '</div><div' + (isFu ? ' hidden' : '') + '>').replace('<!--/l2:tlb-->', '</div>');
        html = html.slice(0, t0) + seg; } }
    return { html, mount(el) {
      if (base.mount) base.mount(el);
      { const ow = el.querySelector('.l2fu [name=assignedTo]'); const g = ow && ow.closest('.ctrl > div'); if (g) g.style.display = 'none'; } // no Owner field on the Follow-up tab (kept in the page, hidden, because the page's handlers expect it)
      // collapsible boxes: Profile and the Email / Call / Meeting / Research composer. State is remembered.
      const sec = el.querySelector('.l2sec'); const comp = el.querySelector('#composer');
      const setProfile = (closed) => { fold.profile = closed; saveFold(); if (!sec) return; sec.classList.add('is-anim'); sec.classList.toggle('is-closed', closed); sec.querySelector('.l2tog').setAttribute('aria-expanded', String(!closed)); setTimeout(() => sec.classList.remove('is-anim'), 320); };
      let ctog = null;
      const setComposer = (closed) => { fold.composer = closed; saveFold(); if (!comp) return; comp.classList.toggle('is-closed', closed); if (ctog) { ctog.setAttribute('aria-expanded', String(!closed)); ctog.querySelector('span').textContent = closed ? 'Show' : 'Hide'; } };
      if (sec) sec.querySelector('.l2tog').addEventListener('click', () => setProfile(!fold.profile));
      if (comp) {
        ctog = document.createElement('button'); ctog.type = 'button'; ctog.className = 'l2ctog'; ctog.title = 'Show or hide this box'; ctog.innerHTML = '<span></span>' + CHEV; comp.querySelector('.tabs').appendChild(ctog);
        setComposer(fold.composer);
        ctog.addEventListener('click', () => setComposer(!fold.composer));
        el.querySelectorAll('[data-ctab],[data-compose]').forEach((b) => b.addEventListener('click', () => { if (fold.composer) setComposer(false); })); // picking a tab always opens the box
      }
      // Email form layout here: To | Cc stakeholders, then Project | Template
      { const ep = el.querySelector('[data-cpanel=email] .grid2'); const cell = (sel) => { const x = ep && ep.querySelector(sel); return x ? x.closest('.grid2 > div') : null; };
        if (ep) { const to = cell('[name=to]'); const pr = cell('[name=project]'); const tp = cell('[name=tpl]'); let cc = cell('[data-sh]');
          // Cc stakeholders: a pick-list of the company's contacts and DAIT Partners staff, plus any typed email.
          // The chosen addresses are mirrored into hidden checked [data-sh] boxes, which is what the send handler reads.
          const preset = cc ? [...cc.querySelectorAll('[data-sh]:checked')].map((x) => x.dataset.sh) : [];
          if (!cc) { cc = document.createElement('div'); ep.insertBefore(cc, ep.firstChild); }
          const meU = Store.currentUser(); const toAddr = () => (ep.querySelector('[name=to]').value || '').trim().toLowerCase();
          const people = db().contacts.filter((k) => k.companyId === l.companyId && k.email).map((k) => ({ email: k.email, name: fullName(k), sub: k.designation || k.type || '', grp: l.companyName }))
            .concat(db().users.filter((u) => u.email && u.id !== meU.id).map((u) => ({ email: u.email, name: u.name, sub: u.role || '', grp: 'DAIT Partners' })));
          const known = (e) => people.find((x) => x.email.toLowerCase() === e.toLowerCase());
          const isEmail = (v) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/.test(v);
          cc.innerHTML = '<label class="lbl" for="ccIn">Cc stakeholders</label><div class="ccbox"><div class="ccfield"><span class="cchips"></span><input id="ccIn" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="ccList" autocomplete="off" placeholder="Choose people or type an email…"></div><ul class="combo-list" id="ccList" role="listbox" hidden></ul><div class="cchid" hidden></div></div>';
          const chips = cc.querySelector('.cchips'); const inp = cc.querySelector('#ccIn'); const list = cc.querySelector('#ccList'); const hid = cc.querySelector('.cchid');
          let sel = preset.slice(); let shown = []; let active = -1;
          const has = (e) => sel.some((x) => x.toLowerCase() === e.toLowerCase());
          const drawSel = () => { chips.innerHTML = sel.map((e, i) => { const k = known(e); return '<span class="cchip" title="' + esc(e) + '">' + esc(k ? k.name : e) + '<button type="button" data-ccx="' + i + '" aria-label="Remove ' + esc(k ? k.name : e) + '">✕</button></span>'; }).join(''); hid.innerHTML = sel.map((e) => '<input type="checkbox" data-sh="' + esc(e) + '" checked>').join(''); inp.placeholder = sel.length ? 'Add another…' : 'Choose people or type an email…'; };
          const drawList = () => { const q = inp.value.trim().toLowerCase(); const to = toAddr();
            shown = people.filter((x) => !has(x.email) && x.email.toLowerCase() !== to && (!q || (x.name + ' ' + x.email + ' ' + x.sub).toLowerCase().includes(q))).map((x) => ({ kind: 'p', p: x }));
            if (q && isEmail(q) && !has(q) && !known(q) && q !== to) shown.push({ kind: 'new', email: inp.value.trim() });
            let grp = null; let html = '';
            shown.forEach((o, i) => { if (o.kind === 'p') { if (o.p.grp !== grp) { grp = o.p.grp; html += '<li class="hint" role="presentation">' + esc(grp) + '</li>'; } html += '<li role="option" data-i="' + i + '">' + esc(o.p.name) + ' <span class="dim">· ' + esc(o.p.sub ? o.p.sub + ' · ' : '') + esc(o.p.email) + '</span></li>'; } else html += '<li role="option" data-i="' + i + '">Add <strong>' + esc(o.email) + '</strong></li>'; });
            if (!shown.length) html = '<li class="none" role="presentation">' + (q ? (isEmail(q) ? 'Already added' : 'No match. Type a full email address to add it.') : 'Everyone is already added. Type an email to add someone else.') + '</li>';
            list.innerHTML = html; active = shown.length ? 0 : -1; mark(); };
          const mark = () => list.querySelectorAll('[data-i]').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === active));
          const open = () => { list.hidden = false; inp.setAttribute('aria-expanded', 'true'); drawList(); };
          const shut = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); };
          const add = (e) => { if (!e || has(e)) return; sel.push(e); inp.value = ''; drawSel(); drawList(); };
          const pick = (i) => { const o = shown[i]; if (o) add(o.kind === 'p' ? o.p.email : o.email); };
          inp.addEventListener('focus', open); inp.addEventListener('input', () => { if (list.hidden) open(); else drawList(); });
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else { active = Math.min(shown.length - 1, active + 1); mark(); } }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
            else if (e.key === 'Enter' || e.key === ',' || e.key === ';') { const v = inp.value.trim(); if (e.key !== 'Enter' && !v) return; e.preventDefault(); if (!list.hidden && active >= 0 && (e.key === 'Enter')) { pick(active); return; } if (!v) return; if (isEmail(v)) { if (has(v)) { toast('Already in Cc', 'warn'); inp.value = ''; drawList(); } else add(v); } else toast('Enter a full email address, e.g. name@company.com', 'warn'); }
            else if (e.key === 'Backspace' && !inp.value && sel.length) { sel.pop(); drawSel(); drawList(); }
            else if (e.key === 'Escape') shut();
          });
          inp.addEventListener('blur', () => setTimeout(() => { if (!cc.contains(document.activeElement)) shut(); }, 140));
          // An address typed but not confirmed is included when Send is clicked (checked before the send handler runs; nothing moves on screen).
          ep.closest('[data-cpanel=email]').addEventListener('click', (e) => { if (!e.target.closest('[data-send=email]')) return; const v = inp.value.trim(); if (!v) return;
            if (!isEmail(v)) { e.stopPropagation(); e.preventDefault(); toast('Cc: "' + v + '" is not a full email address. Fix or clear it before sending.', 'warn'); inp.focus(); return; }
            if (!has(v) && v.toLowerCase() !== toAddr()) { sel.push(v); hid.insertAdjacentHTML('beforeend', '<input type="checkbox" data-sh="' + esc(v) + '" checked>'); } }, true);
          list.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(Number(li.dataset.i)); inp.focus(); } });
          chips.addEventListener('click', (e) => { const x = e.target.closest('[data-ccx]'); if (x) { sel.splice(Number(x.dataset.ccx), 1); drawSel(); if (!list.hidden) drawList(); inp.focus(); } });
          cc.querySelector('.ccfield').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target === chips) inp.focus(); });
          drawSel();
          [to, cc, pr, tp].forEach((d, i) => { if (d) { d.style.order = String(i + 1); d.style.gridColumn = 'auto'; } });
          [...ep.children].forEach((d) => { if (!d.style.order) d.style.order = '9'; }); } }
      el.querySelectorAll('[data-act=focusmail]').forEach((b) => b.addEventListener('click', () => { setProfile(true); setComposer(false); const tabBtn = comp && comp.querySelector('[data-ctab=email]'); if (tabBtn) tabBtn.click(); setTimeout(() => { if (!comp) return; window.scrollTo({ top: Math.max(0, comp.getBoundingClientRect().top + window.scrollY - 12), behavior: 'smooth' }); const subj = comp.querySelector('[name=subject]'); if (subj) subj.focus({ preventScroll: true }); }, 300); }));
      if (!ct) return;
      const act = (n, fn) => el.querySelectorAll('[data-act=' + n + ']').forEach((b) => b.addEventListener('click', fn));
      const xpRow = (e) => '<div class="xprow"><input class="in" data-x="title" placeholder="Job title" aria-label="Job title" value="' + esc(e.title || '') + '"><input class="in" data-x="company" placeholder="Company" aria-label="Company" value="' + esc(e.company || '') + '"><input class="in" data-x="from" placeholder="From" aria-label="From year" value="' + esc(e.from || '') + '"><input class="in" data-x="to" placeholder="To · blank = current" aria-label="To year, blank if current" value="' + esc(e.to || '') + '"><button type="button" class="btn xs" data-xpdel aria-label="Remove this role" title="Remove this role">✕</button><input class="in" data-x="description" placeholder="Description (optional)" aria-label="Description" value="' + esc(e.description || '') + '"></div>';
      act('editp', () => modal('<h2>Edit profile · ' + esc(name) + '</h2><div class="grid2"><div><label class="lbl">First name</label><input class="in" name="firstName" value="' + esc(ct.firstName) + '"></div><div><label class="lbl">Last name</label><input class="in" name="lastName" value="' + esc(ct.lastName) + '"></div><div><label class="lbl">Job title</label><input class="in" name="designation" value="' + esc(ct.designation || '') + '"></div><div><label class="lbl">Department</label><input class="in" name="department" value="' + esc(ct.department || '') + '"></div><div class="span2"><label class="lbl">Headline <span class="dim">(as on LinkedIn)</span></label><input class="in" name="headline" value="' + esc(ct.headline || '') + '"></div><div><label class="lbl">LinkedIn URL</label><input class="in" name="linkedin" placeholder="https://linkedin.com/in/…" value="' + esc(ct.linkedin || '') + '"></div><div><label class="lbl">Location</label><input class="in" name="location" value="' + esc(ct.location || '') + '"></div><div><label class="lbl">Email</label><input class="in" name="email" value="' + esc(ct.email || '') + '"></div><div><label class="lbl">Mobile</label><input class="in" name="mobile" value="' + esc(ct.mobile || '') + '"></div><div class="span2"><label class="lbl">Summary / about</label><textarea class="in" name="about" rows="4">' + esc(ct.about || '') + '</textarea></div><div><label class="lbl">Skills <span class="dim">(comma-separated)</span></label><input class="in" name="skills" value="' + esc((ct.skills || []).join(', ')) + '"></div><div><label class="lbl">Languages <span class="dim">(comma-separated)</span></label><input class="in" name="languages" value="' + esc((ct.languages || []).join(', ')) + '"></div><div class="span2"><label class="lbl">Experience</label><div data-xplist>' + (ct.experience || []).map(xpRow).join('') + '</div><button type="button" class="btn xs" data-xpadd style="margin-top:6px">+ Add role</button></div><div class="span2"><label class="sw" style="font-size:13px"><input type="checkbox" name="doNotEmail"' + (l.doNotEmail || ct.unsubscribedAt ? ' checked' : '') + '> Do not email <span class="dim">· opted out or unsubscribed; the mailer skips this lead</span></label></div></div><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button></div>', (bg, close) => { const xl = bg.querySelector('[data-xplist]');
        bg.querySelector('[data-xpadd]').addEventListener('click', () => { xl.insertAdjacentHTML('beforeend', xpRow({})); xl.lastElementChild.querySelector('input').focus(); });
        xl.addEventListener('click', (e) => { const x = e.target.closest('[data-xpdel]'); if (x) x.closest('.xprow').remove(); });
        bg.querySelector('[data-go]').addEventListener('click', () => { const d = form(bg); if (!d.firstName.trim()) { toast('First name is required', 'warn'); return; } const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
          const xp = [...xl.querySelectorAll('.xprow')].map((r) => { const v = (k) => r.querySelector('[data-x=' + k + ']').value.trim(); return { title: v('title'), company: v('company'), from: v('from') || null, to: v('to') || null, description: v('description') || null }; }).filter((e) => e.title || e.company || e.from || e.to || e.description);
          if (xp.some((e) => !e.title || !e.company)) { toast('Each role needs a job title and a company', 'warn'); return; }
          xp.sort((a, b) => (!a.to && b.to ? -1 : a.to && !b.to ? 1 : (b.from || '') > (a.from || '') ? 1 : -1));
          Store.updateContact(ct.id, { experience: xp, firstName: d.firstName.trim(), lastName: d.lastName.trim(), designation: d.designation || null, department: d.department || null, headline: d.headline || null, linkedin: d.linkedin || null, location: d.location || null, email: d.email || null, mobile: d.mobile || null, about: d.about || null, skills: list(d.skills), languages: list(d.languages) }); Store.setDoNotEmail(id, !!d.doNotEmail); close(); toast('Profile saved'); }); }));
    } };
  };
})();
