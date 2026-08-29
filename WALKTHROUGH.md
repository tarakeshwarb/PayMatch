# Invoice Reconciliation + Receivables Chaser — Development Walkthrough

> This document explains **what was actually built** at each stage, why, and where to find it.
> Updated as each day's work is completed.

---

## Day 1 — Scope + Data

### What we did

Built a synthetic data generator that creates realistic mock datasets for the entire pipeline. The generator uses a **seeded PRNG** (Mulberry32) so every run produces identical output — critical for reproducible testing.

### Schemas defined

**Invoice Register** — what a business's billing system would export:

| Column | Type | Example |
|---|---|---|
| `invoice_id` | String | `INV-0001` |
| `client_name` | String | `Gupta & Sons Pvt Ltd` |
| `amount` | Number (₹) | `335500` |
| `issue_date` | Date | `2025-02-01` |
| `due_date` | Date | `2025-03-18` |
| `payment_terms_days` | Number | `45` |

**Bank Statement** — what a business downloads from their bank portal / UPI app:

| Column | Type | Example |
|---|---|---|
| `transaction_id` | String | `TXN-00019` |
| `date` | Date | `2025-01-20` |
| `amount` | Number (₹) | `262000` |
| `narration` | String | `UPI CREDIT Kapoor Industris` |
| `type` | String | `CREDIT` |

### Realistic mess injected

The whole point of the synthetic data is to stress-test the matcher with real-world problems. Here's what we deliberately injected and why:

| Mess Type | % of invoices | Example | Why it's realistic |
|---|---|---|---|
| **Exact match** | ~45% | Amount and narration match cleanly | Baseline — most payments do match |
| **Partial payment** | ~15% | ₹87,900 paid against ₹132,000 invoice | Clients pay in installments |
| **Combined payment** | ~12% | One ₹167,600 txn covers INV-0030 + INV-0089 | Clients batch-pay multiple invoices in one NEFT |
| **Typo in narration** | ~15% | "Kapoor Industris" instead of "Kapoor Industries" | Banks truncate/mangle names |
| **Rounding difference** | ~13% | ₹36,599.50 paid against ₹36,600 invoice | TDS deductions, bank charges, rounding |
| **Unpaid (no transaction)** | ~8% | Invoice exists, no payment at all | Genuinely overdue receivables |
| **Noise transactions** | 10-18 per set | "SALARY TRANSFER - AUG", "GST REFUND" | Real bank statements have non-invoice credits |

### Client profiles (20 Indian B2B businesses)

Each client has a built-in payment behavior profile that controls how late they typically pay. This serves two purposes:
1. Makes the synthetic payment dates realistic
2. Provides **ground truth** for the Day 4 risk model to validate against

Risk distribution: 7 Low, 6 Medium, 5 High risk clients.

### Train/test split

Two completely separate datasets generated with **different random seeds** and **different ID prefixes** — no data leakage:

| | Tuning Set (Days 2-3) | Test Set (Day 7) |
|---|---|---|
| Seed | 42 | 123 |
| Invoice prefix | `INV-` | `TST-` |
| Invoice count | 100 | 50 |
| Bank transactions | 98 | 58 |
| Date range starts | Jan 2025 | Apr 2025 |

### Files

| File | Purpose |
|---|---|
| [`data/generate_synthetic_data.ts`](./data/generate_synthetic_data.ts) | Data generator script (run with `npx tsx data/generate_synthetic_data.ts`) |
| [`data/tuning/invoices.csv`](./data/tuning/invoices.csv) | Tuning set — invoice register (100 rows) |
| [`data/tuning/bank_statement.csv`](./data/tuning/bank_statement.csv) | Tuning set — bank statement (98 rows incl. noise) |
| [`data/tuning/ground_truth.csv`](./data/tuning/ground_truth.csv) | Tuning set — answer key mapping each invoice to its transaction |
| [`data/tuning/client_risk_profiles.csv`](./data/tuning/client_risk_profiles.csv) | True risk tier per client (for risk model validation) |
| [`data/test/invoices.csv`](./data/test/invoices.csv) | Held-out test set — invoices (50 rows) |
| [`data/test/bank_statement.csv`](./data/test/bank_statement.csv) | Held-out test set — bank statement (58 rows) |
| [`data/test/ground_truth.csv`](./data/test/ground_truth.csv) | Held-out test set — answer key (DO NOT look at until Day 7) |
| [`data/test/client_risk_profiles.csv`](./data/test/client_risk_profiles.csv) | Held-out test set — true risk tiers |

---

## Day 2 — Reconciliation Matching Engine (v1)

### What we built

A **multi-pass greedy reconciliation engine** that matches bank transactions to invoices. Built in Node.js using `fuzzball` (JS port of rapidfuzz) for fuzzy text matching.

### Architecture: 5-pass matching pipeline

The engine processes transactions through 5 sequential passes, ordered from highest to lowest confidence:

| Pass | What it does | Confidence level |
|---|---|---|
| **Pass 1** | Invoice ID found in narration (e.g. "NEFT-INV-0037") | Highest (0.95-0.98) |
| **Pass 2** | Client name + amount match (exact/rounding) | High (0.72-0.95) |
| **Pass 3** | Combined payment detection (1 txn → 2+ invoices) | Medium-High (0.85) |
| **Pass 4** | Partial payments (50-98% of invoice amount) | Medium (0.72+) |
| **Pass 5** | Score all remaining, build candidate lists for review | Low (review queue) |

### Three scoring dimensions

Each invoice-transaction pair is scored on:

1. **Amount score (0-1)**: Exact match → 1.0, rounding tolerance ±₹50 → 0.95, partial 50-98% → scaled lower
2. **Date score (0-1)**: Paid on time → 1.0, decays with days late (7d → 0.95, 30d → 0.70, 90d → 0.10)
3. **Narration score (0-1)**: Invoice ID in text → 1.0, fuzzy client name match via `token_set_ratio` → 0.35-0.90

Composite score weights shift based on signal strength — when narration is strong, it dominates; when narration is absent, amount gets more weight.

### Key design decisions

- **Conservative thresholds**: `matchThreshold = 0.72`, `reviewThreshold = 0.35` — when in doubt, flag for review
- **Ambiguity gap**: If the best match and second-best are within 0.15 of each other, flag for review instead of auto-matching
- **Noise filtering**: 17 keyword patterns (ATM, SALARY, GST REFUND, VENDOR ADVANCE, etc.) filter out non-invoice bank transactions
- **Combined payment tolerance**: 0.5% — tight to prevent coincidental amount-sum matches

### Bugs found and fixed (3 iterations)

| Bug | Impact | Fix |
|---|---|---|
| `"".includes("")` returns `true` in JS | Empty invoiceId gave every client narration score 1.0 in combined detection | Check `invoiceId && invoiceIdUpper.length > 0` before includes |
| "VENDOR ADVANCE REFUND" not in noise filter | Noise transactions being matched as combined payments | Added 'VENDOR ADVANCE', 'ADVANCE REFUND' to noise keywords |
| Combined tolerance too loose (1%) | Coincidental amount sums matching wrong invoices | Tightened to 0.5% |
| Generic narrations ("Bulk payment") auto-matching | Combined detector matched wrong client groups | Raised narration threshold from 0.30 to 0.55 for combined |
| Single-invoice narration containing multiple IDs | Pass 1 only handled single-ID narrations | Rewrote Pass 1 to detect multi-ID narrations → route to combined logic |

### Tuning metrics progression

| Version | Auto-match rate | False-match rate | Precision |
|---|---|---|---|
| v1 (initial) | 69.5% | 15.4% | 84.6% |
| v2 (noise + threshold fixes) | 75.8% | 8.9% | 91.1% |
| **v3 (bug fix + tolerance)** | **83.2%** | **0.0%** | **100%** |

### Remaining misses (by design)

All 16 remaining misses are **combined payments** flagged for human review or unmatched — the engine correctly refuses to auto-confirm when it isn't sure. This is the intended behavior.

### Files

| File | Purpose |
|---|---|
| [`src/reconciliation_engine.ts`](./src/reconciliation_engine.ts) | Core engine — 5-pass matcher with scoring functions |
| [`src/run_reconciliation.ts`](./src/run_reconciliation.ts) | Runner + evaluator — loads CSVs, runs engine, compares to ground truth |
| [`output/reconciliation_tuning.json`](./output/reconciliation_tuning.json) | Full results from latest tuning run |

---

## Day 3 — Validate + Tune the Matcher

*Not started yet.*

---

## Day 4 — Late-Payment Risk Model

*Not started yet.*

---

## Day 5 — Escalating Chaser Messages

*Not started yet.*

---

## Day 6 — Dashboard

*Not started yet.*

---

## Day 7 — Test on Fresh Data + Report

*Not started yet.*

---

## Day 8 — Pitch Video + Polish

*Not started yet.*
