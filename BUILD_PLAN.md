# Invoice Reconciliation + Receivables Chaser — Build Plan

**Track fit:** Razorpay Track 03 (Revenue Recovery) / Track 04 (Finance Controller) — directly named example directions: "B2B receivables chaser," "promise-to-pay tracker," "multi-source reconciliation."

**Scope (locked):** Business uploads (1) their invoice register and (2) a bank/UPI statement export, both as CSV/Excel — no bank API integration needed, this is realistic since that's what small businesses do today anyway. The tool reconciles what's actually paid, flags what's genuinely overdue, scores each client's late-payment risk, and auto-drafts escalating follow-up messages.

**Definition of success (so this doesn't drift):** by Day 7 you need three real numbers on a held-out test batch — reconciliation auto-match rate, false-match rate (an invoice wrongly marked "paid" is the worst failure mode — worse than missing a match), and risk-tier accuracy against known late-payers in your test data. No number, no submission.

---

## Day 1 — Scope + Data

Build a synthetic test dataset yourself: a mock invoice register (invoice ID, client, amount, due date) + a mock bank statement (date, amount, narration text). Deliberately inject realistic mess: partial payments, one bank transaction covering two invoices, typos in the narration, rounding differences.

This synthetic set is what you'll tune on Days 2-3 and test on fresh on Day 7 — don't reuse the same rows for both.

---

## Day 2 — Reconciliation Matching Engine (v1)

Fuzzy-match each bank transaction to open invoices on: amount (exact or partial-payment aware), date window, and approximate name/reference match (`rapidfuzz` or similar for the narration text).

Three output buckets per invoice:
- **Matched** (paid)
- **Unmatched** (still open)
- **Low-confidence** (flag for manual review — never auto-close on a shaky match)

---

## Day 3 — Validate + Tune the Matcher

Run on your synthetic set, log match rate and false-match rate specifically.

Build the exception list output: for low-confidence cases, show the closest candidate transaction so a human can confirm in one click.

---

## Day 4 — Late-Payment Risk Model

Per client, from invoice history: average days-late, invoice size, pattern of late payments.

Start with a simple rules-based score (baseline), upgrade to a small trained classifier only if time allows — don't over-build this, an honestly-evaluated simple model beats an elaborate unvalidated one.

**Output:** Low / Medium / High risk tier per client.

---

## Day 5 — Escalating Chaser Messages (LLM layer)

For overdue + unmatched invoices, auto-draft follow-up messages that escalate in tone with days overdue (polite → firm → formal).

Add a **"promise-to-pay" field**: if a client responds with a date, log it and pause auto-chasing until that date passes — this is a named example direction, don't skip it.

---

## Day 6 — Dashboard

Minimal UI: upload the two files → see reconciliation status per invoice → risk tier per client → chaser message queue with a review-and-send/copy action (don't auto-send unreviewed — keep a human in the loop).

Functional over polished — judges are evaluating the logic, not the CSS.

---

## Day 7 — Test on Fresh Data + Write the Numbers

Run the full pipeline on a new synthetic batch you haven't tuned on.

**Report:**
- Auto-match rate
- False-match rate
- Risk-tier accuracy
- One real failure case shown honestly (e.g. a transaction the matcher correctly refused to auto-confirm)

---

## Day 8 — Pitch Video + Polish

5 minutes: the 10-hrs/week problem → demo → your three real numbers → what it would mean in recovered/tracked receivables if run on a real business's data.

README + simple architecture diagram:

```
Files In → Reconciliation Engine → Risk Model → Chaser Generator → Dashboard
```
