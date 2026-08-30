# Invoice Reconciliation + Receivables Chaser — Task Tracker

> This file is updated as work progresses. Check status markers:
> `[ ]` = Not started | `[/]` = In progress | `[x]` = Completed

---

## Day 1 — Scope + Data ✅

- [x] Define invoice register schema (invoice ID, client name, amount, due date, status)
- [x] Define bank statement schema (date, amount, narration/reference text, transaction ID)
- [x] Build synthetic invoice register (~100+ invoices, multiple clients)
- [x] Build synthetic bank statement with realistic mess:
  - [x] Partial payments (e.g. ₹48,000 paid against ₹50,000 invoice)
  - [x] Combined payments (one transaction covering 2+ invoices)
  - [x] Typos in narration (e.g. "Priya Enterprizes" vs "Priya Enterprises")
  - [x] Rounding differences (e.g. ₹9,999 vs ₹10,000)
  - [x] Duplicate-looking transactions (same amount, different clients)
  - [x] Payments with no matching invoice (noise)
  - [x] TDS Deductions (short-pays of exactly 2% or 10%)
- [x] Split into tuning set + held-out test set (separate rows, no overlap)
- [x] Export as CSV files

---

## Day 2 — Reconciliation Matching Engine (v1) ✅

- [x] Set up project structure and dependencies (`rapidfuzz`, `pandas`, `openpyxl`)
- [x] Build amount matcher (exact match + partial-payment tolerance)
- [x] Build date-window matcher (payment within reasonable window of due date)
- [x] Build narration fuzzy matcher (client name / invoice ref in bank narration)
- [x] Combine signals into composite confidence score
- [x] Define confidence thresholds for three buckets:
  - [x] **Matched** (high confidence → auto-mark paid)
  - [x] **Low-confidence** (flag for manual review, never auto-close)
  - [x] **Unmatched** (no candidate found → still open)
- [x] Handle partial payments (mark invoice partially paid, remaining balance open)
- [x] Handle combined payments (one transaction → multiple invoices)
- [x] Output reconciliation results as structured data

---

## Day 3 — Validate + Tune the Matcher ✅

- [x] Run matcher on tuning synthetic set
- [x] Calculate auto-match rate (correct matches / total matchable)
- [x] Calculate false-match rate (wrongly matched / total matches made)
- [x] Tune confidence thresholds to minimize false-match rate
- [x] Build exception list output:
- [x] For low-confidence cases, show closest candidate transaction
  - [x] Include confidence score and reason for uncertainty
  - [x] Format for one-click human confirm/reject
- [x] Log all metrics to a results file

---

## Day 3.5 — TDS (Tax) Deduction Detection ✅

- [x] Update `data/generate_synthetic_data.ts` to inject 5 common Indian TDS rates (1%, 2%, 5%, 10%, 20%)
- [x] Update `src/reconciliation_engine.ts` with comprehensive ratio detection (0.99, 0.98, 0.95, 0.90, 0.80)
- [x] Add safety guardrail requiring higher confidence / narration match for non-exact matches
- [x] Update `src/validate_and_tune.ts` to evaluate TDS detection accuracy & log metrics
- [x] Regenerate datasets and verify performance (11/11 TDS caught, 0.0% false match rate, 100% precision)

---

## Day 4 — Late-Payment Risk Model

- [ ] Calculate per-client payment history features:
  - [ ] Average days late (payment date − due date)
  - [ ] Max days late
  - [ ] Frequency of late payments (% of invoices paid late)
  - [ ] Average invoice size
  - [ ] Payment consistency (std dev of days-to-pay)
- [ ] Build rules-based risk scorer:
  - [ ] Define Low / Medium / High thresholds
  - [ ] Assign risk tier per client
- [ ] (Optional) Train a simple classifier (e.g. decision tree) if time allows
- [ ] Validate risk tiers against known late-payers in synthetic data
- [ ] Output risk tier per client with contributing factors

---

## Day 5 — Escalating Chaser Messages

- [ ] Define escalation tiers based on days overdue:
  - [ ] 1-7 days: Polite reminder
  - [ ] 8-15 days: Firm follow-up
  - [ ] 16-30 days: Formal notice
  - [ ] 30+ days: Final escalation
- [ ] Build message templates (local, no external API)
- [ ] Personalize messages with invoice details (amount, due date, client name)
- [ ] Implement promise-to-pay tracking:
  - [ ] Field to log promised payment date
  - [ ] Pause auto-chasing until promise date passes
  - [ ] Resume chasing if promise date passes without payment
- [ ] Output chaser message queue as structured data

---

## Day 6 — Dashboard

- [ ] Set up web UI (HTML/JS or Streamlit — local)
- [ ] File upload: accept CSV/Excel for invoice register + bank statement
- [ ] Reconciliation view:
  - [ ] Per-invoice status (Matched / Low-confidence / Unmatched)
  - [ ] Low-confidence cases with candidate transaction for one-click confirm
- [ ] Risk tier view:
  - [ ] Per-client risk score (Low / Medium / High)
  - [ ] Contributing factors shown
- [ ] Chaser message queue:
  - [ ] Review each drafted message before sending
  - [ ] Copy-to-clipboard / mark-as-sent action (human in the loop)
  - [ ] Promise-to-pay input field
- [ ] Summary metrics on dashboard (total receivables, overdue amount, match rate)

---

## Day 7 — Test on Fresh Data + Report

- [ ] Generate new held-out synthetic batch (never tuned on)
- [ ] Run full pipeline end-to-end on fresh batch
- [ ] Report metrics:
  - [ ] Auto-match rate
  - [ ] False-match rate
  - [ ] Risk-tier accuracy
- [ ] Document one honest failure case (e.g. a correctly-refused auto-match)
- [ ] Save results to evaluation report

---

## Day 8 — Pitch Video + Polish

- [ ] Record 5-minute pitch video:
  - [ ] The 10-hrs/week problem
  - [ ] Live demo walkthrough
  - [ ] Three real numbers from Day 7
  - [ ] Projected impact on real business data
- [ ] Write README with:
  - [ ] Setup instructions
  - [ ] Architecture diagram (Files In → Recon Engine → Risk Model → Chaser → Dashboard)
  - [ ] How to run locally
- [ ] Final code cleanup
