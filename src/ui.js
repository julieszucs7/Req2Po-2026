(function(){
'use strict';
const R = Req2PO, S = Req2POSamples, usd = R.usd, I = R.ISSUES;
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const val = sel => { const e = $(sel); return e ? e.value : ''; };
const TODAY = '2026-10-30';
const ROLES = { clerk: { name: 'AP clerk', role: 'clerk' }, pm1: { name: 'Priya Raman', role: 'pm' }, pm2: { name: 'Marcus Webb', role: 'pm' } };
const PMS = ['Priya Raman', 'Marcus Webb'];
const TABS = ['overview', 'inbox', 'review', 'issues', 'requisition', 'statements', 'erp'];
const time = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
let wf, draft, who = ROLES.clerk, selMail = null, asOf = Date.now(), sample = null, errs = {}, fdraft = {};

function reset(){
  wf = new R.Workflow({ today: TODAY });
  draft = { text: '', quote: null, source: '' };
  selMail = null; errs = {}; fdraft = {}; asOf = Date.now();
  $('#glitch').checked = false;
  populate();
  $('#quote-text').value = ''; $('#quote-read').innerHTML = ''; $('#req-outcome').innerHTML = ''; $('#scn-blurb').textContent = '';
  clearForm();
  renderAll();
}
function route(){
  const h = (location.hash || '#overview').slice(1);
  const tab = TABS.indexOf(h) >= 0 ? h : 'overview';
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + tab));
  $$('nav.tabs a').forEach(a => { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
window.addEventListener('hashchange', route);

/* ---------- form setup ---------- */
function populate(){
  $('#vendorlist').innerHTML = $('#vendorlist2').innerHTML = wf.erp.vendors.map(v => '<option value="' + esc(v.name) + '">').join('');
  $('#f-job').innerHTML = '<option value="">Choose</option>' + wf.erp.jobs.map(j => '<option value="' + j.id + '">' + esc(j.id + '  ' + j.name + (j.status !== 'open' ? '  (closed)' : '')) + '</option>').join('');
  $('#f-cc').innerHTML = '<option value="">Choose</option>' + wf.erp.costCodes.map(c => '<option value="' + c.code + '">' + esc(c.code + '  ' + c.desc) + '</option>').join('');
  $('#f-cat').innerHTML = '<option value="">Choose</option>' + Object.keys(R.CATEGORIES).map(k => '<option value="' + k + '">' + R.CATEGORIES[k] + '</option>').join('');
  $('#scn').innerHTML = S.scenarios.map(s => '<button type="button" class="small-btn" data-scn="' + s.id + '">' + esc(s.label) + '</button>').join('');
  $('#f-pclass').innerHTML = Object.keys(R.PCLASS).map(k => '<option value="' + k + '">' + esc(R.PCLASS[k].label) + '</option>').join('');
  syncClass();
}
/* The kind of purchase decides which half of the form applies: a job purchase
   is coded by job and cost code, anything else by what is being bought. */
function syncClass(){
  const cls = $('#f-pclass').value || 'job';
  $('#pclass-hint').textContent = R.PCLASS[cls] ? R.PCLASS[cls].hint : '';
  $$('#reqform [data-cls]').forEach(el => { el.hidden = el.dataset.cls.split(' ').indexOf(cls) < 0; });
  const types = R.PTYPES.filter(t => t.cls === cls);
  const cur = $('#f-ptype').value;
  $('#f-ptype').innerHTML = '<option value="">Choose</option>' + types.map(t => '<option value="' + t.id + '">' + esc(t.label) + (t.capital ? ' — may be capital' : '') + (t.periodic ? ' — may cover a period' : '') + '</option>').join('');
  if (types.some(t => t.id === cur)) $('#f-ptype').value = cur;
  syncPtype();
}
function syncPtype(){
  const t = R.ptypeById($('#f-ptype').value);
  const cls = $('#f-pclass').value || 'job';
  $('#wrap-other').hidden = cls === 'job' || !t || !t.needsReason;
}
function readForm(){
  const cls = $('#f-pclass').value || 'job', isJob = cls === 'job';
  return { vendorName: $('#f-vendor').value.trim(), dateNeeded: $('#f-date').value, type: $('#f-type').value, subtype: $('#f-subtype').value.trim(),
    purchaseClass: cls, ptype: isJob ? '' : $('#f-ptype').value, otherReason: isJob ? '' : $('#f-other').value.trim(),
    coversMonths: isJob ? '' : $('#f-months').value,
    jobId: isJob ? $('#f-job').value : '', costCode: isJob ? $('#f-cc').value : '', category: isJob ? $('#f-cat').value : '',
    price: $('#f-price').value, notes: $('#f-notes').value.trim() };
}
function fillForm(f){
  $('#f-vendor').value = f.vendorName; $('#f-date').value = f.dateNeeded; $('#f-type').value = f.type; $('#f-subtype').value = f.subtype;
  $('#f-pclass').value = f.purchaseClass || 'job'; syncClass();
  $('#f-ptype').value = f.ptype || ''; syncPtype();
  $('#f-other').value = f.otherReason || ''; $('#f-months').value = f.coversMonths || '';
  $('#f-job').value = f.jobId; $('#f-cc').value = f.costCode; $('#f-cat').value = f.category; $('#f-price').value = f.price; $('#f-notes').value = f.notes || '';
}
function clearForm(){ fillForm({ vendorName:'', dateNeeded:'', type:'', subtype:'', purchaseClass:'job', ptype:'', otherReason:'', coversMonths:'', jobId:'', costCode:'', category:'', price:'', notes:'' }); }
document.addEventListener('change', e => {
  if (!e.target.id) return;
  if (e.target.id === 'f-pclass') syncClass();
  if (e.target.id === 'f-ptype') syncPtype();
});

function loadScenario(id){
  const s = S.scenarios.find(x => x.id === id); if (!s) return;
  fillForm(s.form);
  $('#quote-text').value = s.quote || '';
  draft = { text: s.quote || '', quote: null, source: '' };
  $('#scn-blurb').textContent = s.blurb;
  $('#req-outcome').innerHTML = '';
  if (s.quote) readQuote(false); else $('#quote-read').innerHTML = '<p class="muted small">No quote attached in this example.</p>';
}

/* ---------- quote reading ---------- */
function showQuote(q, source){
  if (!q) { $('#quote-read').innerHTML = ''; return; }
  const rows = q.lines.map(l => '<tr><td>' + esc(l.desc) + '</td><td class="r num">' + esc(l.qty) + ' ' + esc(l.unit) + '</td><td class="r num">' + usd(l.unitPrice) + '</td><td class="r num">' + usd(l.amount) + '</td></tr>').join('');
  $('#quote-read').innerHTML =
    '<div class="row" style="justify-content:space-between"><b>What the system read</b><span class="pill idle">' + esc(source) + '</span></div>' +
    '<p class="small muted" style="margin:4px 0 8px">' + esc(q.vendorName || 'Vendor not found') + (q.docNo ? ' · Quote ' + esc(q.docNo) : '') + (q.date ? ' · ' + q.date : '') + (q.validThrough ? ' · valid to ' + q.validThrough : '') + (q.jobId ? ' · job ' + esc(q.jobId) : '') + '</p>' +
    (q.lines.length ? '<div class="scroll"><table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="notice warn">No line items found. A reviewer would read this one by hand.</div>') +
    '<table style="margin-top:6px"><tbody><tr><td>Subtotal</td><td class="r num">' + usd(q.subtotal) + '</td></tr><tr><td>Tax' + (q.taxPct ? ' (' + q.taxPct + '%)' : '') + '</td><td class="r num">' + usd(q.tax) + '</td></tr><tr><td><b>Total</b></td><td class="r num"><b>' + usd(q.total) + '</b></td></tr></tbody></table>';
}
function readQuote(){
  const text = $('#quote-text').value;
  if (!text.trim()) { $('#quote-read').innerHTML = '<div class="notice warn">Paste quote text or choose a file first.</div>'; return; }
  draft.text = text; draft.quote = R.parseQuoteText(text); draft.source = 'Built-in reader';
  showQuote(draft.quote, draft.source);
}
const QUOTE_PROMPT = 'Extract this vendor quote into JSON. Return ONLY a JSON object with keys: vendorName (string), docNo (string), date (YYYY-MM-DD or null), validThrough (YYYY-MM-DD or null), jobId (like 24-101, or null), lines (array of {desc, qty, unit, unitPrice, amount}), subtotal, tax, total (numbers, or null if absent). Copy numbers exactly as printed. Do not correct, calculate or infer anything that is not printed.\n\nQuote text:\n"""\n';
const INVOICE_PROMPT = 'Extract this vendor invoice into JSON. Return ONLY a JSON object with keys: vendorName (string), invoiceNo (string), date (YYYY-MM-DD or null), poRef (the purchase order number printed on the invoice, or null), jobId (like 24-101, or null), lines (array of {desc, qty, unit, unitPrice, amount}), subtotal, tax, freight, total (numbers, or null if absent). Copy numbers exactly as printed. Do not correct, calculate or infer anything that is not printed. If there is no PO number, poRef must be null.\n\nInvoice text:\n"""\n';
function cleanDoc(o){
  const n = v => (v === null || v === undefined || v === '') ? null : R.pm(v);
  return { vendorName: String(o.vendorName || ''), docNo: String(o.docNo || ''), invoiceNo: String(o.invoiceNo || ''), date: R.isoDate(o.date), validThrough: R.isoDate(o.validThrough),
    jobId: o.jobId || null, poRef: o.poRef ? String(o.poRef).toUpperCase() : null, project: '', taxPct: null,
    lines: (Array.isArray(o.lines) ? o.lines : []).map(l => ({ desc: String(l.desc || ''), qty: n(l.qty) || 0, unit: String(l.unit || ''), unitPrice: n(l.unitPrice) || 0, amount: n(l.amount) || 0 })),
    subtotal: n(o.subtotal), tax: n(o.tax), freight: n(o.freight), total: n(o.total) };
}
async function claudeExtract(prompt, text){
  const out = await sample.json(prompt + text + '\n"""');
  return cleanDoc(out);
}
async function readQuoteClaude(){
  const text = $('#quote-text').value;
  if (!text.trim()) { $('#quote-read').innerHTML = '<div class="notice warn">Paste quote text or choose a file first.</div>'; return; }
  $('#quote-read').innerHTML = '<p class="muted small">Reading with Claude…</p>';
  try {
    draft.text = text; draft.quote = await claudeExtract(QUOTE_PROMPT, text); draft.source = 'Read by Claude';
    showQuote(draft.quote, draft.source);
  } catch (e) {
    $('#quote-read').innerHTML = '<div class="notice warn">Claude could not read this one (' + esc((e && e.message) || 'unavailable') + '). Using the built-in reader instead.</div>';
    draft.quote = R.parseQuoteText(text); draft.source = 'Built-in reader';
    $('#quote-read').insertAdjacentHTML('beforeend', '<div style="margin-top:12px"></div>');
    const holder = document.createElement('div'); $('#quote-read').appendChild(holder);
    const keep = $('#quote-read').innerHTML; showQuote(draft.quote, draft.source); $('#quote-read').insertAdjacentHTML('afterbegin', keep);
  }
}

/* ---------- flags / outcome rendering ---------- */
function flagsHTML(flags){
  return flags.map(f => '<div class="flag"><span class="code">' + esc(f.code) + '</span><div>' + esc(f.msg) + '</div><div class="fix">' + esc(f.fix) + '</div></div>').join('');
}
function currentQuote(){
  const text = $('#quote-text').value;
  if (!text.trim()) return null;
  if (!draft.quote || draft.text !== text) { draft.text = text; draft.quote = R.parseQuoteText(text); draft.source = 'Built-in reader'; showQuote(draft.quote, draft.source); }
  return draft.quote;
}
function errorsHTML(errs){
  return '<div class="notice bad"><b>Fix these before submitting</b><ul>' + errs.map(e => '<li>' + esc(e.msg) + '</li>').join('') + '</ul></div>';
}
$('#reqform').addEventListener('submit', e => {
  e.preventDefault();
  const res = wf.submitRequisition(readForm(), currentQuote());
  const out = $('#req-outcome');
  if (!res.ok) { out.innerHTML = errorsHTML(res.errors); }
  else if (res.req.status === 'po_created') {
    const po = wf.erp.getPO(res.req.poNumber);
    out.innerHTML = '<div class="notice ok"><b>' + esc(res.req.id) + ' passed every check. The bot created ' + esc(po.number) + '.</b>' +
      '<div class="small" style="margin-top:6px">' + esc(res.req.vendorName) + ' · job ' + esc(po.jobId) + ' · cost code ' + esc(po.coding.costCode) + ' · GL ' + esc(po.coding.gl) + '<br>Subtotal ' + usd(po.subtotal) + ' + tax ' + usd(po.tax) + ' = <b>' + usd(po.total) + '</b>. The ERP assigned the PO number and it was written back to the requisition.</div></div>';
  } else {
    out.innerHTML = '<div class="notice warn"><b>' + esc(res.req.id) + ' went to the reviewer.</b> No PO has been written yet.' + flagsHTML(res.req.flags) + '<div class="small" style="margin-top:8px"><a href="#queue">Open the reviewer queue</a></div></div>';
  }
  renderAll();
});
$('#precheck').addEventListener('click', () => {
  const v = R.validateRequisition(readForm(), currentQuote(), wf);
  const out = $('#req-outcome');
  if (v.errors.length) out.innerHTML = errorsHTML(v.errors);
  else if (!v.flags.length) out.innerHTML = '<div class="notice ok"><b>No flags.</b> This would go straight to the bot. Total with tax: ' + usd(v.amounts.total) + '.</div>';
  else out.innerHTML = '<div class="notice warn"><b>This would go to the reviewer.</b>' + flagsHTML(v.flags) + '</div>';
});
$('#read-quote').addEventListener('click', readQuote);
$('#read-claude').addEventListener('click', readQuoteClaude);
$('#quote-file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { $('#quote-text').value = String(r.result); readQuote(); }; r.readAsText(f);
});
$('#quote-text').addEventListener('input', () => { draft.quote = null; });


/* ====================== Phase 2: requisition review queue ====================== */
function flagsListHTML(flags){ return flagsHTML(flags); }
function renderReqQueue(){
  const reqs = wf.reqs.filter(r => r.status === 'needs_review');
  const done = wf.reqs.filter(r => r.status !== 'needs_review');
  let h = '';
  if (!reqs.length) h += '<div class="card"><p class="muted">Nothing waiting. Submit a requisition with a problem to see it here.</p></div>';
  reqs.forEach(r => {
    const newV = r.flags.some(f => f.code === 'NEW_VENDOR');
    h += '<div class="card"><div class="row" style="justify-content:space-between"><div><b>' + esc(r.id) + '</b> · ' + esc(r.vendorName) + '<div class="small muted">' + esc(reqWhere(r)) + '</div></div><div class="num"><b>' + usd(r.amounts.total) + '</b></div></div>' +
      '<div style="margin-top:8px">' + flagsListHTML(r.flags) + '</div>' +
      '<label for="note-' + r.id + '" style="margin-top:10px">Reviewer note (required to approve with flags)</label><input id="note-' + r.id + '">' +
      '<div class="inline-err" id="err-' + r.id + '"></div>' +
      '<div class="row" style="margin-top:10px">' +
      (newV ? '<button class="small-btn" data-act="rq-addvendor" data-id="' + r.id + '" type="button">Add vendor to master (demo)</button>' : '') +
      '<button class="primary small-btn" data-act="rq-approve" data-id="' + r.id + '" type="button">Approve and create PO</button>' +
      '<button class="small-btn" data-act="rq-return" data-id="' + r.id + '" type="button">Return to requester</button>' +
      '<button class="small-btn" data-act="rq-reject" data-id="' + r.id + '" type="button">Reject</button></div></div>';
  });
  if (done.length) h += '<h3 style="margin:20px 0 8px">Resolved</h3><div class="card">' + done.slice(0, 12).map(r => '<div class="row" style="justify-content:space-between;padding:4px 0"><span class="small">' + esc(r.id + ' · ' + r.vendorName + ' · ' + usd(r.amounts.total)) + '</span><span class="pill ' + (r.status === 'po_created' ? 'ok' : 'idle') + '">' + esc(r.status === 'po_created' ? 'PO ' + r.poNumber : r.status) + '</span></div>').join('') + '</div>';
  $('#req-queue').innerHTML = h;
}
$('#req-queue').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act, note = val('#note-' + id);
  if (act === 'rq-addvendor') {
    const r = wf.reqs.find(x => x.id === id);
    const nv = { id: 'V' + (100 + wf.erp.vendors.length), name: r.form.vendorName, aliases: [], emails: [], folder: 'AP/Vendors/' + r.form.vendorName, types: [r.form.type], terms: 'Net 30' };
    wf.erp.vendors.push(nv); r.vendorId = nv.id; r.vendorName = nv.name; r.flags = r.flags.filter(f => f.code !== 'NEW_VENDOR');
    wf.log('Reviewer', 'Added vendor to master (W-9 on file)', r.id, nv.name); populate(); renderAll(); return;
  }
  if (act === 'rq-approve') {
    const r = wf.reqs.find(x => x.id === id);
    if (!r.vendorId) { $('#err-' + id).textContent = 'Add the vendor to the master first.'; return; }
    if (r.flags.length && !note.trim()) { $('#err-' + id).textContent = 'Add a note. Approvals with open flags are logged.'; return; }
    wf.approveRequisition(id, note);
  }
  if (act === 'rq-return') wf.returnRequisition(id, note);
  if (act === 'rq-reject') wf.rejectRequisition(id, note);
  renderAll();
});

/* ====================== Phase 1: shared helpers ====================== */
const TYPE = { invoice: ['ok', 'Invoice'], statement: ['idle', 'Statement'], reminder: ['warn', 'Payment reminder'], correspondence: ['idle', 'Correspondence'] };
const typePill = t => '<span class="pill ' + TYPE[t][0] + '">' + TYPE[t][1] + '</span>';
const STATUS = { awaiting_review: ['warn', 'Ready for review'], reportable: ['bad', 'Issues to report'], reported: ['warn', 'With owner'], owner_responded: ['ok', 'Owner answered'], on_hold: ['bad', 'On hold'],
  awaiting_pm_approval: ['warn', 'Awaiting PM approval'], approved: ['ok', 'Approved'], rejected: ['bad', 'Do not pay'], closed: ['idle', 'Closed'] };
const statusPill = r => '<span class="pill ' + STATUS[r.status][0] + '">' + STATUS[r.status][1] + '</span>';
const errBox = id => '<div class="inline-err">' + esc(errs[id] || '') + '</div>';
const sect = (title, n, sub) => '<div class="sect"><h3>' + esc(title) + '</h3><span class="pill idle">' + n + '</span>' + (sub ? '<span class="small muted">' + esc(sub) + '</span>' : '') + '</div>';
function stepList(steps){
  return '<div class="pipe">' + steps.map(s => '<div class="s ' + (s.ok ? 'ok' : 'bad') + '">' + (s.ok ? '✓ ' : '✗ ') + esc(s.name) + '</div>').join('') + '</div>' +
    steps.map(s => '<div class="stepdetail"><b>' + esc(s.name) + '</b> ' + esc(s.detail) + '</div>').join('');
}
function ownerSelect(id, def){
  const list = PMS.concat(['Vendor setup (Purchasing)', 'AP clerk']);
  if (def && list.indexOf(def) < 0) list.unshift(def);
  return '<select id="' + id + '">' + list.map(o => '<option' + (o === def ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
}
function head(r){
  const pg = r.multi ? 'pages ' + r.seg.start + (r.seg.end > r.seg.start ? '-' + r.seg.end : '') + ' of the PDF · ' : '';
  return '<div class="hd"><div><b>' + esc(r.invoice.vendorName || '?') + '</b> · invoice ' + esc(r.invoice.invoiceNo || '?') +
    '<div class="small muted">' + esc(r.id) + ' · ' + esc(r.email.subject) + ' · ' + pg + (r.source === 'manual' ? 'manual entry · ' : '') + (r.po ? esc(r.po.number) : 'no PO matched') + '</div></div>' +
    '<div style="text-align:right"><div class="num"><b>' + usd(r.invoice.total) + '</b></div>' + statusPill(r) + '</div></div>';
}
function cmpTable(r){
  if (!r.comparison.length) {
    const sug = r.suggestions[0];
    return '<p class="small muted">No PO is matched yet, so there is nothing to compare.' + (sug ? ' Closest open PO for this vendor: ' + esc(sug.number) + ' (' + usd(R.poRemaining(sug).total) + ' left).' : '') + '</p>';
  }
  return '<div class="scroll"><table class="cmp"><thead><tr><th>Field</th><th>Purchase order (ERP)</th><th>Invoice</th><th></th></tr></thead><tbody>' +
    r.comparison.map(c => '<tr class="' + c.status + '"><td class="f">' + esc(c.field) + '</td><td>' + esc(c.po) + '</td><td>' + esc(c.inv) + '</td><td>' +
      (c.status === 'match' ? '<span class="pill ok">Match</span>' : (c.status === 'mismatch' ? '<span class="pill bad">Does not match</span>' : '')) + '</td></tr>').join('') + '</tbody></table></div>';
}
function checksBlock(r, open){
  const pass = r.checks.filter(c => c.ok).length;
  return '<details' + (open ? ' open' : '') + '><summary>' + pass + ' of ' + r.checks.length + ' checks passed</summary><div class="scroll"><table><tbody>' +
    r.checks.map(c => '<tr><td>' + (c.ok ? '<span class="pill ok">' + (c.accepted ? 'Accepted' : 'Pass') + '</span>' : '<span class="pill bad">Fail</span>') + '</td><td>' + esc(c.label) + '</td><td class="small">' + esc(c.detail) + '</td></tr>').join('') + '</tbody></table></div></details>';
}
function reasonsBlock(r){
  if (r.stale) return '<div class="reason"><b>Nothing fails the checks any more.</b><div class="small">The PO data has changed since this was reported. Re-run the checks to clear it.</div></div>';
  return r.reasons.map(x => '<div class="reason"><span class="code">' + esc(x.id) + '</span> <b>' + esc(x.label) + '</b><div class="small">' + esc(x.detail) + '</div></div>').join('');
}
function poDoc(po){
  if (!po) return '';
  const rem = R.poRemaining(po), v = wf.erp.getVendor(po.vendorId) || {}, job = wf.erp.getJob(po.jobId) || {};
  return '<details><summary>Purchase order ' + esc(po.number) + '</summary><div class="small" style="margin:8px 0"><b>' + esc(po.number) + '</b> · ' + esc(v.name) + ' (' + esc(po.vendorId) + ') · job ' + esc(po.jobId) + ' ' + esc(job.name) +
    ' · purchaser ' + esc(po.purchaser) + ' · created ' + esc(po.createdDate) + ' · cost code ' + esc(po.coding.costCode) + ' · GL ' + esc(po.coding.gl) + '</div>' +
    '<div class="scroll"><table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>' + po.lines.map(l => '<tr><td>' + esc(l.desc) + '</td><td class="r num">' + esc(l.qty) + ' ' + esc(l.unit) + '</td><td class="r num">' + usd(l.amount) + '</td></tr>').join('') + '</tbody></table></div>' +
    '<table style="margin-top:6px"><thead><tr><th></th><th class="r">PO</th><th class="r">Billed</th><th class="r">Left</th></tr></thead><tbody>' +
    '<tr><td>Subtotal</td><td class="r num">' + usd(po.subtotal) + '</td><td class="r num">' + usd(po.billedSub) + '</td><td class="r num">' + usd(rem.sub) + '</td></tr>' +
    '<tr><td>Sales tax</td><td class="r num">' + usd(po.tax) + '</td><td class="r num">' + usd(po.billedTax) + '</td><td class="r num">' + usd(rem.tax) + '</td></tr>' +
    '<tr><td>Freight</td><td class="r num">' + usd(po.freight || 0) + '</td><td class="r num">' + usd(po.billedFreight) + '</td><td class="r num">' + usd(rem.freight) + '</td></tr>' +
    '<tr><td><b>Total</b></td><td class="r num"><b>' + usd(po.total) + '</b></td><td class="r num">' + usd(po.billed) + '</td><td class="r num"><b>' + usd(rem.total) + '</b></td></tr></tbody></table>' +
    (po.changes ? '<p class="small" style="margin-top:8px"><b>Changes</b></p>' + po.changes.map(c => '<div class="small">' + esc(c.by) + ' · ' + time(c.at) + ' · ' + usd(c.before.total) + ' → ' + usd(c.after.total) + ' · ' + esc(c.reason) + '</div>').join('') : '') + '</details>';
}
const invDoc = r => '<details><summary>Invoice PDF as received' + (r.multi ? ' (pages ' + r.seg.start + ' to ' + r.seg.end + ')' : '') + '</summary><pre>' + esc(r.pageText) + '</pre></details>';
function jeTable(je){
  return '<div class="scroll"><table><thead><tr><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>' + je.lines.map(l => '<tr><td>' + esc(l.acct + ' ' + l.name) + '<div class="small muted">' + (l.job ? 'Job ' + esc(l.job) + ' · ' + esc(l.costCode) : esc(l.vendor)) + '</div></td><td class="r num">' + (l.dr ? usd(l.dr) : '') + '</td><td class="r num">' + (l.cr ? usd(l.cr) : '') + '</td></tr>').join('') + '</tbody></table></div>';
}

/* A job requisition is described by its job and cost code; an overhead or
   equipment one by what it is and where it codes. */
function reqWhere(r){
  if (!r.pclass || r.pclass === 'job') return 'Job ' + r.form.jobId + ' ' + r.jobName + ' · code ' + r.form.costCode + ' · ' + R.CATEGORIES[r.form.category];
  const t = r.treatment || {}, kind = t.kind === 'capital' ? 'capitalize' : (t.kind === 'prepaid' ? 'prepaid, ' + t.months + ' months' : 'expense');
  return R.PCLASS[r.pclass].label + (r.ptype ? ' · ' + r.ptype.label : '') + ' · ' + t.acct + ' ' + t.name + ' · ' + kind;
}

/* ====================== Phase 1: inbox ====================== */
const mailForEmail = id => wf.mails.find(m => m.email.id === id);
function mailRow(e, m){
  const att = e.attachment ? e.attachment.name : 'no attachment';
  return '<div class="mail' + (m && selMail === m.id ? ' sel' : '') + '"><div><div><b>' + esc(e.label || e.subject) + '</b></div><div class="sub">' + esc(e.from || 'keyed in') + ' · ' + esc(e.subject) + ' · ' + esc(att) + '</div></div><div class="row">' +
    (m ? typePill(m.docType) : '<span class="pill idle">Unread</span>') +
    (m && m.invoiceIds && m.invoiceIds.length > 1 ? '<span class="pill warn">Split into ' + m.invoiceIds.length + '</span>' : '') +
    (m ? '<button class="small-btn" data-open-mail="' + m.id + '" type="button">View</button>' : '<button class="small-btn" data-proc="' + e.id + '" type="button">Process</button>') + '</div></div>';
}
function renderInbox(){
  const added = wf.mails.filter(m => !S.emails.some(e => e.id === m.email.id));
  $('#inbox').innerHTML = S.emails.map(e => mailRow(e, mailForEmail(e.id))).join('') +
    (added.length ? '<div class="small muted" style="margin-top:12px">Added by you</div>' + added.map(m => mailRow(Object.assign({ label: m.email.subject }, m.email), m)).join('') : '');
  const m = wf.mails.find(x => x.id === selMail), box = $('#mail-detail');
  if (!m) { box.innerHTML = '<h3>What happened to this email</h3><p class="muted">Process an email to see how it was sorted, filed and read.</p>'; return; }
  let h = '<div class="row" style="justify-content:space-between"><h3 style="margin:0">' + esc(m.email.subject) + '</h3>' + typePill(m.docType) + '</div><div style="margin-top:12px">' + stepList(m.steps) + '</div>';
  if (m.libraryPath) h += '<p class="small" style="margin-top:10px">Saved to the document library: <span class="path">' + esc(m.libraryPath) + '</span></p>';
  const invs = wf.invoicesFor(m);
  invs.forEach(r => {
    h += '<div class="item"><div class="hd"><div><b>' + esc(r.invoice.invoiceNo || '?') + '</b> · ' + esc(r.invoice.vendorName) + '<div class="small muted">' + esc(r.id) + (r.multi ? ' · pages ' + r.seg.start + (r.seg.end > r.seg.start ? '-' + r.seg.end : '') : '') + '</div></div><div style="text-align:right"><div class="num"><b>' + usd(r.invoice.total) + '</b></div>' + statusPill(r) + '</div></div>' +
      '<div style="margin-top:10px">' + stepList(r.steps.filter(s => s.name !== 'Extract' || true)) + '</div>' +
      (r.reasons.length ? '<div style="margin-top:8px">' + r.reasons.map(x => '<span class="pill bad" title="' + esc(x.detail) + '">' + esc(x.label) + '</span> ').join('') + '</div>' : '') +
      '<p class="small" style="margin-top:10px">Library file: <span class="path">' + esc(r.libraryPath) + '</span></p>' +
      '<div class="row" style="margin-top:8px"><a href="#review"><button class="small-btn" type="button">Open in Review and entry</button></a></div></div>';
  });
  const fu = wf.followUps.find(f => f.mailId === m.id);
  if (fu) h += '<div class="' + (fu.needsAction ? 'sent' : 'resp') + '"><b>Follow-up ' + esc(fu.id) + '.</b> ' + esc(fu.note) + '</div>';
  if (m.docType === 'statement') h += '<div class="resp">Recognized as a statement. It is filed with the vendor and queued for <a href="#statements">Phase 3</a>. Nothing is entered.</div>';
  const pages = m.email.attachment ? (m.email.attachment.pages || [m.email.attachment.text]) : [];
  h += '<details style="margin-top:14px"><summary>Email as received</summary><pre>From: ' + esc(m.email.from || '(keyed in)') + '\nSubject: ' + esc(m.email.subject) + '\n' + (m.email.body ? '\n' + esc(m.email.body) + '\n' : '') + (m.email.attachment ? '\nAttachment: ' + esc(m.email.attachment.name) + '\n\n' + pages.map((p, i) => (pages.length > 1 ? '--- page ' + (i + 1) + ' ---\n' : '') + esc(p)).join('\n') : '') + '</pre></details>';
  box.innerHTML = h;
}
function processEmailObj(e){ const m = wf.processEmail(e); selMail = m.id; renderAll(); }
$('#inbox').addEventListener('click', e => {
  const p = e.target.closest('[data-proc]'), o = e.target.closest('[data-open-mail]');
  if (p) processEmailObj(S.emails.find(x => x.id === p.dataset.proc));
  if (o) { selMail = o.dataset.openMail; renderAll(); }
});
$('#proc-all').addEventListener('click', () => {
  let first = null;
  S.emails.forEach(e => { if (!mailForEmail(e.id)) { const m = wf.processEmail(e); if (!first) first = m.id; } });
  selMail = first || selMail; renderAll();
});
$('#manual-run').addEventListener('click', () => {
  const num = id => { const v = val(id); return v === '' ? null : Number(v); };
  const vendorName = val('#m-vendor').trim(), invoiceNo = val('#m-no').trim(), date = val('#m-date'), total = num('#m-tot');
  if (!vendorName || !invoiceNo || !date || total === null) { $('#manual-err').textContent = 'Vendor, invoice number, date and total are required.'; return; }
  $('#manual-err').textContent = '';
  processEmailObj({ id: 'manual-' + Date.now(), subject: 'Manual entry: ' + invoiceNo, from: '', manual: { vendorName: vendorName, invoiceNo: invoiceNo, date: date, poRef: val('#m-po').trim().toUpperCase() || null, jobId: val('#m-job').trim() || null, subtotal: num('#m-sub'), tax: num('#m-tax'), freight: num('#m-fr'), total: total, lines: [] } });
});
function runOwn(parsed){
  const text = val('#own-inv'); if (!text.trim()) return;
  const email = { id: 'own-' + Date.now(), subject: 'Pasted invoice', from: '', attachment: { name: 'pasted_invoice.pdf', text: text } };
  if (parsed) email.parsed = parsed;
  processEmailObj(email);
}
$('#own-run').addEventListener('click', () => runOwn(null));
$('#own-claude').addEventListener('click', async () => { try { runOwn(await claudeExtract(INVOICE_PROMPT, val('#own-inv'))); } catch (e) { runOwn(null); } });

/* ====================== Phase 1: review and entry ====================== */
function reportFound(r){
  const cats = Object.keys(I).filter(k => ['REVIEW_FOUND', 'ITEM_MISMATCH', 'JOB_MISMATCH', 'NO_PO', 'PO_SHORT', 'TAX_RATE', 'FREIGHT', 'DATE', 'MATH'].indexOf(k) >= 0);
  return '<details style="margin-top:10px"><summary>Report a problem I found in the PDFs</summary><div class="formgrid">' +
    '<div><label for="rf-cat-' + r.id + '">Category</label><select id="rf-cat-' + r.id + '">' + cats.map(k => '<option value="' + k + '">' + esc(I[k].label) + '</option>').join('') + '</select></div>' +
    '<div><label for="rf-own-' + r.id + '">Report to</label>' + ownerSelect('rf-own-' + r.id, r.po ? r.po.purchaser : PMS[0]) + '</div>' +
    '<div class="full"><label for="rf-note-' + r.id + '">What did you see?</label><input id="rf-note-' + r.id + '"></div></div>' +
    '<div class="row" style="margin-top:8px"><button class="small-btn" data-act="report-found" data-id="' + r.id + '" type="button">Report it</button></div></details>';
}
function clerkView(){
  const by = (...st) => wf.invoices.filter(r => st.indexOf(r.status) >= 0);
  let h = '';
  const A = by('awaiting_review');
  h += sect('Ready for your review', A.length, 'Check the invoice PDF against the PO. Nothing is entered until you send it to the bot.');
  A.forEach(r => { h += '<div class="item">' + head(r) + '<div style="margin-top:10px">' + cmpTable(r) + '</div><div style="margin-top:8px">' + checksBlock(r, false) + poDoc(r.po) + invDoc(r) + '</div>' +
    (r.note ? '<div class="sent">' + esc(r.note) + '</div>' : '') +
    '<div class="row" style="margin-top:12px"><button class="primary small-btn" data-act="verify" data-id="' + r.id + '" type="button">Verified: send to the bot</button><button class="small-btn" data-act="manual" data-id="' + r.id + '" type="button">Enter manually instead</button></div>' + reportFound(r) + errBox(r.id) + '</div>'; });
  if (!A.length) h += '<p class="muted small">Nothing waiting for review.</p>';
  const B = by('reportable');
  h += sect('Issues to report', B.length, 'These did not match. Report each one to the project manager or purchaser. You cannot change POs.');
  B.forEach(r => {
    const retry = r.manualReasons.some(x => x.id === 'ENTRY_FAILED');
    h += '<div class="item">' + head(r) + '<div style="margin-top:8px">' + reasonsBlock(r) + '</div>' + (r.note ? '<div class="sent">' + esc(r.note) + '</div>' : '') +
      '<div style="margin-top:10px">' + cmpTable(r) + '</div><div style="margin-top:8px">' + checksBlock(r, false) + poDoc(r.po) + invDoc(r) + '</div>' +
      '<div class="formgrid"><div><label for="own-' + r.id + '">Report to</label>' + ownerSelect('own-' + r.id, r.suggestedOwner) + '</div><div><label for="rn-' + r.id + '">Note for them</label><input id="rn-' + r.id + '" placeholder="What do you need from them?"></div></div>' +
      '<div class="row" style="margin-top:10px"><button class="primary small-btn" data-act="report" data-id="' + r.id + '" type="button">Report to owner</button>' +
      (retry ? '<button class="small-btn" data-act="rerun" data-id="' + r.id + '" type="button">Retry entry</button>' : '') +
      (r.reasons.some(x => x.id === 'DUPLICATE') ? '<button class="small-btn" data-act="close" data-reason="Duplicate invoice" data-id="' + r.id + '" type="button">Close as duplicate</button>' : '') + '</div>' + errBox(r.id) + '</div>';
  });
  if (!B.length) h += '<p class="muted small">No unreported issues.</p>';
  const C = by('reported', 'on_hold');
  h += sect('Waiting on others', C.length, 'Reported. The owner responds here, and you re-check once they have.');
  C.forEach(r => {
    h += '<div class="item">' + head(r) + '<div class="sent"><b>' + (r.status === 'on_hold' ? esc(r.hold) + '.' : 'Reported to ' + esc(r.assignment.to) + '.') + '</b> ' + (r.assignment.note ? esc(r.assignment.note) : '') +
      (r.status === 'on_hold' && r.assignment.response ? '<div class="small">' + esc(r.assignment.response.by) + ': ' + esc(r.assignment.response.reason) + '</div>' : '') + '</div>' +
      '<div style="margin-top:8px">' + reasonsBlock(r) + '</div><div class="row" style="margin-top:10px">' +
      (r.status === 'on_hold' ? '<button class="small-btn" data-act="close" data-reason="Handled with the vendor" data-id="' + r.id + '" type="button">Close this invoice</button>' : '') +
      '<button class="small-btn" data-act="try-edit" data-id="' + r.id + '" type="button">Try to change the PO myself (demo)</button></div>' + errBox(r.id) + '</div>';
  });
  if (!C.length) h += '<p class="muted small">Nothing waiting on others.</p>';
  const D = by('owner_responded');
  h += sect('Answered, ready to re-check', D.length, 'The owner has acted. Run the checks again.');
  D.forEach(r => { const rp = r.assignment.response; h += '<div class="item">' + head(r) + '<div class="resp"><b>' + esc(rp.label) + '</b><div class="small">' + esc(rp.reason) + ' (' + time(rp.at) + ')</div></div><div class="row" style="margin-top:10px"><button class="primary small-btn" data-act="rerun" data-id="' + r.id + '" type="button">Re-run checks</button></div>' + errBox(r.id) + '</div>'; });
  if (!D.length) h += '<p class="muted small">None.</p>';
  const E = by('awaiting_pm_approval');
  h += sect('Entered, waiting for PM approval', E.length, 'The PM sees the voucher with the PDF attached.');
  E.forEach(r => { h += '<div class="item">' + head(r) + '<p class="small" style="margin:8px 0"><b>' + esc(r.voucher) + '</b> · entered by ' + (r.entryMode === 'bot' ? 'the bot' : 'the clerk (manual entry)') + ' · read-back matched · PDF copy attached</p>' + jeTable(r.je) + '</div>'; });
  if (!E.length) h += '<p class="muted small">None.</p>';
  const F = by('approved', 'rejected', 'closed');
  if (F.length) h += sect('Finished', F.length) + '<div class="card">' + F.map(r => '<div class="row" style="justify-content:space-between;padding:4px 0"><span class="small">' + esc(r.id + ' · ' + r.invoice.vendorName + ' · ' + r.invoice.invoiceNo + ' · ' + usd(r.invoice.total)) + (r.voucher ? ' · ' + esc(r.voucher) + (r.entryMode === 'manual' ? ' (manual)' : '') : '') + '</span>' + statusPill(r) + '</div>').join('') + '</div>';
  return h;
}
function pmForm(r){
  const id = r.id, opts = [];
  /* Work the shortfall out from the PO balance as it stands right now, not from
     the finding stored at intake: another invoice may have been entered against
     the same PO since, so a stored number would send the PM to the wrong figure. */
  const rem = r.po ? R.poRemaining(r.po) : null;
  const short = rem ? Math.max(0, Math.round((r.invoice.subtotal - rem.sub) * 100) / 100) : 0;
  if (r.po) opts.push(['correct_po', 'Change the PO (add to the subtotal or freight)'], ['use_po', 'Confirm a different PO']); else opts.push(['use_po', 'Confirm which PO this invoice belongs to']);
  if (r.reasons.some(x => R.OVERRIDABLE[x.id])) opts.push(['valid_proceed', 'Accept the difference as valid']);
  if (r.manualReasons.some(x => x.id === 'REVIEW_FOUND' || x.id === 'PM_REJECTED')) opts.push(['fixed', 'Confirm it is correct']);
  opts.push(['dispute', 'Dispute with the vendor'], ['credit_memo', 'Ask for a corrected invoice or credit memo'], ['reject', 'Do not pay']);
  let pos = wf.erp.pos.filter(p => p.status === 'open' && (!r.vendor || p.vendorId === r.vendor.id));
  if (!pos.length) pos = wf.erp.pos.filter(p => p.status === 'open');
  pos.sort((a, b) => (r.suggestions.indexOf(b) >= 0) - (r.suggestions.indexOf(a) >= 0));
  return '<div class="pmform"><div class="formgrid"><div class="full"><label for="pm-act-' + id + '">Your response</label><select id="pm-act-' + id + '" data-pmact>' + opts.map(o => '<option value="' + o[0] + '">' + esc(o[1]) + '</option>').join('') + '</select></div>' +
    '<div data-show="correct_po"><label for="pm-sub-' + id + '">Add to PO subtotal' + (short ? ' (short by ' + usd(short) + ')' : '') + '</label><input id="pm-sub-' + id + '" type="number" step="0.01" min="0"' + (short ? ' value="' + short.toFixed(2) + '"' : '') + '><div class="small muted" style="margin-top:4px">Sales tax on the PO is recalculated at the job rate.</div></div>' +
    '<div data-show="correct_po"><label for="pm-fr-' + id + '">Add to PO freight</label><input id="pm-fr-' + id + '" type="number" step="0.01" min="0"></div>' +
    '<div class="full" data-show="use_po"><label for="pm-po-' + id + '">PO</label><select id="pm-po-' + id + '">' + pos.map(p => '<option value="' + p.number + '">' + esc(p.number + ' · job ' + p.jobId + ' · ' + usd(R.poRemaining(p).total) + ' left') + '</option>').join('') + '</select></div>' +
    '<div class="full"><label for="pm-reason-' + id + '">Reason (required, and logged with your sign-off)</label><textarea id="pm-reason-' + id + '" rows="2" style="font-family:var(--body);font-size:14px"></textarea></div></div>' +
    '<div class="row" style="margin-top:10px"><button class="primary small-btn" data-act="pm-respond" data-id="' + id + '" type="button">Sign off and send</button></div>' + errBox(id) + '</div>';
}
function pmView(){
  let h = '';
  const A = wf.invoices.filter(r => r.status === 'reported' && r.assignment.to === who.name);
  const others = wf.invoices.filter(r => r.status === 'reported' && r.assignment.to !== who.name).length;
  h += sect('Reported to you', A.length, 'Only you or the original purchaser can change a PO or accept a difference. Every response needs a reason.');
  A.forEach(r => { h += '<div class="item">' + head(r) + '<div class="sent"><b>From the AP clerk:</b> ' + (r.assignment.note ? esc(r.assignment.note) : 'No note.') + '</div><div style="margin-top:8px">' + reasonsBlock(r) + '</div><div style="margin-top:10px">' + cmpTable(r) + '</div><div style="margin-top:8px">' + poDoc(r.po) + invDoc(r) + '</div>' + pmForm(r) + '</div>'; });
  if (!A.length) h += '<p class="muted small">Nothing is waiting for you.' + (others ? ' ' + others + ' item' + (others > 1 ? 's are' : ' is') + ' reported to another project manager.' : '') + '</p>';
  const mine = r => { const j = r.invoice.jobId || (r.po && r.po.jobId); const job = j ? wf.erp.getJob(j) : null; return (job && job.pm === who.name) || (r.po && r.po.purchaser === who.name) || (!job && !(r.po && r.po.purchaser)); };
  const B = wf.invoices.filter(r => r.status === 'awaiting_pm_approval' && mine(r));
  const othersV = wf.invoices.filter(r => r.status === 'awaiting_pm_approval' && !mine(r)).length;
  h += sect('Vouchers waiting for your approval', B.length, 'Entered in the ERP with the invoice PDF attached.' + (othersV ? ' ' + othersV + ' more ' + (othersV > 1 ? 'are' : 'is') + ' waiting for another project manager.' : ''));
  B.forEach(r => { h += '<div class="item">' + head(r) + '<p class="small" style="margin:8px 0"><b>' + esc(r.voucher) + '</b> · entered by ' + (r.entryMode === 'bot' ? 'the bot' : 'the clerk (manual entry)') + ' · read-back matched</p>' + cmpTable(r) + '<div style="margin-top:8px">' + invDoc(r) + '</div><div style="margin-top:8px">' + jeTable(r.je) + '</div>' +
    '<div class="formgrid"><div class="full"><label for="pa-' + r.id + '">Note or reason (required to reject)</label><input id="pa-' + r.id + '"></div></div>' +
    '<div class="row" style="margin-top:10px"><button class="primary small-btn" data-act="pm-approve" data-id="' + r.id + '" type="button">Approve</button><button class="small-btn" data-act="pm-reject" data-id="' + r.id + '" type="button">Reject and void</button></div>' + errBox(r.id) + '</div>'; });
  if (!B.length) h += '<p class="muted small">None.</p>';
  return h;
}
function renderReview(){
  wf.refreshView();   // always compare against the PO balance as it stands now
  $('#review').innerHTML = '<div class="notice" style="margin-bottom:6px"><b>' + (who.role === 'pm' ? 'Project manager view: ' + esc(who.name) : 'AP clerk view') + '.</b> ' +
    (who.role === 'pm' ? 'You resolve what the invoice team reports, and approve vouchers. Use "Viewing as" at the top to switch roles.' : 'You verify, report and process. You do not change POs. Use "Viewing as" at the top to switch roles.') + '</div>' + (who.role === 'pm' ? pmView() : clerkView());
  restoreDraft();
  $$('.pmform').forEach(pmSync);
}
/* Keep what a person typed when a validation error re-renders the view:
   a missing reason should not wipe the amount they already entered. */
function restoreDraft(){
  Object.keys(fdraft).forEach(id => { const e = $('#' + id, $('#review')); if (e) e.value = fdraft[id]; else delete fdraft[id]; });
}
function clearDraft(id){ Object.keys(fdraft).forEach(k => { if (k.slice(-(id.length + 1)) === '-' + id) delete fdraft[k]; }); }
$('#review').addEventListener('input', e => { if (e.target.id) fdraft[e.target.id] = e.target.value; });
$('#review').addEventListener('change', e => { if (e.target.id) fdraft[e.target.id] = e.target.value; });
function pmSync(form){
  if (!form) return;
  const sel = $('select[data-pmact]', form);
  if (!sel) return;
  const act = val('#' + sel.id);
  $$('[data-show]', form).forEach(el => { el.hidden = el.dataset.show.split(' ').indexOf(act) < 0; });
}
document.addEventListener('change', e => { if (e.target.matches && e.target.matches('select[data-pmact]')) pmSync(e.target.closest('.pmform')); });
$('#review').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act; errs[id] = '';
  try {
    if (act === 'verify') wf.reviewerVerify(id);
    else if (act === 'manual') wf.enterManually(id);
    else if (act === 'report') wf.reportToOwner(id, val('#own-' + id), val('#rn-' + id));
    else if (act === 'report-found') wf.reportIssue(id, val('#rf-cat-' + id), val('#rf-own-' + id), val('#rf-note-' + id));
    else if (act === 'rerun') wf.rerun(id);
    else if (act === 'close') wf.closeInvoice(id, b.dataset.reason);
    else if (act === 'try-edit') wf.ownerRespond(id, 'correct_po', 'Trying as the clerk', who, { addSubtotal: 1 });
    else if (act === 'pm-respond') wf.ownerRespond(id, val('#pm-act-' + id), val('#pm-reason-' + id), who, { addSubtotal: val('#pm-sub-' + id), addFreight: val('#pm-fr-' + id), poNumber: val('#pm-po-' + id) });
    else if (act === 'pm-approve') wf.pmApprove(id, who, val('#pa-' + id));
    else if (act === 'pm-reject') wf.pmReject(id, who, val('#pa-' + id));
    clearDraft(id);
  } catch (err) { errs[id] = err.message; }
  renderAll();
});
$('#glitch').addEventListener('change', e => { wf.glitch = e.target.checked; });
function setAsOf(){ $$('.asof').forEach(e => { e.textContent = time(asOf); }); }
document.addEventListener('click', e => { if (e.target.closest('[data-act="refresh"]')) { asOf = Date.now(); setAsOf(); } });
setInterval(() => { asOf = Date.now(); setAsOf(); }, 300000);

/* ====================== Phase 1: issues and log ====================== */
function renderIssues(){
  const s = wf.issueSummary(), vouchers = wf.invoices.filter(r => r.voucher), manual = vouchers.filter(r => r.entryMode === 'manual').length;
  let h = '<div class="tiles">' + [['Invoices read', wf.invoices.length], ['Issues found', s.total], ['Still open', s.open], ['Resolved', s.total - s.open], ['Entered' + (manual ? ' (' + manual + ' manual)' : ''), vouchers.length]].map(x => '<div><div class="v">' + x[1] + '</div><div class="small muted">' + x[0] + '</div></div>').join('') + '</div>';
  h += '<div class="card"><h3>Issues by category</h3>';
  if (!s.categories.length) h += '<p class="muted small">No issues yet. Process the inbox to see them counted here.</p>';
  else {
    const max = Math.max.apply(null, s.categories.map(c => c.open + c.resolved));
    h += '<div class="legend"><span><i style="background:var(--accent)"></i>Open</span><span><i style="background:var(--ok)"></i>Resolved</span></div>' +
      s.categories.map(c => '<div class="catrow"><div class="small"><b>' + esc(c.label) + '</b><div class="muted" style="font-family:var(--mono);font-size:11px">' + esc(c.code) + '</div></div><div class="bar"><i class="o" style="width:' + (c.open / max * 100) + '%"></i><i class="r" style="width:' + (c.resolved / max * 100) + '%"></i></div><div class="num small">' + c.open + ' open · ' + c.resolved + ' done</div></div>').join('') +
      '<p class="small muted" style="margin-top:10px">What it is for: the top categories show where the process breaks. Many "No purchase order found" items point to purchases made without a PO, which is what Phase 2 addresses. Repeated tax issues point to a vendor or a job setup.</p>';
  }
  h += '</div>';
  if (s.owners.length) h += '<div class="card"><h3>Issues by owner</h3><table><thead><tr><th>Owner</th><th class="r">Open</th><th class="r">Resolved</th></tr></thead><tbody>' + s.owners.map(o => '<tr><td>' + esc(o.owner) + '</td><td class="r num">' + o.open + '</td><td class="r num">' + o.resolved + '</td></tr>').join('') + '</tbody></table></div>';
  if (wf.issueLog.length) h += '<div class="card"><h3>Issue register</h3><div class="scroll"><table><thead><tr><th>ID</th><th>Category</th><th>Invoice</th><th>Owner</th><th>Status</th><th>Resolution</th></tr></thead><tbody>' +
    wf.issueLog.slice().reverse().slice(0, 40).map(i => { const r = wf.getInv(i.invoiceId); return '<tr><td class="num small">' + esc(i.id) + '</td><td class="small">' + esc(i.label) + '</td><td class="small">' + esc(i.vendor) + '<div class="muted">' + esc(r.invoice.invoiceNo) + ' · ' + esc(i.invoiceId) + '</div></td><td class="small">' + esc(i.owner) + '</td><td><span class="pill ' + (i.status === 'open' ? 'warn' : 'ok') + '">' + i.status + '</span></td><td class="small">' + esc(i.resolution) + '</td></tr>'; }).join('') + '</tbody></table></div></div>';
  h += '<div class="card"><h3>AP invoice log</h3><p class="small muted" style="margin-bottom:8px">Simulates the SharePoint list: one row per invoice, with everything extracted, its status, its owner and its file.</p>';
  if (!wf.invoices.length) h += '<p class="muted small">Empty. Process the inbox first.</p>';
  else h += '<div class="scroll"><table><thead><tr><th>ID</th><th>Vendor</th><th>Invoice</th><th>Date</th><th>PO</th><th>Job</th><th class="r">Subtotal</th><th class="r">Tax</th><th class="r">Freight</th><th class="r">Total</th><th>Status</th><th>Issues</th><th>Assigned to</th><th>Entry</th><th>Voucher</th><th>File</th></tr></thead><tbody>' +
    wf.invoices.slice().reverse().map(r => { const i = r.invoice; return '<tr><td class="num small">' + esc(r.id) + '</td><td class="small">' + esc(i.vendorName) + (r.vendor ? '<div class="muted">' + esc(r.vendor.id) + '</div>' : '') + '</td><td class="small">' + esc(i.invoiceNo) + '</td><td class="small">' + esc(i.date || '') + '</td><td class="small">' + esc(r.po ? r.po.number : (i.poRef || '')) + '</td><td class="small">' + esc(i.jobId || '') + '</td><td class="r num">' + usd(i.subtotal) + '</td><td class="r num">' + usd(i.tax) + '</td><td class="r num">' + usd(i.freight) + '</td><td class="r num">' + usd(i.total) + '</td><td>' + statusPill(r) + '</td><td class="small">' + esc(r.reasons.map(x => x.id).join(', ')) + '</td><td class="small">' + esc(r.assignment ? r.assignment.to : '') + '</td><td class="small">' + (r.voucher ? (r.entryMode === 'manual' ? '<span class="pill warn">Manual</span>' : 'Bot') : (r.source === 'manual' ? '<span class="pill warn">Manual</span>' : '')) + '</td><td class="num small">' + esc(r.voucher || '') + '</td><td class="path">' + esc(r.libraryPath) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  h += '</div>';
  h += '<div class="card"><h3>Mail log</h3>' + (wf.mails.length ? '<div class="scroll"><table><thead><tr><th>ID</th><th>Subject</th><th>Type</th><th>Filed to</th></tr></thead><tbody>' + wf.mails.slice().reverse().map(m => '<tr><td class="num small">' + esc(m.id) + '</td><td class="small">' + esc(m.email.subject) + '</td><td>' + typePill(m.docType) + '</td><td class="path">' + esc(m.folder) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted small">Empty.</p>') + '</div>';
  h += '<div class="card"><h3>Document library</h3><p class="small muted" style="margin-bottom:8px">Simulates the SharePoint document library: every file saved with a consistent name.</p>' + (wf.library.length ? wf.library.slice().reverse().map(l => '<div class="row" style="justify-content:space-between;padding:3px 0"><span class="path">' + esc(l.path) + '</span><span class="pill idle">' + esc(l.kind) + '</span></div>').join('') : '<p class="muted small">Empty.</p>') + '</div>';
  $('#issues').innerHTML = h;
}

/* ====================== Phase 3 placeholder, ERP view, badges ====================== */
function renderStatements(){
  $('#statements').innerHTML = wf.statements.length ? '<table><thead><tr><th>Vendor</th><th>Period</th><th>Status</th></tr></thead><tbody>' + wf.statements.map(s => '<tr><td>' + esc(s.vendor) + '<div class="path muted">' + esc(s.file) + '</div></td><td class="small">' + esc(s.period) + '</td><td><span class="pill idle">Filed, waiting for Phase 3</span></td></tr>').join('') + '</tbody></table>' : '<p class="muted small">None yet. Process the inbox, which includes one vendor statement.</p>';
}
function renderERP(){
  const e = wf.erp, vn = id => (e.getVendor(id) || {}).name || id;
  let h = '<div class="card"><h3>Purchase orders</h3><div class="scroll"><table><thead><tr><th>PO</th><th>Vendor</th><th>Job · code · GL</th><th>Purchaser</th><th class="r">Total</th><th class="r">Billed</th><th class="r">Left</th><th>Left by part</th><th>Status</th></tr></thead><tbody>' +
    e.pos.slice().reverse().map(p => { const rem = R.poRemaining(p); return '<tr><td class="num">' + p.number + (p.reqId ? '<div class="small muted">' + p.reqId + '</div>' : '') + (p.changes ? '<div class="small muted">changed by PM</div>' : '') + '</td><td>' + esc(vn(p.vendorId)) + '<div class="small muted">' + p.vendorId + '</div></td><td class="small">' + p.jobId + ' · ' + p.coding.costCode + ' · ' + p.coding.gl + '</td><td class="small">' + esc(p.purchaser) + '</td><td class="r num">' + usd(p.total) + '</td><td class="r num">' + usd(p.billed) + '</td><td class="r num">' + usd(rem.total) + '</td><td class="small num">sub ' + usd(rem.sub) + '<br>tax ' + usd(rem.tax) + '<br>frt ' + usd(rem.freight) + '</td><td><span class="pill ' + (p.status === 'open' ? 'ok' : 'idle') + '">' + p.status + '</span></td></tr>'; }).join('') + '</tbody></table></div></div>';
  h += '<div class="two-col" style="margin-top:16px"><div class="card"><h3>Vouchers entered</h3><div class="scroll"><table><thead><tr><th>Voucher</th><th>Vendor · invoice</th><th>PO</th><th class="r">Amount</th><th>Entry</th><th>Status</th></tr></thead><tbody>' +
    e.apInvoices.slice().reverse().map(i => '<tr><td class="num small">' + i.voucher + '</td><td class="small">' + esc(vn(i.vendorId)) + '<div class="muted">' + esc(i.invoiceNo) + '</div></td><td class="num small">' + i.poNumber + '</td><td class="r num">' + usd(i.total) + '</td><td class="small">' + (i.mode === 'manual' ? '<span class="pill warn">Manual</span>' : (i.mode === 'bot' ? 'Bot' : 'Prior')) + '</td><td><span class="pill ' + (i.status === 'void' ? 'bad' : (i.status === 'approved' ? 'ok' : 'idle')) + '">' + (i.status || 'posted') + '</span></td></tr>').join('') + '</tbody></table></div></div>' +
    '<div class="card"><h3>Budget lines</h3><div class="scroll"><table><thead><tr><th>Job · code</th><th class="r">Budget</th><th class="r">Committed</th><th class="r">Left</th></tr></thead><tbody>' +
    Object.keys(e.budgets).map(k => { const b = e.budgets[k]; return '<tr><td class="num small">' + k.replace('|', ' · ') + '</td><td class="r num">' + usd(b.budget) + '</td><td class="r num">' + usd(b.committed) + '</td><td class="r num">' + usd(R.r2(b.budget - b.committed)) + '</td></tr>'; }).join('') + '</tbody></table></div></div></div>';
  h += '<div class="card" style="margin-top:16px"><h3>Audit log</h3>' + (wf.audit.length ? '<div class="scroll"><table><thead><tr><th>Time</th><th>Who</th><th>What</th><th>Ref</th><th>Detail</th></tr></thead><tbody>' + wf.audit.slice(0, 150).map(a => '<tr><td class="small num">' + time(a.ts) + '</td><td><span class="pill idle">' + esc(a.actor) + '</span></td><td class="small">' + esc(a.action) + '</td><td class="num small">' + esc(a.ref) + '</td><td class="small">' + esc(a.detail) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">Nothing yet. Every action by the clerk, the project managers, the rules and the bots is logged here with who did it.</p>') + '</div>';
  $('#erp').innerHTML = h;
}
function renderCounters(){
  const s = wf.issueSummary();
  $('#counters').innerHTML = [['Invoices read', wf.invoices.length], ['Entered in the ERP', wf.invoices.filter(r => r.voucher).length], ['Open issues', s.open], ['POs from requisitions', wf.reqs.filter(r => r.status === 'po_created').length]]
    .map(x => '<div><div class="v">' + x[1] + '</div><div class="small muted">' + x[0] + '</div></div>').join('');
  const mine = who.role === 'pm' ? wf.invoices.filter(r => (r.status === 'reported' && r.assignment.to === who.name) || r.status === 'awaiting_pm_approval').length
    : wf.invoices.filter(r => ['awaiting_review', 'reportable', 'owner_responded'].indexOf(r.status) >= 0).length;
  const rn = $('#rn'); rn.textContent = mine; rn.hidden = mine === 0;
  const q = wf.reqs.filter(r => r.status === 'needs_review').length, qn = $('#qn'); qn.textContent = q; qn.hidden = q === 0;
}
function renderAll(){ renderInbox(); renderReview(); renderIssues(); renderReqQueue(); renderStatements(); renderERP(); renderCounters(); setAsOf(); }

document.addEventListener('click', e => {
  const s = e.target.closest('[data-scn]'); if (s) loadScenario(s.dataset.scn);
  const g = e.target.closest('[data-go-scn]'); if (g) setTimeout(() => loadScenario(g.dataset.goScn), 0);
});
$('#role').addEventListener('change', e => { who = ROLES[e.target.value]; renderAll(); });
$('#reset').addEventListener('click', () => { $('#role').value = 'clerk'; who = ROLES.clerk; reset(); });

try {
  if (window.claude && window.claude.use) {
    window.claude.use('sample').then(s => { if (s) { sample = s; $('#read-claude').hidden = false; $('#own-claude').hidden = false; } }).catch(() => {});
  }
} catch (e) {}

reset(); route();
})();
