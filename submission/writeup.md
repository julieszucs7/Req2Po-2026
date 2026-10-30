# Req2PO: modern controls around the ERP you already have

**The problem.** In construction accounting, the people who place orders are rarely accountants. Purchase orders get coded wrong, or never written. Then the invoice arrives: no PO number, the wrong job, tax on an exempt job, or a duplicate.

And an invoice that cannot be entered is not a late payment. It is an unrecorded liability. Cost to date is understated, so a percentage-of-completion job reports a lower percent complete than it has reached, recognizes less revenue and less gross profit, and overstates billings in excess of costs — then reverses when the invoices land, swinging margin between periods on paperwork. The job cost report shows the job underrunning, so nobody investigates.

The close slips, and the CFO reports figures that are not complete. The ERP underneath is old, closed and manual — replacing one is quoted at $25,000 to $750,000, and most run over. So I built controls around it.

**What is actually running.** Phase 1, the AP inbox, is in production where I work and still being tuned. It takes 300 to 500 invoices a week. About 80% arrive with something that must be resolved before entry — the sharpest argument for Phase 2, since those errors are made upstream.

**How it works.** Mail is sorted and filed. A PDF holding several invoices is split by page. Each is read, renamed and compared with its PO: vendor, job, subtotal left, tax, freight. Fifteen checks run, and each failure becomes a categorized issue for whoever can resolve it — the PM or purchaser, never the invoice team. Only then does a reviewer compare the documents, a bot key the voucher and read back what it entered, and the PM approve.

AI reads. Rules decide. A bot enters. A person reviews. Separation of duties is enforced in code: only the job's PM or the original purchaser can change a PO or accept a difference, every change needs a logged reason and sign-off, and the bot voids its own work if the read-back differs.

**What comes next.** Phase 2 moves the control upstream and closes a gap. A job purchase codes itself: the job and cost code decide the account. Overhead and equipment have no such structure, so today they are categorized by whoever keys the invoice. Phase 2 makes every purchase declare its class — job, equipment or overhead — and settles two treatments before the PO exists: an asset over the capitalization threshold is depreciated, not expensed; a cost covering months is carried as prepaid and amortized, not charged to one. The system proposes; a person confirms, and overhead is never auto-approved.

**Who benefits.** The clerk stops chasing and starts resolving. The controller closes on time, with a count of which problems recur. The project manager gets one question, document attached. More broadly: the mechanical errors go, and the data entry with them. What remains needs an accountant — deciding how something should be treated, and reading what the numbers say. Simpler to execute, more demanding to think about.
