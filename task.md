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

## Day 4 — Late-Payment Risk Model ✅

- [x] Calculate per-client payment history features:
  - [x] Average days late (Median used for robustness against combined payment noise)
  - [x] Max days late
  - [x] Frequency of late payments (% of invoices paid late)
  - [x] Average invoice size
  - [x] Payment consistency (std dev of days-to-pay)
- [x] Build rules-based risk scorer:
  - [x] Define Low / Medium / High thresholds (Median >= 14 -> High, >= 4 -> Medium)
  - [x] Assign risk tier per client
- [x] Validate risk tiers against known late-payers in synthetic data (Achieved 85% accuracy on noisy tuning set)
- [x] Output risk tier per client with contributing factors (saved to CSV)

---

## Day 4.5 — Risk Priority Engine ✅

- [x] Upgrade risk model from categorical to financially quantified priority queue
- [x] Compute empirical P(late) per tier from ground truth
- [x] Import live outstanding balances from reconciliation output
- [x] Calculate Expected Amount at Risk (EAR = P(late) × Outstanding)
- [x] Minimum history threshold (3 invoices) to prevent noise
- [x] Output sorted by EAR descending — chase biggest ₹ risk first

---

## Day 5 — Escalating Chaser Messages ✅

- [x] Define escalation tiers based on days overdue:
  - [x] 1-7 days: Polite reminder
  - [x] 8-15 days: Firm follow-up
  - [x] 16-30 days: Formal notice
  - [x] 30+ days: Final escalation
- [x] Build message templates (local, no external API)
- [x] Personalize messages with invoice details (amount, due date, client name)
- [x] Implement promise-to-pay tracking:
  - [x] Field to log promised payment date
  - [x] Pause auto-chasing until promise date passes
  - [x] Resume chasing if promise date passes without payment
- [x] Output chaser message queue as structured data

---

## Day 5.5 — Risk-Driven Chaser Engine ✅

- [x] Dynamic timeline bending based on risk priority queue
  - [x] Critical (Top 20%): Compressed escalation timeline
  - [x] Standard (Middle 60%): Normal timeline
  - [x] Low (Bottom 20%): Stretched timeline
- [x] Broken promise override — immediate escalation when promise date passes
- [x] Queue sorted by expected_amount_at_risk

---

## Day 6 — Dashboard ✅

- [x] Set up web UI (HTML/JS — local, single-file, no build step)
- [x] File upload: accept CSV for invoice register + bank statement, runs full pipeline
- [x] Reconciliation view:
  - [x] Per-invoice status (Matched / Low-confidence / Unmatched)
  - [x] Low-confidence cases with candidate transaction for one-click confirm
- [x] Risk tier view:
  - [x] Per-client risk score (Low / Medium / High)
  - [x] Contributing factors shown
- [x] Chaser message queue:
  - [x] Review each drafted message before sending
  - [x] Copy-to-clipboard / mark-as-sent action (human in the loop)
  - [x] Promise-to-pay input field
- [x] Summary metrics on dashboard (total receivables, overdue amount, match rate)

---

## Day 7 — Test on Fresh Data + Report ✅

- [x] Generate new held-out synthetic batch (seed 123, TST- prefix, 150 invoices, 133 txns)
- [x] Run full pipeline end-to-end on fresh batch
- [x] Report metrics:
  - [x] Auto-match rate: **73.3% by count, 71.2% by ₹ value** (110/150 invoices, ₹1.12Cr/₹1.57Cr)
  - [x] False-match rate: **0.9%** (1 wrong match out of 110)
  - [x] Risk-tier accuracy: **79.2%** (38/48 clients)
- [x] Break down match rate by engine pass (5-pass breakdown: reference/exact/TDS/combined/partial)
- [x] Calculate rupee-weighted match rate (71.2% by ₹ value vs 73.3% by count)
- [x] Quantify TDS pass contribution: **11 invoices, ₹6.07L recovered** that would've been dead ends
- [x] Document honest failure case (TST-0592 — same-client collision in partial payment range)
- [x] Root-cause analysis: narration typo + amount in partial range caused wrong-client match
- [x] Save results to `output/day7_evaluation_report.md`

---

## Day 8 — Pitch Video + Polish ✅

- [ ] Record 5-minute pitch video:
  - [ ] The 10-hrs/week problem
  - [ ] Live demo walkthrough
  - [ ] Three real numbers from Day 7
  - [ ] Projected impact on real business data
- [x] Write README with:
  - [x] Setup instructions
  - [x] Architecture diagram (interactive node-based flowchart)
  - [x] How to run locally
- [x] Build interactive architecture visualization:
  - [x] Black & white node-based diagram (9 nodes, 13 connections)
  - [x] Draggable nodes, click-to-expand details, pan/zoom
  - [x] ▶ RUN simulation walks through pipeline step-by-step
  - [x] Integrated as fullscreen tab in dashboard (← BACK + browser back)
- [x] Final code cleanup

---

## Day 9 — Hungarian Algorithm Upgrade ✅

- [x] Implement `src/hungarian.ts` — pure O(n³) Kuhn-Munkres algorithm (no external library)
  - [x] Classical step-based implementation: row/col reduction + DFS augmenting paths
  - [x] Rectangular matrix support (rows ≠ cols, pad with cost=1)
  - [x] 8/8 unit tests passing including the canonical greedy-failure case
- [x] Replace greedy Pass 1 + Pass 2 with `_passHungarian` in `src/reconciliation_engine.ts`
  - [x] Per-client grouping: solves assignment within each client's invoice × transaction subgraph
  - [x] Replicates exact greedy candidate criteria (amount ≥ 0.70, narration ≥ 0.35) — no regressions
  - [x] Cost matrix: cost = 1 − composite; cost = 1 for below-reviewThreshold pairs (avoid)
  - [x] Post-solve filter: only pairs scoring ≥ matchThreshold (0.72) accepted
  - [x] Audit trail: all Hungarian-assigned matches prefixed `[Hungarian]` in notes
- [x] Passes 3–5 (combined/partial/remaining) unchanged — not bipartite one-to-one problems
- [x] Legacy Pass 1 / Pass 2 methods kept as `@deprecated` for reference
- [x] Verified final metrics — **test set** (150 invoices, 133 txns):
  - Auto-match rate: **70.5%** (98/139 paid)
  - False-match rate: **2.0%** → Precision: **98%** (up from 96.6%)
  - Correct TDS catches: **15** (up from 14 greedy)
- [x] Verified final metrics — **tuning set** (256 invoices, 224 txns):
  - Auto-match rate: **78.9%** (up from 78.4% greedy baseline)
  - False-match rate: **1.1%** → Precision: **98.9%**
- [x] Deleted scratch test file `src/test_hungarian.ts`

