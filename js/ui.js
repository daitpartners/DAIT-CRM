/* Small UI helpers shared by all views. No framework: template strings + event delegation. */
window.UI = (function () {
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Escaped href for a URL that came from data or user input: only http(s), mailto and tel survive. */
  const href = (u) => esc(Store.safeUrl(u) || '#');
  const dash = (v, cls) => (v === null || v === undefined || v === '' ? '<span class="dim">—</span>' : esc(v));
  /* Dates and times follow the acting user's preferences (Settings → Preferences): date format and time zone.
     Stored timestamps are wall-clock times in the office zone (Asia/Kolkata, UTC+5:30); date-only values
     (follow-up, due date) are calendar days and are never shifted. */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MON = { en: MONTHS, es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'], fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'] };
  const BASE_TZ = 'Asia/Kolkata'; const BASE_OFFSET_MIN = 330;
  const DATE_FORMATS = ['auto', 'd MMM yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'MMM d, yyyy'];
  const TIME_ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto', 'UTC'];
  const prefs = () => { let u = null; try { u = Store.currentUser(); } catch (e) { /* store not ready */ } u = u || {}; return { fmt: DATE_FORMATS.includes(u.dateFormat) ? u.dateFormat : 'auto', tz: u.timeZone || BASE_TZ, lang: MON[u.lang] ? u.lang : 'en' }; };
  const p2 = (n) => String(n).padStart(2, '0');
  function zoned(s, tz) {
    const y = +s.slice(0, 4); const m = +s.slice(5, 7); const d = +s.slice(8, 10);
    if (s.length <= 10) return { y, m, d, time: null };
    const hh = +s.slice(11, 13); const mi = +s.slice(14, 16); const same = { y, m, d, time: p2(hh) + ':' + p2(mi) };
    if (tz === BASE_TZ) return same;
    try { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.UTC(y, m - 1, d, hh, mi) - BASE_OFFSET_MIN * 60000)); const g = (k) => +parts.find((x) => x.type === k).value; return { y: g('year'), m: g('month'), d: g('day'), time: p2(g('hour')) + ':' + p2(g('minute')) }; } catch (e) { return same; } // unknown zone: show office time
  }
  function fmtYMD(z, fmt, lang) {
    const mon = (MON[lang] || MONTHS)[z.m - 1];
    if (fmt === 'dd/MM/yyyy') return p2(z.d) + '/' + p2(z.m) + '/' + z.y;
    if (fmt === 'MM/dd/yyyy') return p2(z.m) + '/' + p2(z.d) + '/' + z.y;
    if (fmt === 'yyyy-MM-dd') return z.y + '-' + p2(z.m) + '-' + p2(z.d);
    if (fmt === 'MMM d, yyyy') return MONTHS[z.m - 1] + ' ' + z.d + ', ' + z.y;
    if (fmt === 'd MMM yyyy') return z.d + ' ' + MONTHS[z.m - 1] + ' ' + z.y;
    return z.d + ' ' + mon + ' ' + z.y; // auto: follows the language
  }
  function fmtDate(s) { if (!s) return '—'; const p = prefs(); return fmtYMD(zoned(s, p.tz), p.fmt, p.lang); }
  function fmtDT(s) { if (!s) return '—'; const p = prefs(); const z = zoned(s, p.tz); return fmtYMD(z, p.fmt, p.lang) + (z.time ? ', ' + z.time : ''); }
  function rel(s) { if (!s) return ''; const p = prefs(); const z = zoned(s, p.tz); const d = z.y + '-' + p2(z.m) + '-' + p2(z.d); const t = Store.today(); const tm = z.time ? ', ' + z.time : ''; if (d === t) return 'Today' + tm; if (d === Store.addDays(t, -1)) return 'Yesterday' + tm; return fmtYMD(z, p.fmt, p.lang) + tm; }
  /* Examples for the Settings dropdowns */
  const fmtSample = (fmt, lang) => fmtYMD(zoned(Store.today(), BASE_TZ), fmt, lang);
  const tzOffset = (tz) => { try { const part = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName'); return part ? part.value.replace('GMT', 'UTC') : ''; } catch (e) { return ''; } };
  const STATUS = { New: 'b-purple', 'Not Contacted': 'b-grey', Contacted: 'b-info', Interested: 'b-ok', Qualified: 'b-ok', 'Proposal Sent': 'b-purple2', Negotiation: 'b-warn', Won: 'b-ok', Lost: 'b-bad', 'Not Relevant': 'b-grey', Draft: 'b-grey', Sent: 'b-purple', Negotiating: 'b-warn', Accepted: 'b-ok', Rejected: 'b-bad', Expired: 'b-grey', Active: 'b-ok', Inactive: 'b-grey', Closed: 'b-bad', Pending: 'b-warn', Processing: 'b-warn', Completed: 'b-ok', Failed: 'b-bad', Verified: 'b-ok', 'Partially verified': 'b-warn', Unverified: 'b-grey', Lead: 'b-purple', Prospect: 'b-grey', 'Decision Maker': 'b-purple', Influencer: 'b-purple2', Other: 'b-grey' };
  const badge = (v, cls) => '<span class="badge ' + (cls || STATUS[v] || 'b-grey') + '">' + esc(v) + '</span>';
  const enqBadge = (s) => badge(s, s.startsWith('Processed') ? 'b-ok' : s.startsWith('Needs') ? 'b-bad' : s === 'Spam' ? 'b-grey' : 'b-warn');
  const prio = (p) => '<span class="prio ' + esc(p) + '">' + esc(p) + '</span>';
  const userLabel = (id) => (id ? esc(Store.userName(id)) : '<span class="dim">Unassigned</span>');
  const aiTag = (conf) => '<span class="tag-ai">AI' + (conf ? ' · ' + conf + '%' : '') + '</span>';
  const okTag = () => '<span class="tag-ok">VERIFIED</span>';
  const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const logo = (name, lg) => '<span class="logo' + (lg ? ' lg' : '') + '">' + esc(initials(name)) + '</span>';
  const opts = (list, sel, blank) => (blank ? '<option value="">' + esc(blank) + '</option>' : '') + list.map((o) => { const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o; return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  const I = {
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    leads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17 14c2.8.5 4 2.9 4 6"/></svg>',
    companies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/></svg>',
    enq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12l3 3 5-6"/></svg>',
    reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6A5E86" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="#8A3E12" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    mailS: '<svg viewBox="0 0 24 24" fill="none" stroke="#4B0A9A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="#8A4B00" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 12h12M12 6l6 6-6 6"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="#4B0A9A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="#8A4B00" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="#176B3A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/></svg>',
    calS: '<svg viewBox="0 0 24 24" fill="none" stroke="#4B0A9A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    quoteS: '<svg viewBox="0 0 24 24" fill="none" stroke="#8A4B00" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="#514768" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="#4B0A9A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="#8A3E12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/></svg>',
    phoneC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    calC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    bookC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/></svg>',
    mailC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    person2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/><path d="M17 3.5l1.2 2.3 2.5.4-1.8 1.8.4 2.5-2.3-1.2"/></svg>',
    linkedin: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.4 2H3.6A1.6 1.6 0 0 0 2 3.6v16.8A1.6 1.6 0 0 0 3.6 22h16.8a1.6 1.6 0 0 0 1.6-1.6V3.6A1.6 1.6 0 0 0 20.4 2zM8 19H5V9h3zM6.5 7.7A1.7 1.7 0 1 1 6.5 4.3a1.7 1.7 0 0 1 0 3.4zM19 19h-3v-4.9c0-1.2 0-2.7-1.6-2.7s-1.9 1.3-1.9 2.6V19h-3V9h2.9v1.4a3.2 3.2 0 0 1 2.9-1.6c3 0 3.6 2 3.6 4.6z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>',
  };
  const ACT = { call: ['phone', '#FBE4D4'], email: ['mailS', '#E4D5FB'], meeting: ['calS', '#EFE6FD'], transfer: ['arrow', '#FFF1E0'], assign: ['person', '#EFE6FD'], ai: ['spark', '#FFF8EC'], created: ['inbox', '#E6F6EC'], status: ['swap', '#EFE6FD'], quote: ['quoteS', '#FFF1E0'], note: ['clock', '#EDE9F4'], research: ['book', '#FBE4D4'] };
  function timeline(items, last) {
    return items.map((a, i) => { const [ic, bg] = ACT[a.type] || ACT.note; return '<div class="tl"><div class="rail"><div class="dot" style="background:' + bg + '">' + I[ic] + '</div>' + (i < items.length - 1 ? '<div class="line"></div>' : '') + '</div><div class="ev"><div><strong>' + esc(a.title) + '</strong> <span class="m">· ' + esc(a.by ? Store.userName(a.by) : '') + ' · ' + rel(a.at) + (a.leadId && a.showLead ? ' · <a href="#/leads/' + a.leadId + '">' + a.leadId + '</a>' : '') + '</span></div>' + (a.body ? '<div class="b' + (a.type === 'research' ? ' research' : '') + '">' + esc(a.body) + (a.url ? '<br><a href="' + UI.href(a.url) + '" target="_blank" rel="noopener">' + esc(a.url.replace(/^https?:\/\//, '')) + ' ↗</a>' : '') + '</div>' : '') + (a.statusTo ? '<div class="m" style="margin-top:6px;font-size:12px">Status ' + badge(a.statusFrom) + ' → ' + badge(a.statusTo) + '</div>' : '') + '</div></div>'; }).join('') || '<div class="empty">No activity yet.</div>';
  }
  /* Searchable dropdown: any <select> with 8+ options (or data-search) becomes a type-to-filter combobox.
     The original select stays in the DOM (hidden) so forms and change handlers keep working. */
  const COMBO_MIN = 8;
  function enhanceSelects(root) {
    root.querySelectorAll('select').forEach((sel) => {
      if (sel.dataset.combo || sel.multiple) return;
      if (!sel.hasAttribute('data-search') && sel.options.length < COMBO_MIN) return;
      sel.dataset.combo = '1';
      const wrap = document.createElement('div'); wrap.className = 'combo';
      const input = document.createElement('input'); input.type = 'text'; input.className = sel.className; input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-autocomplete', 'list'); input.autocomplete = 'off';
      const lbl = sel.getAttribute('aria-label') || (sel.id && document.querySelector('label[for="' + sel.id + '"]') ? document.querySelector('label[for="' + sel.id + '"]').textContent.replace('*', '').trim() : 'Choose');
      input.setAttribute('aria-label', lbl); input.placeholder = 'Type to search…';
      const caret = document.createElement('button'); caret.type = 'button'; caret.className = 'caret'; caret.tabIndex = -1; caret.setAttribute('aria-label', 'Open list'); caret.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
      const list = document.createElement('ul'); list.className = 'combo-list'; list.setAttribute('role', 'listbox'); list.hidden = true; list.id = 'combo-' + Math.random().toString(36).slice(2, 8); input.setAttribute('aria-controls', list.id);
      if (sel.style.width) { wrap.style.width = sel.style.width; wrap.style.flex = '0 0 ' + sel.style.width; input.style.width = '100%'; }
      if (sel.style.height) input.style.height = sel.style.height;
      sel.style.display = 'none'; sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(input); wrap.appendChild(caret); wrap.appendChild(list); wrap.appendChild(sel);
      const opts = () => [...sel.options].map((o) => ({ value: o.value, label: o.textContent, blank: o.value === '' }));
      const label = () => { const o = sel.options[sel.selectedIndex]; return o && o.value !== '' ? o.textContent : ''; };
      input.value = label(); if (!input.value && sel.options[0] && sel.options[0].value === '') input.placeholder = sel.options[0].textContent;
      let active = -1; let open = false; let shown = [];
      const esc2 = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      function render(q) {
        q = (q || '').trim().toLowerCase(); const all = opts();
        shown = q ? all.filter((o) => !o.blank && o.label.toLowerCase().includes(q)) : all;
        const n = shown.length;
        list.innerHTML = '<li class="hint" role="presentation">' + (q ? n + ' of ' + (all.length - all.filter((o) => o.blank).length) + ' match' : all.length + ' options · type to filter') + '</li>' + (shown.map((o, i) => { let t = esc2(o.label); if (q) { const k = o.label.toLowerCase().indexOf(q); t = esc2(o.label.slice(0, k)) + '<mark>' + esc2(o.label.slice(k, k + q.length)) + '</mark>' + esc2(o.label.slice(k + q.length)); } return '<li role="option" data-i="' + i + '" aria-selected="' + (o.value === sel.value) + '"' + (o.blank ? ' style="color:var(--muted)"' : '') + '>' + (o.blank ? esc2(o.label) : t) + '</li>'; }).join('') || '<li class="none">No match for "' + esc2(q) + '"</li>');
        active = n ? (q ? 0 : Math.max(0, shown.findIndex((o) => o.value === sel.value))) : -1; mark();
      }
      function mark() { list.querySelectorAll('[data-i]').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === active)); const li = list.querySelector('[data-i="' + active + '"]'); if (li) li.scrollIntoView({ block: 'nearest' }); }
      function show() { if (open) return; open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); render(''); }
      function hide() { open = false; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.value = label(); }
      function choose(i) { const o = shown[i]; if (!o) return; const changed = sel.value !== o.value; sel.value = o.value; hide(); if (changed) sel.dispatchEvent(new Event('change', { bubbles: true })); }
      input.addEventListener('focus', () => { show(); input.select(); });
      input.addEventListener('input', () => { if (!open) { open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); } render(input.value); });
      input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); active = Math.min(shown.length - 1, active + 1); mark(); } else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); } else if (e.key === 'Enter') { if (open) { e.preventDefault(); choose(active); } } else if (e.key === 'Escape') { hide(); } else if (e.key === 'Tab') { hide(); } });
      input.addEventListener('blur', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) hide(); }, 120));
      list.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); choose(Number(li.dataset.i)); } });
      caret.addEventListener('mousedown', (e) => { e.preventDefault(); if (open) hide(); else input.focus(); });
      sel.addEventListener('change', () => { if (!open) input.value = label(); });
    });
  }
  /* modal + toast */
  function modal(html, onMount) {
    const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
    I18N.apply(bg); setTimeout(() => enhanceSelects(bg), 0);
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
    function close() { bg.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey); document.body.appendChild(bg);
    const first = bg.querySelector('input,select,textarea,button'); if (first) first.focus();
    if (onMount) onMount(bg, close); return close;
  }
  function toast(text, kind) { let box = document.querySelector('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); } const t = document.createElement('div'); t.className = 'toast ' + (kind || 'ok'); t.textContent = I18N.translateString(text); box.appendChild(t); setTimeout(() => t.remove(), 4200); }
  function form(el) { const o = {}; el.querySelectorAll('[name]').forEach((i) => { o[i.name] = i.type === 'checkbox' ? i.checked : i.value; }); return o; }
  function tile(label, value, meta, cls, href) { return '<' + (href ? 'a href="' + href + '"' : 'div') + ' class="tile"><div class="l">' + esc(label) + '</div><div class="v">' + value + '</div><div class="m ' + (cls || '') + '">' + meta + '</div></' + (href ? 'a' : 'div') + '>'; }
  return { DATE_FORMATS, TIME_ZONES, BASE_TZ, fmtSample, tzOffset, esc, href, dash, fmtDate, fmtDT, rel, badge, enqBadge, prio, userLabel, aiTag, okTag, initials, logo, opts, I, timeline, modal, toast, form, tile, STATUS, enhanceSelects };
})();
