# Req2PO: modern controls around the ERP you already have

**The problem.** In construction accounting, the people placing orders are rarely accountants. POs get coded wrong, or never written. Then the invoice arrives: no PO number, wrong job, tax on an exempt job, or a duplicate.

And an invoice that cannot be entered is not a late payment. It is an unrecorded liability. Cost to date is understated, so a percentage-of-completion job reports a lower percent complete than it has reached, recognizes less revenue and gross profit, and overstates billings in excess of costs — reversing when the invoices land, so margin swings between periods on paperwork.

The ERP is old, closed and manual, and replacing one runs into six figures. So I built controls around it.

**What is actually running.** Phase 1, the AP inbox, runs in production where I work, still being tuned. It takes 300 to 500 invoices a week, and about 80% arrive with something to resolve before entry — the sharpest argument for Phase 2, since those errors are made upstream.

**How it works.** Mail is sorted and filed. A PDF of several invoices is split where the invoice number changes. Vendor, invoice number, date, PO and amounts are read from each, then compared with the PO: vendor, job, subtotal left, tax, freight. The number is normalized against everything entered, so a resend is caught. Fifteen checks run; each failure becomes an issue for the PM or purchaser, never the invoice team. Only then does a reviewer compare the documents, a bot key the voucher and read back what it entered — voiding it if anything differs — and the PM approve.

AI reads. Rules decide. A bot enters. A person reviews. Only the job's PM or the original purchaser can assign a PO to an invoice that arrived without one, change one, or accept a difference — each with a logged reason and sign-off, enforced in code, not on screen.

**What comes next.** Phase 2 moves the control upstream. A job purchase codes itself; overhead and equipment do not, so today they are categorized by whoever keys the invoice. Phase 2 makes every purchase declare its class — job, equipment or overhead — and settles two treatments before the PO exists: an asset over the capitalization threshold is depreciated, not expensed; a cost covering months is carried as prepaid. The system proposes, a person confirms, and overhead is never auto-approved.

**Who benefits.** The clerk stops chasing and starts resolving. The controller closes on time, knowing which problems recur. The PM gets one question, document attached. The mechanical errors go, and the data entry with them. What remains needs an accountant: deciding how something should be treated, and reading the numbers. Simpler to execute, more demanding to think about.

It is not only for construction. Every organization that buys things has these problems; only the dimension a cost codes to differs — a job here, a client matter, a grant, a department elsewhere. The checks are the same, and the dimension sits behind one adapter.
