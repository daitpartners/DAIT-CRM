/* App shell: sidebar, hash router, re-render on store changes. */
window.App = (function () {
  const { esc, I } = UI;
  let silent = 0;
  function parse() {
    const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [pathPart, query] = h.split('?'); const parts = pathPart.split('/').filter(Boolean); const q = {};
    (query || '').split('&').filter(Boolean).forEach((kv) => { const [k, v] = kv.split('='); q[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return { parts, q };
  }
  function sidebar(active) {
    const me = Store.currentUser(); const n = Store.counts;
    const item = (key, href, label, icon, cnt, hot) => '<a class="nav' + (active === key ? ' on' : '') + '" href="' + href + '">' + icon + label + (cnt ? '<span class="cnt' + (hot ? ' hot' : '') + '">' + cnt + '</span>' : '') + '</a>';
    document.getElementById('sidebar').innerHTML = '<div class="brand"><img src="assets/logo-mark.svg" alt=""><div><b>DAIT Partners</b><small>Sales CRM · prototype</small></div></div>' +
      item('dashboard', '#/dashboard', 'Dashboard', I.dash) + '<div class="navsec">Modules</div>' +
      item('leads', '#/leads', 'Leads', I.leads, n.leads()) + item('companies', '#/companies', 'Companies', I.companies) + 
      item('email', '#/email', 'Email', I.mail, n.unread()) + item('mailer', '#/mailer', 'Mailer', I.send, (Store.db.campaigns || []).filter((c) => ['Sending', 'Scheduled'].includes(c.status)).length ? (Store.db.campaigns || []).filter((c) => ['Sending', 'Scheduled'].includes(c.status)).length + ' live' : '', true) + item('calendar', '#/calendar', 'Calendar', I.cal) + item('quotes', '#/quotes', 'Quotations', I.quote) + item('projects', '#/projects', 'Projects', I.tasks, Store.db.projects.length) +
      '<div class="navsec">Work</div>' + item('tasks', '#/tasks', 'Tasks', I.tasks, n.overdue(me.id) ? n.overdue(me.id) + ' overdue' : '') + item('notifications', '#/notifications', 'Notifications', I.bell, n.notifications(me.id) ? n.notifications(me.id) + ' new' : '', true) + item('reports', '#/reports', 'Reports', I.reports) + '<div class="grow"></div>' + item('settings', '#/settings', 'Settings', I.settings) +
      '<div class="me"><span class="av">' + esc(me.initials) + '</span><div style="min-width:0;flex-grow:1"><div style="font-size:13px;font-weight:600">' + esc(me.name) + '</div><small>' + esc(me.role) + '</small><label class="sr" for="userSwitch">Switch user</label><select id="userSwitch">' + Store.db.users.map((u) => '<option value="' + u.id + '"' + (u.id === me.id ? ' selected' : '') + '>Act as ' + esc(u.name) + '</option>').join('') + '</select></div></div>';
    I18N.apply(document.getElementById('sidebar'));
    document.getElementById('userSwitch').addEventListener('change', (e) => { Store.setUser(e.target.value); UI.toast('Now acting as ' + Store.userName(e.target.value)); });
  }
  function settings() {
    const e = Store.db.config;
    return { html: topbar('Settings', 'Configuration the CRM reads at runtime; nothing here is hard-coded in forms') + '<div class="page">' + V.preferencesCard() + V.connectionsCard() + V.templatesCard() + '<div class="cols"><section class="card col-main"><h2>Dropdown configuration</h2><div class="grid2">' + [['Lead sources', e.leadSources], ['Lead statuses (admins can add more)', e.leadStatuses], ['Industries', e.industries], ['Employee ranges', e.employeeRanges], ['Contact types', e.contactTypes], ['Quotation statuses', e.quoteStatuses]].map(([l, v]) => '<div><label class="lbl">' + l + '</label><div>' + v.map((x) => '<span class="pill">' + esc(x) + '</span>').join('') + '</div></div>').join('') + '</div><h2>Lead allocation rules</h2><div class="tbl"><table><thead><tr><th>Rule</th><th>Country</th><th>Assign to</th></tr></thead><tbody>' + e.allocationRules.map((r) => '<tr><td>' + esc(r.name) + '</td><td>' + esc(Array.isArray(r.country) ? r.country.join(', ') : r.country) + '</td><td>' + esc(Array.isArray(r.assignTo) ? r.assignTo.map(Store.userName).join(' → ') + ' (round-robin)' : Store.userName(r.assignTo)) + '</td></tr>').join('') + '</tbody></table></div><h2>Roles</h2><div class="tbl"><table><thead><tr><th>Role</th><th>Access</th></tr></thead><tbody><tr><td>Administrator</td><td class="wrap">Full access, configuration, duplicate merges, enrichment engine</td></tr><tr><td>Manager</td><td class="wrap">View and manage team leads, companies, quotations; transfer leads</td></tr><tr><td>Sales Representative</td><td class="wrap">Assigned leads and their companies, own email, calendar and quotations</td></tr><tr><td>Data Research User</td><td class="wrap">Create and update prospects, companies and research records</td></tr></tbody></table></div></section><aside class="col-side"><section class="card"><h2>Prototype data</h2><div style="font-size:13px;color:var(--body)">Everything you change is saved in this browser only. Reset to reload the sample data.</div><button class="btn danger" id="resetData">Reset sample data</button></section><section class="card"><h2>Hosting</h2><dl class="kv" style="grid-template-columns:110px 1fr"><dt>Domain</dt><dd>crm.daitpartners.com</dd><dt>Backend</dt><dd>Node.js</dd><dt>OS</dt><dd>AlmaLinux 9</dd><dt>Panel</dt><dd>CyberPanel</dd><dt>Web server</dt><dd>OpenLiteSpeed (reverse proxy to Node)</dd><dt>Enrichment</dt><dd>Separate Node worker · Ollama or Claude API</dd><dt>Mail &amp; calendar</dt><dd>Microsoft Graph (OAuth 2.0), tokens encrypted server-side</dd></dl></section></aside></div></div>', mount(el) { V.mountPreferences(el); V.mountConnections(el); V.mountTemplates(el); el.querySelector('#resetData').addEventListener('click', () => { if (confirm('Reset all prototype data to the sample set?')) { Store.reset(); UI.toast('Sample data restored'); } }); } };
  }
  function reports() {
    const leads = Store.db.leads.filter((l) => !l.archived); const bySrc = {}; leads.forEach((l) => { bySrc[l.source] = (bySrc[l.source] || 0) + 1; }); const max = Math.max(1, ...Object.values(bySrc));
    return { html: topbar('Reports', 'Existing dashboard and reporting stay as they are; these are the additions for the new modules') + '<div class="page cols"><section class="card col-main"><h2>Leads by source</h2><div style="display:flex;flex-direction:column;gap:9px;font-size:12.5px">' + Object.keys(bySrc).sort((a, b) => bySrc[b] - bySrc[a]).map((s) => '<div><div style="display:flex;justify-content:space-between"><span>' + esc(s) + '</span><strong>' + bySrc[s] + '</strong></div><div class="bar"><div style="width:' + Math.round(bySrc[s] / max * 100) + '%"></div></div></div>').join('') + '</div></section><section class="card col-main"><h2>Enquiry conversion</h2><dl class="kv" style="grid-template-columns:200px 1fr"><dt>Enquiries received</dt><dd>' + Store.db.enquiries.length + '</dd><dt>Spam blocked</dt><dd>' + Store.db.enquiries.filter((e) => e.status === 'Spam').length + '</dd><dt>Leads created</dt><dd>' + Store.db.enquiries.filter((e) => e.leadId).length + '</dd><dt>Awaiting manual review</dt><dd>' + Store.db.enquiries.filter((e) => e.status === 'Needs review').length + '</dd><dt>Matched existing companies</dt><dd>' + Store.db.enquiries.filter((e) => e.trace.some((t) => /match on/.test(t))).length + '</dd></dl></section></div>' };
  }
  function render() {
    if (silent) return;
    document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
    const { parts, q } = parse(); const p = parts[0] || 'dashboard'; let v; let active = p;
    try {
      if (p === 'dashboard') v = V.dashboard();
      else if (p === 'leads' || p === 'leads2') { active = 'leads'; v = parts[1] === 'new' ? V.leadForm(q) : parts[1] ? V.leads2Detail(parts[1], parts[2]) : V.leads2List(q); } // #/leads2 kept as an alias for old links
      else if (p === 'mailer') v = V.mailer(parts[1]);
      else if (p === 'notifications') v = V.notifications(q);
      else if (p === 'companies') v = parts[1] ? V.companyProfile(parts[1], parts[2]) : V.companiesList(q);
      else if (p === 'enquiries') v = V.enquiries(parts[1], q);
      else if (p === 'email') v = V.email(parts[1], q);
      else if (p === 'calendar') v = V.calendar(q);
      else if (p === 'quotes') v = parts[1] ? V.quoteEditor(parts[1], q) : V.quotes(q);
      else if (p === 'projects') v = V.projects(q);
      else if (p === 'tasks') v = V.tasks(q);
      else if (p === 'settings') v = settings();
      else if (p === 'reports') v = reports();
      else { v = { html: topbar('Not found') + '<div class="page"><div class="empty"><a href="#/dashboard">Go to dashboard</a></div></div>' }; }
    } catch (err) { console.error(err); v = { html: topbar('Something went wrong') + '<div class="page"><div class="note warn">' + esc(err.message) + '</div></div>' }; }
    sidebar(active);
    const el = document.getElementById('view'); el.innerHTML = v.html; I18N.apply(el); if (v.mount) v.mount(el); UI.enhanceSelects(el);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  Store.onChange(() => { if (!silent) render(); });
  document.addEventListener('DOMContentLoaded', render);
  /* Mailer worker (prototype): once a second, send whatever is due. It never re-draws the screen under the user,
     except on the Mailer pages (with no dialog open), where progress should be seen live; scroll position is kept. */
  setInterval(() => { let changed = false; silent++; try { changed = Store.campaignTick(); } catch (e) { console.error(e); } finally { silent--; }
    if (changed && parse().parts[0] === 'mailer' && !document.querySelector('.modal-bg')) { const y = window.scrollY; render(); window.scrollTo(0, y); } }, 1000);
  return { render, silent(fn) { silent++; try { fn(); } finally { silent--; } } };
})();
