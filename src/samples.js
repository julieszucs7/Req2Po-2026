/* Fictional sample requisitions, quotes and invoice emails used by the demo and the tests. */
(function (root) {
  'use strict';

  const quote = {
    metro:
`METRO SAFETY SUPPLY
Quote # MS-5521    Date: 10/28/2026    Valid through: 11/27/2026
Project: Riverside Medical Office (24-101)
Description | Qty | Unit | Unit Price | Amount
Fall protection kit, harness and lanyard | 12 | EA | 100.00 | 1,200.00
Subtotal 1,200.00
Sales tax (7.0%) 84.00
Total 1,284.00`,
    ridgeline:
`RIDGELINE CONCRETE SUPPLY
Quote # Q-88214    Date: 10/26/2026    Valid through: 11/25/2026
Project: Riverside Medical Office (24-101)
Description | Qty | Unit | Unit Price | Amount
Ready-mix concrete 4000 PSI, slab on grade | 120 | CY | 148.00 | 17,760.00
Pump truck, 4 hour minimum | 1 | EA | 950.00 | 950.00
Subtotal 18,710.00
Sales tax (7.0%) 1,309.70
Total 20,019.70`,
    keystone:
`KEYSTONE STEEL & REBAR
Quote # KS-3307    Date: 10/27/2026    Valid through: 11/26/2026
Project: Elm Street Warehouse (24-107)
Description | Qty | Unit | Unit Price | Amount
Rebar #4 grade 60, cut and bent | 9000 | LB | 0.50 | 4,500.00
Subtotal 4,500.00
Sales tax (7.0%) 315.00
Total 4,815.00`
  };

  const scenarios = [
    { id: 'clean', label: 'Clean request', blurb: 'Everything lines up. The bot creates the PO without a human.',
      form: { vendorName: 'Metro Safety Supply', dateNeeded: '2026-11-04', type: 'material', subtype: 'Fall protection kits', jobId: '24-101', costCode: '01-560', category: 'M', price: '1200', notes: 'Needed before deck work starts' },
      quote: quote.metro },
    { id: 'mismatch', label: 'Quote ≠ form', blurb: 'The quote has a pump truck the PM did not mention. Over the auto limit.',
      form: { vendorName: 'Ridgeline Concrete', dateNeeded: '2026-11-09', type: 'material', subtype: 'Slab pour, level 1', jobId: '24-101', costCode: '03-300', category: 'M', price: '17000', notes: '' },
      quote: quote.ridgeline },
    { id: 'exempt', label: 'Tax-exempt job', blurb: 'The vendor charged tax on a tax-exempt job, and the cost code is nearly out of budget.',
      form: { vendorName: 'Keystone Steel', dateNeeded: '2026-11-12', type: 'material', subtype: 'Rebar for footings', jobId: '24-107', costCode: '05-120', category: 'M', price: '4500', notes: '' },
      quote: quote.keystone },
    { id: 'capital', label: 'Overhead: should be capitalized', blurb: 'An equipment purchase over the capitalization threshold. The system says depreciate it, do not expense it.',
      form: { vendorName: 'Metro Safety Supply', dateNeeded: '2026-11-18', type: 'equipment', subtype: 'Air compressor for the shop', purchaseClass: 'equipment', ptype: 'equip_buy', jobId: '', costCode: '', category: '', price: '6400', notes: 'Shop use, not a job' },
      quote: null },
    { id: 'prepaid', label: 'Overhead: covers 12 months', blurb: 'An annual policy. Expensing it in one month overstates this period and understates the next eleven.',
      form: { vendorName: 'Metro Safety Supply', dateNeeded: '2026-11-20', type: 'other', subtype: 'General liability policy renewal', purchaseClass: 'overhead', ptype: 'insurance', coversMonths: '12', jobId: '', costCode: '', category: '', price: '12000', notes: 'Annual renewal' },
      quote: null },
    { id: 'newvendor', label: 'New vendor, wrong code', blurb: 'Vendor not in the master, rental coded to a steel cost code, no quote.',
      form: { vendorName: 'Pinnacle Rental Co', dateNeeded: '2026-11-03', type: 'equipment', subtype: 'Boom lift, 2 weeks', jobId: '24-101', costCode: '05-120', category: 'E', price: '3200', notes: '' },
      quote: null },
    { id: 'closed', label: 'Closed job', blurb: 'Hard stop. The form will not submit to a closed job.',
      form: { vendorName: 'Metro Safety Supply', dateNeeded: '2026-11-05', type: 'material', subtype: 'Hard hats', jobId: '23-088', costCode: '01-560', category: 'M', price: '400', notes: '' },
      quote: null }
  ];

  function inv(vendor, no, date, po, jobLine, rows, subtotal, tax, total, freight) {
    return [vendor, 'INVOICE', 'Invoice No: ' + no, 'Invoice Date: ' + date, po ? 'PO Number: ' + po : '', jobLine,
      'Description | Qty | Unit | Unit Price | Amount'].concat(rows)
      .concat(['Subtotal ' + subtotal, 'Sales Tax ' + tax].concat(freight ? ['Freight ' + freight] : []).concat(['Total Due ' + total, 'Terms: Net 30'])).filter(Boolean).join('\n');
  }

  const emails = [
    { id: 'e1', label: 'Clean: second delivery on a PO', from: 'ar@harborelectric.example', subject: 'Invoice HW-30533', received: '10/28/2026',
      attachment: { name: 'scan_0001.pdf', text: inv('HARBOR ELECTRICAL WHOLESALE', 'HW-30533', '10/28/2026', 'PO-26-0604', 'Job: Riverside Medical Office (24-101)',
        ['Breakers 20A single-pole | 30 | EA | 35.00 | 1,050.00', 'EMT conduit 3/4 in | 800 | LF | 2.00 | 1,600.00'], '2,650.00', '185.50', '2,920.50', '85.00') } },
    { id: 'e2', label: 'No PO number on the invoice', from: 'billing@metrosafety.example', subject: 'Your invoice MS-90112', received: '10/28/2026',
      attachment: { name: 'Invoice-90112.pdf', text: inv('METRO SAFETY SUPPLY', 'MS-90112', '10/27/2026', '', 'Job: Riverside Medical Office (24-101)',
        ['Safety netting and guardrail posts | 1 | LS | 1,600.00 | 1,600.00'], '1,600.00', '112.00', '1,712.00') } },
    { id: 'e3', label: 'Invoice quotes the wrong vendor’s PO', from: 'accounts@ridgelineconcrete.example', subject: 'Invoice RC-41002 for PO-26-0611', received: '10/29/2026',
      attachment: { name: 'RC41002.pdf', text: inv('RIDGELINE CONCRETE SUPPLY', 'RC-41002', '10/29/2026', 'PO-26-0611', 'Job: Riverside Medical Office (24-101)',
        ['Ready-mix concrete 4000 PSI | 25 | CY | 148.00 | 3,700.00'], '3,700.00', '259.00', '3,959.00') } },
    { id: 'e4', label: 'Same invoice sent twice', from: 'ar@harborelectric.example', subject: 'RESEND: Invoice HW30418', received: '10/29/2026',
      attachment: { name: 'HW30418_resend.pdf', text: inv('HARBOR ELECTRICAL WHOLESALE', 'HW30418', '10/15/2026', 'PO-26-0604', 'Job: Riverside Medical Office (24-101)',
        ['Panelboard 200A 42-circuit | 1 | EA | 2,350.00 | 2,350.00'], '2,350.00', '164.50', '2,514.50') } },
    { id: 'e5', label: 'Bills more than the PO has left', from: 'ar@summitrentals.example', subject: 'Invoice SE-2290', received: '10/29/2026',
      attachment: { name: 'SE-2290.pdf', text: inv('SUMMIT EQUIPMENT RENTALS', 'SE-2290', '10/29/2026', 'PO-26-0607', 'Job: Riverside Medical Office (24-101)',
        ['Scissor lift rental 4 weeks | 4 | WK | 1,125.00 | 4,500.00'], '4,500.00', '315.00', '4,815.00') } },
    { id: 'e6', label: 'Tax charged on a tax-exempt job', from: 'ar@keystonesteel.example', subject: 'Invoice KS-7710', received: '10/30/2026',
      attachment: { name: 'KS7710.pdf', text: inv('KEYSTONE STEEL & REBAR', 'KS-7710', '10/30/2026', 'PO-26-0611', 'Job: Elm Street Warehouse (24-107)',
        ['Rebar #5 grade 60 | 10000 | LB | 0.50 | 5,000.00'], '5,000.00', '350.00', '5,350.00') } },
    { id: 'e7', label: 'Total does not add up', from: 'accounts@ridgelineconcrete.example', subject: 'Invoice RC-40871', received: '10/30/2026',
      attachment: { name: 'RC-40871.pdf', text: inv('RIDGELINE CONCRETE SUPPLY', 'RC-40871', '10/30/2026', 'PO-26-0601', 'Job: Riverside Medical Office (24-101)',
        ['Ready-mix concrete 4000 PSI | 60 | CY | 148.00 | 8,880.00'], '8,880.00', '621.60', '9,502.60') } },
    { id: 'e11', label: 'One PDF with two invoices (3 pages)', from: 'ar@summitrentals.example', subject: 'October invoices', received: '10/30/2026',
      attachment: { name: 'Summit_Oct_invoices.pdf', pages: [
        ['SUMMIT EQUIPMENT RENTALS', 'INVOICE', 'Invoice No: SE-2301', 'Invoice Date: 10/30/2026', 'PO Number: PO-26-0607', 'Job: Riverside Medical Office (24-101)',
          'Description | Qty | Unit | Unit Price | Amount', 'Scissor lift rental, weeks 3 and 4 | 2 | WK | 1,125.00 | 2,250.00', 'Page 1 of 2'].join('\n'),
        ['SUMMIT EQUIPMENT RENTALS', 'Invoice No: SE-2301 (continued)', 'Subtotal 2,250.00', 'Sales Tax 157.50', 'Total Due 2,407.50', 'Page 2 of 2'].join('\n'),
        inv('SUMMIT EQUIPMENT RENTALS', 'SE-2302', '10/30/2026', 'PO-26-0612', 'Job: Elm Street Warehouse (24-107)',
          ['Telehandler rental 2 weeks | 2 | WK | 2,000.00 | 4,000.00'], '4,000.00', '0.00', '4,000.00')] } },
    { id: 'e9', label: 'Via a billing platform, similar vendor name', from: 'invoices@billingportal.example', subject: 'Invoice 55210 from Harbor Mechanical', received: '10/30/2026',
      attachment: { name: 'inv55210.pdf', text: inv('HARBOR MECHANICAL SERVICES LLC', '55210', '10/30/2026', '', 'Job: Riverside Medical Office (24-101)',
        ['Rooftop unit start-up and inspection | 1 | LS | 850.00 | 850.00'], '850.00', '59.50', '909.50') } },
    { id: 'e10', label: 'Vendor not on the list', from: 'ar@graniteridgepaving.example', subject: 'Invoice GR-118', received: '10/30/2026',
      attachment: { name: 'GR118.pdf', text: inv('GRANITE RIDGE PAVING', 'GR-118', '10/30/2026', 'PO-26-0599', 'Job: Elm Street Warehouse (24-107)',
        ['Asphalt patching | 1 | LS | 2,200.00 | 2,200.00'], '2,200.00', '0.00', '2,200.00') } },
    { id: 'e8', label: 'Not an invoice (statement)', from: 'ar@harborelectric.example', subject: 'October statement of account', received: '10/30/2026',
      attachment: { name: 'statement.pdf', text: 'HARBOR ELECTRICAL WHOLESALE\nSTATEMENT OF ACCOUNT\nPeriod: October 2026\nBalance forward 0.00\nCurrent charges 2,514.50' } },
    { id: 'e12', label: 'Question about a payment (no attachment)', from: 'ar@harborelectric.example', fromName: 'Harbor Electrical Wholesale', subject: 'Payment status for HW-30418?', received: '10/30/2026',
      body: 'Hi, can you confirm when invoice HW-30418 will be paid? Thanks.' },
    { id: 'e13', label: 'Past due notice', from: 'ar@summitrentals.example', subject: 'PAST DUE NOTICE: Invoice SE-2150', received: '10/30/2026',
      attachment: { name: 'SE-2150_pastdue.pdf', text: 'SUMMIT EQUIPMENT RENTALS\nPAST DUE NOTICE\nOur records show the invoice below is unpaid. Please remit.\nInvoice No: SE-2150\nAmount Due 3,150.00' } }
  ];

  const API = { scenarios: scenarios, emails: emails, quotes: quote };
  root.Req2POSamples = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
