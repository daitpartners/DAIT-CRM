/* Mailer: send a personalised template to the leads ticked on the Leads page.
   Wizard (template → Cc/Bcc → timing → review) and the Mailer page (campaigns, progress, per-recipient audit).
   All rules (who may be emailed, queueing, spacing, skipping, pause/cancel) live in Store; see "mailer" in js/store.js. */
(function () {
  const { esc, fmtDT, badge, opts, I, modal, toast } = UI;
  const db = () => Store.db;
  const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;
  const ST = { Queued: 'b-grey', Sent: 'b-purple', Failed: 'b-bad', Skipped: 'b-grey', Replied: 'b-ok', Sending: 'b-warn', Scheduled: 'b-purple2', Paused: 'b-grey', Completed: 'b-ok', Cancelled: 'b-bad' };
  const sb = (s) => badge(s, ST[s]);
  const list = (v) => (v || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const lawful = ['Legitimate interest (B2B outreach relevant to their role)', 'Consent (they asked to be contacted)', 'Existing client or business relationship'];
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  /* Why the current user cannot use the mailer, or null. */
  V.mailerGate = function () { const me = Store.currentUser(); return Store.accountFor(me.id) ? null : 'Connect your Microsoft 365 mailbox in Settings to use the mailer.'; };

  /* ---------- wizard ---------- */
  V.mailerWizard = function (leadIds, onDone) {
    const me = Store.currentUser(); const acct = Store.accountFor(me.id);
    if (!acct) { toast(V.mailerGate(), 'warn'); return; }
    const rows = Store.mailerCheck(leadIds); const okRows = rows.filter((r) => !r.block);
    if (!okRows.length) { toast('None of the selected leads can be emailed (' + rows[0].block.toLowerCase() + (rows.length > 1 ? ', …' : '') + ').', 'warn'); return; }
    const tpls = Store.templatesFor(me.lang || 'en');
    const nowS = Store.now(); const defStart = nowS.slice(0, 11) + String(Math.min(23, Number(nowS.slice(11, 13)) + 1)).padStart(2, '0') + ':00';
    const st = { step: 0, name: 'Mailer · ' + UI.fmtDate(Store.today()) + ' · ' + plural(okRows.length, 'lead'), templateId: (tpls[0] || {}).id || '', cc: '', bcc: '', when: 'now', startAt: defStart, intervalMin: 3, workingHoursOnly: false, unsubscribeLine: true, lawfulBasis: '' };
    const STEPS = ['Template', 'Cc / Bcc', 'Timing', 'Review & send'];
    const tpl = () => tpls.find((x) => x.id === st.templateId) || null;
    const sampleCtx = () => { const r = okRows[0]; return { first_name: (r.name || '').split(' ')[0] || 'there', company: r.company, me: me.name, lead_id: r.leadId }; };
    const staff = db().users.filter((u) => u.email && u.id !== me.id);

    modal('<div data-wiz></div>', (bg, close) => {
      bg.querySelector('.modal').style.width = '760px';
      const box = bg.querySelector('[data-wiz]');
      const head = () => '<h2>Send via mailer</h2><ol class="wsteps">' + STEPS.map((s, i) => '<li class="' + (i === st.step ? 'on' : i < st.step ? 'done' : '') + '"><span>' + (i + 1) + '</span>' + s + '</li>').join('') + '</ol>';
      const foot = (nextLabel) => '<div class="actions"><button class="btn" data-close>Cancel</button><span class="grow"></span>' + (st.step ? '<button class="btn" data-back>Back</button>' : '') + '<button class="btn primary" data-next>' + nextLabel + '</button></div>';
      const save = () => { box.querySelectorAll('[data-f]').forEach((i) => { st[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.type === 'radio' ? (i.checked ? i.value : st[i.dataset.f]) : i.value; }); };
      const draw = () => {
        let body = '';
        if (st.step === 0) { const t = tpl(); const cx = sampleCtx();
          body = '<div class="grid2"><div><label class="lbl" for="mwName">Campaign name</label><input id="mwName" class="in" data-f="name" value="' + esc(st.name) + '"></div><div><label class="lbl" for="mwTpl">Template</label><select id="mwTpl" class="in" data-f="templateId">' + tpls.map((x) => '<option value="' + x.id + '"' + (x.id === st.templateId ? ' selected' : '') + '>' + esc(x.name) + (x.source === 'oft' ? ' · .oft' : '') + ' (' + esc(x.lang.toUpperCase()) + ')</option>').join('') + '</select></div></div>' +
            (t ? '<div class="mprev"><div class="lbl">Preview for ' + esc(okRows[0].name || okRows[0].company) + ' · ' + esc(okRows[0].to) + '</div><div class="msub">' + esc(Store.fillTemplate(t.subject, cx)) + '</div><pre>' + esc(Store.fillTemplate(t.body, cx)) + '</pre></div>' : '<div class="note warn">No templates yet. Add one under Settings → Email templates.</div>') +
            '<div class="dim" style="font-size:12.5px">Each email is filled in per lead: <code>{first_name}</code>, <code>{company}</code>, <code>{me}</code>, <code>{lead_id}</code>. From: ' + esc(acct.address) + '.</div>'; }
        if (st.step === 1) { const quick = (f) => '<div class="mquick">' + staff.map((u) => '<button type="button" class="btn xs" data-add="' + f + '" data-email="' + esc(u.email) + '">+ ' + esc(u.name) + '</button>').join('') + '</div>';
          body = '<div><label class="lbl" for="mwCc">Cc <span class="dim">· on every email, visible to the recipient</span></label><input id="mwCc" class="in" data-f="cc" value="' + esc(st.cc) + '" placeholder="name@company.com, another@company.com">' + quick('cc') + '</div><div><label class="lbl" for="mwBcc">Bcc <span class="dim">· on every email, hidden from the recipient</span></label><input id="mwBcc" class="in" data-f="bcc" value="' + esc(st.bcc) + '" placeholder="name@company.com">' + quick('bcc') + '</div><div class="dim" style="font-size:12.5px">Both are optional. Separate addresses with commas. Cc and Bcc receive one copy per lead, so ' + plural(okRows.length, 'email') + ' each.</div>'; }
        if (st.step === 2) { const n = okRows.length; const mins = (n - 1) * Number(st.intervalMin);
          body = '<div class="grid2"><div><div class="lbl">When to start</div><label class="mradio"><input type="radio" name="mwWhen" data-f="when" value="now"' + (st.when === 'now' ? ' checked' : '') + '> Send now</label><label class="mradio"><input type="radio" name="mwWhen" data-f="when" value="later"' + (st.when === 'later' ? ' checked' : '') + '> Start at <input class="in" type="datetime-local" data-f="startAt" value="' + esc(st.startAt) + '" aria-label="Start date and time" style="width:210px;height:32px;margin-left:6px"></label></div>' +
            '<div><label class="lbl" for="mwInt">Delay between emails</label><select id="mwInt" class="in" data-f="intervalMin">' + [1, 2, 3, 5, 10, 15].map((m) => '<option value="' + m + '"' + (Number(st.intervalMin) === m ? ' selected' : '') + '>One every ' + plural(m, 'minute') + '</option>').join('') + '</select><label class="sw" style="margin-top:10px;font-size:12.5px"><input type="checkbox" data-f="workingHoursOnly"' + (st.workingHoursOnly ? ' checked' : '') + '> Only send in working hours (' + Store.WORK_HOURS[0] + '–' + Store.WORK_HOURS[1] + ', office time)</label></div></div>' +
            '<div class="note info">' + plural(n, 'email') + ', one every ' + plural(Number(st.intervalMin), 'minute') + ': the last one goes out about ' + (mins < 60 ? plural(mins, 'minute') : (Math.round(mins / 6) / 10) + ' hours') + ' after the start. That is far inside Microsoft 365\'s limits (about 30 a minute, 10,000 recipients a day).' + (n > 200 ? ' <strong>More than 200 in one run</strong> starts to look like bulk mail from a personal mailbox; consider splitting it across days.' : '') + '</div>' +
            '<div class="dim" style="font-size:12.5px">Prototype speed: a minute of delay runs as one second here, so you can watch a run finish. The real build waits the full time.</div>'; }
        if (st.step === 3) { const t = tpl(); const skip = rows.filter((r) => r.block);
          body = '<dl class="kv" style="grid-template-columns:120px 1fr"><dt>Template</dt><dd>' + esc(t ? t.name : '—') + '</dd><dt>From</dt><dd>' + esc(me.name) + ' · ' + esc(acct.address) + '</dd><dt>Cc</dt><dd>' + (st.cc ? esc(list(st.cc).join(', ')) : '<span class="dim">—</span>') + '</dd><dt>Bcc</dt><dd>' + (st.bcc ? esc(list(st.bcc).join(', ')) : '<span class="dim">—</span>') + '</dd><dt>Timing</dt><dd>' + (st.when === 'now' ? 'Starts now' : 'Starts ' + esc(fmtDT(st.startAt + ':00'))) + ' · one every ' + plural(Number(st.intervalMin), 'minute') + (st.workingHoursOnly ? ' · working hours only' : '') + '</dd></dl>' +
            '<div class="tbl mrec"><table><thead><tr><th>Lead</th><th>Name</th><th>To</th><th>Result</th></tr></thead><tbody>' + rows.map((r) => '<tr><td>' + esc(r.leadId) + '</td><td>' + esc(r.name || r.company) + '</td><td>' + (r.to ? esc(r.to) : '<span class="dim">—</span>') + '</td><td>' + (r.block ? badge('Skipped', 'b-grey') + ' <span class="dim">' + esc(r.block) + '</span>' : badge('Will send', 'b-ok')) + '</td></tr>').join('') + '</tbody></table></div>' +
            '<div class="grid2"><div><label class="lbl" for="mwLaw">Lawful basis for contacting these leads <span class="req">*</span></label><select id="mwLaw" class="in" data-f="lawfulBasis"><option value="">— choose —</option>' + lawful.map((x) => '<option' + (st.lawfulBasis === x ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></div><div><div class="lbl">Opt-out</div><label class="sw" style="font-size:12.5px;margin-top:8px"><input type="checkbox" data-f="unsubscribeLine"' + (st.unsubscribeLine ? ' checked' : '') + '> Add an unsubscribe line to every email</label></div></div>' +
            '<div class="note ' + (skip.length ? 'warn' : 'ok') + '"><strong>' + plural(okRows.length, 'email') + ' will be queued.</strong>' + (skip.length ? ' ' + plural(skip.length, 'lead') + ' skipped (see the table).' : '') + ' Leads that reply, unsubscribe or close before their turn are skipped automatically.</div>'; }
        box.innerHTML = head() + body + foot(st.step === 3 ? I.send + 'Queue ' + plural(okRows.length, 'email') : 'Next');
        I18N.apply(box); UI.enhanceSelects(box);
        const first = box.querySelector('[data-f]'); if (first && st.step < 3) first.focus();
        box.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => { save(); const f = b.dataset.add; const cur = list(st[f]); if (!cur.some((x) => x.toLowerCase() === b.dataset.email.toLowerCase())) cur.push(b.dataset.email); st[f] = cur.join(', '); draw(); }));
        if (st.step === 0) box.querySelector('#mwTpl').addEventListener('change', () => { save(); draw(); });
        if (st.step === 2) box.querySelectorAll('#mwInt,[data-f=when],[data-f=startAt]').forEach((i) => i.addEventListener('change', () => { save(); if (i.dataset.f === 'startAt') st.when = 'later'; draw(); }));
        const back = box.querySelector('[data-back]'); if (back) back.addEventListener('click', () => { save(); st.step--; draw(); });
        box.querySelector('[data-next]').addEventListener('click', () => { save();
          if (st.step === 0 && !tpl()) { toast('Choose a template', 'warn'); return; }
          if (st.step === 1) { const bad = list(st.cc).concat(list(st.bcc)).find((a) => !EMAIL_RE.test(a)); if (bad) { toast('"' + bad + '" is not a full email address', 'warn'); return; } }
          if (st.step === 2 && st.when === 'later' && !st.startAt) { toast('Choose a start date and time', 'warn'); return; }
          if (st.step < 3) { st.step++; draw(); return; }
          if (!st.lawfulBasis) { toast('Choose the lawful basis before sending', 'warn'); return; }
          try { const c = Store.createCampaign({ name: st.name, templateId: st.templateId, leadIds, cc: st.cc, bcc: st.bcc, startAt: st.when === 'later' ? st.startAt + ':00' : null, intervalMin: st.intervalMin, workingHoursOnly: st.workingHoursOnly, unsubscribeLine: st.unsubscribeLine, lawfulBasis: st.lawfulBasis });
            close(); toast(c.status === 'Scheduled' ? c.id + ' scheduled' : c.id + ' is sending'); if (onDone) onDone(c); location.hash = '#/mailer/' + c.id; }
          catch (err) { toast(err.message, 'warn'); }
        });
      };
      draw();
    });
  };

  /* ---------- Mailer page ---------- */
  const bar = (n) => { const done = n.Sent + n.Failed; const pct = n.toSend ? Math.round(done / n.toSend * 100) : 100; return '<span class="mbar" title="' + done + ' of ' + n.toSend + '"><i style="width:' + pct + '%"></i></span> <span class="dim">' + done + ' / ' + n.toSend + '</span>'; };
  const when = (c) => (c.status === 'Scheduled' ? 'Starts ' + fmtDT(c.startAt) : c.completedAt ? 'Ended ' + fmtDT(c.completedAt) : 'Started ' + fmtDT(c.createdAt));
  V.mailer = function (id) {
    const all = db().campaigns || []; const gate = V.mailerGate();
    if (id) return detail(id);
    const html = topbar('Mailer', 'Personalised emails to selected leads, sent one by one from your own mailbox', '<a class="btn primary" href="#/leads">' + I.plus + 'New from Leads</a>') +
      '<div class="page">' + (gate ? '<div class="note warn">' + esc(gate) + ' <a href="#/settings">Open Settings</a></div>' : '') +
      '<div class="card flush"><div class="head"><h2>Campaigns</h2><span class="dim" style="font-size:12.5px">Tick leads on the Leads page, then choose Send via mailer.</span></div><div class="tbl"><table><thead><tr><th>Campaign</th><th>Template</th><th>Sender</th><th>Progress</th><th>Replied</th><th>Status</th><th>When</th></tr></thead><tbody>' +
      (all.map((c) => { const n = Store.campaignStats(c); return '<tr data-go="#/mailer/' + c.id + '" style="cursor:pointer"><td><a href="#/mailer/' + c.id + '" style="font-weight:600">' + c.id + '</a> · ' + esc(c.name) + '</td><td>' + esc(c.templateName) + '</td><td>' + esc(Store.userName(c.senderId)) + '</td><td>' + bar(n) + '</td><td>' + n.replied + '</td><td>' + sb(c.status) + (c.waitingForHours && c.status === 'Sending' ? ' <span class="dim">waiting for working hours</span>' : '') + '</td><td class="dim">' + esc(when(c)) + '</td></tr>'; }).join('') || '<tr><td colspan="7"><div class="empty">No campaigns yet. Go to <a href="#/leads">Leads</a>, tick the people to email and choose Send via mailer.</div></td></tr>') +
      '</tbody></table></div></div>' +
      '<div class="note info">Sending limits to keep in mind: a personal Microsoft 365 mailbox suits a few dozen to a few hundred personalised emails a day. Thousands a day is marketing mail and belongs on a dedicated sending service, so the daitpartners.com domain keeps its reputation.</div></div>';
    return { html, mount(el) { const tb = el.querySelector('tbody'); tb.addEventListener('click', (e) => { if (e.target.closest('a')) return; const tr = e.target.closest('tr[data-go]'); if (tr) location.hash = tr.dataset.go; }); } };
  };
  function detail(id) {
    const c = Store.campaign(id); if (!c) return { html: topbar('Campaign not found') + '<div class="page"><div class="empty">No campaign ' + esc(id) + '. <a href="#/mailer">Back to Mailer</a></div></div>' };
    const n = Store.campaignStats(c); const live = ['Sending', 'Scheduled', 'Paused'].includes(c.status);
    const rStatus = (r) => (r.status === 'Sent' && db().emails.some((e) => e.folder === 'inbox' && e.leadId === r.leadId && e.at > r.sentAt) ? 'Replied' : r.status);
    const next = c.recipients.find((r) => r.status === 'Queued');
    const html = topbar(c.id + ' · ' + esc(c.name), sb(c.status) + ' <span class="l2line">' + esc(when(c)) + (c.status === 'Sending' && c.waitingForHours ? '<i>|</i>Waiting for working hours (' + Store.WORK_HOURS[0] + '–' + Store.WORK_HOURS[1] + ')' : c.status === 'Sending' && next ? '<i>|</i>Next: ' + esc(next.name || next.company) : '') + (c.pauseReason && c.status === 'Paused' ? '<i>|</i>' + esc(c.pauseReason) : '') + '</span>',
      '<div class="hdr-actions">' + (c.status === 'Scheduled' ? '<button class="btn" data-m="start">Start now</button>' : '') + (['Sending', 'Scheduled'].includes(c.status) ? '<button class="btn" data-m="pause">Pause</button>' : '') + (c.status === 'Paused' ? '<button class="btn primary" data-m="resume">Resume</button>' : '') + (live ? '<button class="btn danger" data-m="cancel">Cancel remaining</button>' : '') + '</div>', '<a href="#/mailer">Mailer</a> / ' + c.id) +
      '<div class="page"><div class="tiles">' + UI.tile('Sent', n.Sent, bar(n), '') + UI.tile('Queued', n.Queued, live ? 'one every ' + plural(c.intervalMin, 'minute') : 'nothing waiting', '') + UI.tile('Skipped / failed', n.Skipped + ' / ' + n.Failed, 'reason shown under the status', n.Failed ? 'bad' : '') + UI.tile('Replied', n.replied, 'matched from the mailbox', n.replied ? 'ok' : '') + '</div>' +
      '<div class="cols"><div class="col-main"><section class="card flush"><div class="head"><h2>Recipients</h2><span class="dim" style="font-size:12.5px">' + plural(n.total, 'lead') + ' · audit record per recipient</span></div><div class="tbl"><table><thead><tr><th>Lead</th><th>Name</th><th>To</th><th>Status</th><th>Sent at</th><th>Message</th></tr></thead><tbody>' +
      c.recipients.map((r) => '<tr><td><a href="#/leads/' + r.leadId + '/email" style="font-weight:600">' + esc(r.leadId) + '</a></td><td>' + esc(r.name || r.company) + '</td><td>' + (r.to ? esc(r.to) : '<span class="dim">—</span>') + '</td><td style="white-space:normal">' + sb(rStatus(r)) + (r.error ? '<div class="dim" style="font-size:12px;margin-top:3px">' + esc(r.error) + '</div>' : '') + '</td><td>' + (r.sentAt ? esc(fmtDT(r.sentAt)) : '<span class="dim">—</span>') + '</td><td class="dim">' + (r.messageId ? esc(r.messageId) : '—') + '</td></tr>').join('') + '</tbody></table></div></section></div>' +
      '<aside class="col-side"><section class="card" style="gap:10px"><h2>Details</h2><dl class="kv" style="grid-template-columns:110px 1fr"><dt>Template</dt><dd>' + esc(c.templateName) + (c.templateVersion ? ' <span class="dim">· version of ' + esc(UI.fmtDate(c.templateVersion)) + '</span>' : '') + '</dd><dt>From</dt><dd>' + esc(Store.userName(c.senderId)) + '<div class="dim" style="font-weight:400">' + esc(c.senderAddress) + '</div></dd><dt>Cc</dt><dd>' + (c.cc ? esc(c.cc) : '<span class="dim">—</span>') + '</dd><dt>Bcc</dt><dd>' + (c.bcc ? esc(c.bcc) : '<span class="dim">—</span>') + '</dd><dt>Start</dt><dd>' + (c.startAt ? esc(fmtDT(c.startAt)) : 'Immediately') + '</dd><dt>Delay</dt><dd>One every ' + plural(c.intervalMin, 'minute') + (c.workingHoursOnly ? ' · working hours only' : '') + '</dd><dt>Opt-out line</dt><dd>' + (c.unsubscribeLine ? 'Included' : 'Not included') + '</dd><dt>Lawful basis</dt><dd style="font-weight:400">' + esc(c.lawfulBasis) + '</dd><dt>Created</dt><dd>' + esc(Store.userName(c.createdBy)) + ' · ' + esc(fmtDT(c.createdAt)) + '</dd></dl></section>' +
      '<section class="card" style="gap:8px"><h2>Email as queued</h2><div class="mprev" style="margin:0"><div class="msub">' + esc(c.subject) + '</div><pre>' + esc(c.body) + '</pre></div><div class="dim" style="font-size:12px">Saved with the campaign, so later template edits do not change this record.</div></section></aside></div></div>';
    return { html, mount(el) {
      const on = (k, fn) => { const b = el.querySelector('[data-m=' + k + ']'); if (b) b.addEventListener('click', fn); };
      on('start', () => { Store.startCampaignNow(id); toast(id + ' started'); });
      on('pause', () => { Store.pauseCampaign(id); toast(id + ' paused'); });
      on('resume', () => { try { Store.resumeCampaign(id); toast(id + ' resumed'); } catch (err) { toast(err.message, 'warn'); } });
      on('cancel', () => modal('<h2>Cancel the rest of ' + id + '?</h2><p style="margin:0;font-size:13px;color:var(--muted)">' + plural(n.Queued, 'email') + ' still queued will not be sent. Emails already sent stay on their leads. This cannot be undone.</p><div class="actions"><button class="btn" data-close>Keep sending</button><button class="btn primary" data-go>Cancel remaining</button></div>', (bg, close) => bg.querySelector('[data-go]').addEventListener('click', () => { close(); Store.cancelCampaign(id); toast(id + ' cancelled'); })));
    } };
  }
})();
