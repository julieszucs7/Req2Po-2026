/*
 * Req2PO core: requisition intake, quote reading + cross-check, PO coding rules,
 * invoice intake + matching + checks, and a MOCK ERP behind a small adapter.
 *
 * Everything here runs in Node (tests) and in the browser (demo). No network calls.
 * All vendor/job/PO data is fictional.
 *
 * ERP ADAPTER CONTRACT (what a real connector, for a legacy, closed ERP would implement):
 *   findVendor(name) -> {vendor, suggestion, score}
 *   getJob(id), getCostCode(code), getBudget(jobId, costCode)
 *   createPO(draft)            -> po (ERP assigns the PO number)
 *   getPO(number), findOpenPOs({vendorId, jobId})
 *   invoiceExists(vendorId, invoiceNo)
 *   postAPInvoice(invoice, po, journalEntry) -> voucher
 * MockERP below implements it in memory. A real adapter is NOT included.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- config
  const CFG = {
    taxRate: 0.07,          // fictional state + local rate on taxable purchases
    autoApproveMax: 5000,   // clean requisitions at or under this total skip human review
    quoteTolerance: 0.01,   // 1% between form price and quote subtotal
    invoiceTolerance: 5.0,  // dollars over remaining PO balance allowed
    taxTolerance: 0.05,     // dollars of rounding allowed on tax
    dupWindowDays: 14
  };

  const CATEGORIES = { M: 'Material', E: 'Equipment', S: 'Subcontract', L: 'Labor', O: 'Other' };
  const TYPE_TO_CAT = { material: 'M', equipment: 'E', subcontract: 'S', other: 'O' };
  const GL = {
    M: { acct: '5100', name: 'Job materials' },
    E: { acct: '5200', name: 'Equipment rental' },
    S: { acct: '5300', name: 'Subcontract costs' },
    L: { acct: '5400', name: 'Direct labor' },
    O: { acct: '5900', name: 'Other job costs' }
  };
  const TAXABLE_CATS = { M: true, E: true, O: true, S: false, L: false };

  /* ---------------------------------------------------------------- purchase classification
     Job-related purchases code themselves: the job and cost code decide the GL
     account. Overhead, SG&A and equipment have no such structure, so they get
     categorized by whoever happens to key the invoice. Phase 2 moves that
     decision to the requisition, before the purchase, and makes the two
     treatments that people get wrong explicit:
       - an asset bought above the capitalization threshold is capitalized and
         depreciated, not expensed;
       - a cost covering more than one period is carried as a prepaid expense
         and amortized across the periods it benefits.
     The system proposes. A person still decides. */
  const CAP_THRESHOLD = 2500;            // fictional capitalization policy
  const PREPAID = { acct: '1400', name: 'Prepaid expenses' };
  const PCLASS = {
    job:       { label: 'Job related (direct job cost)', needsJob: true, hint: 'Costs that belong to a job and appear in job cost.' },
    equipment: { label: 'Equipment', needsJob: false, hint: 'Owned equipment, vehicles, parts and repairs. May be capital.' },
    overhead:  { label: 'Overhead, indirect and operating expense', needsJob: false, hint: 'Runs the company rather than a job. SG&A.' }
  };
  const PTYPES = [
    { id: 'job_material',  cls: 'job',       label: 'Materials for a job',               gl: '5100', name: 'Job materials',           cat: 'M' },
    { id: 'job_sub',       cls: 'job',       label: 'Subcontract work',                  gl: '5300', name: 'Subcontract costs',       cat: 'S' },
    { id: 'job_rental',    cls: 'job',       label: 'Equipment rental for a job',        gl: '5200', name: 'Equipment rental',        cat: 'E' },
    { id: 'job_other',     cls: 'job',       label: 'Other job cost',                    gl: '5900', name: 'Other job costs',         cat: 'O' },
    { id: 'equip_buy',     cls: 'equipment', label: 'Equipment purchase (owned)',        gl: '6700', name: 'Equipment expense',       capital: true, life: '5 years' },
    { id: 'vehicle',       cls: 'equipment', label: 'Vehicle purchase',                  gl: '6700', name: 'Equipment expense',       capital: true, life: '5 years' },
    { id: 'equip_repair',  cls: 'equipment', label: 'Equipment repair',                  gl: '6400', name: 'Repairs and maintenance' },
    { id: 'equip_parts',   cls: 'equipment', label: 'Parts and small tools',             gl: '6410', name: 'Small tools and parts',   capital: true, life: '3 years' },
    { id: 'office',        cls: 'overhead',  label: 'Office supplies',                   gl: '6100', name: 'Office supplies' },
    { id: 'facility_rm',   cls: 'overhead',  label: 'Repairs and maintenance (facility)', gl: '6400', name: 'Repairs and maintenance' },
    { id: 'software',      cls: 'overhead',  label: 'Software or subscription',          gl: '6200', name: 'Software and subscriptions', periodic: true },
    { id: 'insurance',     cls: 'overhead',  label: 'Insurance',                         gl: '6300', name: 'Insurance',               periodic: true },
    { id: 'service',       cls: 'overhead',  label: 'Service or maintenance contract',   gl: '6400', name: 'Repairs and maintenance', periodic: true },
    { id: 'prof_fees',     cls: 'overhead',  label: 'Professional fees',                 gl: '6500', name: 'Professional fees' },
    { id: 'utilities',     cls: 'overhead',  label: 'Utilities',                         gl: '6600', name: 'Utilities',               periodic: true },
    { id: 'oh_other',      cls: 'overhead',  label: 'Other (explain)',                   gl: '6900', name: 'Other operating expense', needsReason: true }
  ];
  const ptypeById = function (id) { return PTYPES.filter(function (t) { return t.id === id; })[0] || null; };
  const CAPITAL_ACCT = { acct: '1500', name: 'Machinery and equipment' };


  // ---------------------------------------------------------------- helpers
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function pm(s) {
    if (s === null || s === undefined || s === '') return null;
    const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : n;
  }
  function usd(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function isoDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  function dayDiff(a, b) {
    return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
  }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const STOP = new Set(['inc', 'llc', 'co', 'corp', 'company', 'the', 'ltd', 'and']);
  function normName(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/).filter(function (t) { return t && !STOP.has(t); }).join(' ');
  }
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = []; for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  function similarity(a, b) {
    const na = normName(a), nb = normName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
    let inter = 0; ta.forEach(function (t) { if (tb.has(t)) inter++; });
    const jac = inter / (ta.size + tb.size - inter);
    const subset = (inter === ta.size || inter === tb.size) ? 0.9 : 0;
    const ratio = 1 - lev(na, nb) / Math.max(na.length, nb.length);
    return Math.max(jac, ratio, subset);
  }
  function normInvoiceNo(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  }
  function descOverlap(a, b) {
    const ta = (String(a).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    const tb = new Set(String(b).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    if (!ta.length || !tb.size) return 0;
    let hit = 0; ta.forEach(function (t) { if (tb.has(t)) hit++; });
    return hit / Math.min(ta.length, tb.size);
  }
  function sum(arr) { return r2(arr.reduce(function (s, x) { return s + x; }, 0)); }

  function expectedTax(job, category, subtotal) {
    if (!job || job.taxExempt) return 0;
    if (!TAXABLE_CATS[category]) return 0;
    return r2(subtotal * CFG.taxRate);
  }

  // ---------------------------------------------------------------- issue categories (reportable problems)
  // owner: 'purchaser' = the PO's project manager / original purchaser, 'setup' = vendor setup, 'ap' = the AP clerk
  const ISSUES = {
    EXTRACT:         { label: 'Could not read the invoice', owner: 'ap' },
    SPLIT:           { label: 'Multi-invoice split needs confirming', owner: 'ap' },
    VENDOR_UNKNOWN:  { label: 'Vendor not on the vendor list', owner: 'setup' },
    NO_PO:           { label: 'No purchase order found', owner: 'purchaser' },
    VENDOR_MISMATCH: { label: 'Vendor ID does not match the PO', owner: 'purchaser' },
    PO_CLOSED:       { label: 'PO is closed', owner: 'purchaser' },
    JOB_MISMATCH:    { label: 'Job does not match the PO', owner: 'purchaser' },
    DUPLICATE:       { label: 'Duplicate invoice', owner: 'ap' },
    MATH:            { label: 'Invoice does not add up', owner: 'purchaser' },
    TAX_RATE:        { label: 'Incorrect sales tax rate', owner: 'purchaser' },
    PO_SHORT:        { label: 'Not enough $ left on the PO', owner: 'purchaser' },
    TAX_SHORT:       { label: 'Sales tax does not match the PO', owner: 'purchaser' },
    FREIGHT:         { label: 'Freight not covered by the PO', owner: 'purchaser' },
    ITEM_MISMATCH:   { label: 'Billed items not on the PO', owner: 'purchaser' },
    DATE:            { label: 'Invoice date problem', owner: 'purchaser' },
    REVIEW_FOUND:    { label: 'Reviewer found a discrepancy', owner: 'purchaser' },
    ENTRY_FAILED:    { label: 'Bot entry did not match the invoice', owner: 'ap' },
    PM_REJECTED:     { label: 'Rejected by the PM after entry', owner: 'purchaser' }
  };
  const OVERRIDABLE = { ITEM_MISMATCH: true, DATE: true };   // differences a PM may accept as valid without changing the PO
  const JOB_PM = { '24-101': 'Priya Raman', '24-107': 'Marcus Webb', '23-088': 'Priya Raman' };
  function pad(n, w) { return String(n).padStart(w || 3, '0'); }
  function poRemaining(po) {
    return { sub: r2(po.subtotal - po.billedSub), tax: r2(po.tax - po.billedTax), freight: r2((po.freight || 0) - po.billedFreight), total: r2(po.total - po.billed) };
  }

  // ---------------------------------------------------------------- seed data (fictional)
  function seedData() {
    return {
      vendors: [
        { id: 'V100', name: 'Ridgeline Concrete Supply', aliases: ['Ridgeline Concrete'], emails: ['accounts@ridgelineconcrete.example'], folder: 'AP/Vendors/Ridgeline Concrete Supply', types: ['material', 'equipment'], terms: 'Net 30' },
        { id: 'V101', name: 'Summit Equipment Rentals', aliases: ['Summit Rentals'], emails: ['ar@summitrentals.example'], folder: 'AP/Vendors/Summit Equipment Rentals', types: ['equipment'], terms: 'Net 30' },
        { id: 'V102', name: 'Harbor Electrical Wholesale', aliases: [], emails: ['ar@harborelectric.example'], folder: 'AP/Vendors/Harbor Electrical Wholesale', types: ['material'], terms: 'Net 30' },
        { id: 'V103', name: 'Keystone Steel & Rebar', aliases: ['Keystone Steel'], emails: ['ar@keystonesteel.example'], folder: 'AP/Vendors/Keystone Steel and Rebar', types: ['material'], terms: 'Net 45' },
        { id: 'V104', name: 'Metro Safety Supply', aliases: [], emails: ['billing@metrosafety.example'], folder: 'AP/Vendors/Metro Safety Supply', types: ['material', 'other'], terms: 'Net 30' },
        { id: 'V105', name: 'Northgate Paving LLC', aliases: [], emails: [], folder: 'AP/Vendors/Northgate Paving', types: ['subcontract'], terms: 'Net 30' },
        { id: 'V106', name: 'Harbor Mechanical Services', aliases: [], emails: ['billing@harbormechanical.example'], folder: 'AP/Vendors/Harbor Mechanical Services', types: ['equipment', 'material'], terms: 'Net 30' }
      ],
      jobs: [
        { id: '24-101', name: 'Riverside Medical Office', status: 'open', taxExempt: false, pm: 'Priya Raman' },
        { id: '24-107', name: 'Elm Street Warehouse', status: 'open', taxExempt: true, pm: 'Marcus Webb' },
        { id: '23-088', name: 'County Library Renovation', status: 'closed', taxExempt: false, pm: 'Priya Raman' }
      ],
      costCodes: [
        { code: '01-500', desc: 'Temporary facilities and equipment', categories: ['E'] },
        { code: '01-560', desc: 'Safety and jobsite supplies', categories: ['M', 'O'] },
        { code: '03-300', desc: 'Cast-in-place concrete', categories: ['M', 'S', 'E'] },
        { code: '05-120', desc: 'Structural steel and rebar', categories: ['M', 'S'] },
        { code: '16-100', desc: 'Electrical', categories: ['M', 'S'] },
        { code: '31-200', desc: 'Earthwork', categories: ['S', 'E'] }
      ],
      budgets: {
        '24-101|01-500': { budget: 18000, committed: 4815 },
        '24-101|01-560': { budget: 9000, committed: 3200 + 1712 },
        '24-101|05-120': { budget: 30000, committed: 0 },
        '24-101|03-300': { budget: 85000, committed: 52000 + 9501.6 },
        '24-101|16-100': { budget: 42000, committed: 5350 },
        '24-107|05-120': { budget: 40000, committed: 38500 },
        '24-107|31-200': { budget: 25000, committed: 0 },
        '24-107|01-500': { budget: 20000, committed: 3600 }
      },
      pos: [
        mkPO('PO-26-0601', 'V100', '24-101', '03-300', 'M', '2026-10-05', [
          ['Ready-mix concrete 4000 PSI', 60, 'CY', 148.0]]),
        mkPO('PO-26-0604', 'V102', '24-101', '16-100', 'M', '2026-10-07', [
          ['Panelboard 200A 42-circuit', 1, 'EA', 2350.0],
          ['Breakers 20A single-pole', 30, 'EA', 35.0],
          ['EMT conduit 3/4 in', 800, 'LF', 2.0]], 2350.0, 85.0),
        mkPO('PO-26-0607', 'V101', '24-101', '01-500', 'E', '2026-10-09', [
          ['Scissor lift rental 4 weeks', 4, 'WK', 1125.0]], 2250.0),
        mkPO('PO-26-0611', 'V103', '24-107', '05-120', 'M', '2026-10-12', [
          ['Rebar #5 grade 60', 20000, 'LB', 0.5]], 0, 250.0),
        mkPO('PO-26-0612', 'V101', '24-107', '01-500', 'E', '2026-10-13', [
          ['Telehandler rental 2 weeks', 2, 'WK', 1800.0]]),
        mkPO('PO-26-0615', 'V104', '24-101', '01-560', 'M', '2026-10-14', [
          ['Safety netting and guardrail posts', 1, 'LS', 1600.0]])
      ],
      apInvoices: [
        { voucher: 'AP-26-0412', vendorId: 'V102', invoiceNo: 'HW-30418', invoiceNoNorm: normInvoiceNo('HW-30418'), date: '2026-10-15', total: 2514.5, poNumber: 'PO-26-0604' },
        { voucher: 'AP-26-0415', vendorId: 'V101', invoiceNo: 'SE-2201', invoiceNoNorm: normInvoiceNo('SE-2201'), date: '2026-10-20', total: 2407.5, poNumber: 'PO-26-0607' }
      ],
      poSeq: 617,
      voucherSeq: 417
    };
  }
  function mkPO(number, vendorId, jobId, costCode, category, created, lines, billedSub, freight) {
    const ls = lines.map(function (l) { return { desc: l[0], qty: l[1], unit: l[2], unitPrice: l[3], amount: r2(l[1] * l[3]) }; });
    const subtotal = sum(ls.map(function (l) { return l.amount; }));
    const taxable = jobId !== '24-107' && TAXABLE_CATS[category];
    const tax = taxable ? r2(subtotal * CFG.taxRate) : 0;
    const fr = freight || 0, bSub = billedSub || 0, bTax = taxable ? r2(bSub * CFG.taxRate) : 0;
    return {
      number: number, vendorId: vendorId, jobId: jobId, status: 'open', createdDate: created, dateNeeded: created,
      reqId: null, purchaser: JOB_PM[jobId] || 'Unassigned', lines: ls, subtotal: subtotal, tax: tax, freight: fr, total: r2(subtotal + tax + fr),
      billedSub: bSub, billedTax: bTax, billedFreight: 0, billed: r2(bSub + bTax),
      coding: { costCode: costCode, category: category, gl: GL[category].acct }
    };
  }

  // ---------------------------------------------------------------- vendor matching
  // Rules (written from the AP workflow): match against name AND every alias; ignore legal suffixes,
  // punctuation, "&" vs "and", dba wording; a branch suffix only counts if the list has that branch;
  // companies sharing one generic word are NOT a match; sender address is strong evidence, except
  // billing platforms (hint only) and internal forwards (ignored); ties and near-ties match nothing.
  const GENERIC = new Set(['supply', 'supplies', 'electric', 'electrical', 'mechanical', 'services', 'service', 'wholesale', 'equipment', 'rentals', 'rental', 'solutions', 'parts', 'building', 'group', 'industries', 'contracting', 'construction']);
  /* Invoices often arrive through a third-party billing portal rather than from
     the vendor's own domain, so the sender address is a hint about the vendor,
     never proof. Fictional domains here; a real build would list the portals
     that company actually receives mail from. */
  const PLATFORMS = ['billingportal.example', 'invoicehub.example', 'apexchange.example'];
  const INTERNAL_DOMAIN = '@ourcompany.example';
  function variants(s) {
    const out = [];
    String(s || '').split(/\s+(?:dba|d\/b\/a|t\/a)\s+/i).forEach(function (part) {
      out.push({ text: part, cap: 1 });
      const base = part.split(/\s[-\u2013]\s/)[0];
      if (base !== part) out.push({ text: base, cap: 0.95 });
    });
    return out;
  }
  function pairScore(a, b) {
    const na = normName(a), nb = normName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ta = na.split(' '), tb = nb.split(' ');
    const small = new Set(ta.length <= tb.length ? ta : tb), big = new Set(ta.length <= tb.length ? tb : ta);
    if (Array.from(small).every(function (t) { return big.has(t); })) {
      const extras = Array.from(big).filter(function (t) { return !small.has(t); });
      return extras.every(function (t) { return GENERIC.has(t); }) ? 0.9 : 0.5;
    }
    const ratio = 1 - lev(na, nb) / Math.max(na.length, nb.length);
    if (ratio >= 0.9) return 0.9;
    const sa = new Set(ta), sb = new Set(tb); let inter = 0; sa.forEach(function (t) { if (sb.has(t)) inter++; });
    return Math.min(Math.max(inter / (sa.size + sb.size - inter), ratio), 0.8);
  }
  function vendorScore(printed, v) {
    let best = 0;
    const listed = [v.name].concat(v.aliases || []).reduce(function (acc, n) { return acc.concat(variants(n).filter(function (x) { return x.cap === 1; }).map(function (x) { return x.text; })); }, []);
    variants(printed).forEach(function (pv) {
      listed.forEach(function (ln) { best = Math.max(best, Math.min(pairScore(pv.text, ln), pv.cap)); });
    });
    return best;
  }
  function matchVendor(printed, sender, vendors) {
    const s = String(sender || '').toLowerCase(), domain = s.split('@')[1] || '';
    const internal = s.endsWith(INTERNAL_DOMAIN);
    const platform = PLATFORMS.some(function (p) { return domain === p || domain.endsWith('.' + p); });
    const useEmail = !!s && !internal && !platform;
    const rows = vendors.map(function (v) {
      return { v: v, score: vendorScore(printed, v), email: useEmail && (v.emails || []).some(function (e) { return e.toLowerCase() === s; }) };
    });
    const byName = rows.slice().sort(function (a, b) { return b.score - a.score; });
    const emailRows = rows.filter(function (r) { return r.email; });
    const none = function (reason, sug) { return { vendor: null, confidence: 'none', reason: reason, suggestion: sug || null, score: byName[0] ? byName[0].score : 0 }; };
    if (emailRows.length === 1) {
      const er = emailRows[0];
      if (er.score >= 0.6) return { vendor: er.v, confidence: 'high', reason: 'sender address is on file for this vendor and the printed name is consistent', suggestion: null, score: er.score };
      if (byName[0].score >= 0.85) return none('sender address and printed name point to different vendors', byName[0].v);
      return { vendor: er.v, confidence: 'medium', reason: 'sender address is on file for this vendor but the printed name differs', suggestion: null, score: er.score };
    }
    const best = byName[0], second = byName[1];
    if (best.score >= 0.85) {
      if (second && second.score >= best.score - 0.03) return none('two vendors fit equally well', best.v);
      return best.score === 1
        ? { vendor: best.v, confidence: 'high', reason: 'printed name matches the vendor list', suggestion: null, score: 1 }
        : { vendor: best.v, confidence: 'medium', reason: 'printed name is a shortened or slightly different form of the listed name', suggestion: null, score: best.score };
    }
    return none('printed name is not on the vendor list', best.score >= 0.6 ? best.v : null);
  }

  // ---------------------------------------------------------------- mock ERP
  class MockERP {
    constructor(seed, wf) {
      const s = JSON.parse(JSON.stringify(seed));
      this.vendors = s.vendors; this.jobs = s.jobs; this.costCodes = s.costCodes; this.budgets = s.budgets;
      this.pos = s.pos; this.apInvoices = s.apInvoices; this.poSeq = s.poSeq; this.voucherSeq = s.voucherSeq;
      this.wf = wf;
    }
    findVendor(name, sender) { return matchVendor(name, sender, this.vendors); }
    getVendor(id) { return this.vendors.find(function (v) { return v.id === id; }) || null; }
    getJob(id) { return this.jobs.find(function (j) { return j.id === id; }) || null; }
    getCostCode(code) { return this.costCodes.find(function (c) { return c.code === code; }) || null; }
    getBudget(jobId, code) { return this.budgets[jobId + '|' + code] || null; }
    createPO(draft) {
      const number = 'PO-26-' + String(++this.poSeq).padStart(4, '0');
      const po = Object.assign({ number: number, status: 'open', billed: 0, billedSub: 0, billedTax: 0, billedFreight: 0, freight: 0, purchaser: JOB_PM[draft.jobId] || 'Unassigned' }, JSON.parse(JSON.stringify(draft)));
      this.pos.push(po);
      const b = this.getBudget(po.jobId, po.coding.costCode);
      if (b) b.committed = r2(b.committed + po.total);
      return po;
    }
    getPO(number) {
      const n = String(number || '').toUpperCase();
      return this.pos.find(function (p) { return p.number === n; }) || null;
    }
    findOpenPOs(q) {
      return this.pos.filter(function (p) {
        return p.status === 'open' && p.vendorId === q.vendorId && (!q.jobId || p.jobId === q.jobId) && r2(p.total - p.billed) > 0;
      });
    }
    invoiceExists(vendorId, invoiceNo) {
      const n = normInvoiceNo(invoiceNo);
      return this.apInvoices.find(function (i) { return i.vendorId === vendorId && i.invoiceNoNorm === n && i.status !== 'void'; }) || null;
    }
    // The bot enters a voucher, then reads it back. If the read-back does not match, the voucher is voided.
    enterVoucher(inv, po, je, mode, glitch) {
      const voucher = 'AP-26-' + String(++this.voucherSeq).padStart(4, '0');
      const rec = { voucher: voucher, vendorId: po.vendorId, invoiceNo: inv.invoiceNo, invoiceNoNorm: normInvoiceNo(inv.invoiceNo), date: inv.date,
        total: glitch ? r2(inv.total + 0.10) : inv.total, applied: { sub: inv.subtotal, tax: inv.tax, freight: inv.freight },
        poNumber: po.number, je: je, status: 'entered', mode: mode, pdfAttached: true };
      this.apInvoices.push(rec);
      po.billedSub = r2(po.billedSub + inv.subtotal); po.billedTax = r2(po.billedTax + inv.tax); po.billedFreight = r2(po.billedFreight + inv.freight);
      po.billed = r2(po.billedSub + po.billedTax + po.billedFreight);
      if (r2(po.total - po.billed) <= 0.005) po.status = 'closed';
      return rec;
    }
    readBack(voucher) { const r = this.apInvoices.find(function (i) { return i.voucher === voucher; }); return r ? { total: r.total, vendorId: r.vendorId, invoiceNo: r.invoiceNo, poNumber: r.poNumber } : null; }
    voidVoucher(voucher) {
      const r = this.apInvoices.find(function (i) { return i.voucher === voucher; });
      if (!r || r.status === 'void') return;
      const po = this.getPO(r.poNumber);
      po.billedSub = r2(po.billedSub - r.applied.sub); po.billedTax = r2(po.billedTax - r.applied.tax); po.billedFreight = r2(po.billedFreight - r.applied.freight);
      po.billed = r2(po.billedSub + po.billedTax + po.billedFreight);
      if (po.status === 'closed' && r2(po.total - po.billed) > 0.005) po.status = 'open';
      r.status = 'void';
    }
    approveVoucher(voucher) { const r = this.apInvoices.find(function (i) { return i.voucher === voucher; }); if (r) r.status = 'approved'; }
  }

  // ---------------------------------------------------------------- document parsing (built-in, rule-based)
  const AMT = '\\$?\\s*([\\d,]+\\.\\d{2})';
  function firstLine(lines) { return lines.length ? lines[0] : ''; }
  function parseTableLines(rawLines) {
    const out = [];
    rawLines.forEach(function (l) {
      const cols = l.split(/\s*\|\s*|\t+/);
      if (cols.length < 5) return;
      if (/^description$/i.test(cols[0].trim())) return;
      const qty = pm(cols[1]), unitPrice = pm(cols[3]), amount = pm(cols[4]);
      if (qty === null || unitPrice === null || amount === null) return;
      out.push({ desc: cols[0].trim(), qty: qty, unit: cols[2].trim(), unitPrice: unitPrice, amount: amount });
    });
    return out;
  }
  function parseCommon(text) {
    const raw = String(text || '').replace(/\r/g, '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    const out = { vendorName: firstLine(raw), date: null, jobId: null, project: '', lines: [], subtotal: null, tax: null, freight: null, total: null, taxPct: null };
    const dm = []; const re = /(\bdue\s+|\bship\s+)?\bdate\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/gi; let m;
    while ((m = re.exec(text))) { if (!m[1]) dm.push(m[2]); }
    out.date = isoDate(dm[0]);
    raw.forEach(function (l) {
      let x;
      if ((x = l.match(/^(?:project|job)\s*[:\-]?\s*(.+)$/i))) {
        out.project = x[1].trim();
        const j = x[1].match(/\b(\d{2}-\d{3})\b/); if (j) out.jobId = j[1];
      }
      if ((x = l.match(new RegExp('^subtotal\\s*[:\\-]?\\s*' + AMT, 'i')))) out.subtotal = pm(x[1]);
      if ((x = l.match(new RegExp('^(?:sales\\s*)?tax(?:\\s*\\(([\\d.]+)%\\))?\\s*[:\\-]?\\s*' + AMT, 'i')))) { out.tax = pm(x[2]); if (x[1]) out.taxPct = parseFloat(x[1]); }
      if ((x = l.match(new RegExp('^(?:freight|shipping|delivery|handling)(?:\\s*charges?)?\\s*[:\\-]?\\s*' + AMT, 'i')))) out.freight = pm(x[1]);
      if ((x = l.match(new RegExp('^(?:total(?:\\s*due)?|amount\\s*due|grand\\s*total)\\s*[:\\-]?\\s*' + AMT, 'i')))) out.total = pm(x[1]);
    });
    out.lines = parseTableLines(raw);
    return out;
  }
  function parseQuoteText(text) {
    const c = parseCommon(text);
    const q = text.match(/quote\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Z0-9\-]+)/i);
    const v = text.match(/valid\s*(?:through|until|thru)\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    c.docNo = q ? q[1] : '';
    c.validThrough = v ? isoDate(v[1]) : null;
    return c;
  }
  function parseInvoiceText(text) {
    const c = parseCommon(text);
    const n = text.match(/invoice\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-]*)/i);
    c.invoiceNo = n ? n[1] : '';
    let po = null;
    const strict = text.match(/\b(PO-\d{2}-\d{4})\b/i);
    if (strict) po = strict[1].toUpperCase();
    else {
      const loose = text.match(/\b(?:P\.?O\.?|purchase\s+order)\s*(?:#|no\.?|number)?\s*[:\-]\s*([A-Z0-9][A-Z0-9\-]{2,})/i);
      if (loose) po = loose[1].toUpperCase();
    }
    c.poRef = po;
    return c;
  }
  function normalizeInvoice(inv) {
    inv.tax = inv.tax === null || inv.tax === undefined ? 0 : inv.tax;
    inv.freight = inv.freight === null || inv.freight === undefined ? 0 : inv.freight;
    if ((inv.subtotal === null || inv.subtotal === undefined) && inv.total !== null && inv.total !== undefined) inv.subtotal = r2(inv.total - inv.tax - inv.freight);
    inv.lines = inv.lines || [];
    return inv;
  }
  function classifyDocument(email) {
    if (email.manual) return 'invoice';
    const att = email.attachment;
    const pages = att ? (att.pages || [att.text]) : [];
    const head = pages.length ? String(pages[0]).split('\n').slice(0, 6).join('\n') : '';
    if (/\b(past due|second notice|final notice|overdue|payment reminder|friendly reminder)\b/i.test((email.subject || '') + '\n' + head)) return 'reminder';
    if (att && /\bstatement\b/i.test(head)) return 'statement';
    if (att && looksLikeInvoice(pages.join('\n'))) return 'invoice';
    return 'correspondence';
  }
  // Splits one PDF (an array of page texts) into invoices. A page with a new invoice number starts a new invoice;
  // a page with the same number, or no number, continues the current one. Unmarked continuation pages are flagged.
  function splitPages(pages) {
    const segs = []; let cur = null;
    pages.forEach(function (txt, i) {
      const m = String(txt).match(/invoice\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-]*)/i);
      const key = m ? normInvoiceNo(m[1]) : null;
      const marked = /\bcontinued\b|\bpage\s+\d+\s+of\s+\d+\b/i.test(txt);
      if (cur && (key === null || key === cur.key)) {
        cur.end = i + 1; cur.pages.push(txt);
        if (key === null && !marked) { cur.confident = false; cur.note = 'Page ' + (i + 1) + ' has no invoice number and no "continued" marker. It was attached to the previous invoice. Confirm the split.'; }
      } else {
        cur = { start: i + 1, end: i + 1, pages: [txt], key: key, confident: key !== null, note: key === null ? 'The first page has no invoice number.' : '' };
        segs.push(cur);
      }
    });
    return segs;
  }
  function checkSplit(segs, n) {
    let next = 1;
    for (let i = 0; i < segs.length; i++) { if (segs[i].start !== next || segs[i].end < segs[i].start) return false; next = segs[i].end + 1; }
    return segs.length > 0 && next === n + 1;
  }
  function looksLikeInvoice(text) {
    const head = String(text || '').split('\n').slice(0, 12).join('\n');
    return /\binvoice\b/i.test(head) && /invoice\s*(?:#|no\.?|number)\s*[:\-]?\s*[A-Z0-9]/i.test(text) && /total/i.test(text);
  }

  // ---------------------------------------------------------------- requisition validation
  function validateRequisition(form, quote, wf) {
    const erp = wf.erp, errors = [], flags = [];
    const need = function (f, label) { if (form[f] === undefined || form[f] === null || String(form[f]).trim() === '') errors.push({ field: f, msg: label + ' is required.' }); };
    need('vendorName', 'Vendor'); need('dateNeeded', 'Date needed'); need('type', 'Purchase type');
    need('subtype', 'What is being purchased');
    /* What is being bought decides what else the form has to answer. A job
       purchase needs a job and a cost code; an overhead or equipment purchase
       needs a purchase type, because that is what sets the GL account. */
    const cls = form.purchaseClass || 'job';
    if (!PCLASS[cls]) errors.push({ field: 'purchaseClass', msg: 'Choose what kind of purchase this is.' });
    const pt = form.ptype ? ptypeById(form.ptype) : null;
    if (cls === 'job') {
      need('jobId', 'Job number'); need('costCode', 'Cost code'); need('category', 'Cost category');
    } else {
      if (!form.ptype) errors.push({ field: 'ptype', msg: 'Choose what is being purchased, so it can be coded.' });
      else if (!pt) errors.push({ field: 'ptype', msg: 'That purchase type is not on the list.' });
      else if (pt.needsReason && !String(form.otherReason || '').trim()) errors.push({ field: 'otherReason', msg: 'Explain what this is, so it can be categorized and reviewed.' });
      if (form.jobId && String(form.jobId).trim()) errors.push({ field: 'jobId', msg: 'A ' + PCLASS[cls].label.toLowerCase() + ' purchase does not belong to a job. Clear the job number, or change the purchase to job related.' });
    }
    const price = pm(form.price);
    if (price === null || price <= 0) errors.push({ field: 'price', msg: 'Enter an estimated price before tax, greater than zero.' });
    const job = form.jobId ? erp.getJob(form.jobId) : null;
    if (form.jobId && !job) errors.push({ field: 'jobId', msg: 'Job ' + form.jobId + ' is not in the job master.' });
    if (job && job.status !== 'open') errors.push({ field: 'jobId', msg: 'Job ' + job.id + ' (' + job.name + ') is closed. Costs cannot be committed to it.' });
    const cc = form.costCode ? erp.getCostCode(form.costCode) : null;
    if (form.costCode && !cc) errors.push({ field: 'costCode', msg: 'Cost code ' + form.costCode + ' is not in the cost code master.' });
    if (form.category && !CATEGORIES[form.category]) errors.push({ field: 'category', msg: 'Choose a valid cost category.' });
    if (form.dateNeeded && !isoDate(form.dateNeeded)) errors.push({ field: 'dateNeeded', msg: 'Enter the date needed as a valid date.' });
    if (errors.length) return { errors: errors, flags: [], vendor: null, amounts: null };

    const vm = erp.findVendor(form.vendorName);
    const vendor = vm.vendor;
    if (!vendor) {
      flags.push({ code: 'NEW_VENDOR', msg: '"' + form.vendorName + '" is not in the vendor master' + (vm.suggestion ? ' (closest match: ' + vm.suggestion.name + ')' : '') + '.', fix: 'Set up the vendor (W-9, terms) before a PO can be issued.' });
    } else {
      if (vm.confidence === 'medium') flags.push({ code: 'VENDOR_UNSURE', msg: '"' + form.vendorName + '" only partly matches ' + vendor.name + '.', fix: 'Confirm it is the same company.' });
      if (vendor.types.indexOf(form.type) < 0) flags.push({ code: 'VENDOR_TYPE', msg: vendor.name + ' is not set up to supply ' + form.type + '.', fix: 'Confirm the vendor and purchase type.' });
    }
    if (isoDate(form.dateNeeded) < wf.today) flags.push({ code: 'DATE_PAST', msg: 'Date needed (' + form.dateNeeded + ') is already past.', fix: 'Confirm the purchase was not already made without a PO.' });
    if (cc && cc.categories.indexOf(form.category) < 0) {
      flags.push({ code: 'CATEGORY_MISMATCH', msg: 'Cost code ' + cc.code + ' (' + cc.desc + ') does not allow category ' + CATEGORIES[form.category] + '.', fix: 'Allowed: ' + cc.categories.map(function (k) { return CATEGORIES[k]; }).join(', ') + '.' });
    }
    if (cls === 'job' && TYPE_TO_CAT[form.type] && TYPE_TO_CAT[form.type] !== form.category) {
      flags.push({ code: 'TYPE_MISMATCH', msg: 'Purchase type "' + form.type + '" does not match category ' + CATEGORIES[form.category] + '.', fix: 'Confirm which one is right; coding follows the category.' });
    }
    if (pt && pt.cls !== cls) {
      flags.push({ code: 'CLASS_TYPE', msg: '"' + pt.label + '" is a ' + PCLASS[pt.cls].label.toLowerCase() + ' purchase, but this is marked ' + PCLASS[cls].label.toLowerCase() + '.', fix: 'Confirm which it is. The class decides whether it hits a job or the GL.' });
    }

    let subtotal = price, quoteTax = null;
    if (quote) {
      if (quote.lines && quote.lines.length) subtotal = sum(quote.lines.map(function (l) { return l.amount; }));
      quoteTax = quote.tax;
      const qs = quote.subtotal !== null && quote.subtotal !== undefined ? quote.subtotal : subtotal;
      if (!quote.lines.length || quote.total === null) flags.push({ code: 'QUOTE_UNREADABLE', msg: 'Could not read line items or a total from the quote.', fix: 'Reviewer to read the quote manually.' });
      const qv = erp.findVendor(quote.vendorName).vendor;
      if (vendor ? !qv || qv.id !== vendor.id : similarity(quote.vendorName, form.vendorName) < 0.85) flags.push({ code: 'QUOTE_VENDOR', msg: 'Quote is from "' + quote.vendorName + '" but the form says "' + form.vendorName + '".', fix: 'Confirm the right vendor.' });
      if (Math.abs(qs - price) > price * CFG.quoteTolerance) flags.push({ code: 'QUOTE_PRICE', msg: 'Quote subtotal ' + usd(qs) + ' does not match the form price ' + usd(price) + '.', fix: 'PO will be written from the quote. Confirm the scope with the PM.' });
      const lineBad = quote.lines.some(function (l) { return Math.abs(r2(l.qty * l.unitPrice) - l.amount) > 0.011; });
      const subBad = quote.subtotal !== null && quote.lines.length && Math.abs(sum(quote.lines.map(function (l) { return l.amount; })) - quote.subtotal) > 0.011;
      const totBad = quote.total !== null && quote.subtotal !== null && quote.tax !== null && Math.abs(r2(quote.subtotal + quote.tax) - quote.total) > 0.011;
      if (lineBad || subBad || totBad) flags.push({ code: 'QUOTE_MATH', msg: 'The quote does not add up (' + [lineBad ? 'line extensions' : '', subBad ? 'subtotal' : '', totBad ? 'total' : ''].filter(Boolean).join(', ') + ').', fix: 'Ask the vendor for a corrected quote.' });
      const exp = cls === 'job' ? expectedTax(job, form.category, subtotal) : r2(subtotal * CFG.taxRate);
      if (quote.tax !== null && Math.abs(quote.tax - exp) > CFG.taxTolerance) {
        flags.push({ code: 'QUOTE_TAX', msg: 'Quote charges ' + usd(quote.tax) + ' tax; ' + (job && job.taxExempt ? 'job ' + job.id + ' is tax-exempt' : 'the rule expects ' + usd(exp)) + '.', fix: 'The PO is written with ' + usd(exp) + ' tax. Ask the vendor to correct the quote.' });
      }
      if (quote.validThrough && quote.validThrough < wf.today) flags.push({ code: 'QUOTE_EXPIRED', msg: 'Quote expired on ' + quote.validThrough + '.', fix: 'Ask the vendor to reissue.' });
      if (quote.jobId && job && quote.jobId !== job.id) flags.push({ code: 'QUOTE_JOB', msg: 'Quote references job ' + quote.jobId + ' but the form says ' + job.id + '.', fix: 'Confirm the job.' });
    } else if (price >= 2500) {
      flags.push({ code: 'NO_QUOTE', msg: 'No quote attached for a purchase of ' + usd(price) + '.', fix: 'Attach the vendor quote.' });
    }

    const tax = cls === 'job' ? expectedTax(job, form.category, subtotal) : r2(subtotal * CFG.taxRate);
    const amounts = { subtotal: r2(subtotal), tax: tax, total: r2(subtotal + tax) };

    /* Treatment. Both of these are decided here, before the PO exists, rather
       than argued about at close. */
    let treatment = { kind: 'expense', acct: pt ? pt.gl : (form.category ? GL[form.category].acct : '5900'), name: pt ? pt.name : (form.category ? GL[form.category].name : 'Other job costs') };
    const months = Number(form.coversMonths) || 0;
    if (pt && pt.capital && amounts.subtotal >= CAP_THRESHOLD) {
      treatment = { kind: 'capital', acct: CAPITAL_ACCT.acct, name: CAPITAL_ACCT.name, life: pt.life };
      flags.push({ code: 'CAPITALIZE', msg: usd(amounts.subtotal) + ' is at or above the ' + usd(CAP_THRESHOLD) + ' capitalization threshold for ' + pt.label.toLowerCase() + '.', fix: 'Code to ' + CAPITAL_ACCT.acct + ' ' + CAPITAL_ACCT.name + ' and depreciate over ' + (pt.life || 'its useful life') + ', rather than expensing it this period.' });
    }
    if (months > 1) {
      treatment = { kind: 'prepaid', acct: PREPAID.acct, name: PREPAID.name, months: months, to: treatment.acct, toName: treatment.name };
      flags.push({ code: 'PREPAID', msg: 'This covers ' + months + ' months, so expensing it in one period overstates this month and understates the rest.', fix: 'Record to ' + PREPAID.acct + ' ' + PREPAID.name + ' and amortize ' + usd(r2(amounts.subtotal / months)) + ' a month to ' + treatment.to + ' ' + treatment.toName + '.' });
    } else if (pt && pt.periodic && !months) {
      flags.push({ code: 'PERIOD_UNKNOWN', msg: pt.label + ' usually covers a period, but no period was given.', fix: 'Enter the number of months it covers, so it is expensed or carried as prepaid correctly.' });
    }
    /* Anything that is not a job cost is categorized by a person before it goes
       anywhere. The system proposes the coding; it does not decide it. */
    if (cls !== 'job') {
      flags.push({ code: 'CATEGORIZE', msg: 'Categorization review: coded as ' + treatment.acct + ' ' + treatment.name + (pt ? ' (' + pt.label + ')' : '') + (form.otherReason ? '. Stated reason: ' + form.otherReason : '') + '.', fix: 'A person confirms the category before the PO is issued. Overhead coding is not auto-approved.' });
    }

    const b = cls === 'job' && job && cc ? erp.getBudget(job.id, cc.code) : null;
    if (cls === 'job') {
      if (b && amounts.total > r2(b.budget - b.committed)) {
        flags.push({ code: 'OVER_BUDGET', msg: 'Adds ' + usd(amounts.total) + ' to ' + job.id + ' / ' + cc.code + ', which has only ' + usd(r2(b.budget - b.committed)) + ' budget left.', fix: 'PM to confirm a budget transfer or change order.' });
      } else if (!b) {
        flags.push({ code: 'NO_BUDGET', msg: 'No budget line exists for ' + job.id + ' / ' + cc.code + '.', fix: 'Add the budget line or correct the cost code.' });
      }
    }

    if (vendor) {
      const dupe = wf.reqs.concat(erp.pos.map(function (p) { return { id: p.number, vendorId: p.vendorId, form: { jobId: p.jobId }, amounts: { total: p.total }, status: 'po', submittedAt: null, created: p.createdDate }; }))
        .find(function (r) {
          if (r.status === 'returned' || r.status === 'rejected') return false;
          if (r.vendorId !== vendor.id || r.form.jobId !== (job ? job.id : undefined)) return false;
          if (Math.abs(r.amounts.total - amounts.total) > amounts.total * 0.01) return false;
          const when = r.created || (r.submittedAt ? new Date(r.submittedAt).toISOString().slice(0, 10) : wf.today);
          return Math.abs(dayDiff(wf.today, when)) <= CFG.dupWindowDays;
        });
      if (dupe) flags.push({ code: 'DUPLICATE', msg: 'Looks like ' + dupe.id + ' (same vendor, job and amount within ' + CFG.dupWindowDays + ' days).', fix: 'Confirm this is not a double order.' });
    }
    if (amounts.total > CFG.autoApproveMax) flags.push({ code: 'OVER_LIMIT', msg: 'Total ' + usd(amounts.total) + ' is over the ' + usd(CFG.autoApproveMax) + ' auto-approval limit.', fix: 'Reviewer approval required.' });

    return { errors: errors, flags: flags, vendor: vendor, job: job, cc: cc, amounts: amounts, quoteTax: quoteTax, pclass: cls, ptype: pt, treatment: treatment };
  }

  // ---------------------------------------------------------------- workflow (requisitions + invoices)
  class Workflow {
    constructor(opts) {
      opts = opts || {};
      this.today = opts.today || todayISO();
      this.erp = new MockERP(seedData(), this);
      this.reqs = []; this.reqSeq = 1000;
      this.mails = []; this.mailSeq = 0;
      this.invoices = []; this.invSeq = 0;
      this.statements = []; this.followUps = []; this.library = [];
      this.issueLog = []; this.issSeq = 0; this.glitch = false;
      this.audit = [];
    }
    log(actor, action, ref, detail) {
      this.audit.unshift({ ts: Date.now(), actor: actor, action: action, ref: ref || '', detail: detail || '' });
    }

    // ---- requisitions
    submitRequisition(form, quote) {
      const v = validateRequisition(form, quote || null, this);
      if (v.errors.length) return { ok: false, errors: v.errors };
      const req = {
        id: 'REQ-' + (++this.reqSeq), form: Object.assign({}, form, { price: pm(form.price) }), quote: quote || null,
        flags: v.flags, vendorId: v.vendor ? v.vendor.id : null, vendorName: v.vendor ? v.vendor.name : form.vendorName,
        jobName: v.job ? v.job.name : PCLASS[v.pclass].label, pclass: v.pclass, ptype: v.ptype, treatment: v.treatment,
        amounts: v.amounts, status: 'needs_review', poNumber: null, note: '', submittedAt: Date.now()
      };
      this.reqs.unshift(req);
      this.log('Requester', 'Submitted requisition', req.id, req.vendorName + ' / ' + (form.jobId || PCLASS[v.pclass].label) + ' / ' + usd(req.amounts.total));
      if (req.flags.length === 0) {
        this.log('Rules engine', 'All checks passed, under auto-approval limit', req.id);
        this.botCreatePO(req);
      } else {
        this.log('Rules engine', 'Routed to reviewer (' + req.flags.map(function (f) { return f.code; }).join(', ') + ')', req.id);
      }
      return { ok: true, req: req };
    }
    buildPODraft(req) {
      const f = req.form, q = req.quote;
      const lines = q && q.lines && q.lines.length ? q.lines.map(function (l) { return Object.assign({}, l); })
        : [{ desc: f.subtype, qty: 1, unit: 'LS', unitPrice: req.amounts.subtotal, amount: req.amounts.subtotal }];
      const vendor = this.erp.getVendor(req.vendorId);
      return {
        vendorId: req.vendorId, jobId: f.jobId, createdDate: this.today, dateNeeded: f.dateNeeded, reqId: req.id,
        lines: lines, subtotal: req.amounts.subtotal, tax: req.amounts.tax, total: req.amounts.total,
        terms: vendor ? vendor.terms : '', quoteRef: q ? q.docNo : '',
        coding: (req.pclass && req.pclass !== 'job')
          ? { costCode: null, category: null, gl: req.treatment.acct, glName: req.treatment.name, pclass: req.pclass, ptype: req.ptype ? req.ptype.id : null, treatment: req.treatment.kind }
          : { costCode: f.costCode, category: f.category, gl: GL[f.category].acct }
      };
    }
    botCreatePO(req, actor) {
      if (!req.vendorId) throw new Error('Vendor must exist in the vendor master before a PO is created.');
      const po = this.erp.createPO(this.buildPODraft(req));
      req.status = 'po_created'; req.poNumber = po.number;
      this.log(actor || 'ERP bot', 'Created PO in ERP (ERP assigned the number)', req.id, po.number + ' / GL ' + po.coding.gl + ' / ' + usd(po.total));
      return po;
    }
    approveRequisition(id, note, overrideVendorId) {
      const req = this.reqs.find(function (r) { return r.id === id; });
      if (!req) return null;
      if (overrideVendorId) { req.vendorId = overrideVendorId; req.vendorName = this.erp.getVendor(overrideVendorId).name; }
      if (!req.vendorId) return { error: 'Set up the vendor first.' };
      req.note = note || '';
      this.log('Reviewer', 'Approved requisition', req.id, note || 'No note');
      return { po: this.botCreatePO(req) };
    }
    returnRequisition(id, note) {
      const req = this.reqs.find(function (r) { return r.id === id; });
      req.status = 'returned'; req.note = note || '';
      this.log('Reviewer', 'Returned to requester', id, note || '');
    }
    rejectRequisition(id, note) {
      const req = this.reqs.find(function (r) { return r.id === id; });
      req.status = 'rejected'; req.note = note || '';
      this.log('Reviewer', 'Rejected requisition', id, note || '');
    }

    // ---- Phase 1: AP inbox -> invoices
    getInv(id) { return this.invoices.find(function (r) { return r.id === id; }); }
    invoicesFor(mail) { const self = this; return mail.invoiceIds.map(function (id) { return self.getInv(id); }); }
    ownerFor(res, code) {
      const kind = ISSUES[code] ? ISSUES[code].owner : 'ap';
      if (kind === 'setup') return 'Vendor setup (Purchasing)';
      if (kind === 'ap') return 'AP clerk';
      if (res.po && res.po.purchaser) return res.po.purchaser;
      const job = res.invoice && res.invoice.jobId ? this.erp.getJob(res.invoice.jobId) : null;
      return job && job.pm ? job.pm : 'Choose a project manager';
    }
    processEmail(email) {
      const mail = { id: 'M-' + pad(++this.mailSeq), email: email, docType: null, vendor: null, vendorMatch: null, folder: null, steps: [], invoiceIds: [], note: '' };
      this.mails.unshift(mail);
      const att = email.attachment, pages = att ? (att.pages || [att.text]) : [];
      mail.pageCount = pages.length;
      mail.docType = classifyDocument(email);
      const names = { invoice: 'Invoice', statement: 'Vendor statement', reminder: 'Payment reminder', correspondence: 'General correspondence' };
      mail.steps.push({ name: 'Classify', ok: true, detail: names[mail.docType] });
      this.log('Inbox bot', 'Classified email as ' + names[mail.docType].toLowerCase(), mail.id, email.subject);
      if (mail.docType === 'invoice') return this.intakeInvoices(mail, pages);
      const printed = att ? String(pages[0]).split('\n')[0].trim() : (email.fromName || '');
      const vm = this.erp.findVendor(printed, email.from);
      mail.vendorMatch = vm; mail.vendor = vm.confidence === 'high' ? vm.vendor : null;
      const sub = mail.docType === 'statement' ? 'Statements' : 'Correspondence';
      mail.folder = mail.vendor ? mail.vendor.folder + '/' + sub : 'AP/General inbox (needs review)';
      mail.steps.push({ name: 'File', ok: !!mail.vendor, detail: mail.vendor ? 'Matched ' + mail.vendor.name + '. Filed to ' + mail.folder : 'No confident vendor match. Left in ' + mail.folder });
      const text = pages.join('\n');
      if (att) {
        const lib = 'AP Library/' + sub + '/' + (mail.vendor ? mail.vendor.name : 'Unmatched') + '/' + att.name;
        this.library.push({ path: lib, kind: names[mail.docType], mailId: mail.id });
        mail.libraryPath = lib;
      }
      if (mail.docType === 'statement') {
        const per = text.match(/period\s*[:\-]?\s*(.+)/i);
        this.statements.unshift({ id: 'ST-' + pad(this.statements.length + 1), mailId: mail.id, vendor: mail.vendor ? mail.vendor.name : printed, period: per ? per[1].trim() : '', file: mail.libraryPath, receivedAt: Date.now() });
        mail.steps.push({ name: 'Queue', ok: true, detail: 'Saved for Phase 3 statement reconciliation. Nothing is entered.' });
      }
      if (mail.docType === 'reminder') {
        const no = parseInvoiceText(text).invoiceNo;
        const found = mail.vendor && no ? this.erp.invoiceExists(mail.vendor.id, no) : null;
        this.followUps.unshift({ id: 'FU-' + pad(this.followUps.length + 1), mailId: mail.id, vendor: mail.vendor ? mail.vendor.name : printed, invoiceNo: no || '(none found)', found: !!found, voucher: found ? found.voucher : null,
          note: found ? 'Invoice ' + no + ' is already entered as ' + found.voucher + '. No action needed.' : 'Invoice ' + (no || '?') + ' is not in the ERP. The original may be missing from the inbox.', needsAction: !found });
        mail.steps.push({ name: 'Check', ok: !!found, detail: this.followUps[0].note });
      }
      if (mail.docType === 'correspondence') mail.steps.push({ name: 'Route', ok: true, detail: 'Filed with the vendor. No invoice found, so nothing is extracted.' });
      return mail;
    }
    intakeInvoices(mail, pages) {
      const email = mail.email;
      const segs = email.manual ? [{ start: 1, end: 1, pages: ['(Manual entry, no PDF)'], key: null, confident: true, note: '' }] : splitPages(pages);
      const range = function (g) { return g.start === g.end ? 'p' + g.start : 'p' + g.start + '-' + g.end; };
      mail.steps.push({ name: 'Split', ok: email.manual ? true : (checkSplit(segs, pages.length) && segs.every(function (g) { return g.confident; })),
        detail: email.manual ? 'Manual entry' : (segs.length === 1 ? 'One invoice (' + range(segs[0]) + ')' : segs.length + ' invoices found in ' + pages.length + ' pages: ' + segs.map(range).join(', ')) + (segs.every(function (g) { return g.confident; }) ? '' : '. Needs confirming.') });
      const self = this;
      segs.forEach(function (seg) {
        const inv = email.manual ? normalizeInvoice(Object.assign({ lines: [] }, email.manual)) : normalizeInvoice(segs.length === 1 && email.parsed ? email.parsed : parseInvoiceText(seg.pages.join('\n')));
        const vm = self.erp.findVendor(inv.vendorName, email.from);
        const res = { id: 'IN-' + pad(++self.invSeq), mailId: mail.id, email: email, seg: seg, pageText: seg.pages.join('\n'), multi: segs.length > 1, invoice: inv,
          status: 'reportable', vendor: vm.confidence === 'high' ? vm.vendor : null, vendorMatch: vm, renamed: null, libraryPath: null, po: null, matchMethod: null, suggestions: [], checks: [], reasons: [], manualReasons: [],
          comparison: [], steps: [], je: null, voucher: null, entryMode: email.manual ? 'manual' : 'bot', source: email.manual ? 'manual' : 'email', assignment: null, responses: [], override: null, assignedPO: null, hold: null, suggestedOwner: null, createdAt: Date.now() };
        res.steps.push({ name: 'Extract', ok: true, detail: 'Invoice ' + (inv.invoiceNo || '?') + ', ' + usd(inv.total) + ', PO ref ' + (inv.poRef || 'none') });
        self.invoices.unshift(res); mail.invoiceIds.push(res.id);
        self.evaluateInvoice(res);
      });
      const first = this.getInv(mail.invoiceIds[0]);
      mail.vendor = first.vendor; mail.vendorMatch = first.vendorMatch;
      mail.folder = first.vendor ? first.vendor.folder + '/Invoices' : 'AP/General inbox (needs review)';
      mail.steps.push({ name: 'File', ok: !!first.vendor, detail: first.vendor ? 'Matched ' + first.vendor.name + ' (' + first.vendorMatch.reason + '). Filed to ' + mail.folder : 'No confident vendor match. Left in ' + mail.folder });
      return mail;
    }

    // Every check uses its issue code as its id, so a failed check IS the reportable issue category.
    runChecks(res) {
      const inv = res.invoice, vendor = res.vendor, erp = this.erp, vmx = res.vendorMatch, today = this.today, self = this;
      const out = { checks: [], reasons: [], po: null, method: null, suggestions: [], comparison: [] };
      const ov = (res.override && res.override.codes) || [];
      const add = function (code, label, ok, detail, extra) {
        if (!ok && ov.indexOf(code) >= 0) { out.checks.push({ id: code, label: label, ok: true, accepted: true, detail: 'Accepted by ' + res.override.by + ' (' + res.override.reason + '). Original finding: ' + detail }); return; }
        out.checks.push({ id: code, label: label, ok: ok, detail: detail });
        if (!ok) out.reasons.push(Object.assign({ id: code, label: ISSUES[code].label, detail: detail }, extra || {}));
      };
      const missing = [];
      if (!inv.invoiceNo) missing.push('invoice number'); if (!inv.date) missing.push('date'); if (inv.total === null || inv.total === undefined) missing.push('total'); if (!inv.vendorName) missing.push('vendor name');
      add('EXTRACT', 'Key fields were read', !missing.length, missing.length ? 'Missing: ' + missing.join(', ') : 'Vendor, invoice number, date and total found');
      add('SPLIT', 'Page range is confident', res.seg.confident, res.seg.confident ? 'Pages ' + res.seg.start + ' to ' + res.seg.end : res.seg.note);
      add('VENDOR_UNKNOWN', 'Vendor is on the vendor list', !!vendor,
        vendor ? vendor.name + ' (' + vmx.reason + ')' : (vmx.vendor ? 'Probably ' + vmx.vendor.name + ', but the ' + vmx.reason + '. Confirm before posting.' :
          '"' + inv.vendorName + '" is not on the vendor list' + (vmx.suggestion ? ' (closest: ' + vmx.suggestion.name + ')' : '') + '. ' + vmx.reason + '.'));
      const assigned = res.assignedPO;
      let po = null, method = null;
      if (assigned) { po = erp.getPO(assigned); method = res.confirmedBy ? 'confirmed by ' + res.confirmedBy : (res.poEnteredBy ? 'PO number keyed by ' + res.poEnteredBy + ' (missing from the invoice)' : 'confirmed by the project manager'); }
      else if (inv.poRef) { po = erp.getPO(inv.poRef); method = po ? 'PO number on the invoice' : null; }
      if (!po && vendor) {
        out.suggestions = erp.findOpenPOs({ vendorId: vendor.id, jobId: inv.jobId }).sort(function (x, y) {
          return Math.abs(poRemaining(x).total - inv.total) - Math.abs(poRemaining(y).total - inv.total); });
      }
      out.po = po; out.method = method;
      if (!po) {
        const sug = out.suggestions[0];
        add('NO_PO', 'Invoice matches a purchase order', false, inv.poRef ? 'PO "' + inv.poRef + '" does not exist in the ERP.' : 'No PO number on the invoice.' +
          (sug ? ' Possible match: ' + sug.number + ' (' + usd(poRemaining(sug).total) + ' left). Only the project manager can confirm it.' : ''));
      } else {
        add('NO_PO', 'Invoice matches a purchase order', true, po.number + ' via ' + method);
        add('VENDOR_MISMATCH', 'Vendor ID matches the PO', !!vendor && vendor.id === po.vendorId,
          vendor ? (vendor.id === po.vendorId ? 'Vendor ID ' + vendor.id + ' on both' : 'Invoice vendor is ' + vendor.id + ' (' + vendor.name + '); ' + po.number + ' was issued to ' + po.vendorId + ' (' + (erp.getVendor(po.vendorId) || {}).name + ')') : 'Invoice vendor could not be identified');
        add('PO_CLOSED', 'PO is open', po.status === 'open', po.status === 'open' ? 'Open' : po.number + ' is ' + po.status);
        if (inv.jobId) add('JOB_MISMATCH', 'Job on the invoice matches the PO', inv.jobId === po.jobId, inv.jobId === po.jobId ? 'Job ' + po.jobId : 'Invoice says ' + inv.jobId + '; the PO is for ' + po.jobId);
      }
      const dupe = vendor ? erp.invoiceExists(vendor.id, inv.invoiceNo) : null;
      const inflight = vendor && inv.invoiceNo ? this.invoices.find(function (x) {
        return x !== res && x.id < res.id && x.vendor && x.vendor.id === vendor.id && x.invoice.invoiceNo && normInvoiceNo(x.invoice.invoiceNo) === normInvoiceNo(inv.invoiceNo) && ['closed', 'rejected'].indexOf(x.status) < 0; }) : null;
      add('DUPLICATE', 'Invoice number not already entered', !dupe && !inflight, dupe ? 'Already entered as ' + dupe.voucher + ' (' + dupe.invoiceNo + ', ' + usd(dupe.total) + ')' : (inflight ? 'Already received as ' + inflight.id + ' (' + inflight.invoice.invoiceNo + ')' : 'New for this vendor'));
      const lineSum = inv.lines.length ? sum(inv.lines.map(function (l) { return l.amount; })) : null;
      const lineExt = inv.lines.every(function (l) { return Math.abs(r2(l.qty * l.unitPrice) - l.amount) <= 0.011; });
      const calc = inv.subtotal === null || inv.subtotal === undefined ? null : r2(inv.subtotal + inv.tax + inv.freight);
      const mathOk = inv.total !== null && inv.total !== undefined && calc !== null && lineExt && (lineSum === null || Math.abs(lineSum - inv.subtotal) <= 0.011) && Math.abs(calc - inv.total) <= 0.011;
      add('MATH', 'Invoice adds up (lines, subtotal, tax, freight, total)', mathOk, mathOk ? 'Balanced at ' + usd(inv.total) :
        'Subtotal ' + usd(inv.subtotal) + ' + tax ' + usd(inv.tax) + ' + freight ' + usd(inv.freight) + ' = ' + usd(calc) + ', but the total says ' + usd(inv.total));
      if (po) {
        const job = erp.getJob(po.jobId), rem = poRemaining(po), tol = CFG.invoiceTolerance;
        const exp = expectedTax(job, po.coding.category, inv.subtotal), rateOk = Math.abs(inv.tax - exp) <= CFG.taxTolerance;
        add('TAX_RATE', 'Sales tax rate follows the job rule', rateOk, rateOk ? (exp === 0 ? 'No tax (exempt or non-taxable)' : usd(inv.tax) + ' at ' + (CFG.taxRate * 100).toFixed(1) + '%') :
          'Invoice charges ' + usd(inv.tax) + '; ' + (job && job.taxExempt ? 'job ' + job.id + ' is tax-exempt' : 'the rule expects ' + usd(exp)));
        const subOk = inv.subtotal <= rem.sub + tol;
        add('PO_SHORT', 'Enough subtotal left on the PO', subOk, subOk ? usd(inv.subtotal) + ' against ' + usd(rem.sub) + ' left' : 'Invoice subtotal ' + usd(inv.subtotal) + ' is more than the ' + usd(rem.sub) + ' left on ' + po.number + ' — short by ' + usd(r2(inv.subtotal - rem.sub)), { shortBy: r2(inv.subtotal - rem.sub) });
        if (rateOk && subOk) add('TAX_SHORT', 'Enough sales tax left on the PO', inv.tax <= rem.tax + CFG.taxTolerance, inv.tax <= rem.tax + CFG.taxTolerance ? usd(inv.tax) + ' against ' + usd(rem.tax) + ' left' : 'Invoice tax ' + usd(inv.tax) + ' is more than the ' + usd(rem.tax) + ' left on the PO');
        add('FREIGHT', 'Freight is covered by the PO', inv.freight <= rem.freight + tol, inv.freight <= rem.freight + tol ? (inv.freight ? usd(inv.freight) + ' against ' + usd(rem.freight) + ' left' : 'No freight billed') : 'Invoice freight ' + usd(inv.freight) + ' is more than the ' + usd(rem.freight) + ' left on the PO');
        const unmatched = inv.lines.filter(function (l) { return !po.lines.some(function (q) { return descOverlap(l.desc, q.desc) >= 0.5; }); });
        add('ITEM_MISMATCH', 'Billed items appear on the PO', unmatched.length === 0, unmatched.length ? 'Not on the PO: ' + unmatched.map(function (l) { return l.desc; }).join('; ') : 'All lines found on the PO');
        const dateOk = !inv.date || (inv.date <= today && inv.date >= po.createdDate);
        add('DATE', 'Invoice date is sensible', dateOk, !inv.date ? 'No date found' : (inv.date > today ? 'Invoice is dated in the future' : (inv.date < po.createdDate ? 'Invoice predates the PO (' + po.createdDate + ')' : inv.date)));

        const row = function (field, poVal, invVal, status) { out.comparison.push({ field: field, po: poVal, inv: invVal, status: status }); };
        const st = function (code) { const c = out.checks.find(function (x) { return x.id === code; }); return c ? (c.ok ? 'match' : 'mismatch') : 'info'; };
        const pending = this.invoices.filter(function (x) { return x !== res && x.po && x.po.number === po.number && x.status === 'awaiting_review'; });
        row('PO number', po.number, inv.poRef || '(not printed)', assigned ? 'info' : (inv.poRef === po.number ? 'match' : 'info'));
        row('Vendor ID', po.vendorId, vendor ? vendor.id : '(no confident match)', st('VENDOR_MISMATCH'));
        row('Vendor name', (erp.getVendor(po.vendorId) || {}).name, inv.vendorName, 'info');
        row('Job number', po.jobId, inv.jobId || '(not printed)', inv.jobId ? st('JOB_MISMATCH') : 'info');
        row('Job name', job ? job.name : '', inv.project || '(not printed)', 'info');
        row('PO total · billed · left', usd(po.total) + ' · ' + usd(po.billed) + ' · ' + usd(rem.total), usd(inv.total) + ' (this invoice)', inv.total <= rem.total + tol ? 'match' : 'mismatch');
        row('Subtotal (left on PO)', usd(rem.sub) + ' of ' + usd(po.subtotal), usd(inv.subtotal), st('PO_SHORT'));
        row('Sales tax (left on PO)', usd(rem.tax) + ' of ' + usd(po.tax), usd(inv.tax), st('TAX_RATE') === 'mismatch' ? 'mismatch' : st('TAX_SHORT'));
        row('Freight (left on PO)', usd(rem.freight) + ' of ' + usd(po.freight || 0), usd(inv.freight), st('FREIGHT'));
        if (pending.length) row('Other invoices waiting on this PO', pending.map(function (x) { return x.id + ' ' + usd(x.invoice.total); }).join(', '), 'Re-checked again when the bot enters', 'info');
      }
      return out;
    }
    evaluateInvoice(res, assignedPO) {
      if (assignedPO) res.assignedPO = assignedPO;
      const r = this.runChecks(res), inv = res.invoice, vendor = res.vendor;
      res.checks = r.checks; res.po = r.po; res.matchMethod = r.method; res.suggestions = r.suggestions; res.comparison = r.comparison;
      res.reasons = r.reasons.concat(res.manualReasons);
      res.renamed = [vendor ? vendor.id : 'UNKNOWN', normInvoiceNo(inv.invoiceNo) || 'NOINV', inv.date || 'NODATE', r.po ? r.po.number : 'NOPO'].join('_') + (res.multi ? '_p' + res.seg.start + (res.seg.end > res.seg.start ? '-' + res.seg.end : '') : '') + '.pdf';
      const day = inv.date || this.today;
      res.libraryPath = 'AP Library/Invoices/' + day.slice(0, 4) + '/' + day.slice(5, 7) + '/' + res.renamed;
      this.library = this.library.filter(function (l) { return l.invoiceId !== res.id; });
      this.library.push({ path: res.libraryPath, kind: 'Invoice', invoiceId: res.id, mailId: res.mailId });
      res.steps = res.steps.filter(function (x) { return x.name === 'Extract'; });
      res.steps.push({ name: 'Rename', ok: true, detail: (res.email.attachment ? res.email.attachment.name : 'manual entry') + '  →  ' + res.renamed });
      res.steps.push({ name: 'Match', ok: !!r.po, detail: r.po ? r.po.number + ' (' + r.method + ')' : 'No PO matched' });
      const failed = res.reasons.length;
      res.steps.push({ name: 'Checks', ok: failed === 0, detail: (res.checks.length - r.reasons.length) + ' of ' + res.checks.length + ' passed' });
      res.assignment = null;
      if (failed === 0) {
        res.status = 'awaiting_review'; res.suggestedOwner = null;
        res.steps.push({ name: 'Review', ok: true, detail: 'Ready for the reviewer to verify the invoice PDF and the PO. Not entered yet.' });
      } else {
        res.status = 'reportable'; res.suggestedOwner = this.ownerFor(res, res.reasons[0].id);
        res.steps.push({ name: 'Report', ok: false, detail: failed + ' issue' + (failed > 1 ? 's' : '') + ' to report. Suggested owner: ' + res.suggestedOwner + '. Nothing is entered.' });
      }
      this.syncIssues(res);
      this.log('Rules engine', failed ? 'Reportable: ' + res.reasons.map(function (x) { return x.id; }).join(', ') : 'All checks passed, ready for review', res.id, inv.invoiceNo + ' / ' + usd(inv.total));
      return res;
    }
    syncIssues(res) {
      const now = Date.now(), codes = res.reasons.map(function (x) { return x.id; }), self = this;
      res.reasons.forEach(function (rs) {
        if (!self.issueLog.find(function (i) { return i.invoiceId === res.id && i.code === rs.id && i.status === 'open'; })) {
          self.issueLog.push({ id: 'ISS-' + pad(++self.issSeq), invoiceId: res.id, code: rs.id, label: ISSUES[rs.id].label, owner: self.ownerFor(res, rs.id), vendor: res.vendor ? res.vendor.name : res.invoice.vendorName, openedAt: now, status: 'open', resolution: '' });
        }
      });
      this.issueLog.filter(function (i) { return i.invoiceId === res.id && i.status === 'open' && codes.indexOf(i.code) < 0; }).forEach(function (i) {
        i.status = 'resolved'; i.resolvedAt = now; i.resolution = res.lastAction || 'No longer failing after re-check';
      });
    }
    issueSummary() {
      const cats = {}, owners = {};
      this.issueLog.forEach(function (i) {
        const c = cats[i.code] || (cats[i.code] = { code: i.code, label: i.label, open: 0, resolved: 0 });
        const o = owners[i.owner] || (owners[i.owner] = { owner: i.owner, open: 0, resolved: 0 });
        const k = i.status === 'open' ? 'open' : 'resolved'; c[k]++; o[k]++;
      });
      const byTotal = function (x, y) { return (y.open + y.resolved) - (x.open + x.resolved); };
      return { categories: Object.keys(cats).map(function (k) { return cats[k]; }).sort(byTotal), owners: Object.keys(owners).map(function (k) { return owners[k]; }).sort(byTotal),
        total: this.issueLog.length, open: this.issueLog.filter(function (i) { return i.status === 'open'; }).length };
    }

    // ---- clerk actions (processing only: report, verify, enter, re-run, close). Clerks never edit POs.
    reportToOwner(resId, owner, note) {
      const res = this.getInv(resId);
      if (res.status !== 'reportable') throw new Error('Only items with open issues can be reported.');
      res.assignment = { to: owner, note: note || '', by: 'AP clerk', at: Date.now(), response: null };
      res.status = 'reported';
      this.log('AP clerk', 'Reported to ' + owner, res.id, res.reasons.map(function (x) { return x.label; }).join('; '));
      return res;
    }
    reportIssue(resId, code, owner, note) {   // the reviewer spots a problem while checking the PDFs
      const res = this.getInv(resId);
      if (!ISSUES[code]) throw new Error('Unknown issue category.');
      if (res.status !== 'awaiting_review') throw new Error('Only invoices waiting for review can be reported this way.');
      res.manualReasons.push({ id: code, label: ISSUES[code].label, detail: note || 'Reported by the reviewer' });
      res.reasons = res.reasons.concat([res.manualReasons[res.manualReasons.length - 1]]);
      this.syncIssues(res);
      res.assignment = { to: owner, note: note || '', by: 'AP clerk', at: Date.now(), response: null };
      res.status = 'reported';
      this.log('AP clerk', 'Reviewer found a discrepancy, reported to ' + owner, res.id, note || '');
      return res;
    }
    /* The invoice team may key the PO number when the invoice itself does not
       carry one. That is a lookup, not a change: nothing on the PO moves, every
       check still runs against whatever PO they picked, and a wrong one still
       fails. They may not redirect an invoice that already quotes a PO, and they
       may not change anything on the PO itself. Both of those are the
       purchaser's call and go back to them as a reported issue. */
    setPONumber(resId, poNumber, who) {
      const res = this.getInv(resId);
      if (!poNumber || !String(poNumber).trim()) throw new Error('Enter a PO number.');
      if (res.invoice.poRef) throw new Error('This invoice already quotes ' + res.invoice.poRef + '. Sending it to a different PO is the purchaser\'s decision: report it instead.');
      const po = this.erp.getPO(String(poNumber).trim().toUpperCase());
      if (!po) throw new Error('There is no purchase order ' + poNumber + ' in the ERP.');
      res.poEnteredBy = (who && who.name) || 'AP clerk'; res.confirmedBy = null;
      this.log(res.poEnteredBy, 'Keyed the PO number missing from the invoice', res.id, po.number + ' (no change made to the PO)');
      return this.evaluateInvoice(res, po.number);
    }
    rerun(resId) {
      const res = this.getInv(resId);
      res.manualReasons = res.manualReasons.filter(function (x) { return x.id !== 'ENTRY_FAILED'; });
      this.log('AP clerk', 'Re-ran checks', res.id, '');
      return this.evaluateInvoice(res);
    }
    /* Recompute what the screens show against the ERP as it stands right now,
       without moving anything through the workflow. A PO balance can change
       between intake and review, because another invoice may have been entered
       against the same PO in the meantime. The reviewer and the project manager
       must see the balance as it is now, not as it was when the mail arrived.
       Anything already entered or finished is left alone: its figures are
       whatever was posted. */
    refreshView() {
      const live = ['awaiting_review', 'reportable', 'reported', 'owner_responded', 'on_hold'];
      const self = this;
      this.invoices.forEach(function (res) {
        if (live.indexOf(res.status) < 0) return;
        const r = self.runChecks(res);
        res.checks = r.checks; res.po = r.po; res.comparison = r.comparison; res.suggestions = r.suggestions;
        res.reasons = r.reasons.concat(res.manualReasons);
        res.stale = res.status !== 'awaiting_review' && res.reasons.length === 0;
      });
    }
    closeInvoice(resId, reason) {
      const res = this.getInv(resId);
      res.status = 'closed'; res.closeReason = reason || ''; res.lastAction = 'Closed: ' + (reason || 'no reason given');
      this.issueLog.filter(function (i) { return i.invoiceId === res.id && i.status === 'open'; }).forEach(function (i) { i.status = 'resolved'; i.resolvedAt = Date.now(); i.resolution = res.lastAction; });
      this.log('AP clerk', 'Closed invoice', res.id, reason || '');
    }
    reviewerVerify(resId) {
      const res = this.getInv(resId);
      if (res.status !== 'awaiting_review') throw new Error('This invoice is not waiting for review.');
      this.log('AP clerk', 'Verified invoice and PO against the PDFs', res.id, res.invoice.invoiceNo);
      return this.botEnter(res, 'bot');
    }
    enterManually(resId) {
      const res = this.getInv(resId);
      if (res.status !== 'awaiting_review') throw new Error('This invoice is not waiting for review.');
      this.log('AP clerk', 'Verified invoice and PO, entering manually', res.id, res.invoice.invoiceNo);
      return this.botEnter(res, 'manual');
    }
    botEnter(res, mode) {
      const actor = mode === 'bot' ? 'ERP bot' : 'AP clerk (manual)';
      const re = this.runChecks(res), reasons = re.reasons.concat(res.manualReasons);
      if (reasons.length) {
        this.evaluateInvoice(res);
        res.note = 'Checked again just before entry and something had changed since review. Nothing was entered.';
        this.log(actor, 'Stopped before entry: re-check found ' + reasons.map(function (x) { return x.id; }).join(', '), res.id, '');
        return res;
      }
      const po = re.po, inv = res.invoice;
      const je = { lines: [
        { acct: po.coding.gl, name: GL[po.coding.category].name, job: po.jobId, costCode: po.coding.costCode, dr: inv.total, cr: 0 },
        { acct: '2000', name: 'Accounts payable', vendor: res.vendor.name, dr: 0, cr: inv.total }] };
      je.balanced = sum(je.lines.map(function (l) { return l.dr; })) === sum(je.lines.map(function (l) { return l.cr; }));
      const rec = this.erp.enterVoucher(inv, po, je, mode, mode === 'bot' && this.glitch);
      const rb = this.erp.readBack(rec.voucher);
      const ok = je.balanced && rb.total === inv.total && rb.vendorId === po.vendorId && rb.invoiceNo === inv.invoiceNo && rb.poNumber === po.number;
      if (!ok) {
        this.erp.voidVoucher(rec.voucher);
        res.manualReasons.push({ id: 'ENTRY_FAILED', label: ISSUES.ENTRY_FAILED.label, detail: 'Read-back showed a total of ' + usd(rb.total) + ' but the invoice says ' + usd(inv.total) + '. Voucher ' + rec.voucher + ' was voided and the PO balance restored.' });
        this.evaluateInvoice(res);
        this.log(actor, 'Read-back did not match, voucher voided', res.id, rec.voucher);
        return res;
      }
      res.voucher = rec.voucher; res.je = je; res.entryMode = mode; res.enteredAt = Date.now(); res.status = 'awaiting_pm_approval';
      res.steps.push({ name: mode === 'bot' ? 'Bot entry' : 'Manual entry', ok: true, detail: 'Entered as ' + rec.voucher + '. Read-back matched. PDF copy attached for PM approval.' });
      this.log(actor, 'Entered voucher, read-back matched, PDF attached for PM approval', res.id, rec.voucher + ' → ' + po.number + ' / ' + usd(inv.total));
      return res;
    }

    // ---- project manager / original purchaser actions. Only these can change a PO or accept a difference.
    requirePM(who, reason) {
      if (!who || who.role !== 'pm') throw new Error('Only the project manager or original purchaser can do this. The invoice team can report and process, not change POs or accept differences.');
      if (!reason || !String(reason).trim()) throw new Error('A reason is required and is logged.');
    }
    /* A project manager may only act on their own job, or on a PO they raised
       themselves. Another job's PM is not a substitute signature. */
    requireOwnJob(who, res) {
      const jobId = (res.po && res.po.jobId) || res.invoice.jobId;
      const job = jobId ? this.erp.getJob(jobId) : null;
      const purchaser = res.po && res.po.purchaser;
      if (job && job.pm === who.name) return;
      if (purchaser && purchaser === who.name) return;
      const owner = (job && job.pm) || purchaser;
      if (!owner) return;   // no job and no PO yet: any PM can pick it up
      throw new Error('This belongs to ' + owner + ', not you. Only the job\'s project manager or the original purchaser can sign this off.');
    }
    changePO(po, addSub, addFreight, reason, who) {
      const job = this.erp.getJob(po.jobId), before = { subtotal: po.subtotal, tax: po.tax, freight: po.freight || 0, total: po.total };
      if (addSub > 0) po.lines.push({ desc: 'Change order: ' + reason, qty: 1, unit: 'LS', unitPrice: addSub, amount: addSub });
      po.subtotal = r2(po.subtotal + addSub); po.freight = r2((po.freight || 0) + addFreight);
      po.tax = expectedTax(job, po.coding.category, po.subtotal);
      po.total = r2(po.subtotal + po.tax + po.freight);
      const b = this.erp.getBudget(po.jobId, po.coding.costCode); if (b) b.committed = r2(b.committed + (po.total - before.total));
      if (po.status === 'closed' && r2(po.total - po.billed) > 0.005) po.status = 'open';
      po.changes = po.changes || []; po.changes.push({ at: Date.now(), by: who.name, reason: reason, before: before, after: { subtotal: po.subtotal, tax: po.tax, freight: po.freight, total: po.total } });
      this.log('PM ' + who.name, 'Changed PO with sign-off', po.number, usd(before.total) + ' → ' + usd(po.total) + '. Reason: ' + reason);
    }
    ownerRespond(resId, action, reason, who, params) {
      this.requirePM(who, reason);
      params = params || {};
      const res = this.getInv(resId);
      this.requireOwnJob(who, res);
      if (res.status !== 'reported') throw new Error('This item has not been reported to a project manager.');
      let label;
      if (action === 'correct_po') {
        if (!res.po) throw new Error('There is no PO to change. Use "Confirm this PO" instead.');
        const addSub = Number(params.addSubtotal) || 0, addFr = Number(params.addFreight) || 0;
        if (addSub <= 0 && addFr <= 0) throw new Error('Enter how much to add to the PO subtotal or freight.');
        this.changePO(res.po, addSub, addFr, reason, who); label = 'PO changed by ' + who.name;
      } else if (action === 'use_po') {
        if (!this.erp.getPO(params.poNumber)) throw new Error('That PO does not exist.');
        res.assignedPO = params.poNumber; res.confirmedBy = who.name; label = 'PO ' + params.poNumber + ' confirmed by ' + who.name;
      } else if (action === 'valid_proceed') {
        const codes = res.reasons.map(function (x) { return x.id; }).filter(function (c) { return OVERRIDABLE[c]; });
        if (!codes.length) throw new Error('None of the open issues can be accepted as-is. Change the PO or dispute with the vendor.');
        res.override = { codes: codes, by: who.name, reason: reason }; label = 'Difference accepted by ' + who.name;
      } else if (action === 'fixed') {
        res.manualReasons = res.manualReasons.filter(function (x) { return x.id !== 'REVIEW_FOUND' && x.id !== 'PM_REJECTED'; }); label = 'Confirmed OK by ' + who.name;
      } else if (action === 'dispute') {
        res.hold = 'Disputed with the vendor'; label = 'Disputing with vendor (' + who.name + ')';
      } else if (action === 'credit_memo') {
        res.hold = 'Waiting for a corrected invoice or credit memo'; label = 'Corrected invoice or credit memo requested (' + who.name + ')';
      } else if (action === 'reject') {
        res.status = 'rejected'; label = 'Do not pay (' + who.name + ')';
      } else throw new Error('Unknown action.');
      const response = { action: action, label: label, reason: reason, by: who.name, at: Date.now() };
      res.assignment.response = response; res.responses.push(response); res.lastAction = label + '. ' + reason;
      if (action === 'dispute' || action === 'credit_memo') res.status = 'on_hold';
      else if (action !== 'reject') res.status = 'owner_responded';
      if (action === 'reject') this.issueLog.filter(function (i) { return i.invoiceId === res.id && i.status === 'open'; }).forEach(function (i) { i.status = 'resolved'; i.resolvedAt = Date.now(); i.resolution = res.lastAction; });
      this.log('PM ' + who.name, label, res.id, reason);
      return res;
    }
    pmApprove(resId, who, note) {
      this.requirePM(who, note || 'Approved');
      const res = this.getInv(resId);
      this.requireOwnJob(who, res);
      if (res.status !== 'awaiting_pm_approval') throw new Error('This invoice is not waiting for PM approval.');
      res.status = 'approved'; res.approvedBy = who.name; this.erp.approveVoucher(res.voucher);
      this.log('PM ' + who.name, 'Approved voucher after reviewing the PDF', res.id, res.voucher);
      return res;
    }
    pmReject(resId, who, reason) {
      this.requirePM(who, reason);
      const res = this.getInv(resId);
      this.requireOwnJob(who, res);
      if (res.status !== 'awaiting_pm_approval') throw new Error('This invoice is not waiting for PM approval.');
      const v = res.voucher; this.erp.voidVoucher(v);
      res.voucher = null; res.je = null;
      res.manualReasons.push({ id: 'PM_REJECTED', label: ISSUES.PM_REJECTED.label, detail: who.name + ' rejected voucher ' + v + ': ' + reason + '. Voucher voided and PO balance restored.' });
      this.evaluateInvoice(res);
      this.log('PM ' + who.name, 'Rejected voucher, voided', res.id, v + '. ' + reason);
      return res;
    }
  }

  const API = {
    CFG: CFG, CATEGORIES: CATEGORIES, TYPE_TO_CAT: TYPE_TO_CAT, GL: GL,
    r2: r2, pm: pm, usd: usd, isoDate: isoDate, similarity: similarity, normInvoiceNo: normInvoiceNo, expectedTax: expectedTax,
    seedData: seedData, matchVendor: matchVendor, ISSUES: ISSUES, PCLASS: PCLASS, PTYPES: PTYPES, ptypeById: ptypeById, CAP_THRESHOLD: CAP_THRESHOLD, PREPAID_ACCT: PREPAID, CAPITAL_ACCT: CAPITAL_ACCT, OVERRIDABLE: OVERRIDABLE, splitPages: splitPages, checkSplit: checkSplit, classifyDocument: classifyDocument, poRemaining: poRemaining, MockERP: MockERP, Workflow: Workflow,
    parseQuoteText: parseQuoteText, parseInvoiceText: parseInvoiceText, looksLikeInvoice: looksLikeInvoice,
    validateRequisition: validateRequisition, todayISO: todayISO
  };
  root.Req2PO = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
