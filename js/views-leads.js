/* Lead Management: shared helpers (topbar, qs), CSV import and the create form. The list and lead page are in views-leads2.js. */
window.V = window.V || {};
window.topbar = (title, sub, actions, crumb) => '<header class="topbar"><div style="min-width:0">' + (crumb ? '<div class="crumb">' + crumb + '</div>' : '') + '<h1>' + title + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div><div class="grow"></div>' + (actions || '') + '</header>';
window.qs = (o) => Object.keys(o).filter((k) => o[k] !== '' && o[k] !== undefined && o[k] !== null).map((k) => k + '=' + encodeURIComponent(o[k])).join('&');

(function () {
  const { esc, dash, fmtDate, badge, prio, userLabel, opts, I, timeline, modal, toast, form, tile } = UI;
  const db = () => Store.db;

  V.importCsv = function () {
    modal('<h2>Import prospects from CSV</h2><p style="margin:0;font-size:13px;color:var(--body)">Paste rows as <code>company,country,website,city</code>. Each row becomes a Prospect with source "CSV Import"; companies are matched on domain before any new company is created.</p><textarea class="in" name="csv" rows="6">Aurora Dental Clinics,United Arab Emirates,https://auroradental.ae,Abu Dhabi\nNorthwind Logistics,India,https://northwindlogistics.in,Pune\nPolar Freight Solutions,Canada,,Toronto</textarea><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Import</button></div>', (bg, close) => {
      bg.querySelector('[data-go]').addEventListener('click', () => {
        const batch = 'B-' + String(Math.floor(Math.random() * 9000) + 1000); let n = 0, matched = 0;
        bg.querySelector('[name=csv]').value.split('\n').map((r) => r.split(',').map((x) => x.trim())).filter((r) => r[0]).forEach((r) => { const m = Store.matchCompanyWithCountry({ name: r[0], website: r[2], country: r[1] }); if (m.match) matched++; Store.createLead({ type: 'Prospect', companyName: r[0], country: r[1] || 'Unknown', website: r[2] || null, city: r[3] || null, source: 'CSV Import', importBatch: batch, status: 'New' }, { autoAssign: false }); n++; });
        close(); toast(n + ' prospects imported in batch #' + batch + ' · ' + matched + ' attached to existing companies');
      });
    });
  };

  /* ---------------- Lead form ---------------- */
  V.leadForm = function (q) {
    const cfg = db().config; const me = Store.currentUser();
    const preset = q.company ? Store.company(q.company) : null;
    const html = topbar('Create lead or prospect', '', '<span style="font-size:12.5px;color:var(--muted)">Lead ID will be generated on save · <strong style="color:var(--text)">LD-' + db().counters.lead + '</strong></span>', '<a href="#/leads">Leads</a> / New') +
      '<form class="page" id="leadForm" style="flex-direction:row;flex-wrap:wrap;align-items:flex-start"><div class="col-main">' +
      '<section class="card"><div><h2>Lead type <span class="req">*</span></h2><div class="sub" style="font-size:12.5px;color:var(--muted)">Both types live in this module. A prospect can be saved with company name and country alone.</div></div><div class="grid2">' +
      '<label class="radio-card on"><input type="radio" name="type" value="Lead" checked><span><strong>Lead</strong><small>Has expressed interest in DAIT Partners\' services (website form, referral, direct contact).</small></span></label>' +
      '<label class="radio-card"><input type="radio" name="type" value="Prospect"><span><strong>Prospect</strong><small>Identified through research, directories or Google Places. Contact details optional.</small></span></label></div></section>' +
      '<section class="card"><div><h2>Company</h2><div style="font-size:12.5px;color:var(--muted)">Link to an existing company record so leads never duplicate organisations.</div></div><div class="grid2">' +
      '<div class="span2"><label class="lbl" for="companyName">Company name <span class="req">*</span></label><input id="companyName" name="companyName" class="in" value="' + esc(preset ? preset.name : '') + '" required></div>' +
      '<div class="span2" id="dupBox"></div>' +
      '<div><label class="lbl" for="companyId">Company (existing record)</label><select id="companyId" name="companyId" class="in" data-search><option value="">Create new company on save</option>' + db().companies.map((c) => '<option value="' + c.id + '"' + (preset && preset.id === c.id ? ' selected' : '') + '>' + c.id + ' · ' + esc(c.legalName || c.name) + '</option>').join('') + '</select></div>' +
      '<div><label class="lbl" for="contactId">Contact person</label><select id="contactId" name="contactId" class="in" data-search><option value="">— none yet —</option></select></div>' +
      '<div><label class="lbl" for="website">Company website</label><input id="website" name="website" class="in" type="url" value="' + esc(preset ? preset.website || '' : '') + '" placeholder="https://"></div>' +
      '<div><label class="lbl" for="email">Business email</label><input id="email" name="email" class="in" type="email"></div>' +
      '<div><label class="lbl" for="phone">Phone number</label><input id="phone" name="phone" class="in" placeholder="+91 …"></div>' +
      '<div><label class="lbl" for="country">Country <span class="req">*</span></label><select id="country" name="country" class="in">' + opts(cfg.countries, preset ? preset.country : 'India') + '</select></div>' +
      '<div><label class="lbl" for="city">City</label><input id="city" name="city" class="in" value="' + esc(preset ? preset.city || '' : '') + '"></div></div></section>' +
      '<section class="card"><div><h2>Source</h2><div style="font-size:12.5px;color:var(--muted)">Values come from the shared dropdown configuration, not hard-coded in the form.</div></div><div class="grid2">' +
      '<div><label class="lbl" for="source">Lead source <span class="req">*</span></label><select id="source" name="source" class="in">' + opts(cfg.leadSources, 'Manual Entry') + '</select></div>' +
      '<div><label class="lbl" for="sourceUrl">Source URL</label><input id="sourceUrl" name="sourceUrl" class="in" type="url" placeholder="https://"></div>' +
      '<div class="span2" style="font-size:12.5px;color:var(--muted)"><span class="badge b-grey">Import batch: —</span> Set automatically for CSV and Google Places imports.</div></div></section>' +
      '<section class="card"><div><h2>Assignment &amp; follow-up</h2><div style="font-size:12.5px;color:var(--muted)">Assigning creates a task for the owner and sends them a notification. A follow-up date creates a dated task automatically.</div></div><div class="grid2">' +
      '<div><label class="lbl" for="assignedTo">Assigned to</label><select id="assignedTo" name="assignedTo" class="in"><option value="">Leave unassigned · allocation rules decide</option>' + opts(db().users.map((u) => ({ value: u.id, label: u.name + (u.id === me.id ? ' (me)' : '') })), me.id) + '</select></div>' +
      '<div><label class="lbl" for="priority">Lead priority</label><select id="priority" name="priority" class="in">' + opts(cfg.priorities, 'Medium') + '</select></div>' +
      '<div><label class="lbl" for="status">Lead status</label><select id="status" name="status" class="in">' + opts(cfg.leadStatuses, 'New') + '</select></div>' +
      '<div><label class="lbl" for="followUp">Next follow-up date</label><input id="followUp" name="followUp" class="in" type="date" value="' + Store.addDays(Store.today(), 2) + '"></div>' +
      '<div class="span2"><label class="lbl" for="notes">Lead notes</label><textarea id="notes" name="notes" class="in" rows="4"></textarea></div></div></section>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><a href="#/leads" class="btn">Cancel</a><div class="grow"></div><button type="submit" class="btn primary">Create lead</button></div>' +
      '</div><aside class="col-side"><section class="card"><h2>What happens on save</h2><ol style="margin:0;padding-left:18px;font-size:13px;color:var(--body);display:flex;flex-direction:column;gap:8px"><li>Duplicate check runs on domain, legal name and normalised name + country. Uncertain matches are shown for you to decide.</li><li>Lead is linked to the chosen company. No new company record is created when one exists.</li><li>Owner gets an in-app notification and the lead appears in their task list.</li><li>A follow-up task is created for the follow-up date.</li><li>AI enrichment job is queued with status <strong>Pending</strong>. It never overwrites verified fields.</li></ol></section><section class="card" id="coPreview"></section></aside></form>';
    return { html, mount(el) {
      const f = el.querySelector('#leadForm'); const dup = el.querySelector('#dupBox'); const coSel = el.querySelector('#companyId'); const ctSel = el.querySelector('#contactId'); const prev = el.querySelector('#coPreview');
      el.querySelectorAll('.radio-card input').forEach((r) => r.addEventListener('change', () => { el.querySelectorAll('.radio-card').forEach((c) => c.classList.toggle('on', c.querySelector('input').checked)); }));
      function refreshContacts() { const cid = coSel.value; const cts = db().contacts.filter((c) => c.companyId === cid); ctSel.innerHTML = '<option value="">— none yet —</option>' + cts.map((c) => '<option value="' + c.id + '">' + esc(c.firstName + ' ' + c.lastName) + ' · ' + esc(c.designation || c.type) + '</option>').join(''); if (cts.length) { ctSel.value = cts.find((c) => c.primary) ? cts.find((c) => c.primary).id : cts[0].id; const ct = Store.contact(ctSel.value); if (ct && !el.querySelector('#email').value) el.querySelector('#email').value = ct.email || ''; } ctSel.dispatchEvent(new Event('change')); preview(); }
      function preview() { const c = Store.company(coSel.value); if (!c) { prev.innerHTML = '<h2>Linked company preview</h2><div style="font-size:13px;color:var(--muted)">A new company record will be created on save, unless a duplicate is found above.</div>'; return; } const leads = db().leads.filter((l) => l.companyId === c.id); prev.innerHTML = '<h2>Linked company preview</h2><div style="display:flex;gap:12px;align-items:center">' + UI.logo(c.name) + '<div><a href="#/companies/' + c.id + '" style="font-weight:600;color:var(--text)">' + esc(c.legalName || c.name) + '</a><div style="font-size:12px;color:var(--muted)">' + esc(c.industry || 'Industry unknown') + ' · ' + esc([c.city, c.country].filter(Boolean).join(', ')) + (c.employeeRange ? ' · ' + c.employeeRange + ' employees' : '') + '</div></div></div><dl class="kv" style="grid-template-columns:110px 1fr"><dt>Contacts</dt><dd>' + db().contacts.filter((x) => x.companyId === c.id).length + '</dd><dt>Open leads</dt><dd>' + leads.filter((l) => !['Won', 'Lost', 'Not Relevant'].includes(l.status)).length + (leads.length ? ' · ' + leads.map((l) => l.id + ' (' + l.status + ')').join(', ') : '') + '</dd><dt>Verification</dt><dd>' + badge(c.ai.verification) + '</dd></dl>'; }
      function check() {
        const name = el.querySelector('#companyName').value; const web = el.querySelector('#website').value; const em = el.querySelector('#email').value; const country = el.querySelector('#country').value;
        if (!name && !web && !em) { dup.innerHTML = ''; return; }
        const m = Store.matchCompanyWithCountry({ name, website: web, email: em, country });
        if (m.match && coSel.value === m.match.id) { dup.innerHTML = '<div class="note ok">Linked to existing company ' + m.match.id + ' · ' + esc(m.match.legalName || m.match.name) + ' (matched on ' + m.how + ').</div>'; return; }
        if (m.match || m.candidates.length) { const c = m.match || m.candidates[0]; dup.innerHTML = '<div class="note warn" style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap"><div class="grow" style="min-width:200px"><div style="font-weight:600;color:var(--warn-fg)">Possible duplicate: ' + m.candidates.length + ' existing compan' + (m.candidates.length > 1 ? 'ies match' : 'y matches') + '</div><div>' + m.candidates.map((x) => esc(x.legalName || x.name) + ' · ' + esc(x.domain || 'no website') + ' · ' + esc(x.country || '—') + ' · ' + db().contacts.filter((k) => k.companyId === x.id).length + ' contacts · ' + db().leads.filter((k) => k.companyId === x.id && !['Won', 'Lost', 'Not Relevant'].includes(k.status)).length + ' open leads').join('<br>') + '<br>Matched on ' + esc(m.how) + ' · confidence ' + esc(m.confidence) + '.' + (m.match ? '' : ' Not auto-merged: please confirm.') + '</div></div><a class="btn sm" href="#/companies/' + c.id + '" target="_blank">View</a><button type="button" class="btn sm primary" data-use="' + c.id + '">Use existing company</button></div>'; dup.querySelector('[data-use]').addEventListener('click', (e) => { coSel.value = e.target.dataset.use; refreshContacts(); check(); }); }
        else dup.innerHTML = '<div class="note ok">No duplicate found for this name, website or email domain. A new company record will be created.</div>';
      }
      ['companyName', 'website', 'email', 'country'].forEach((id) => el.querySelector('#' + id).addEventListener('input', check));
      coSel.addEventListener('change', () => { refreshContacts(); check(); });
      if (preset) refreshContacts(); else preview();
      f.addEventListener('submit', (e) => { e.preventDefault(); const d = form(f); if (!d.companyName || !d.country) { toast('Company name and country are required', 'warn'); return; } try { const l = Store.createLead({ type: d.type, companyName: d.companyName, contactId: d.contactId || null, website: d.website || null, email: d.email || null, phone: d.phone || null, country: d.country, city: d.city || null, source: d.source, sourceUrl: d.sourceUrl || null, assignedTo: d.assignedTo || null, priority: d.priority, status: d.status, followUp: d.followUp || null, notes: d.notes || null }, { linkCompanyId: d.companyId || null }); toast(l.id + ' created' + (l.assignedTo ? ' and assigned to ' + Store.userName(l.assignedTo) : '')); location.hash = '#/leads/' + l.id; } catch (err) { toast(err.message, 'warn'); } });
    } };
  };

})();
