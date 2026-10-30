# Req2PO

**Modern controls around the ERP you already have.**

Construction accounting runs on ERP systems that are often old, closed and expensive to replace. Req2PO does not replace one. It builds the controls *around* it: mail is sorted, invoices are read and split, every invoice is compared with its purchase order, problems are reported to the person who can actually fix them, and only then is anything entered.

**This design is not hypothetical.** A Phase 1 system built on these rules is running in production at a specialty contractor and is still being tuned. This repository is a working reconstruction of that design on a mock ERP with fictional data — the production system runs against an employer's systems, vendors and documents, none of which appear here.

**Open the demo:** `index.html` — one self-contained file, no build step, no network calls. `dist/index.html` is the same file.

---

## The phases

The work is phased so each phase is useful on its own and only the next one depends on it.

| | | |
|---|---|---|
| **Phase 1 — AP inbox and invoice controls** | **Built in this demo** | Sorting, splitting, reading, 15 checks per invoice, reporting, review, entry, approval |
| **Phase 2 — Requisition to PO** | **Prototype in this demo** | One requisition form, quote cross-check, purchase classification and GL coding, rules, bot writes the PO |
| **Phase 3 — Vendor statement reconciliation** | **Planned, not built** | Statements compared with what the ERP shows entered and paid |

Phase 1 comes first because it changes how one team works and nobody else has to learn anything. Phase 2 needs project managers to adopt a new form, and it reduces the problems Phase 1 keeps reporting. Phase 3 is last because Phase 1 already collects and files the statements it needs.

---

## Phase 1 — what happens to an invoice

1. **Inbox.** Each mail is sorted into invoice, statement, payment reminder or general correspondence, and filed to the vendor's folder.
2. **Split and read.** A PDF holding several invoices is split by page. Each invoice is read, renamed `VENDOR_INVOICE_DATE_PO.pdf` and saved.
3. **Compare.** Each invoice is compared with its PO: vendor ID, vendor name, job number and name, PO total, subtotal left, sales tax left, freight. PO data refreshes every five minutes, and can be refreshed by hand.
4. **Report.** Anything that fails becomes an issue with a category and an owner. The owner responds, and the response is logged.
5. **Review.** A person compares the invoice PDF with the PO before anything is entered.
6. **Enter.** A bot re-runs the checks at the moment of entry, keys the voucher, attaches the PDF, then reads back what it entered and voids it if anything differs.
7. **Approve.** The project manager sees the voucher with the PDF attached and approves or rejects it. A rejection voids the voucher and restores the PO balance.

### Why this reaches past accounts payable

An invoice that cannot be entered is not a late payment. It is an unrecorded liability, and the damage spreads.

Cost to date is understated, and on percentage-of-completion work everything built on it moves with it. Under cost-to-cost, percent complete is cost incurred over total estimated cost — so missing cost produces a lower percent complete than the job has really reached, less revenue recognized this period, and less gross profit with it on a profitable job. Billings in excess of costs and estimated earnings is correspondingly overstated: the balance sheet carries a liability that is not really there. None of it is permanent. It reverses when the invoices are finally entered, which means reported margin swings between periods on nothing more than paperwork timing.

The job cost report, meanwhile, misleads in the opposite direction. It shows the job underrunning its budget, because the costs are not on it yet — and nobody investigates a job that appears to be coming in under.

Alongside that: the close is delayed while someone chases a PO, with the accrual a guess until they stop; the CFO reports figures that are not complete, corrected later as a journal entry; payments go late, bringing fees and credit holds; and the backlog is finally forced in all at once to clear a payment, which is where keying errors come from.

That is why the checks run at intake rather than at the end. Catching it here protects the completeness of the books, not just the AP queue.

### Separation of duties

This is the rule the whole design is built around, and it is enforced in the code, not just in the interface:

- **Only the job's project manager or the original purchaser can change a PO or accept a difference.** The invoice team reports and processes. It does not edit.
- **One exception, and it is a lookup rather than an edit:** when an invoice arrives with no PO number on it, the invoice team can look the number up and key it in. Nothing on the PO moves, the entry is logged, and all 15 checks run again against the PO they picked — so the wrong one still fails on vendor, job or balance.
- **Every change needs a reason**, is signed off, and is written to the audit log with who, what, when and why.
- **One project manager cannot sign off on another's job.** Attempting it is refused.
- Switch "Viewing as" to AP clerk and press *Try to change the PO myself* — the system refuses it.

### The checks

15 checks run on every invoice. Each failed check is a category in the issue log, so the counts show where the process actually breaks:

`EXTRACT` `SPLIT` `VENDOR_UNKNOWN` `NO_PO` `VENDOR_MISMATCH` `PO_CLOSED` `JOB_MISMATCH` `DUPLICATE` `MATH` `TAX_RATE` `PO_SHORT` `TAX_SHORT` `FREIGHT` `ITEM_MISMATCH` `DATE` — plus `REVIEW_FOUND`, `ENTRY_FAILED` and `PM_REJECTED` raised by people and by the bot.

Counting them is the point. A month of "No purchase order found" is an argument for Phase 2. A month of tax issues is a vendor or job setup problem.

---

## Phase 2 — coding what has no job to code it to

A job purchase codes itself: the job and cost code decide the GL account, so there is little to get wrong. Overhead, SG&A and equipment have no such structure. Today they are categorized by whoever happens to key the invoice, which is where miscoding hides. Phase 2 moves that decision to the requisition, before the purchase is made.

**Every requisition declares one of three classes:**

| Class | What it covers | Coded to |
|---|---|---|
| Job related | Costs belonging to a job: materials, subcontract, rental | Job and cost code, as now |
| Equipment | Owned equipment, vehicles, parts, repairs | GL account by type; may be capital |
| Overhead and operating | Office supplies, repairs, software, insurance, professional fees, utilities | GL account by type |

Within a class, a list of purchase types covers the ordinary cases and carries the GL account with it. "Other" exists, and requires a written explanation before it can be submitted.

**Two treatments are decided here rather than at close:**

- **Capitalize or expense.** An asset at or above the $2,500 capitalization threshold is coded to fixed assets and depreciated over its useful life, not expensed in the period it was bought.
- **Expense or prepay.** A cost covering more than one month — insurance, a software license, a service contract — is carried to prepaid expenses and amortized across the periods it benefits. Expensing it in one month overstates that month and understates the rest.

The system proposes the class, the account and the treatment from the purchase type, the amount and the period covered. **It does not decide them.** Every non-job requisition carries a categorization review and is never auto-approved, however clean it looks. The proposal saves the lookup; the person still makes the call.

---

## How the real build would run

The demo is an HTML prototype of the logic and the screens. The real build would use the tools the company already licenses:

| In this demo | In the real build |
|---|---|
| Shared AP mailbox and vendor folders | An Outlook shared mailbox with Power Automate flows that sort and file the mail |
| Sorting, splitting and reading documents | A document-reading AI step and a PDF splitting step, called from Power Automate |
| Invoice log and saved files | A SharePoint list for the extracted data and a SharePoint document library for the PDFs |
| PO data, refreshed every five minutes | A scheduled sync of purchase order data from the ERP into a SharePoint list |
| Review screen and PM response screen | A Power Apps app, one view for the clerk and one for the project manager |
| Checks and issue categories | The same rules inside the flows, with the categories as a SharePoint choice column |
| Issue report | Power BI or SharePoint views over the invoice log |
| Entry bot with read-back | UI automation of the ERP, taught from screenshots, that checks what it entered |

That mapping is the plan. It is not built or tested in those tools here.

---

## What is real and what is mocked

**Real and tested here (80 automated tests):**
- Mail sorting, PDF splitting, vendor matching against a fixed list
- PO comparison, the 15 checks, issue categories, reporting and PM-only PO changes
- Reviewer verification, bot entry with read-back, PM approval, manual entry marked as manual
- The one lookup the invoice team may do: keying a PO number the invoice did not carry, logged, with every check re-run against it
- Live re-checking: the screens compare against the PO balance as it stands now, so a balance consumed by another invoice is caught before entry
- Requisition form, quote cross-check, coding, tax, budget and approval rules
- Purchase classification: three classes, 16 purchase types, capitalization threshold, prepaid detection, mandatory categorization review

**Mocked or not built:**
- The ERP is an in-memory stand-in. A real connection to the company's ERP is not built or tested.
- Outlook is simulated by the sample inbox. PDFs are represented as text pages.
- SharePoint, Power Automate and Power Apps are not used here. The log and library views are simulations.
- Phase 3 statement reconciliation is described, not built.

All data is fictional. No employer data, vendor data or system name appears anywhere in this repository.

---

## Running it

```bash
node test/test.js     # 80 tests
node build.js         # runs the tests, then inlines src/ into index.html
```

Opening `index.html` is enough to use the demo. The build only matters if you change anything in `src/`.

```
src/core.js          rules, checks, workflow, mock ERP   (no DOM)
src/samples.js       fictional vendors, jobs, POs, 13 sample emails
src/ui.js            screens and event handling
src/ui.body.html     page structure
src/ui.css           styles
test/test.js         80 tests over core.js
build.js             runs tests, inlines everything into index.html
```

`core.js` has no DOM dependency, which is why it can be tested directly in Node. The ERP sits behind one small adapter (`findVendor`, `getJob`, `getPO`, `findOpenPOs`, `enterVoucher`, `readBack`, `voidVoucher`, and so on), so swapping the mock for a real connection means rewriting that adapter and nothing else.
