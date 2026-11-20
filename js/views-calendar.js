/* Calendar (follow-ups first) and Notifications.
   Calendar: mini month + overdue list on the left; Day / Week / Month on the right. It shows follow-up tasks
   (all-day or timed) together with calls and meetings. Click an empty day to add one; click an item to open its lead.
   Notifications: everything the CRM has told the acting user, newest first, with a live "needs attention" strip. */
(function () {
  const { esc, badge, opts, I, modal, toast, form } = UI;
  const db = () => Store.db;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const p2 = (n) => String(n).padStart(2, '0');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const dow = (d) => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0; UTC so the computer's time zone cannot shift the day
  const monthStart = (d) => d.slice(0, 8) + '01';
  const addMonths = (d, n) => { const y = +d.slice(0, 4); const m = +d.slice(5, 7) - 1 + n; const dt = new Date(Date.UTC(y, m, 1)); return dt.getUTCFullYear() + '-' + p2(dt.getUTCMonth() + 1) + '-01'; };
  const dayNum = (d) => parseInt(d.slice(8), 10);
  const short = (d) => DAYS[dow(d)].slice(0, 3) + ' ' + dayNum(d) + ' ' + MONTHS[+d.slice(5, 7) - 1].slice(0, 3);
  const qs = (o) => Object.keys(o).filter((k) => o[k]).map((k) => k + '=' + encodeURIComponent(o[k])).join('&');
  const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  /* Everything that sits on the calendar, in one shape. */
  function items(who, me) {
    const t = Store.today(); const out = [];
    db().tasks.filter((x) => x.due && (who === 'all' || x.assignedTo === me.id)).forEach((x) => { const l = x.leadId ? Store.lead(x.leadId) : null; out.push({ kind: 'task', id: x.id, date: x.due, time: x.time || '', title: x.title, done: !!x.done, over: !x.done && x.due < t, leadId: x.leadId, company: l ? l.companyName : '', owner: x.assignedTo, type: 'followup' }); });
    db().events.filter((e) => e.type !== 'task' ? true : true).filter((e) => who === 'all' || e.organiser === me.id || (e.attendeeIds || []).includes(me.id) || (e.attendees || '').includes(me.name)).forEach((e) => { const l = e.leadId ? Store.lead(e.leadId) : null; out.push({ kind: 'event', id: e.id, date: e.date, time: e.start || '', end: e.end || '', title: e.title, done: !!e.done, over: false, leadId: e.leadId, company: l ? l.companyName : (e.note || ''), owner: e.organiser, type: e.type || 'meeting', where: e.where || '' }); });
    return out.sort((a, b) => (a.date === b.date ? (a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : a.title.localeCompare(b.title) : a.date < b.date ? -1 : 1));
  }
  const chip = (x, full) => { const cls = 'cit t-' + esc(x.type) + (x.done ? ' done' : '') + (x.over ? ' over' : ''); const inner = (x.time ? '<span class="tm">' + esc(x.time) + '</span>' : '') + '<span class="tt">' + esc(x.title) + '</span>' + (full && x.company ? '<span class="co">' + esc(x.company) + (x.leadId ? ' · ' + esc(x.leadId) : '') + '</span>' : ''); const tip = esc(x.title + (x.company ? ' · ' + x.company : '') + (x.done ? ' (done)' : x.over ? ' (overdue)' : ''));
    return x.leadId ? '<a class="' + cls + '" href="#/leads/' + esc(x.leadId) + '" title="' + tip + '">' + inner + '</a>' : '<button type="button" class="' + cls + '" data-info="' + esc(x.id) + '" title="' + tip + '">' + inner + '</button>'; };

  V.calendar = function (q) {
    q = q || {}; const me = Store.currentUser(); const t = Store.today();
    const view = ['day', 'week', 'month'].includes(q.view) ? q.view : 'month'; const d = isDate(q.d) ? q.d : t; const who = q.who === 'all' ? 'all' : 'mine';
    const all = items(who, me); const byDay = {}; all.forEach((x) => { (byDay[x.date] = byDay[x.date] || []).push(x); });
    const link = (patch) => '#/calendar?' + qs(Object.assign({ view, d, who: who === 'all' ? 'all' : '' }, patch));
    const ms = monthStart(d); const gridStart = Store.addDays(ms, -dow(ms)); const inMonth = (x) => x.slice(0, 7) === d.slice(0, 7);
    const weekStart = Store.addDays(d, -dow(d));
    const range = view === 'month' ? [...Array(42)].map((_, i) => Store.addDays(gridStart, i)) : view === 'week' ? [...Array(7)].map((_, i) => Store.addDays(weekStart, i)) : [d];
    const title = view === 'month' ? MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : view === 'week' ? dayNum(range[0]) + (range[0].slice(5, 7) !== range[6].slice(5, 7) ? ' ' + MONTHS[+range[0].slice(5, 7) - 1].slice(0, 3) : '') + ' – ' + dayNum(range[6]) + ' ' + MONTHS[+range[6].slice(5, 7) - 1].slice(0, 3) + ' ' + range[6].slice(0, 4) : DAYS[dow(d)] + ' ' + dayNum(d) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
    const prev = view === 'month' ? addMonths(d, -1) : Store.addDays(d, view === 'week' ? -7 : -1); const next = view === 'month' ? addMonths(d, 1) : Store.addDays(d, view === 'week' ? 7 : 1);
    const scope = view === 'month' ? all.filter((x) => inMonth(x.date)) : all.filter((x) => range.includes(x.date));
    const openN = scope.filter((x) => !x.done).length;
    const overdue = all.filter((x) => x.kind === 'task' && x.over);

    // mini month
    const miniDays = [...Array(42)].map((_, i) => Store.addDays(gridStart, i));
    const mini = '<section class="card cmini"><div class="cmh"><strong>' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) + '</strong><span class="grow"></span><a class="cnav" href="' + link({ d: addMonths(d, -1) }) + '" aria-label="Previous month">' + CHEV_L + '</a><a class="cnav" href="' + link({ d: addMonths(d, 1) }) + '" aria-label="Next month">' + CHEV_R + '</a></div><div class="cmg">' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => '<span class="wd">' + x + '</span>').join('') +
      miniDays.map((x) => '<a href="' + link({ d: x }) + '" class="' + (inMonth(x) ? 'in' : 'out') + (x === t ? ' today' : '') + (x === d && view !== 'month' ? ' sel' : '') + ((byDay[x] || []).some((i) => !i.done) ? ' has' : '') + '" aria-label="' + esc(short(x)) + '">' + dayNum(x) + '</a>').join('') + '</div></section>';
    const overdueBox = '<div class="cover"><div class="coh">Overdue ' + (overdue.length ? '<span>' + overdue.length + '</span>' : '') + '</div>' + (overdue.map((x) => '<a class="coi" href="' + (x.leadId ? '#/leads/' + esc(x.leadId) : link({ view: 'day', d: x.date })) + '"><strong>' + esc(x.title) + '</strong><span>' + esc([x.company, short(x.date) + (x.time ? ', ' + x.time : '')].filter(Boolean).join(', ')) + '</span></a>').join('') || '<div class="con">Nothing overdue.</div>') + '</div>';

    // main grid
    let grid;
    if (view === 'month') { const weeks = range.slice(35).some(inMonth) ? 6 : 5; const cells = range.slice(0, weeks * 7);
      grid = '<div class="cgrid month"><div class="cgh">' + DAYS.map((x) => '<div>' + x + '</div>').join('') + '</div><div class="cgb">' + cells.map((x) => { const its = byDay[x] || []; const first = dayNum(x) === 1; return '<div class="cc' + (inMonth(x) ? '' : ' out') + (x === t ? ' today' : '') + '" data-day="' + x + '"><div class="cn"><span>' + (first ? MONTHS[+x.slice(5, 7) - 1].slice(0, 3) + ' ' : '') + dayNum(x) + '</span></div>' + its.slice(0, 3).map((i) => chip(i)).join('') + (its.length > 3 ? '<a class="cmore" href="' + link({ view: 'day', d: x }) + '">+' + (its.length - 3) + ' more</a>' : '') + '</div>'; }).join('') + '</div></div>'; }
    else if (view === 'week') grid = '<div class="cgrid week"><div class="cgh">' + range.map((x) => '<div class="' + (x === t ? 'today' : '') + '">' + DAYS[dow(x)].slice(0, 3) + ' <b>' + dayNum(x) + '</b></div>').join('') + '</div><div class="cgb">' + range.map((x) => '<div class="cc tall' + (x === t ? ' today' : '') + '" data-day="' + x + '">' + ((byDay[x] || []).map((i) => chip(i)).join('') || '<span class="cnone">—</span>') + '</div>').join('') + '</div></div>';
    else { const its = byDay[d] || []; grid = '<div class="cgrid day"><div class="cc tall' + (d === t ? ' today' : '') + '" data-day="' + d + '">' + (its.map((i) => chip(i, true)).join('') || '<div class="empty" style="padding:40px 0">Nothing on this day. Click here to add a follow-up.</div>') + '</div></div>'; }

    const acct = Store.accountFor(me.id);
    const html = topbar('Calendar', 'Follow-ups, calls and meetings for your leads' + (acct && acct.syncCalendar ? ' · ' + badge('Outlook sync on', 'b-ok') : ''), '<div class="seg" role="group" aria-label="Whose items"><a class="' + (who === 'mine' ? 'on' : '') + '" href="' + link({ who: '' }) + '">Mine</a><a class="' + (who === 'all' ? 'on' : '') + '" href="' + link({ who: 'all' }) + '">Everyone</a></div>') +
      '<div class="page ccal"><aside class="cside">' + mini + overdueBox + '</aside><div class="cmain"><div class="cbar"><button class="btn primary" data-act="newfu">' + I.plus + 'New follow-up</button><a class="btn" href="' + link({ d: t }) + '">Today</a><a class="cnav lg" href="' + link({ d: prev }) + '" aria-label="Previous">' + CHEV_L + '</a><a class="cnav lg" href="' + link({ d: next }) + '" aria-label="Next">' + CHEV_R + '</a><h2 class="ctitle">' + esc(title) + '</h2><span class="grow"></span><div class="seg" role="group" aria-label="View">' + ['day', 'week', 'month'].map((v) => '<a class="' + (v === view ? 'on' : '') + '" href="' + link({ view: v }) + '">' + v[0].toUpperCase() + v.slice(1) + '</a>').join('') + '</div></div>' +
      '<div class="csum">' + openN + ' open ' + (openN === 1 ? 'item' : 'items') + ' in this ' + view + '. Click an empty slot to add a follow-up; click an item to open its lead.</div>' + grid +
      '<div class="cleg"><span class="k t-followup"></span>Follow-up<span class="k t-call"></span>Call<span class="k t-meeting"></span>Meeting<span class="k t-internal"></span>Internal<span class="k over"></span>Overdue<span class="k done"></span>Done</div></div></div>';

    return { html, mount(el) {
      const leads = db().leads.filter((l) => !l.archived && !['Won', 'Lost', 'Not Relevant'].includes(l.status));
      const open = (date) => modal('<h2>New follow-up</h2><div class="grid2"><div class="span2"><label class="lbl" for="fuLead">Lead <span class="req">*</span></label><select id="fuLead" class="in" name="leadId" data-search><option value="">— choose a lead —</option>' + leads.map((l) => '<option value="' + l.id + '"' + (q.lead === l.id ? ' selected' : '') + '>' + esc(l.id + ' · ' + l.companyName + (Store.contactName(l.contactId) ? ' · ' + Store.contactName(l.contactId) : '')) + '</option>').join('') + '</select></div><div class="span2"><label class="lbl" for="fuTitle">What to do <span class="req">*</span></label><input id="fuTitle" class="in" name="title" placeholder="e.g. Call back about the proposal"></div><div><label class="lbl" for="fuType">Type</label><select id="fuType" class="in" name="type">' + opts([{ value: 'followup', label: 'Follow-up (task)' }, { value: 'call', label: 'Call' }, { value: 'meeting', label: 'Meeting' }], 'followup') + '</select></div><div><label class="lbl" for="fuWho">Assigned to</label><select id="fuWho" class="in" name="assignedTo">' + opts(db().users.map((u) => ({ value: u.id, label: u.name })), me.id) + '</select></div><div><label class="lbl" for="fuDate">Date <span class="req">*</span></label><input id="fuDate" class="in" type="date" name="date" value="' + esc(date || d) + '"></div><div><label class="lbl" for="fuTime">Time <span class="dim">· optional for a follow-up</span></label><input id="fuTime" class="in" type="time" name="time"></div></div><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Add to calendar</button></div>', (bg, close) => bg.querySelector('[data-go]').addEventListener('click', () => { const f = form(bg);
        if (!f.leadId) { toast('Choose a lead', 'warn'); return; } if (!f.title.trim()) { toast('Say what needs doing', 'warn'); return; } if (!isDate(f.date)) { toast('Choose a date', 'warn'); return; }
        if (f.type !== 'followup' && !f.time) { toast('A ' + f.type + ' needs a time', 'warn'); return; }
        const l = Store.lead(f.leadId);
        if (f.type === 'followup') Store.createFollowUp({ leadId: f.leadId, title: f.title.trim(), due: f.date, time: f.time || null, assignedTo: f.assignedTo });
        else { const [h, m] = f.time.split(':').map(Number); const endM = h * 60 + m + (f.type === 'call' ? 30 : 60); Store.createEvent({ title: f.title.trim(), type: f.type, organiser: f.assignedTo, date: f.date, start: f.time, end: p2(Math.min(23, Math.floor(endM / 60))) + ':' + p2(endM % 60), leadId: f.leadId, companyId: l.companyId, attendees: [Store.contactName(l.contactId), Store.userName(f.assignedTo)].filter(Boolean).join(', '), attendeeIds: [f.assignedTo], where: f.type === 'call' ? 'Phone' : 'Microsoft Teams', note: '' }); }
        close(); toast((f.type === 'followup' ? 'Follow-up' : f.type === 'call' ? 'Call' : 'Meeting') + ' added for ' + short(f.date)); }));
      el.querySelector('[data-act=newfu]').addEventListener('click', () => open(view === 'month' ? (inMonth(t) ? t : ms) : d));
      if (q.new) setTimeout(() => open(d), 0);
      el.querySelectorAll('.cc[data-day]').forEach((c) => c.addEventListener('click', (e) => { if (e.target.closest('a,button')) return; open(c.dataset.day); }));
      el.querySelectorAll('[data-info]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const ev = db().events.find((x) => x.id === b.dataset.info); if (!ev) return; modal('<h2>' + esc(ev.title) + '</h2><dl class="kv" style="grid-template-columns:110px 1fr"><dt>When</dt><dd>' + esc(short(ev.date)) + ' · ' + esc(ev.start + '–' + ev.end) + '</dd><dt>Type</dt><dd>' + esc(ev.type) + '</dd><dt>Organiser</dt><dd>' + esc(Store.userName(ev.organiser)) + '</dd><dt>Attendees</dt><dd style="font-weight:400">' + esc(ev.attendees || '—') + '</dd><dt>Where</dt><dd>' + esc(ev.where || '—') + '</dd></dl><div class="actions"><button class="btn primary" data-close>Close</button></div>'); }));
    } };
  };

  /* ---------- Notifications ---------- */
  const KIND = [[/^New lead|^Lead transferred/i, 'person', '#EFE6FD', 'Leads'], [/^Email/i, 'mailS', '#E4D5FB', 'Email'], [/^Mailer/i, 'mailS', '#FFF1E0', 'Mailer'], [/^Quotation/i, 'quoteS', '#FFF1E0', 'Quotations'], [/^AI research/i, 'spark', '#FFF8EC', 'AI research'], [/^Meeting/i, 'calS', '#EFE6FD', 'Calendar'], [/^Project/i, 'swap', '#EFE6FD', 'Projects'], [/mailbox/i, 'mailS', '#E6F6EC', 'Mailbox']];
  const kindOf = (n) => { const k = KIND.find((x) => x[0].test(n.text)); return k ? { icon: k[1], bg: k[2], label: k[3] } : { icon: 'clock', bg: '#EDE9F4', label: 'Other' }; };
  V.notifications = function (q) {
    q = q || {}; const me = Store.currentUser(); const t = Store.today(); const tab = q.tab === 'unread' ? 'unread' : 'all';
    const mine = db().notifications.filter((n) => n.userId === me.id).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
    const kinds = [...new Set(mine.map((n) => kindOf(n).label))];
    let rows = tab === 'unread' ? mine.filter((n) => !n.read) : mine; if (q.kind) rows = rows.filter((n) => kindOf(n).label === q.kind);
    const unread = mine.filter((n) => !n.read).length;
    const link = (patch) => '#/notifications?' + qs(Object.assign({ tab: tab === 'unread' ? 'unread' : '', kind: q.kind || '' }, patch));
    const grp = (n) => { const dd = n.at.slice(0, 10); return dd === t ? 'Today' : dd === Store.addDays(t, -1) ? 'Yesterday' : 'Earlier'; };
    const myTasks = db().tasks.filter((x) => x.assignedTo === me.id && !x.done); const od = myTasks.filter((x) => x.due < t).length; const td = myTasks.filter((x) => x.due === t).length;
    const unreadMail = Store.counts.unread(); const live = (db().campaigns || []).filter((c) => c.senderId === me.id && ['Sending', 'Scheduled', 'Paused'].includes(c.status)).length;
    const att = [[od, od + ' overdue follow-up' + (od === 1 ? '' : 's'), '#/calendar', 'bad'], [td, td + ' follow-up' + (td === 1 ? '' : 's') + ' due today', '#/calendar?view=day', 'warn'], [unreadMail, unreadMail + ' unread email' + (unreadMail === 1 ? '' : 's'), '#/email', ''], [live, live + ' mailer run' + (live === 1 ? '' : 's') + ' in progress', '#/mailer', '']].filter((a) => a[0]);
    let last = null;
    const html = topbar('Notifications', 'What has happened on your leads, newest first', '<button class="btn" data-act="readall"' + (unread ? '' : ' disabled') + '>Mark all as read</button>') +
      '<div class="page">' + (att.length ? '<div class="natt">' + att.map((a) => '<a class="' + a[3] + '" href="' + a[2] + '">' + esc(a[1]) + ' →</a>').join('') + '</div>' : '') +
      '<div class="card flush"><div class="tabs"><a class="tab' + (tab === 'all' ? ' on' : '') + '" href="' + link({ tab: '' }) + '">All <span class="n">' + mine.length + '</span></a><a class="tab' + (tab === 'unread' ? ' on' : '') + '" href="' + link({ tab: 'unread' }) + '">Unread <span class="n' + (unread ? ' bad' : '') + '">' + unread + '</span></a></div>' +
      '<div class="filters"><a class="nk' + (!q.kind ? ' on' : '') + '" href="' + link({ kind: '' }) + '">All types</a>' + kinds.map((k) => '<a class="nk' + (q.kind === k ? ' on' : '') + '" href="' + link({ kind: k }) + '">' + esc(k) + '</a>').join('') + '<span class="grow"></span><span class="dim" style="font-size:12.5px">Showing ' + rows.length + ' of ' + mine.length + '</span></div>' +
      '<div class="nlist">' + (rows.map((n) => { const k = kindOf(n); const g = grp(n); const head = g !== last ? '<div class="ngh">' + g + '</div>' : ''; last = g; return head + '<button type="button" class="nrow' + (n.read ? '' : ' unread') + '" data-n="' + esc(n.id) + '"><span class="ni" style="background:' + k.bg + '">' + I[k.icon] + '</span><span class="nb"><strong>' + esc(n.text) + '</strong>' + (n.detail ? '<span class="nd">' + esc(n.detail) + '</span>' : '') + '<span class="nm">' + esc(k.label) + ' · ' + UI.rel(n.at) + '</span></span>' + (n.read ? '' : '<span class="ndot" aria-label="Unread"></span>') + '</button>'; }).join('') || '<div class="empty">' + (tab === 'unread' ? 'You are all caught up.' : 'No notifications yet.') + '</div>') + '</div></div></div>';
    return { html, mount(el) {
      el.querySelector('[data-act=readall]').addEventListener('click', () => { Store.markAllNotifications(me.id); toast('All notifications marked as read'); });
      el.querySelector('.nlist').addEventListener('click', (e) => { const b = e.target.closest('[data-n]'); if (!b) return; const n = db().notifications.find((x) => x.id === b.dataset.n); if (!n) return; const go = typeof n.link === 'string' && n.link.indexOf('#/') === 0 ? n.link : null; App.silent(() => Store.markNotification(n.id)); if (go && go !== location.hash) location.hash = go; else App.render(); });
    } };
  };
})();
