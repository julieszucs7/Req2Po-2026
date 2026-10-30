const assert = require('assert');
const R = require('../src/core.js');
const S = require('../src/samples.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const wf = () => new R.Workflow({ today: '2026-10-30' });
const codes = (req) => req.flags.map(f => f.code).sort();
const sc = (id) => S.scenarios.find(s => s.id === id);
const submit = (w, id) => { const s = sc(id); return w.submitRequisition(s.form, s.quote ? R.parseQuoteText(s.quote) : null); };
const mail = (id) => S.emails.find(e => e.id === id);

console.log('Parsing');
t('quote: reads vendor, lines, totals, dates', () => {
  const q = R.parseQuoteText(S.quotes.ridgeline);
  assert.strictEqual(q.vendorName, 'RIDGELINE CONCRETE SUPPLY');
  assert.strictEqual(q.lines.length, 2);
  assert.strictEqual(q.subtotal, 18710);
  assert.strictEqual(q.tax, 1309.7);
  assert.strictEqual(q.total, 20019.7);
  assert.strictEqual(q.docNo, 'Q-88214');
  assert.strictEqual(q.validThrough, '2026-11-25');
  assert.strictEqual(q.jobId, '24-101');
});
t('invoice: PO ref found, none when absent', () => {
  assert.strictEqual(R.parseInvoiceText(mail('e1').attachment.text).poRef, 'PO-26-0604');
  assert.strictEqual(R.parseInvoiceText(mail('e2').attachment.text).poRef, null);
});
t('invoice: number and date parsed', () => {
  const i = R.parseInvoiceText(mail('e4').attachment.text);
  assert.strictEqual(i.invoiceNo, 'HW30418'); assert.strictEqual(i.date, '2026-10-15');
});
t('statement is not treated as an invoice', () => assert.ok(!R.looksLikeInvoice(mail('e8').attachment.text)));

console.log('Requisitions');
t('clean request: no flags, bot creates PO, ERP number written back', () => {
  const w = wf(); const r = submit(w, 'clean');
  assert.ok(r.ok); assert.deepStrictEqual(r.req.flags, []);
  assert.strictEqual(r.req.status, 'po_created');
  assert.strictEqual(r.req.poNumber, 'PO-26-0618');
  const po = w.erp.getPO('PO-26-0618');
  assert.strictEqual(po.total, 1284); assert.strictEqual(po.coding.gl, '5100'); assert.strictEqual(po.reqId, r.req.id);
});
t('PO numbers come from the ERP sequence, never from the tool', () => {
  const w = wf(); const a = submit(w, 'clean');
  const b = w.submitRequisition(Object.assign({}, sc('clean').form, { subtype: 'More hard hats', price: '900' }), null);
  assert.strictEqual(a.req.poNumber, 'PO-26-0618');
  assert.strictEqual(b.req.poNumber, 'PO-26-0619');
});
t('quote mismatch: flags QUOTE_PRICE and OVER_LIMIT, PO not created', () => {
  const r = submit(wf(), 'mismatch');
  assert.deepStrictEqual(codes(r.req), ['OVER_LIMIT', 'QUOTE_PRICE']);
  assert.strictEqual(r.req.status, 'needs_review'); assert.strictEqual(r.req.poNumber, null);
});
t('tax-exempt job: QUOTE_TAX and OVER_BUDGET, PO tax forced to zero on approval', () => {
  const w = wf(); const r = submit(w, 'exempt');
  assert.deepStrictEqual(codes(r.req), ['OVER_BUDGET', 'QUOTE_TAX']);
  const a = w.approveRequisition(r.req.id, 'Budget transfer approved by PM');
  assert.strictEqual(a.po.tax, 0); assert.strictEqual(a.po.total, 4500);
});
t('new vendor, wrong code, no quote', () => {
  const r = submit(wf(), 'newvendor');
  assert.deepStrictEqual(codes(r.req), ['CATEGORY_MISMATCH', 'NEW_VENDOR', 'NO_QUOTE']);
});
t('new vendor cannot get a PO until set up', () => {
  const w = wf(); const r = submit(w, 'newvendor');
  assert.strictEqual(w.approveRequisition(r.req.id, '').error, 'Set up the vendor first.');
});
t('closed job: hard error, nothing created', () => {
  const w = wf(); const r = submit(w, 'closed');
  assert.ok(!r.ok); assert.ok(/closed/.test(r.errors[0].msg)); assert.strictEqual(w.reqs.length, 0);
});
t('missing fields are hard errors', () => {
  const r = wf().submitRequisition({ vendorName: '', dateNeeded: '', type: '', subtype: '', jobId: '', costCode: '', category: '', price: '' }, null);
  assert.ok(!r.ok); assert.ok(r.errors.length >= 7);
});
t('duplicate requisition is flagged', () => {
  const w = wf(); submit(w, 'clean'); const r = submit(w, 'clean');
  assert.ok(codes(r.req).includes('DUPLICATE'));
});
t('past date needed is flagged', () => {
  const w = wf(); const f = Object.assign({}, sc('clean').form, { dateNeeded: '2026-10-01' });
  assert.ok(codes(w.submitRequisition(f, R.parseQuoteText(sc('clean').quote)).req).includes('DATE_PAST'));
});
t('reviewer can return a requisition', () => {
  const w = wf(); const r = submit(w, 'mismatch'); w.returnRequisition(r.req.id, 'Add pump truck to form');
  assert.strictEqual(r.req.status, 'returned');
});
t('vendor fuzzy matching: alias and containment match, unrelated does not', () => {
  const e = wf().erp;
  assert.strictEqual(e.findVendor('Ridgeline Concrete').vendor.id, 'V100');
  assert.strictEqual(e.findVendor('KEYSTONE STEEL & REBAR').vendor.id, 'V103');
  assert.strictEqual(e.findVendor('Pinnacle Rental Co').vendor, null);
});

console.log('Vendor matching');
t('exact, alias, legal suffix, dba all match with high confidence', () => {
  const e = wf().erp;
  ['Ridgeline Concrete', 'RIDGELINE CONCRETE SUPPLY LLC', 'ridgeline concrete supply, inc.', 'Acme Co dba Ridgeline Concrete Supply'].forEach(n => {
    const m = e.findVendor(n); assert.strictEqual(m.vendor.id, 'V100', n); assert.strictEqual(m.confidence, 'high', n);
  });
  assert.strictEqual(e.findVendor('Keystone Steel and Rebar').vendor.id, 'V103');
});
t('shared generic word is NOT a match (Metro Supply vs Metro Safety Supply)', () => {
  assert.strictEqual(wf().erp.findVendor('Metro Supply').vendor, null);
  assert.strictEqual(wf().erp.findVendor('Summit Supply').vendor, null);
});
t('look-alike names resolve to the right row, never the wrong one', () => {
  const e = wf().erp;
  assert.strictEqual(e.findVendor('Harbor Mechanical Services LLC').vendor.id, 'V106');
  assert.strictEqual(e.findVendor('Harbor Electrical Wholesale').vendor.id, 'V102');
  assert.strictEqual(e.findVendor('Harbor Electric').vendor, null);
});
t('shortened name is medium confidence, not high', () => {
  const m = wf().erp.findVendor('Harbor Mechanical'); assert.strictEqual(m.vendor.id, 'V106'); assert.strictEqual(m.confidence, 'medium');
});
t('sender address is strong evidence when the name is garbled', () => {
  const m = wf().erp.findVendor('H E W', 'ar@harborelectric.example'); assert.strictEqual(m.vendor.id, 'V102'); assert.strictEqual(m.confidence, 'medium');
});
t('billing platforms and internal forwards never decide the vendor', () => {
  const e = wf().erp;
  assert.strictEqual(e.findVendor('Unknown Co', 'invoices@billingportal.example').vendor, null);
  assert.strictEqual(e.findVendor('Unknown Co', 'jane@ourcompany.example').vendor, null);
  assert.strictEqual(e.findVendor('Harbor Electrical Wholesale', 'invoices@billingportal.example').vendor.id, 'V102');
});
t('sender and name pointing at different vendors matches nothing', () => {
  assert.strictEqual(wf().erp.findVendor('Harbor Electrical Wholesale', 'ar@summitrentals.example').vendor, null);
});
t('the matcher can only return a row from the list', () => {
  const e = wf().erp; ['', 'zzz', 'Acme', 'Harbor'].forEach(n => { const v = e.findVendor(n).vendor; assert.ok(v === null || e.vendors.includes(v)); });
});

console.log('Inbox: classification, filing, splitting');
const PM = { name: 'Priya Raman', role: 'pm' }, CLERK = { name: 'AP clerk', role: 'clerk' };
const run = (w, id) => { const m = w.processEmail(mail(id)); return { m, invs: w.invoicesFor(m) }; };
const ids = (r) => r.reasons.map(x => x.id).sort();
t('documents are classified: invoice, statement, reminder, correspondence', () => {
  const w = wf();
  assert.strictEqual(run(w, 'e1').m.docType, 'invoice');
  assert.strictEqual(run(w, 'e8').m.docType, 'statement');
  assert.strictEqual(run(w, 'e13').m.docType, 'reminder');
  assert.strictEqual(run(w, 'e12').m.docType, 'correspondence');
});
t('statements are filed and queued for Phase 3, never entered', () => {
  const w = wf(); const { m, invs } = run(w, 'e8');
  assert.strictEqual(invs.length, 0); assert.strictEqual(w.statements.length, 1);
  assert.strictEqual(m.folder, 'AP/Vendors/Harbor Electrical Wholesale/Statements');
  assert.strictEqual(w.erp.apInvoices.length, 2);
});
t('correspondence with no attachment is filed to the vendor by sender', () => {
  const { m } = run(wf(), 'e12'); assert.strictEqual(m.folder, 'AP/Vendors/Harbor Electrical Wholesale/Correspondence');
});
t('a past-due notice is checked against the ERP and flagged when the invoice is missing', () => {
  const w = wf(); run(w, 'e13');
  assert.strictEqual(w.followUps[0].invoiceNo, 'SE-2150'); assert.strictEqual(w.followUps[0].needsAction, true);
  assert.strictEqual(w.invoices.length, 0);
});
t('one PDF with two invoices is split by page range, each judged on its own', () => {
  const w = wf(); const { m, invs } = run(w, 'e11');
  assert.strictEqual(invs.length, 2);
  const [a, b] = invs.slice().sort((p, q) => p.seg.start - q.seg.start);
  assert.deepStrictEqual([a.seg.start, a.seg.end, b.seg.start, b.seg.end], [1, 2, 3, 3]);
  assert.strictEqual(a.invoice.invoiceNo, 'SE-2301'); assert.strictEqual(a.status, 'awaiting_review');
  assert.strictEqual(b.invoice.invoiceNo, 'SE-2302'); assert.deepStrictEqual(ids(b), ['PO_SHORT']);
  assert.strictEqual(a.renamed, 'V101_SE2301_2026-10-30_PO-26-0607_p1-2.pdf');
  assert.strictEqual(b.renamed, 'V101_SE2302_2026-10-30_PO-26-0612_p3.pdf');
  assert.ok(R.checkSplit(R.splitPages(mail('e11').attachment.pages), 3));
});
t('an unmarked page with no invoice number makes the split unsure', () => {
  const segs = R.splitPages(['V\nINVOICE\nInvoice No: A-1\nTotal Due 5.00', 'some page with nothing on it']);
  assert.strictEqual(segs.length, 1); assert.strictEqual(segs[0].confident, false);
  assert.ok(R.checkSplit(segs, 2));
});
t('split coverage check rejects gaps and overlaps', () => {
  assert.ok(!R.checkSplit([{ start: 1, end: 1 }, { start: 3, end: 3 }], 3));
  assert.ok(!R.checkSplit([{ start: 1, end: 2 }, { start: 2, end: 3 }], 3));
});
t('invoice is filed to the matched vendor folder and saved to the library', () => {
  const w = wf(); const { m, invs } = run(w, 'e1');
  assert.strictEqual(m.folder, 'AP/Vendors/Harbor Electrical Wholesale/Invoices');
  assert.strictEqual(invs[0].libraryPath, 'AP Library/Invoices/2026/10/V102_HW30533_2026-10-28_PO-26-0604.pdf');
  assert.ok(w.library.some(l => l.path === invs[0].libraryPath));
});
t('platform sender + similar vendor name: right vendor, held for missing PO', () => {
  const { invs } = run(wf(), 'e9'); assert.strictEqual(invs[0].vendor.id, 'V106'); assert.deepStrictEqual(ids(invs[0]), ['NO_PO']);
});
t('vendor not on the list: held, left unmatched, nothing invented', () => {
  const { m, invs } = run(wf(), 'e10');
  assert.strictEqual(invs[0].vendor, null); assert.ok(/General inbox/.test(m.folder)); assert.ok(ids(invs[0]).includes('VENDOR_UNKNOWN'));
});

console.log('Invoice checks against the PO');
t('clean invoice passes every check and waits for a person: nothing is entered yet', () => {
  const w = wf(); const r = run(w, 'e1').invs[0];
  assert.strictEqual(r.status, 'awaiting_review'); assert.strictEqual(r.reasons.length, 0);
  assert.strictEqual(w.erp.getPO('PO-26-0604').billed, 2514.5); assert.strictEqual(w.erp.apInvoices.length, 2);
  assert.ok(r.comparison.find(c => c.field === 'Vendor ID' && c.status === 'match'));
  assert.ok(r.comparison.find(c => c.field.startsWith('Freight') && c.status === 'match'));
});
t('no PO on invoice: reportable NO_PO with a suggestion, never auto-assigned', () => {
  const r = run(wf(), 'e2').invs[0];
  assert.deepStrictEqual(ids(r), ['NO_PO']); assert.strictEqual(r.suggestions[0].number, 'PO-26-0615'); assert.strictEqual(r.po, null);
});
t('wrong vendor on the PO is caught by vendor ID', () => {
  const r = run(wf(), 'e3').invs[0]; assert.ok(ids(r).includes('VENDOR_MISMATCH')); assert.ok(ids(r).includes('JOB_MISMATCH'));
  assert.strictEqual(r.comparison.find(c => c.field === 'Vendor ID').status, 'mismatch');
});
t('duplicate caught even with different punctuation', () => assert.deepStrictEqual(ids(run(wf(), 'e4').invs[0]), ['DUPLICATE']));
t('not enough $ left on the PO is its own category', () => assert.deepStrictEqual(ids(run(wf(), 'e5').invs[0]), ['PO_SHORT']));
t('tax on a tax-exempt job is reported once as a rate problem', () => assert.deepStrictEqual(ids(run(wf(), 'e6').invs[0]), ['TAX_RATE']));
t('arithmetic error caught', () => assert.deepStrictEqual(ids(run(wf(), 'e7').invs[0]), ['MATH']));
t('the same invoice received twice: the second is a duplicate of the first', () => {
  const w = wf(); run(w, 'e1'); const again = run(w, 'e1').invs[0];
  assert.deepStrictEqual(ids(again), ['DUPLICATE']);
});
t('freight above the PO allowance is its own category', () => {
  const w = wf(); const e = JSON.parse(JSON.stringify(mail('e1'))); e.attachment.text = e.attachment.text.replace('Freight 85.00', 'Freight 185.00').replace('Total Due 2,920.50', 'Total Due 3,020.50');
  assert.deepStrictEqual(ids(w.invoicesFor(w.processEmail(e))[0]), ['FREIGHT']);
});
t('not enough sales tax left on the PO (subtotal fine) is its own category', () => {
  const w = wf(); const po = w.erp.getPO('PO-26-0604'); po.billedTax = 250; po.billed = R.r2(po.billedSub + po.billedTax + po.billedFreight);
  const r = run(w, 'e1').invs[0]; assert.deepStrictEqual(ids(r), ['TAX_SHORT']);
});
t('a root cause is reported once: short subtotal does not also report short tax', () => {
  const r = run(wf(), 'e5').invs[0]; assert.ok(!ids(r).includes('TAX_SHORT'));
});
t('nothing is entered in the ERP by processing alone', () => {
  const w = wf(); S.emails.forEach(e => w.processEmail(e)); assert.strictEqual(w.erp.apInvoices.length, 2);
});

console.log('Review, bot entry, PM approval');
t('reviewer verifies, bot enters with read-back, PO balances update, JE balanced, PM approves', () => {
  const w = wf(); const r = run(w, 'e1').invs[0];
  w.reviewerVerify(r.id);
  assert.strictEqual(r.status, 'awaiting_pm_approval'); assert.strictEqual(r.entryMode, 'bot');
  const po = w.erp.getPO('PO-26-0604');
  assert.strictEqual(po.billed, 5435); assert.strictEqual(po.status, 'closed');
  assert.strictEqual(r.je.lines[0].dr, r.je.lines[1].cr); assert.ok(w.erp.apInvoices.find(v => v.voucher === r.voucher).pdfAttached);
  w.pmApprove(r.id, PM, 'PDF looks right'); assert.strictEqual(r.status, 'approved');
});
t('the bot re-checks just before entry: two invoices that both fit alone cannot both be entered', () => {
  const w = wf(); const a = run(w, 'e1').invs[0];
  const e2 = JSON.parse(JSON.stringify(mail('e1'))); e2.attachment.text = e2.attachment.text.replace('HW-30533', 'HW-30540');
  const b = w.invoicesFor(w.processEmail(e2))[0];
  assert.strictEqual(a.status, 'awaiting_review'); assert.strictEqual(b.status, 'awaiting_review');
  w.reviewerVerify(a.id); w.reviewerVerify(b.id);
  assert.strictEqual(a.status, 'awaiting_pm_approval'); assert.strictEqual(b.status, 'reportable');
  assert.ok(ids(b).includes('PO_SHORT')); assert.strictEqual(w.erp.getPO('PO-26-0604').billed, 5435);
});
t('read-back mismatch voids the voucher, restores the PO and reports ENTRY_FAILED', () => {
  const w = wf(); w.glitch = true; const r = run(w, 'e1').invs[0];
  w.reviewerVerify(r.id);
  assert.strictEqual(r.status, 'reportable'); assert.deepStrictEqual(ids(r), ['ENTRY_FAILED']);
  assert.strictEqual(w.erp.getPO('PO-26-0604').billed, 2514.5);
  assert.strictEqual(w.erp.apInvoices.filter(v => v.status === 'void').length, 1);
  w.glitch = false; w.rerun(r.id); assert.strictEqual(r.status, 'awaiting_review');
  w.reviewerVerify(r.id); assert.strictEqual(r.status, 'awaiting_pm_approval');
});
t('manual entry is marked as manual and skips the bot', () => {
  const w = wf(); const r = run(w, 'e1').invs[0]; w.enterManually(r.id);
  assert.strictEqual(r.entryMode, 'manual'); assert.strictEqual(w.erp.apInvoices.find(v => v.voucher === r.voucher).mode, 'manual');
});
t('an invoice keyed in by hand is logged as manual and goes through the same checks', () => {
  const w = wf();
  const m = w.processEmail({ id: 'man', subject: 'Manual entry', from: '', manual: { vendorName: 'Metro Safety Supply', invoiceNo: 'MS-1', date: '2026-10-29', poRef: 'PO-26-0615', jobId: '24-101', subtotal: 1600, tax: 112, freight: 0, total: 1712, lines: [] } });
  const r = w.invoicesFor(m)[0]; assert.strictEqual(r.source, 'manual'); assert.strictEqual(r.entryMode, 'manual'); assert.strictEqual(r.status, 'awaiting_review');
  const dup = w.invoicesFor(w.processEmail({ id: 'man2', subject: 'Manual entry', from: '', manual: { vendorName: 'Metro Safety Supply', invoiceNo: 'MS-1', date: '2026-10-29', poRef: 'PO-26-0615', jobId: '24-101', subtotal: 1600, tax: 112, freight: 0, total: 1712, lines: [] } }))[0];
  assert.deepStrictEqual(ids(dup), ['DUPLICATE']);
});
t('PM can reject after entry: voucher voided, PO restored, reported back', () => {
  const w = wf(); const r = run(w, 'e1').invs[0]; w.reviewerVerify(r.id);
  assert.throws(() => w.pmReject(r.id, PM, ''), /reason/i);
  w.pmReject(r.id, PM, 'Wrong equipment delivered');
  assert.strictEqual(r.status, 'reportable'); assert.ok(ids(r).includes('PM_REJECTED')); assert.strictEqual(w.erp.getPO('PO-26-0604').billed, 2514.5);
});

console.log('Reporting, PM-only PO changes, feedback loop');
t('NO_PO: clerk reports, PM confirms the PO with a reason, clerk re-runs, invoice moves to review', () => {
  const w = wf(); const r = run(w, 'e2').invs[0];
  w.reportToOwner(r.id, 'Priya Raman', 'Is this for the safety netting PO?'); assert.strictEqual(r.status, 'reported');
  w.ownerRespond(r.id, 'use_po', 'Yes, PO-26-0615', PM, { poNumber: 'PO-26-0615' });
  assert.strictEqual(r.status, 'owner_responded'); assert.strictEqual(r.status === 'awaiting_review', false);
  w.rerun(r.id); assert.strictEqual(r.status, 'awaiting_review'); assert.strictEqual(r.matchMethod, 'confirmed by Priya Raman');
});
t('PO_SHORT: only the PM can change the PO, with a reason; the change is logged; re-run passes', () => {
  const w = wf(); const r = run(w, 'e5').invs[0]; w.reportToOwner(r.id, 'Priya Raman', '');
  assert.throws(() => w.ownerRespond(r.id, 'correct_po', 'Extended the rental', CLERK, { addSubtotal: 2250 }), /Only the project manager/);
  assert.throws(() => w.ownerRespond(r.id, 'correct_po', '', PM, { addSubtotal: 2250 }), /reason/i);
  w.ownerRespond(r.id, 'correct_po', 'Rental extended 2 more weeks', PM, { addSubtotal: 2250 });
  const po = w.erp.getPO('PO-26-0607'); assert.strictEqual(po.changes.length, 1); assert.strictEqual(po.changes[0].by, 'Priya Raman');
  assert.strictEqual(po.subtotal, 6750); assert.strictEqual(po.tax, 472.5);
  w.rerun(r.id); assert.strictEqual(r.status, 'awaiting_review');
  assert.ok(w.audit.some(a => /Changed PO with sign-off/.test(a.action)));
});
t('the clerk cannot change a PO or accept a difference in any way', () => {
  const w = wf(); const r = run(w, 'e5').invs[0]; w.reportToOwner(r.id, 'Priya Raman', '');
  ['correct_po', 'use_po', 'valid_proceed', 'dispute', 'credit_memo', 'reject', 'fixed'].forEach(a => assert.throws(() => w.ownerRespond(r.id, a, 'because', CLERK, { addSubtotal: 1, poNumber: 'PO-26-0607' }), /Only the project manager/));
  assert.strictEqual(w.erp.getPO('PO-26-0607').changes, undefined);
});
t('a difference can be accepted as valid only for categories that allow it', () => {
  const w = wf(); const r = run(w, 'e5').invs[0]; w.reportToOwner(r.id, 'Priya Raman', '');
  assert.throws(() => w.ownerRespond(r.id, 'valid_proceed', 'fine', PM), /accepted as-is/);
});
t('dispute and credit-memo put the invoice on hold; reject ends it', () => {
  const w = wf(); const a = run(w, 'e6').invs[0]; w.reportToOwner(a.id, 'Marcus Webb', '');
  w.ownerRespond(a.id, 'dispute', 'Calling vendor about tax on an exempt job', { name: 'Marcus Webb', role: 'pm' });
  assert.strictEqual(a.status, 'on_hold'); assert.strictEqual(a.hold, 'Disputed with the vendor');
  const b = run(w, 'e7').invs[0]; w.reportToOwner(b.id, 'Priya Raman', '');
  w.ownerRespond(b.id, 'reject', 'Do not pay', PM); assert.strictEqual(b.status, 'rejected');
});
t('the clerk can close a duplicate; its issue is marked resolved', () => {
  const w = wf(); const r = run(w, 'e4').invs[0]; w.closeInvoice(r.id, 'Duplicate of AP-26-0412');
  assert.strictEqual(r.status, 'closed'); assert.ok(w.issueLog.every(i => i.status === 'resolved'));
});
t('issue summary counts by category and owner, open and resolved', () => {
  const w = wf(); ['e2', 'e4', 'e5', 'e6'].forEach(id => run(w, id));
  const s = w.issueSummary();
  assert.strictEqual(s.total, 4); assert.strictEqual(s.open, 4);
  assert.deepStrictEqual(s.categories.map(c => c.code).sort(), ['DUPLICATE', 'NO_PO', 'PO_SHORT', 'TAX_RATE']);
  const r = w.invoices.find(x => x.invoice.invoiceNo === 'HW30418'); w.closeInvoice(r.id, 'dup');
  assert.strictEqual(w.issueSummary().open, 3);
});

t('the review screens refresh against the PO balance as it stands now', () => {
  const w = wf();
  // SE-2301 and SE-2290 both bill PO-26-0607. SE-2290 is short at intake.
  const a = run(w, 'e11').invs[0];          // SE-2301, clean, uses the balance
  const b = w.invoices.find(x => x.invoice.invoiceNo === 'SE-2290') || run(w, 'e5').invs[0];
  const firstShort = b.reasons.find(x => x.id === 'PO_SHORT').shortBy;
  w.reviewerVerify(a.id);                    // entering it consumes the PO balance
  w.refreshView();
  const nowShort = b.reasons.find(x => x.id === 'PO_SHORT').shortBy;
  assert.ok(nowShort > firstShort, 'shortfall should grow once the other invoice is entered');
  assert.strictEqual(b.status, 'reportable', 'refresh must not move anything through the workflow');
});
t('refresh leaves anything already entered alone', () => {
  const w = wf();
  const r = run(w, 'e1').invs[0];
  w.reviewerVerify(r.id);
  const v = r.voucher, st = r.status;
  w.refreshView();
  assert.strictEqual(r.voucher, v); assert.strictEqual(r.status, st);
});
t('a cleared finding is flagged instead of silently passing', () => {
  const w = wf();
  const r = run(w, 'e5').invs[0];            // SE-2290, PO_SHORT
  w.reportToOwner(r.id, 'Priya Raman', 'short');
  w.ownerRespond(r.id, 'correct_po', 'Rental extended', { name: 'Priya Raman', role: 'pm' }, { addSubtotal: 2250 });
  w.refreshView();
  assert.strictEqual(r.reasons.length, 0);
  assert.ok(r.stale, 'the screen should say the findings no longer apply');
});

t('a project manager cannot sign off on another PM\'s job', () => {
  const w = wf();
  const r = run(w, 'e5').invs[0];                       // job 24-101, PM Priya Raman
  w.reportToOwner(r.id, 'Priya Raman', 'short');
  const marcus = { name: 'Marcus Webb', role: 'pm' };
  assert.throws(() => w.ownerRespond(r.id, 'correct_po', 'I will approve it', marcus, { addSubtotal: 2250 }), /belongs to Priya Raman/);
  assert.strictEqual(r.status, 'reported');
  w.ownerRespond(r.id, 'correct_po', 'Rental extended', { name: 'Priya Raman', role: 'pm' }, { addSubtotal: 2250 });
  assert.strictEqual(r.status, 'owner_responded');
});
t('a project manager cannot approve another PM\'s voucher', () => {
  const w = wf();
  const r = run(w, 'e1').invs[0];                       // job 24-101, PM Priya Raman
  w.reviewerVerify(r.id);
  assert.throws(() => w.pmApprove(r.id, { name: 'Marcus Webb', role: 'pm' }, 'ok'), /belongs to Priya Raman/);
  assert.throws(() => w.pmReject(r.id, { name: 'Marcus Webb', role: 'pm' }, 'no'), /belongs to Priya Raman/);
  w.pmApprove(r.id, { name: 'Priya Raman', role: 'pm' }, 'checked');
  assert.strictEqual(r.status, 'approved');
});

t('an invoice with no PO goes to the project manager, not to the clerk', () => {
  const w = wf();
  const r = run(w, 'e2').invs[0];                        // MS-90112, no PO on the invoice
  assert.ok(r.reasons.some(x => x.id === 'NO_PO'));
  assert.strictEqual(r.status, 'reportable');
  // the clerk has no way to put a PO on it: there is no such method on the workflow
  assert.strictEqual(typeof w.setPONumber, 'undefined', 'the invoice team must not be able to assign a PO');
  // and the clerk cannot reach the PM-only route either
  assert.throws(() => w.ownerRespond(r.id, 'use_po', 'Found it', { name: 'AP clerk', role: 'clerk' }, { poNumber: 'PO-26-0615' }),
    /Only the project manager or original purchaser/);
  assert.strictEqual(r.po, null);
});
t('the project manager assigns the PO, and it is recorded against their name', () => {
  const w = wf();
  const r = run(w, 'e2').invs[0];
  w.reportToOwner(r.id, 'Priya Raman', 'No PO on this invoice. Which one should it go to?');
  assert.strictEqual(r.status, 'reported');
  w.ownerRespond(r.id, 'use_po', 'This is the fall-protection order', { name: 'Priya Raman', role: 'pm' }, { poNumber: 'PO-26-0615' });
  assert.strictEqual(r.status, 'owner_responded');
  assert.ok(/PO-26-0615 confirmed by Priya Raman/.test(r.assignment.response.label), r.assignment.response.label);
  w.rerun(r.id);
  assert.strictEqual(r.po.number, 'PO-26-0615');
  assert.ok(/confirmed by Priya Raman/.test(r.matchMethod), r.matchMethod);
  assert.ok(w.audit.some(a => /Priya Raman/.test(a.actor)), 'the PM action should be in the audit log');
});
t('assigning a PO changes nothing on the PO itself', () => {
  const w = wf();
  const before = JSON.stringify(w.erp.getPO('PO-26-0615'));
  const r = run(w, 'e2').invs[0];
  w.reportToOwner(r.id, 'Priya Raman', 'no PO');
  w.ownerRespond(r.id, 'use_po', 'Confirmed', { name: 'Priya Raman', role: 'pm' }, { poNumber: 'PO-26-0615' });
  const after = w.erp.getPO('PO-26-0615');
  assert.strictEqual(after.subtotal, JSON.parse(before).subtotal);
  assert.strictEqual(after.total, JSON.parse(before).total);
});
t('a PO the PM assigns is still checked, so the wrong one fails', () => {
  const w = wf();
  const r = run(w, 'e2').invs[0];                        // Metro Safety Supply
  w.reportToOwner(r.id, 'Priya Raman', 'no PO');
  w.ownerRespond(r.id, 'use_po', 'Try this one', { name: 'Priya Raman', role: 'pm' }, { poNumber: 'PO-26-0611' });  // Keystone's PO
  w.rerun(r.id);
  assert.strictEqual(r.status, 'reportable');
  assert.ok(r.reasons.some(x => x.id === 'VENDOR_MISMATCH'), r.reasons.map(x => x.id).join(','));
});
t('the other way out is for the PM to put the charges on the PO', () => {
  const w = wf();
  const r = run(w, 'e5').invs[0];                        // SE-2290, PO is short
  w.reportToOwner(r.id, 'Priya Raman', 'PO is short');
  w.ownerRespond(r.id, 'correct_po', 'Rental extended; adding the balance', { name: 'Priya Raman', role: 'pm' }, { addSubtotal: 2250 });
  w.rerun(r.id);
  assert.strictEqual(r.status, 'awaiting_review');
  assert.ok(r.po.changes.some(c => c.by === 'Priya Raman'));
});
/* ---------- Phase 2: classifying what is being bought ---------- */
const ohForm = (over) => Object.assign({
  vendorName: 'Metro Safety Supply', dateNeeded: '2026-11-15', type: 'material', subtype: 'Office paper and toner',
  purchaseClass: 'overhead', ptype: 'office', jobId: '', costCode: '', category: '', price: '400'
}, over || {});

t('an overhead purchase needs no job, and codes from the purchase type', () => {
  const w = wf(); const r = w.submitRequisition(ohForm(), null);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.req.pclass, 'overhead');
  assert.strictEqual(r.req.treatment.acct, '6100');
  assert.strictEqual(r.req.treatment.kind, 'expense');
});
t('a job number on an overhead purchase is refused', () => {
  const r = wf().submitRequisition(ohForm({ jobId: '24-101' }), null);
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.field === 'jobId' && /does not belong to a job/.test(e.msg)), JSON.stringify(r.errors));
});
t('a job purchase still needs a job and cost code', () => {
  const r = wf().submitRequisition(ohForm({ purchaseClass: 'job', ptype: '', jobId: '', costCode: '' }), null);
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.field === 'jobId'));
  assert.ok(r.errors.some(e => e.field === 'costCode'));
});
t('"other" has to be explained before it can be categorized', () => {
  const bad = wf().submitRequisition(ohForm({ ptype: 'oh_other' }), null);
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some(e => e.field === 'otherReason'));
  const good = wf().submitRequisition(ohForm({ ptype: 'oh_other', otherReason: 'Annual trade association dues' }), null);
  assert.ok(good.ok);
  assert.ok(good.req.flags.some(f => f.code === 'CATEGORIZE' && /trade association/.test(f.msg)));
});
t('an asset over the capitalization threshold is capitalized, not expensed', () => {
  const w = wf();
  const r = w.submitRequisition(ohForm({ purchaseClass: 'equipment', ptype: 'equip_buy', subtype: 'Compressor', price: '6400' }), null);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const f = r.req.flags.find(x => x.code === 'CAPITALIZE');
  assert.ok(f, r.req.flags.map(x => x.code).join(','));
  assert.strictEqual(r.req.treatment.kind, 'capital');
  assert.strictEqual(r.req.treatment.acct, '1500');
  assert.ok(/depreciate over 5 years/.test(f.fix), f.fix);
});
t('the same asset under the threshold is expensed', () => {
  const r = wf().submitRequisition(ohForm({ purchaseClass: 'equipment', ptype: 'equip_buy', subtype: 'Small compressor', price: '900' }), null);
  assert.ok(r.ok);
  assert.strictEqual(r.req.treatment.kind, 'expense');
  assert.ok(!r.req.flags.some(f => f.code === 'CAPITALIZE'));
});
t('a cost covering several months is carried as prepaid and amortized', () => {
  const r = wf().submitRequisition(ohForm({ ptype: 'insurance', subtype: 'General liability policy', price: '12000', coversMonths: '12' }), null);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const f = r.req.flags.find(x => x.code === 'PREPAID');
  assert.ok(f, r.req.flags.map(x => x.code).join(','));
  assert.strictEqual(r.req.treatment.kind, 'prepaid');
  assert.strictEqual(r.req.treatment.acct, '1400');
  assert.strictEqual(r.req.treatment.months, 12);
  assert.ok(/\$1,000\.00 a month/.test(f.fix), f.fix);
});
t('a one-month cost is not treated as prepaid', () => {
  const r = wf().submitRequisition(ohForm({ ptype: 'insurance', price: '900', coversMonths: '1' }), null);
  assert.ok(r.ok); assert.strictEqual(r.req.treatment.kind, 'expense');
  assert.ok(!r.req.flags.some(f => f.code === 'PREPAID'));
});
t('a subscription with no period given is asked for one', () => {
  const r = wf().submitRequisition(ohForm({ ptype: 'software', subtype: 'Takeoff software' }), null);
  assert.ok(r.ok);
  assert.ok(r.req.flags.some(f => f.code === 'PERIOD_UNKNOWN'));
});
t('a purchase type from another class is flagged', () => {
  const r = wf().submitRequisition(ohForm({ purchaseClass: 'equipment', ptype: 'office' }), null);
  assert.ok(r.ok);
  assert.ok(r.req.flags.some(f => f.code === 'CLASS_TYPE'));
});
t('overhead coding is never auto-approved: a person categorizes it', () => {
  const w = wf(); const r = w.submitRequisition(ohForm(), null);
  assert.ok(r.req.flags.some(f => f.code === 'CATEGORIZE'));
  assert.strictEqual(r.req.status, 'needs_review');
  assert.strictEqual(r.req.poNumber, null);
});
t('once reviewed, the overhead PO carries the GL coding and no job', () => {
  const w = wf(); const r = w.submitRequisition(ohForm(), null);
  w.approveRequisition(r.req.id, 'Category confirmed');
  const po = w.erp.getPO(r.req.poNumber);
  assert.ok(po, 'PO should exist after approval');
  assert.strictEqual(po.coding.gl, '6100');
  assert.strictEqual(po.jobId, '');
  assert.strictEqual(po.coding.pclass, 'overhead');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
