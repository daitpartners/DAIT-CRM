/* Mock data layer. Stands in for the Node.js API + MySQL/Postgres.
   Persists to localStorage so the public form (public/contact.html) and the CRM share one "database".
   Every rule the spec calls out lives here, not in the views:
   duplicate detection, immutable enquiries, lead allocation, follow-up → task, transfer history + notifications,
   AI enrichment that never overwrites verified fields, quotation revisions and conversion. */
window.Store = (function () {
  const KEY = 'dait-crm-proto-v1';
  let db = null;
  const listeners = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) { db = JSON.parse(raw); return; } } catch (e) { /* storage blocked */ }
    db = clone(window.SEED);
  }
  /* Data saved by an older build may be missing collections or config lists added since (projects, templates,
     mailbox accounts…). Fill every missing key from the seed so old browsers never crash on undefined. */
  function migrate() {
    if (!db) return;
    const seed = window.SEED;
    Object.keys(seed).forEach((k) => { if (k !== 'TODAY' && db[k] === undefined) db[k] = clone(seed[k]); });
    ['config', 'counters'].forEach((k) => { Object.keys(seed[k]).forEach((s) => { if (db[k][s] === undefined) db[k][s] = clone(seed[k][s]); }); });
    if (db.counters.project === undefined) db.counters.project = db.projects.reduce((m, p) => Math.max(m, Number(String(p.id).replace(/\D/g, '')) || 0), 0) + 1;
    if (typeof db.rr !== 'object' || db.rr === null) db.rr = {};
    if (!Array.isArray(db.campaigns)) db.campaigns = [];
    // Leads-2 person profile fields (added after the first builds)
    const seedCt = {}; seed.contacts.forEach((c) => { seedCt[c.id] = c; });
    db.contacts.forEach((c) => { const s = seedCt[c.id] || {}; ['headline', 'location', 'about', 'photo'].forEach((k) => { if (c[k] === undefined) c[k] = s[k] === undefined ? null : clone(s[k]); }); ['experience', 'education', 'skills', 'languages'].forEach((k) => { if (!Array.isArray(c[k])) c[k] = clone(s[k] || []); }); });
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } listeners.forEach((fn) => fn()); }
  function reset() { db = clone(window.SEED); migrate(); save(); }
  function onChange(fn) { listeners.push(fn); }
  load(); migrate();

  /* ---------- helpers ---------- */
  const now = () => (db.clock || window.SEED.TODAY + 'T' + new Date().toTimeString().slice(0, 8));
  const today = () => window.SEED.TODAY;
  function nextId(kind) {
    const c = db.counters; const n = c[kind]++;
    return { lead: 'LD-' + n, company: 'CO-' + String(n).padStart(4, '0'), contact: 'CT-' + n, enquiry: 'ENQ-' + String(n).padStart(4, '0'), quote: 'Q-2026-' + String(n).padStart(3, '0'), task: 'T-' + n, activity: 'A-' + n, note: 'X-' + n, project: 'PRJ-' + n }[kind];
  }
  /* Unique id for rows without a business counter (sources, assignments, runs…). Date.now() alone repeats
     when two rows are created in the same millisecond. */
  let uidSeq = 0;
  const uid = (prefix) => prefix + '-' + Date.now().toString(36) + (uidSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  /* Only web, mail and phone links may become an href; anything else (javascript:, data:…) is dropped. */
  const safeUrl = (u) => { if (!u) return null; const s = String(u).trim(); if (/^(https?:|mailto:|tel:)/i.test(s)) return s; if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; return /^[\w-]+(\.[\w-]+)+/.test(s) ? 'https://' + s : null; };
  const CLOSED_STATUSES = ['Won', 'Lost', 'Not Relevant'];
  const by = (list, id) => list.find((x) => x.id === id) || null;
  const user = (id) => by(db.users, id);
  const userName = (id) => (id === 'system' ? 'System' : (user(id) || {}).name || 'Unassigned');
  const company = (id) => by(db.companies, id);
  const contact = (id) => by(db.contacts, id);
  const contactName = (id) => { const c = contact(id); return c ? c.firstName + ' ' + c.lastName : null; };
  const lead = (id) => by(db.leads, id);
  const domainOf = (s) => { if (!s) return null; let d = String(s).trim().toLowerCase(); if (d.includes('@')) d = d.split('@')[1]; d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; return d || null; };
  const FREE_MAIL = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'free-prizes.biz'];
  const norm = (s) => (s || '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llc|inc|gmbh|plc|spa|sl|pty|co|corp|corporation|company|group)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const normPhone = (p) => (p || '').replace(/[^0-9]/g, '').slice(-10);
  const isOverdue = (t) => !t.done && t.due && t.due < today();
  const isToday = (t) => !t.done && t.due === today();

  /* ---------- duplicate detection ---------- */
  function matchCompany({ name, website, email }) {
    const d = domainOf(website) || (email && !FREE_MAIL.includes(domainOf(email)) ? domainOf(email) : null);
    if (d) { const hit = db.companies.find((c) => c.domain === d); if (hit) return { match: hit, how: 'exact website domain', confidence: 'High', candidates: [hit] }; }
    if (name) {
      const exactLegal = db.companies.find((c) => c.legalName && c.legalName.toLowerCase() === name.toLowerCase());
      if (exactLegal) return { match: exactLegal, how: 'exact legal company name', confidence: 'High', candidates: [exactLegal] };
      const n = norm(name);
      const cands = db.companies.filter((c) => norm(c.name) === n || norm(c.legalName) === n);
      if (cands.length === 1) return { match: null, how: 'normalised name (country unconfirmed)', confidence: 'Medium', candidates: cands };
      if (cands.length > 1) return { match: null, how: 'several normalised-name matches', confidence: 'Low', candidates: cands };
    }
    return { match: null, how: 'no match', confidence: null, candidates: [] };
  }
  function matchCompanyWithCountry(args) {
    const r = matchCompany(args);
    if (!r.match && r.candidates.length === 1 && args.country && r.candidates[0].country === args.country) return { match: r.candidates[0], how: 'normalised name + country', confidence: 'Medium', candidates: r.candidates };
    return r;
  }
  function matchContact({ email, phone, firstName, lastName, companyId }) {
    if (email) { const hit = db.contacts.find((c) => c.email && c.email.toLowerCase() === email.toLowerCase()); if (hit) return { match: hit, how: 'exact email' }; }
    if (phone && normPhone(phone).length >= 8) { const hit = db.contacts.find((c) => normPhone(c.mobile) === normPhone(phone) || normPhone(c.phone) === normPhone(phone)); if (hit) return { match: hit, how: 'normalised phone' }; }
    if (firstName && companyId) { const hit = db.contacts.find((c) => c.companyId === companyId && c.firstName.toLowerCase() === firstName.toLowerCase() && (!lastName || c.lastName.toLowerCase() === lastName.toLowerCase())); if (hit) return { match: hit, how: 'name + company' }; }
    return { match: null, how: 'no match' };
  }

  /* ---------- allocation + notifications + tasks ---------- */
  function allocate(countryName) {
    for (const r of db.config.allocationRules) {
      const c = r.country;
      if (c === '*' || c === countryName || (Array.isArray(c) && c.includes(countryName))) {
        if (Array.isArray(r.assignTo)) { if (!db.rr || typeof db.rr !== 'object') db.rr = {}; const k = r.name; const i = (db.rr[k] || 0) % r.assignTo.length; db.rr[k] = i + 1; return { userId: r.assignTo[i], rule: r }; }
        return { userId: r.assignTo, rule: r };
      }
    }
    return { userId: null, rule: null };
  }
  function notify(userId, text, detail, link) { if (!userId) return; db.notifications.unshift({ id: nextId('note'), userId, at: now(), text, detail, link, read: false }); }
  function addActivity(leadId, type, title, body, extra) { const a = Object.assign({ id: nextId('activity'), leadId, type, by: db.currentUser || 'u1', at: now(), title, body }, extra || {}); db.activities.unshift(a); return a; }
  function addTask(leadId, title, due, assignedTo, origin) { const t = { id: nextId('task'), leadId, title, due, assignedTo, done: false, origin }; db.tasks.push(t); return t; }
  function ensureFollowUpTask(l) {
    if (!l.followUp || !l.assignedTo) return null;
    const existing = db.tasks.find((t) => t.leadId === l.id && t.origin === 'follow-up date' && !t.done);
    if (existing) { existing.due = l.followUp; existing.assignedTo = l.assignedTo; return existing; }
    return addTask(l.id, 'Follow up · ' + l.companyName, l.followUp, l.assignedTo, 'follow-up date');
  }
  /* Follow-up date removed → its auto-created task goes too, so it stops counting as overdue. */
  function dropFollowUpTask(l) { db.tasks = db.tasks.filter((t) => !(t.leadId === l.id && t.origin === 'follow-up date' && !t.done)); }
  /* Single place for what a status change implies, whichever screen made it (stepper, call log, quotation, close dialog). */
  function applyStatusEffects(l, from, to) {
    if (to === from) return;
    if (to === 'Won') { l.convertedTo = l.convertedTo || 'client'; const c = company(l.companyId); if (c) c.isClient = true; }
    if (CLOSED_STATUSES.includes(to)) {
      l.followUp = null; dropFollowUpTask(l);
      const open = db.tasks.filter((t) => t.leadId === l.id && !t.done);
      open.forEach((t) => { t.done = true; t.closedReason = 'Lead closed as ' + to; });
      if (open.length) addActivity(l.id, 'note', open.length + ' open task' + (open.length === 1 ? '' : 's') + ' closed', 'Closed automatically because the lead moved to ' + to + '.', { by: 'system' });
    }
  }

  /* ---------- companies & contacts ---------- */
  function createCompany(data, createdBy) {
    const c = Object.assign({ id: nextId('company'), legalName: null, domain: domainOf(data.website), industry: null, category: null, businessType: null, yearEstablished: null, description: null, linkedin: null, status: 'Active', isClient: false, state: null, city: null, street: null, zip: null, timezone: null, lat: null, lng: null, mapsUrl: null, employeeCount: null, employeeRange: null, revenue: null, revenueCurrency: null, revenueRange: null, ownership: null, registrationNumber: null, stockExchange: null, stockSymbol: null, products: null, services: null, verticals: [], targetMarkets: [], geoMarkets: [], brands: null, specialisation: null, social: {}, webTech: null, webAssessment: null, digitalSummary: null, verified: { name: true }, aiMeta: {}, ai: { summary: null, industry: null, category: null, services: [], score: null, confidence: null, status: 'Pending', lastRun: null, verification: 'Unverified' }, createdAt: today(), createdBy: createdBy || 'system' }, data);
    if (data.country) c.verified.country = true;
    db.companies.push(c); return c;
  }
  function createContact(data) { const c = Object.assign({ id: nextId('contact'), designation: null, department: null, phone: null, mobile: null, linkedin: null, type: 'Other', primary: false }, data); if (!db.contacts.some((x) => x.companyId === c.companyId && x.primary)) c.primary = true; db.contacts.push(c); return c; }
  /* Person profile (Leads-2): headline, location, about, photo, experience, education, skills, languages, linkedin, designation… */
  function updateContact(id, patch) {
    const c = contact(id); if (!c) throw new Error('Contact ' + id + ' not found.');
    patch = Object.assign({}, patch); if ('linkedin' in patch) patch.linkedin = safeUrl(patch.linkedin);
    Object.assign(c, patch);
    db.leads.filter((l) => l.contactId === id && !CLOSED_STATUSES.includes(l.status)).slice(0, 1).forEach((l) => addActivity(l.id, 'note', 'Profile updated · ' + c.firstName + ' ' + c.lastName, Object.keys(patch).join(', ') + ' changed by ' + userName(db.currentUser || 'u1') + '.'));
    save(); return c;
  }
  function updateCompany(id, patch, markVerified) { const c = company(id); Object.keys(patch).forEach((k) => { c[k] = patch[k]; if (patch[k] === null) { delete c.verified[k]; delete c.aiMeta[k]; } else if (markVerified) { c.verified[k] = true; delete c.aiMeta[k]; } }); recomputeVerification(c); save(); return c; }
  function recomputeVerification(c) {
    const fields = ['name', 'legalName', 'website', 'industry', 'category', 'businessType', 'yearEstablished', 'description', 'country', 'city', 'street', 'employeeCount', 'employeeRange', 'revenue', 'registrationNumber', 'services', 'products', 'webTech'];
    const filled = fields.filter((f) => c[f] !== null && c[f] !== undefined && c[f] !== '');
    const verified = filled.filter((f) => c.verified[f]);
    c.ai.verification = filled.length && verified.length === filled.length ? 'Verified' : verified.length ? 'Partially verified' : 'Unverified';
  }

  /* ---------- leads ---------- */
  function createLead(data, opts) {
    opts = opts || {};
    const l = Object.assign({ id: nextId('lead'), type: 'Lead', companyId: null, contactId: null, website: null, email: null, phone: null, city: null, sourceUrl: null, importBatch: null, assignedTo: null, priority: 'Medium', status: 'New', followUp: null, notes: null, enquiryId: null, enrichment: 'Pending', archived: false, convertedTo: null, createdAt: now() }, data);
    if (!l.companyName || !l.country || !l.source) throw new Error('Company name, country and lead source are required.');
    // company link / creation without duplicating
    if (!l.companyId) {
      if (opts.linkCompanyId) l.companyId = opts.linkCompanyId;
      else if (opts.createCompany !== false) { const m = matchCompanyWithCountry({ name: l.companyName, website: l.website, email: l.email, country: l.country }); l.companyId = m.match ? m.match.id : createCompany({ name: l.companyName, website: l.website, country: l.country, city: l.city }, db.currentUser).id; }
    }
    let ruleUsed = null;
    if (!l.assignedTo && opts.autoAssign !== false) { const a = allocate(l.country); l.assignedTo = a.userId; ruleUsed = a.rule; }
    db.leads.unshift(l);
    addActivity(l.id, 'created', 'Lead created' + (l.enquiryId ? ' from website enquiry ' + l.enquiryId : ' by ' + userName(db.currentUser || 'u1')), 'Linked to company ' + l.companyId + (l.contactId ? ', contact ' + l.contactId : '') + '.', { by: l.enquiryId ? 'system' : db.currentUser || 'u1' });
    if (l.assignedTo) {
      db.assignments.push({ id: uid('AS'), leadId: l.id, from: null, to: l.assignedTo, by: ruleUsed ? 'system' : db.currentUser || 'u1', at: now(), note: ruleUsed ? 'Allocation rule "' + ruleUsed.name + '"' : 'Assigned on creation' });
      addActivity(l.id, 'assign', (ruleUsed ? 'Auto-assigned' : 'Assigned') + ' to ' + userName(l.assignedTo), ruleUsed ? 'Allocation rule "' + ruleUsed.name + '".' : '', { by: ruleUsed ? 'system' : db.currentUser || 'u1' });
      notify(l.assignedTo, 'New lead assigned · ' + l.companyName + ' (' + l.source + ')', ruleUsed ? 'Rule "' + ruleUsed.name + '"' : 'Assigned by ' + userName(db.currentUser || 'u1'), '#/leads/' + l.id);
      addTask(l.id, 'Review new lead · ' + l.companyName, today(), l.assignedTo, 'new assignment');
    }
    ensureFollowUpTask(l);
    const c = company(l.companyId); if (c && c.ai.status !== 'Completed') { c.ai.status = 'Pending'; }
    addActivity(l.id, 'ai', 'AI enrichment queued for ' + (c ? c.name : l.companyName), 'Status Pending. Results will appear under the company\'s AI Intelligence tab, marked as unverified.', { by: 'system' });
    save(); return l;
  }
  function updateLead(id, patch) {
    const l = lead(id); const before = clone(l); const note = patch.note; patch = Object.assign({}, patch); delete patch.note;
    Object.assign(l, patch);
    if ('assignedTo' in patch && !patch.assignedTo && before.assignedTo) {
      db.assignments.push({ id: uid('AS'), leadId: id, from: before.assignedTo, to: null, by: db.currentUser || 'u1', at: now(), note: 'Unassigned' });
      addActivity(id, 'assign', 'Unassigned from ' + userName(before.assignedTo), 'Lead has no owner; open tasks stay with ' + userName(before.assignedTo) + ' until it is reassigned.');
    }
    if (patch.status && patch.status !== before.status) {
      if (patch.status === 'Won' && !before.convertedTo) { l.status = before.status; return convertLead(id, note); }
      addActivity(id, 'status', 'Status changed ' + before.status + ' → ' + patch.status, note || '', { statusFrom: before.status, statusTo: patch.status });
      applyStatusEffects(l, before.status, patch.status);
    }
    if ('followUp' in patch && patch.followUp !== before.followUp) { if (patch.followUp) ensureFollowUpTask(l); else dropFollowUpTask(l); }
    if ('assignedTo' in patch && patch.assignedTo && patch.assignedTo !== before.assignedTo) ensureFollowUpTask(l);
    save(); return l;
  }
  function transferLead(id, toUserId, note) {
    const l = lead(id); const from = l.assignedTo; if (from === toUserId) return l;
    l.assignedTo = toUserId;
    db.assignments.push({ id: uid('AS'), leadId: id, from, to: toUserId, by: db.currentUser || 'u1', at: now(), note });
    db.tasks.filter((t) => t.leadId === id && !t.done).forEach((t) => { t.assignedTo = toUserId; });
    addActivity(id, 'transfer', 'Lead transferred ' + userName(from) + ' → ' + userName(toUserId), 'Transfer note: "' + note + '". ' + userName(toUserId) + ' notified in app and by email; open tasks moved.');
    notify(toUserId, 'Lead transferred to you · ' + l.companyName + ' from ' + userName(from), '"' + note + '"', '#/leads/' + id);
    save(); return l;
  }
  function saveResearch(id, title, url, body) {
    const l = lead(id);
    url = safeUrl(url); const a = addActivity(id, 'research', 'Research · ' + title, body, { url: url || null });
    if (l.companyId) db.sources.push({ id: uid('SR'), companyId: l.companyId, title, url: url || null, type: 'Manual research', at: now(), by: userName(db.currentUser || 'u1') + ' (manual)', fields: 'Research note on ' + id, confidence: 'Manual', snapshot: body });
    save(); return a;
  }
  function logCall(id, outcome, minutes, body, statusAfter, followUp) {
    const l = lead(id); const before = l.status; const changed = statusAfter && statusAfter !== before;
    addActivity(id, 'call', 'Call · ' + outcome + (minutes ? ' · ' + minutes + ' min' : ''), body, changed ? { statusFrom: before, statusTo: statusAfter } : {});
    if (followUp) { l.followUp = followUp; ensureFollowUpTask(l); }
    if (changed) {
      if (statusAfter === 'Won' && !l.convertedTo) return convertLead(id, 'Marked Won after a call.');
      l.status = statusAfter; applyStatusEffects(l, before, statusAfter);
    }
    save(); return l;
  }
  /* Clone: a new lead on the same company and contact, with the same details, starting fresh at status New.
     History (activities, tasks, quotes, emails), follow-up date, enquiry link and archive/won flags are not copied. */
  function cloneLead(id) {
    const src = lead(id); if (!src) throw new Error('Lead ' + id + ' not found.');
    const keep = ['type', 'companyName', 'companyId', 'contactId', 'website', 'email', 'phone', 'country', 'city', 'source', 'sourceUrl', 'priority', 'notes', 'assignedTo'];
    const data = {}; keep.forEach((k) => { data[k] = src[k] === undefined ? null : src[k]; });
    const l = createLead(data, { autoAssign: false, createCompany: false });
    addActivity(l.id, 'note', 'Cloned from ' + id, 'Details copied from ' + id + '. History, tasks and quotations stay on the original.');
    addActivity(id, 'note', 'Cloned to ' + l.id, 'A new lead was created from this one by ' + userName(db.currentUser || 'u1') + '.');
    save(); return l;
  }
  function logActivity(id, type, body) { const titles = { call: 'Call', email: 'Email', meeting: 'Meeting', note: 'Note' }; const a = addActivity(id, type, titles[type] + ' logged by ' + userName(db.currentUser || 'u1'), body); save(); return a; }
  /* ---------- projects: many per client, each from its own lead ---------- */
  function primaryStakeholders(companyId) { const cs = db.contacts.filter((c) => c.companyId === companyId); return cs.filter((c) => c.primary || c.type === 'Decision Maker').map((c) => c.id); }
  function createProject(data) {
    const l = data.leadId ? lead(data.leadId) : null; const c = company(data.companyId);
    const pr = Object.assign({ id: nextId('project'), quoteId: null, status: 'Active', startDate: today(), value: null, currency: 'GBP', managerId: db.currentUser || 'u1', stakeholders: [], description: '', createdAt: now() }, data);
    if (!pr.stakeholders.length) pr.stakeholders = Array.from(new Set([l && l.contactId].filter(Boolean).concat(primaryStakeholders(pr.companyId))));
    if (!pr.name) pr.name = (c ? c.name : 'Client') + ' engagement';
    db.projects.push(pr); if (c) c.isClient = true;
    if (l) addActivity(l.id, 'status', 'Project created · ' + pr.id + ' ' + pr.name, 'Stakeholders: ' + pr.stakeholders.map(contactName).join(', '));
    notify(pr.managerId, 'Project created · ' + pr.name, (c ? c.name : '') + (l ? ' · from ' + l.id : ''), '#/projects');
    save(); return pr;
  }
  function updateProject(id, patch) { const pr = by(db.projects, id); Object.assign(pr, patch); save(); return pr; }
  function projectsFor(companyId) { return db.projects.filter((p) => p.companyId === companyId); }
  /* Won from any screen ends here: lead Won, company flagged Client, follow-up and open tasks closed.
     A project is NOT created automatically; the UI offers "Create project" right after (one client, many projects). */
  function convertLead(id, note) {
    const l = lead(id); const before = l.status; if (before === 'Won') return l;
    l.status = 'Won';
    addActivity(id, 'status', 'Converted to client · status Won', (note ? note + ' ' : '') + 'Company ' + l.companyId + ' flagged as Client. No duplicate company record.', { statusFrom: before, statusTo: 'Won' });
    applyStatusEffects(l, before, 'Won'); l.convertedTo = l.convertedTo || 'client';
    save(); return l;
  }

  /* ---------- website enquiry workflow ---------- */
  function submitEnquiry(form) {
    const errors = {};
    if (!form.fullName || form.fullName.trim().length < 2) errors.fullName = 'Please enter your full name.';
    if (!form.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errors.email = 'Please enter a valid business email.';
    if (!form.companyName || form.companyName.trim().length < 2) errors.companyName = 'Please enter your company name.';
    if (!form.message || form.message.trim().length < 10) errors.message = 'Please describe your requirement (at least 10 characters).';
    if (form.website && !/^https?:\/\//i.test(form.website)) form.website = 'https://' + form.website;
    if (Object.keys(errors).length) return { ok: false, errors };
    // 1–2 validate + store immutable record
    const enq = { id: nextId('enquiry'), fullName: form.fullName.trim(), email: form.email.trim(), phone: form.phone ? form.phone.trim() : null, companyName: form.companyName.trim(), website: form.website || null, message: form.message.trim(), submittedAt: now(), sourcePage: 'daitpartners.com/contact', spamCheck: form.honeypot ? 'Failed · honeypot' : 'Passed', status: 'Received', leadId: null, contactId: null, companyId: null, trace: ['Validated and stored'] };
    // The submission fields above are never written again (only status/trace/link ids change).
    // Object.freeze would not survive the JSON round-trip, so the real build must enforce this in the database.
    db.enquiries.unshift(enq);
    if (form.honeypot) { enq.status = 'Spam'; enq.trace.push('Honeypot field filled → blocked', 'No records created'); save(); return { ok: true, enquiry: enq, spam: true }; }
    // 3–6 company
    const cm = matchCompany({ name: enq.companyName, website: enq.website, email: enq.email });
    let comp;
    if (cm.match) { comp = cm.match; enq.trace.push('Company match on ' + cm.how + ' → existing ' + comp.id); }
    else if (cm.candidates.length) { enq.status = 'Needs review'; enq.reviewCandidates = cm.candidates.map((c) => c.name + ' (' + c.id + ')'); enq.trace.push('Possible company match (' + cm.how + ') with uncertain confidence', 'Held for manual review · no lead created yet'); save(); return { ok: true, enquiry: enq, review: true }; }
    else { comp = createCompany({ name: enq.companyName, website: enq.website, country: null }, 'system'); enq.trace.push('No company match → created ' + comp.id); }
    enq.companyId = comp.id;
    // 7 contact
    const parts = enq.fullName.split(/\s+/); const first = parts[0]; const last = parts.slice(1).join(' ') || null;
    const ctm = matchContact({ email: enq.email, phone: enq.phone, firstName: first, lastName: last, companyId: comp.id });
    let ct;
    if (ctm.match) { ct = ctm.match; enq.trace.push('Contact match on ' + ctm.how + ' → existing ' + ct.id); }
    else { ct = createContact({ companyId: comp.id, firstName: first, lastName: last || '', email: enq.email, mobile: enq.phone, type: 'Other' }); enq.trace.push('No contact match → created ' + ct.id); }
    enq.contactId = ct.id;
    // 8–15 lead
    const l = createLead({ companyName: enq.companyName, companyId: comp.id, contactId: ct.id, website: enq.website, email: enq.email, phone: enq.phone, country: comp.country || 'Unknown', city: comp.city, source: 'Website Contact Form', sourceUrl: 'https://daitpartners.com/contact', status: 'New', notes: enq.message, enquiryId: enq.id, enrichment: 'Pending', followUp: addDays(today(), 2) });
    enq.leadId = l.id; enq.status = 'Enrichment pending';
    enq.trace.push('New lead ' + l.id + ' created · Lead · Website Contact Form · New', 'AI enrichment status = Pending', l.assignedTo ? 'Assigned to ' + userName(l.assignedTo) + ' and notified' : 'No allocation rule matched · unassigned', 'Follow-up task added to owner\'s list', 'Visitor confirmation sent');
    db.sources.push({ id: uid('SR'), companyId: comp.id, title: 'Website enquiry ' + enq.id, url: null, type: 'Contact form', at: now(), by: 'Visitor', fields: 'Company name, website, contact email, phone', confidence: 'Submitted by contact', snapshot: null });
    save(); return { ok: true, enquiry: enq, lead: l, company: comp, contact: ct };
  }
  function resolveEnquiry(enqId, companyId) {
    const enq = by(db.enquiries, enqId); if (!enq || enq.leadId) return;
    let comp = companyId === 'new' ? createCompany({ name: enq.companyName, website: enq.website, country: null }, db.currentUser) : company(companyId);
    if (!comp) { comp = createCompany({ name: enq.companyName, website: enq.website, country: null }, db.currentUser); }
    enq.companyId = comp.id; enq.trace.push('Manual review by ' + userName(db.currentUser || 'u1') + ' → ' + (companyId === 'new' ? 'new company ' : 'existing ') + comp.id);
    const parts = enq.fullName.split(/\s+/);
    const ctm = matchContact({ email: enq.email, phone: enq.phone, firstName: parts[0], companyId: comp.id });
    const ct = ctm.match || createContact({ companyId: comp.id, firstName: parts[0], lastName: parts.slice(1).join(' '), email: enq.email, mobile: enq.phone });
    enq.contactId = ct.id;
    const l = createLead({ companyName: enq.companyName, companyId: comp.id, contactId: ct.id, website: enq.website, email: enq.email, phone: enq.phone, country: comp.country || 'Unknown', source: 'Website Contact Form', sourceUrl: 'https://daitpartners.com/contact', notes: enq.message, enquiryId: enq.id, followUp: addDays(today(), 2) });
    enq.leadId = l.id; enq.status = 'Enrichment pending'; enq.trace.push('Lead ' + l.id + ' created'); delete enq.reviewCandidates; save(); return l;
  }
  /* Calendar-day arithmetic in UTC, so the result does not depend on the computer's time zone (local midnight east of UTC is the previous day in UTC). */
  function addDays(d, n) { const x = new Date(d.slice(0, 10) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

  /* ---------- AI enrichment (simulated, modular) ---------- */
  function runEnrichment(companyId) {
    const c = company(companyId); c.ai.status = 'Processing'; save();
    const run = { id: uid('EH'), companyId, at: now(), trigger: 'Manual · ' + userName(db.currentUser || 'u1'), engine: db.config.enrichment.engine === 'ollama' ? 'Ollama ' + db.config.enrichment.model : 'Claude API', sources: Object.keys(db.config.enrichment.sources).filter((k) => db.config.enrichment.sources[k]).join(', '), result: '', applied: 0, status: 'Completed', suggestions: [] };
    const propose = (field, label, value, confidence, source, display) => { if (c.verified[field]) return; if (c[field] !== null && c[field] !== undefined && c[field] === value) return; run.suggestions.push({ id: uid('S') + '-' + field, field, label, value, display, confidence, source, decision: null }); };
    const d = c.domain || 'the company website';
    if (!c.description) propose('description', 'Company description', 'Organisation operating in ' + (c.industry || 'its sector') + ' based in ' + (c.city || c.country || 'an unconfirmed location') + ', according to ' + d + '.', 64, d);
    if (!c.industry) propose('industry', 'Industry', 'Professional Services', 48, d + ' (keywords)');
    if (!c.webTech) propose('webTech', 'Website technology', 'WordPress, Cloudflare', 85, 'Site headers');
    if (!c.employeeRange) propose('employeeRange', 'Employee range', '51–200', 50, 'LinkedIn page');
    if (!c.webAssessment) propose('webAssessment', 'Website assessment', 'Brochure-style site with a contact form; no client portal detected.', 72, 'AI analysis');
    if (!c.ai.services || !c.ai.services.length) propose('aiServices', 'Potential services', ['Digital transformation', 'Process advisory'], 66, 'AI analysis', 'Digital transformation, Process advisory');
    run.result = run.suggestions.length + ' suggestions' + (run.suggestions.length ? '' : ' (all filled fields are verified)');
    db.enrichmentHistory.unshift(run);
    c.ai.status = 'Completed'; c.ai.lastRun = now(); if (c.ai.score === null) c.ai.score = 50 + Math.min(30, run.suggestions.length * 5); if (!c.ai.confidence) c.ai.confidence = run.suggestions.length > 4 ? 'Medium' : 'Low';
    if (!c.ai.summary) c.ai.summary = 'Automated summary pending review: ' + c.name + (c.industry ? ' operates in ' + c.industry : '') + '. Verified fields were left untouched.';
    db.sources.push({ id: uid('SR'), companyId, title: d, url: c.website, type: 'Company website', at: now(), by: 'Enrichment worker', fields: run.suggestions.map((s) => s.label).join(', ') || '—', confidence: 'varies', snapshot: null });
    db.leads.filter((l) => l.companyId === companyId && l.enrichment !== 'Completed').forEach((l) => { l.enrichment = 'Completed'; });
    const owner = (db.leads.find((l) => l.companyId === companyId && l.assignedTo) || {}).assignedTo; notify(owner, 'AI research completed · ' + c.name, run.suggestions.length + ' suggestions to review', '#/companies/' + companyId + '/ai');
    save(); return run;
  }
  function decideSuggestion(runId, sid, accept) {
    const run = by(db.enrichmentHistory, runId); const s = run && by(run.suggestions, sid); if (!s) return null;
    if (s.decision) return s; // already decided (double click, second tab): never apply twice
    const c = company(run.companyId);
    s.decision = accept ? 'accepted' : 'rejected';
    if (accept) {
      if (c.verified[s.field]) { s.decision = 'blocked'; s.note = 'Field is verified; not overwritten'; }
      else {
        if (s.field === 'aiServices') { c.ai.services = s.value; } else { c[s.field] = s.value; c.aiMeta[s.field] = true; }
        run.applied = (run.applied || 0) + 1;
      }
    }
    recomputeVerification(c); save(); return s;
  }
  function verifyField(companyId, field) { const c = company(companyId); c.verified[field] = true; delete c.aiMeta[field]; recomputeVerification(c); save(); }
  function verifyAll(companyId) { const c = company(companyId); Object.keys(c).forEach((k) => { if (c[k] !== null && c[k] !== undefined && typeof c[k] !== 'object') c.verified[k] = true; }); c.aiMeta = {}; recomputeVerification(c); save(); }

  /* ---------- tasks ---------- */
  function toggleTask(id) { const t = by(db.tasks, id); t.done = !t.done; save(); }
  /* Follow-up added from the Calendar: an ordinary task with an optional time of day. */
  function createFollowUp({ leadId, title, due, time, assignedTo }) { const l = lead(leadId); if (!l) throw new Error('Choose a lead.'); const t = addTask(leadId, title, due, assignedTo || l.assignedTo || db.currentUser || 'u1', 'added in calendar by ' + userName(db.currentUser || 'u1')); if (time) t.time = time; addActivity(leadId, 'note', 'Follow-up planned · ' + title, due + (time ? ' ' + time : '') + ' · ' + userName(t.assignedTo)); if (t.assignedTo !== (db.currentUser || 'u1')) notify(t.assignedTo, 'New lead follow-up assigned · ' + title, l.companyName + ' · due ' + due, '#/leads/' + leadId); save(); return t; }
  function markNotification(id, read) { const n = by(db.notifications, id); if (n) { n.read = read !== false; save(); } return n; }
  function markAllNotifications(userId) { db.notifications.filter((n) => n.userId === userId).forEach((n) => { n.read = true; }); save(); }
  function createTask(leadId, title, due, assignedTo) { const t = addTask(leadId, title, due, assignedTo, 'added by ' + userName(db.currentUser || 'u1')); save(); return t; }

  /* ---------- email & calendar ---------- */
  function sendEmail({ to, cc, bcc, subject, body, leadId, contactId, companyId, projectId, campaignId }) { const e = { id: uid('E'), folder: 'sent', from: userName(db.currentUser || 'u1'), fromEmail: (user(db.currentUser || 'u1') || {}).email, to, cc: cc || '', bcc: bcc || '', campaignId: campaignId || null, subject, at: now(), unread: false, leadId, contactId, companyId, projectId: projectId || null, body, history: ['Sent' + (cc ? ' · cc ' + cc : '') + (bcc ? ' · bcc ' + bcc : '') + (campaignId ? ' · mailer ' + campaignId : '')] }; db.emails.unshift(e); if (leadId) addActivity(leadId, 'email', 'Email sent · ' + subject, 'To ' + to + (cc ? ' · cc ' + cc : '') + (projectId ? ' · project ' + projectId : '')); save(); return e; }
  function linkEmail(emailId, leadId) { const e = by(db.emails, emailId); const l = lead(leadId); e.leadId = leadId; e.contactId = l.contactId; e.companyId = l.companyId; addActivity(leadId, 'email', 'Email linked · ' + e.subject, 'From ' + e.from); save(); }
  function markRead(emailId) { const e = by(db.emails, emailId); if (e.unread) { e.unread = false; save(); } }
  function createEvent(ev) { const e = Object.assign({ id: uid('EV'), type: 'meeting', organiser: db.currentUser || 'u1' }, ev); db.events.push(e); if (e.leadId) addActivity(e.leadId, 'meeting', e.type === 'call' ? 'Call scheduled · ' + e.title : 'Meeting scheduled · ' + e.title, e.date + ' ' + e.start + '–' + e.end + (e.where ? ' · ' + e.where : '')); (e.attendeeIds || []).forEach((u) => { if (u !== e.organiser) notify(u, 'Meeting assigned · ' + e.title, e.date + ' ' + e.start, '#/calendar'); }); save(); return e; }

  /* ---------- mailbox connections (Microsoft 365 via Graph, Google, IMAP) ---------- */
  function accountFor(userId) { return (db.emailAccounts || []).find((a) => a.userId === userId && a.status !== 'disconnected') || null; }
  function connectMailbox({ userId, provider, address, syncMail, syncCalendar, sharedMailboxes }) {
    const u = user(userId); const a = { id: uid('EA'), userId, provider, address: address || u.email, displayName: u.name, tenant: provider === 'microsoft' ? 'daitpartners.onmicrosoft.com' : null, status: 'connected', connectedAt: now(), lastSync: now(), syncMail: syncMail !== false, syncCalendar: !!syncCalendar, sharedMailboxes: sharedMailboxes || [], scopes: provider === 'microsoft' ? ['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'User.Read', 'offline_access'] : provider === 'google' ? ['gmail.modify', 'calendar.events'] : ['imap', 'smtp'], messages: 0 };
    (db.emailAccounts = db.emailAccounts || []).filter((x) => x.userId === userId).forEach((x) => { x.status = 'disconnected'; });
    db.emailAccounts.push(a);
    notify(userId, (provider === 'microsoft' ? 'Microsoft 365' : provider === 'google' ? 'Google Workspace' : 'IMAP') + ' mailbox connected · ' + a.address, 'Initial sync of the last 90 days has started', '#/settings');
    save(); return a;
  }
  function disconnectMailbox(id) { const a = by(db.emailAccounts, id); if (a) { a.status = 'disconnected'; a.disconnectedAt = now(); } save(); }
  function updateMailbox(id, patch) { const a = by(db.emailAccounts, id); Object.assign(a, patch); save(); return a; }
  function syncMailbox(id) {
    const a = by(db.emailAccounts, id); a.lastSync = now(); a.messages = (a.messages || 0) + 1;
    const u = user(a.userId);
    const e = { id: uid('E'), folder: 'inbox', from: 'Rohini Deshpande', fromEmail: 'r.deshpande@northwindlogistics.in', to: a.address, subject: 'Capability deck – a few questions before Thursday', at: now(), unread: true, leadId: 'LD-2041', contactId: null, companyId: 'CO-0318', body: 'Hi ' + (u ? u.name.split(' ')[0] : '') + ',\n\nPriya forwarded your deck. Could you share two reference clients in pharma logistics before our call on Thursday?\n\nRegards,\nRohini Deshpande\nCFO, Northwind Logistics', history: ['Synced from Microsoft 365 · matched to CO-0318 on sender domain'] };
    if (!db.emails.some((x) => x.subject === e.subject)) { db.emails.unshift(e); addActivity('LD-2041', 'email', 'Email received · ' + e.subject, 'From ' + e.from + ' (auto-linked on sender domain)', { by: 'system' }); }
    save(); return a;
  }

  /* ---------- email templates (manual or uploaded Outlook .oft) ---------- */
  function addTemplate(tp) { const x = Object.assign({ id: uid('TP'), lang: 'en', source: 'manual', createdBy: db.currentUser || 'u1', at: now() }, tp); (db.templates = db.templates || []).push(x); save(); return x; }
  function updateTemplate(id, patch) { const x = by(db.templates, id); Object.assign(x, patch); save(); return x; }
  function removeTemplate(id) { db.templates = db.templates.filter((x) => x.id !== id); save(); }
  function templatesFor(lang) { const all = db.templates || []; const mine = all.filter((x) => x.lang === lang); return mine.length ? mine.concat(all.filter((x) => x.lang !== lang)) : all; }
  function fillTemplate(s, ctx) { return (s || '').replace(/\{(first_name|company|me|quote_no|lead_id)\}/g, (m, k) => ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '' ? ctx[k] : m); }
  /* Per-user display preferences: date format and time zone (language has its own setter below). */
  function setPrefs(userId, patch) { const u = user(userId); if (!u) return; if ('dateFormat' in patch) u.dateFormat = patch.dateFormat || 'auto'; if ('timeZone' in patch) u.timeZone = patch.timeZone || 'Asia/Kolkata'; save(); }
  function setLang(userId, lang) { const u = user(userId); if (u) u.lang = lang; save(); }

  /* ---------- mailer: bulk, personalised sending to selected leads ----------
     email_campaigns + email_campaign_recipients (recipients are embedded here; separate tables in the real build).
     The real build queues rows and a background worker sends through the sender's Microsoft 365 mailbox (Graph sendMail).
     Here campaignTick() plays the worker; the app calls it once a second. */
  const MAILER_SPEED = 60; // prototype only: 1 minute of spacing runs as 1 second, so a demo does not take an hour
  const WORK_HOURS = ['09:00', '18:00'];
  const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;
  const UNSUB_LINE = '\n\n—\nIf you would prefer not to receive emails from DAIT Partners, reply with "unsubscribe" and we will not contact you again.';
  /* Why a lead cannot be mailed right now, or null when it can. One rule, used by the wizard and again by the worker at send time. */
  function mailBlock(l) {
    if (!l) return 'Lead no longer exists';
    const ct = contact(l.contactId); const to = (ct && ct.email) || l.email;
    if (!to) return 'No email address';
    if (!EMAIL_RE.test(to)) return 'Invalid email address';
    if (l.doNotEmail) return 'Marked do not email';
    if (ct && ct.unsubscribedAt) return 'Unsubscribed';
    if (l.archived) return 'Lead is archived';
    if (CLOSED_STATUSES.includes(l.status)) return 'Lead is closed (' + l.status + ')';
    return null;
  }
  function mailerCheck(leadIds) { const seen = new Set(); // one email per address per run, even when the person is on several selected leads
    return leadIds.map((id) => { const l = lead(id); const ct = l && contact(l.contactId); const to = l ? ((ct && ct.email) || l.email || '') : ''; let block = mailBlock(l);
      if (!block) { const k = to.toLowerCase(); if (seen.has(k)) block = 'Same address as another selected lead'; else seen.add(k); }
      return { leadId: id, contactId: l ? l.contactId : null, to, name: ct ? (ct.firstName + ' ' + (ct.lastName || '')).trim() : '', company: l ? l.companyName : '', block }; }); }
  function createCampaign(d) {
    const tp = by(db.templates || [], d.templateId); if (!tp) throw new Error('Choose a template.');
    const sender = db.currentUser || 'u1'; if (!accountFor(sender)) throw new Error('Connect your mailbox in Settings before using the mailer.');
    const rows = mailerCheck(d.leadIds || []); if (!rows.some((r) => !r.block)) throw new Error('None of the selected leads can be emailed.');
    [['Cc', d.cc], ['Bcc', d.bcc]].forEach(([k, v]) => (v || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((a) => { if (!EMAIL_RE.test(a)) throw new Error(k + ': "' + a + '" is not a full email address.'); }));
    if (!d.lawfulBasis) throw new Error('Record the lawful basis for contacting these leads.');
    const interval = Math.min(60, Math.max(1, Number(d.intervalMin) || 3)); const startAt = d.startAt && d.startAt > now() ? d.startAt : null;
    if (!db.counters.campaign) db.counters.campaign = db.campaigns.length + 1;
    const c = { id: 'MC-' + String(db.counters.campaign++).padStart(3, '0'), name: (d.name || '').trim() || 'Mailer · ' + tp.name, templateId: tp.id, templateName: tp.name, templateVersion: tp.at || null, subject: tp.subject, body: tp.body,
      senderId: sender, senderAddress: accountFor(sender).address, cc: (d.cc || '').split(',').map((x) => x.trim()).filter(Boolean).join(', '), bcc: (d.bcc || '').split(',').map((x) => x.trim()).filter(Boolean).join(', '),
      startAt, intervalMin: interval, workingHoursOnly: !!d.workingHoursOnly, unsubscribeLine: d.unsubscribeLine !== false, lawfulBasis: d.lawfulBasis, status: startAt ? 'Scheduled' : 'Sending', createdBy: sender, createdAt: now(), nextAtMs: Date.now(), completedAt: null,
      recipients: rows.map((r, i) => ({ id: 'R' + (i + 1), leadId: r.leadId, contactId: r.contactId, to: r.to, name: r.name, company: r.company, status: r.block ? 'Skipped' : 'Queued', sentAt: null, messageId: null, error: r.block || null })) };
    db.campaigns.unshift(c);
    notify(sender, 'Mailer queued · ' + c.name, c.recipients.filter((r) => r.status === 'Queued').length + ' emails' + (startAt ? ' · starts ' + startAt.replace('T', ' ').slice(0, 16) : ' · sending now'), '#/mailer/' + c.id);
    save(); return c;
  }
  const campaign = (id) => by(db.campaigns || [], id);
  function campaignStats(c) { const n = { Queued: 0, Sent: 0, Failed: 0, Skipped: 0 }; c.recipients.forEach((r) => { n[r.status] = (n[r.status] || 0) + 1; }); n.total = c.recipients.length; n.toSend = n.total - n.Skipped; n.replied = c.recipients.filter((r) => r.status === 'Sent' && db.emails.some((e) => e.folder === 'inbox' && e.leadId === r.leadId && e.at > r.sentAt)).length; return n; }
  function finishIfDone(c) { if (!c.recipients.some((r) => r.status === 'Queued')) { c.status = c.status === 'Cancelled' ? 'Cancelled' : 'Completed'; c.completedAt = now(); const n = campaignStats(c); notify(c.senderId, 'Mailer finished · ' + c.name, n.Sent + ' sent · ' + n.Skipped + ' skipped · ' + n.Failed + ' failed', '#/mailer/' + c.id); return true; } return false; }
  function sendCampaignEmail(c, r) {
    const l = lead(r.leadId); const ct = l && contact(l.contactId); const me = user(c.senderId) || {};
    const ctx = { first_name: ct ? ct.firstName : '', company: l.companyName, me: me.name || 'DAIT Partners', lead_id: l.id };
    const first = ctx.first_name ? null : 'there'; if (first) ctx.first_name = first; // no contact name: "Hi there"
    const prevUser = db.currentUser; db.currentUser = c.senderId; // the email and its timeline entry belong to the sender, whoever is acting now
    try {
      const e = sendEmail({ to: r.to, cc: c.cc, bcc: c.bcc, subject: fillTemplate(c.subject, ctx), body: fillTemplate(c.body, ctx) + (c.unsubscribeLine ? UNSUB_LINE : ''), leadId: l.id, contactId: l.contactId, companyId: l.companyId, campaignId: c.id });
      r.status = 'Sent'; r.sentAt = now(); r.messageId = e.id; r.error = null;
      if (['New', 'Not Contacted'].includes(l.status)) updateLead(l.id, { status: 'Contacted', note: 'First email sent by mailer ' + c.id + '.' });
    } catch (err) { r.status = 'Failed'; r.error = err.message || 'Send failed'; }
    finally { db.currentUser = prevUser; }
  }
  /* One pass of the "worker". Returns true when something changed on screen-worthy data. */
  function campaignTick() {
    let changed = false; const clock = now(); const hhmm = clock.slice(11, 16);
    (db.campaigns || []).forEach((c) => {
      if (c.status === 'Scheduled' && (!c.startAt || c.startAt <= clock)) { c.status = 'Sending'; c.nextAtMs = Date.now(); changed = true; }
      if (c.status !== 'Sending') return;
      const waiting = c.workingHoursOnly && (hhmm < WORK_HOURS[0] || hhmm >= WORK_HOURS[1]);
      if (!!c.waitingForHours !== waiting) { c.waitingForHours = waiting; changed = true; }
      if (waiting || Date.now() < (c.nextAtMs || 0)) return;
      let r; while ((r = c.recipients.find((x) => x.status === 'Queued'))) { // skips cost no time; one real send per pass
        const l = lead(r.leadId); const block = mailBlock(l);
        const replied = !block && db.emails.some((e) => e.folder === 'inbox' && e.leadId === r.leadId && e.at > c.createdAt);
        changed = true;
        if (block || replied) { r.status = 'Skipped'; r.error = block || 'Replied before this email was due'; continue; }
        if (!accountFor(c.senderId)) { c.status = 'Paused'; c.pauseReason = 'Mailbox disconnected'; notify(c.senderId, 'Mailer paused · ' + c.name, 'The sender\'s mailbox is no longer connected.', '#/mailer/' + c.id); return; }
        sendCampaignEmail(c, r); c.nextAtMs = Date.now() + c.intervalMin * 60000 / MAILER_SPEED; break;
      }
      finishIfDone(c);
    });
    if (changed) save();
    return changed;
  }
  function pauseCampaign(id) { const c = campaign(id); if (c && ['Sending', 'Scheduled'].includes(c.status)) { c.resumeTo = c.status; c.status = 'Paused'; c.pauseReason = 'Paused by ' + userName(db.currentUser || 'u1'); save(); } return c; }
  function resumeCampaign(id) { const c = campaign(id); if (c && c.status === 'Paused') { if (!accountFor(c.senderId)) throw new Error('The sender\'s mailbox is not connected.'); c.status = c.resumeTo === 'Scheduled' && c.startAt && c.startAt > now() ? 'Scheduled' : 'Sending'; c.pauseReason = null; c.nextAtMs = Date.now(); save(); } return c; }
  function startCampaignNow(id) { const c = campaign(id); if (c && c.status === 'Scheduled') { c.startAt = null; c.status = 'Sending'; c.nextAtMs = Date.now(); save(); } return c; }
  function cancelCampaign(id) { const c = campaign(id); if (c && ['Sending', 'Scheduled', 'Paused'].includes(c.status)) { c.recipients.filter((r) => r.status === 'Queued').forEach((r) => { r.status = 'Skipped'; r.error = 'Campaign cancelled'; }); c.status = 'Cancelled'; c.completedAt = now(); c.cancelledBy = db.currentUser || 'u1'; save(); } return c; }
  /* Opt-out: blocks the mailer for this lead and stamps the contact as unsubscribed. */
  function setDoNotEmail(leadId, on) { const l = lead(leadId); if (!l) return; if (!!l.doNotEmail === !!on) return; l.doNotEmail = !!on; const ct = contact(l.contactId); if (ct) ct.unsubscribedAt = on ? now() : null; addActivity(leadId, 'note', on ? 'Marked do not email' : 'Do not email removed', on ? 'The mailer will skip this lead.' : 'The mailer may email this lead again.'); save(); }

  /* ---------- quotations ---------- */
  function quoteTotals(q) {
    let sub = 0, disc = 0;
    q.lines.forEach((l) => { const gross = l.qty * l.price; sub += gross; disc += gross * (l.discount || 0) / 100; });
    const overall = (sub - disc) * (q.overallDiscount || 0) / 100; const net = sub - disc - overall; const tax = net * (q.taxRate || 0) / 100;
    return { sub, disc, overall, net, tax, total: net + tax };
  }
  function createQuote(data) { data = cleanQuotePatch(data || {}); const q = Object.assign({ id: nextId('quote'), ownerId: db.currentUser || 'u1', date: today(), validUntil: addDays(today(), 30), status: 'Draft', revision: 1, currency: 'GBP', taxRate: db.config.taxRate, overallDiscount: 0, lines: [{ id: 'l1', item: 'Consulting services', desc: '', qty: 1, unit: 'project', price: 0, discount: 0 }], notes: 'Payment: 40% on acceptance, 40% at milestone, 20% on completion. Prices exclude VAT where applicable.', revisions: [], history: [{ at: now(), text: 'Draft created by ' + userName(db.currentUser || 'u1') }] }, data); db.quotes.unshift(q); if (q.leadId) addActivity(q.leadId, 'quote', 'Quotation drafted · ' + q.id, q.subject || ''); save(); return q; }
  /* Quantities and prices cannot go negative; discounts and tax are percentages between 0 and 100. */
  const clampNum = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
  function cleanQuotePatch(patch) {
    const p = Object.assign({}, patch);
    if (p.lines) p.lines = p.lines.map((l) => Object.assign({}, l, { qty: clampNum(l.qty, 0, 1e9), price: clampNum(l.price, 0, 1e12), discount: clampNum(l.discount, 0, 100) }));
    if (p.overallDiscount !== undefined) p.overallDiscount = clampNum(p.overallDiscount, 0, 100);
    if (p.taxRate !== undefined) p.taxRate = clampNum(p.taxRate, 0, 100);
    return p;
  }
  const QUOTE_LOCKED = ['Accepted', 'Rejected', 'Expired'];
  function updateQuote(id, patch) { const q = by(db.quotes, id); if (QUOTE_LOCKED.includes(q.status)) return q; patch = cleanQuotePatch(patch); if (['Sent', 'Negotiating'].includes(q.status) && (patch.lines || patch.overallDiscount !== undefined)) { if (!q.editingNewRevision) { q.editingNewRevision = true; q.revision += 1; q.history.push({ at: now(), text: 'Revision ' + q.revision + ' opened for editing' }); } } Object.assign(q, patch); save(); return q; }
  function sendQuote(id) { const q = by(db.quotes, id); const to = (contact(q.contactId) || {}).email; if (!to) throw new Error('Choose a contact with an email address before sending.'); if (QUOTE_LOCKED.includes(q.status)) throw new Error('This quotation is ' + q.status + ' and can no longer be sent.'); const t = quoteTotals(q); q.revisions.push({ rev: q.revision, at: now(), total: t.total, note: 'Sent by email as PDF', lines: q.lines.length }); q.status = q.status === 'Negotiating' ? 'Negotiating' : 'Sent'; q.editingNewRevision = false; q.history.push({ at: now(), text: 'Sent · rev ' + q.revision + ' · emailed as PDF to ' + (contactName(q.contactId) || 'contact') }); const l = lead(q.leadId); if (l) { if (['New', 'Not Contacted', 'Contacted', 'Interested', 'Qualified'].includes(l.status)) updateLead(l.id, { status: 'Proposal Sent' }); addActivity(l.id, 'quote', 'Quotation sent · ' + q.id + ' rev ' + q.revision, fmtMoney(t.total, q.currency)); } sendEmail({ to, subject: 'Quotation ' + q.id + ' · ' + q.subject, body: 'Please find attached quotation ' + q.id + ' (revision ' + q.revision + '), valid until ' + q.validUntil + '.', leadId: q.leadId, contactId: q.contactId, companyId: q.companyId }); save(); return q; }
  function setQuoteStatus(id, status) { const q = by(db.quotes, id); q.status = status; q.history.push({ at: now(), text: status + ' · by ' + userName(db.currentUser || 'u1') }); const l = lead(q.leadId); if (status === 'Accepted' && l) { updateLead(l.id, { status: 'Won' }); const c = company(q.companyId); if (c) c.isClient = true; notify(q.ownerId, 'Quotation accepted · ' + q.id + ' · ' + fmtMoney(quoteTotals(q).total, q.currency), 'Convert to project?', '#/quotes/' + id); } if (status === 'Rejected' && l) updateLead(l.id, { status: 'Lost' }); save(); return q; }
  function convertQuote(id) { const q = by(db.quotes, id); if (q.projectId) return by(db.projects, q.projectId); if (q.status !== 'Accepted') throw new Error('Only an accepted quotation can become a project.'); const p = createProject({ companyId: q.companyId, leadId: q.leadId, quoteId: id, name: q.subject, value: quoteTotals(q).total, currency: q.currency, managerId: q.ownerId }); q.projectId = p.id; q.history.push({ at: now(), text: 'Converted to project ' + p.id }); const l = lead(q.leadId); if (l) { l.convertedTo = 'project'; addActivity(l.id, 'status', 'Converted to project ' + p.id, 'From accepted quotation ' + id + '. No duplicate company record.'); } save(); return p; }
  function fmtMoney(n, cur) { return (cur || 'GBP') + ' ' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  /* ---------- queries ---------- */
  const counts = {
    leads: () => db.leads.filter((l) => !l.archived).length,
    overdue: (uid) => db.tasks.filter((t) => isOverdue(t) && (!uid || t.assignedTo === uid)).length,
    newEnquiries: () => db.enquiries.filter((e) => ['Received', 'Enrichment pending', 'Enrichment processing', 'Needs review'].includes(e.status)).length,
    unread: () => db.emails.filter((e) => e.unread && e.folder === 'inbox').length, // team inbox in the prototype; the real build scopes this to the user's mailbox,
    notifications: (uid) => db.notifications.filter((n) => n.userId === uid && !n.read).length,
  };
  function setUser(id) { db.currentUser = id; save(); }
  function currentUser() { return user(db.currentUser || 'u1'); }

  return { get db() { return db; }, uid, safeUrl, save, reset, onChange, now, today, addDays, user, userName, company, contact, contactName, lead, domainOf, norm, isOverdue, isToday,
    matchCompany, matchCompanyWithCountry, matchContact, allocate, notify,
    createCompany, createContact, updateContact, updateCompany, createLead, updateLead, transferLead, logActivity, saveResearch, logCall, cloneLead, convertLead, submitEnquiry, resolveEnquiry,
    runEnrichment, decideSuggestion, verifyField, verifyAll, toggleTask, createTask, sendEmail, linkEmail, markRead, createEvent,
    quoteTotals, createQuote, updateQuote, sendQuote, setQuoteStatus, convertQuote, fmtMoney, counts, setUser, currentUser, createProject, updateProject, projectsFor, primaryStakeholders, accountFor, connectMailbox, disconnectMailbox, updateMailbox, syncMailbox, addTemplate, updateTemplate, removeTemplate, templatesFor, fillTemplate, setLang, setPrefs, createFollowUp, markNotification, markAllNotifications, mailBlock, mailerCheck, createCampaign, campaign, campaignStats, campaignTick, pauseCampaign, resumeCampaign, startCampaignNow, cancelCampaign, setDoNotEmail, MAILER_SPEED, WORK_HOURS };
})();
