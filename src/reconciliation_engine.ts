/**
 * Reconciliation Matching Engine
 * 
 * Multi-pass greedy matcher that reconciles bank transactions to invoices.
 * 
 * Algorithm:
 *   Pass 1 — High-confidence: invoice ID found in narration + amount match
 *   Pass 2 — Strong matches: client name match + amount close (exact/rounding)
 *   Pass 3 — Combined payments: one transaction covers 2+ invoices from same client
 *   Pass 4 — Partial payments: transaction is a fraction of an invoice
 *   Pass 5 — Score remaining and classify (low-confidence or unmatched)
 * 
 * Design principle: FALSE MATCHES ARE THE WORST FAILURE MODE.
 *   → Conservative thresholds. When in doubt, flag for review, never auto-close.
 * 
 * Three output buckets per invoice:
 *   - matched:        high confidence, safe to auto-mark as paid
 *   - low_confidence:  flag for human review, show closest candidate
 *   - unmatched:       no candidate found, invoice still open
 */

import * as fuzz from 'fuzzball';

// ============================================================
// Types
// ============================================================

export interface InvoiceRecord {
    invoice_id: string;
    client_name: string;
    amount: string | number;
    issue_date: string;
    due_date: string;
    [key: string]: any;
}

export interface TransactionRecord {
    transaction_id: string;
    date: string;
    amount: string | number;
    narration: string;
    type: string;
    [key: string]: any;
}

export interface CandidateTransaction {
    transaction_id: string;
    amount: number;
    date: string;
    narration: string;
    confidence: number;
    matchType: string;
    amountScore?: number;
    dateScore?: number;
    narrationScore?: number;
    note: string;
}

export interface MatchedTransaction {
    transaction_id: string;
    amount: number;
    paidAmount: number;
    date: string;
    narration: string;
    confidence: number;
    matchType: string;
}

export interface EngineInvoice extends InvoiceRecord {
    amount: number;
    status: 'open' | 'matched' | 'low_confidence' | 'unmatched' | 'partial';
    remainingAmount: number;
    matchedTransactions: MatchedTransaction[];
    candidateTransactions: CandidateTransaction[];
    confidence: number;
    matchType: string | null;
    notes: string[];
}

export interface EngineTransaction extends TransactionRecord {
    amount: number;
    assigned: boolean;
    assignedTo: string[];
}

export interface EngineOptions {
    matchThreshold?: number;
    reviewThreshold?: number;
    combinedTolerance?: number;
    ambiguityGap?: number;
}

// ============================================================
// Scoring Functions
// ============================================================

/**
 * Score how well a transaction amount matches an invoice amount.
 * Returns { score: 0-1, type: 'exact'|'rounding'|'partial'|'none' }
 */
export function scoreAmount(txnAmount: number, invoiceAmount: number): { score: number; type: string } {
    if (invoiceAmount <= 0) return { score: 0, type: 'none' };

    const diff = Math.abs(txnAmount - invoiceAmount);
    const pctDiff = diff / invoiceAmount;

    // Exact match
    if (diff === 0) {
        return { score: 1.0, type: 'exact' };
    }

    // Rounding tolerance: within ₹50 AND within 0.5%
    if (diff <= 50 && pctDiff <= 0.005) {
        return { score: 0.95, type: 'rounding' };
    }

    // TDS Deduction: common Indian TDS rates — 1%, 2%, 5%, 10%, 20% (no-PAN)
    // Check if paid amount = invoice_amount × (1 − rate) within rounding tolerance
    // MUST come before generic rounding checks so 1%/2% TDS isn't misclassified
    if (txnAmount < invoiceAmount) {
        const ratio = txnAmount / invoiceAmount;
        const tdsRatios = [0.99, 0.98, 0.95, 0.90, 0.80]; // (1 - 1%), (1 - 2%), (1 - 5%), (1 - 10%), (1 - 20%)
        const tolerance = 0.005; // 0.5% rounding tolerance
        for (const expectedRatio of tdsRatios) {
            if (Math.abs(ratio - expectedRatio) <= tolerance) {
                const tdsRate = Math.round((1 - expectedRatio) * 100);
                return { score: 0.92, type: `tds_${tdsRate}pct` };
            }
        }
    }

    // Close match: within 1% (but not TDS — those are caught above)
    if (pctDiff <= 0.01) {
        return { score: 0.90, type: 'rounding' };
    }

    // Wider rounding: within 2% (for larger rounding diffs)
    // Classified as 'rounding_wide' — not safe to auto-match without strong evidence
    if (pctDiff <= 0.02) {
        return { score: 0.80, type: 'rounding_wide' };
    }

    // Partial payment: 40-99% of invoice
    if (txnAmount < invoiceAmount && txnAmount / invoiceAmount >= 0.40) {
        const ratio = txnAmount / invoiceAmount;
        // Higher ratio → higher score, but capped lower than exact
        return { score: 0.30 + (ratio * 0.40), type: 'partial' };
    }

    // Overpayment within 5% (rare but happens)
    if (txnAmount > invoiceAmount && pctDiff <= 0.05) {
        return { score: 0.70, type: 'rounding' };
    }

    return { score: 0, type: 'none' };
}

/**
 * Score how well the transaction date fits the invoice due date.
 * Returns 0-1.
 */
export function scoreDate(txnDateStr: string, dueDateStr: string, issueDateStr: string): number {
    const txnDate = new Date(txnDateStr);
    const dueDate = new Date(dueDateStr);
    const issueDate = new Date(issueDateStr);

    const daysDiff = Math.floor((txnDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    const daysFromIssue = Math.floor((txnDate.getTime() - issueDate.getTime()) / (1000 * 60 * 60 * 24));

    // Payment before issue date is suspicious
    if (daysFromIssue < -5) return 0.05;

    // Paid early (before due date) — excellent
    if (daysDiff <= 0) return 1.0;

    // 1-7 days late
    if (daysDiff <= 7) return 0.95;

    // 8-15 days late
    if (daysDiff <= 15) return 0.85;

    // 16-30 days late
    if (daysDiff <= 30) return 0.70;

    // 31-60 days late
    if (daysDiff <= 60) return 0.50;

    // 61-90 days late
    if (daysDiff <= 90) return 0.30;

    // 90+ days — very unlikely to be the right match
    return 0.10;
}

/**
 * Score how well the narration matches the invoice.
 * Returns { score: 0-1, invoiceIdFound: boolean, clientNameScore: number }
 */
export function scoreNarration(narration: string, clientName: string, invoiceId: string): { score: number; invoiceIdFound: boolean; clientNameScore: number } {
    if (!narration) return { score: 0, invoiceIdFound: false, clientNameScore: 0 };

    const narrationUpper = narration.toUpperCase();
    const invoiceIdUpper = invoiceId.toUpperCase();

    // Check if invoice ID appears in narration (strongest signal)
    const invoiceIdFound = invoiceId && invoiceIdUpper.length > 0 && narrationUpper.includes(invoiceIdUpper);
    if (invoiceIdFound) {
        return { score: 1.0, invoiceIdFound: true, clientNameScore: 100 };
    }

    // Fuzzy match client name against narration
    // Use token_set_ratio — handles extra words and word order differences
    const clientNameScore = fuzz.token_set_ratio(clientName.toUpperCase(), narrationUpper);

    // Also try partial_ratio for substring matching (bank narrations often embed client name)
    const partialScore = fuzz.partial_ratio(clientName.toUpperCase(), narrationUpper);

    const bestScore = Math.max(clientNameScore, partialScore);

    let score;
    if (bestScore >= 90) score = 0.90;
    else if (bestScore >= 80) score = 0.75;
    else if (bestScore >= 70) score = 0.60;
    else if (bestScore >= 55) score = 0.35;
    else if (bestScore >= 40) score = 0.15;
    else score = 0.0;

    return { score, invoiceIdFound: false, clientNameScore: bestScore };
}

/**
 * Compute composite confidence score from individual scores.
 * Weights shift depending on signal strength.
 */
export function computeComposite(amountScore: number, dateScore: number, narrationResult: { score: number, invoiceIdFound: boolean }): number {
    const { score: narrScore, invoiceIdFound } = narrationResult;

    // If invoice ID found in narration, that's the strongest signal
    if (invoiceIdFound) {
        return 0.35 * amountScore + 0.05 * dateScore + 0.60 * narrScore;
    }

    // If narration matches well, trust it
    if (narrScore >= 0.75) {
        return 0.40 * amountScore + 0.15 * dateScore + 0.45 * narrScore;
    }

    // If narration is weak, rely more on amount
    if (narrScore >= 0.35) {
        return 0.50 * amountScore + 0.20 * dateScore + 0.30 * narrScore;
    }

    // No narration signal — amount-only match is risky
    return 0.55 * amountScore + 0.25 * dateScore + 0.20 * narrScore;
}

// ============================================================
// Combined Payment Detection
// ============================================================

/**
 * Try to find a subset of invoices (2-3) whose amounts sum to the transaction.
 * Only considers invoices from the same client.
 * Returns null or { invoices: [...], totalAmount, diff }
 */
export function detectCombinedPayment(txnAmount: number, candidateInvoices: EngineInvoice[], tolerance = 0.01) {
    if (candidateInvoices.length < 2) return null;

    // Try pairs first (most common)
    for (let i = 0; i < candidateInvoices.length; i++) {
        for (let j = i + 1; j < candidateInvoices.length; j++) {
            const sum = candidateInvoices[i].amount + candidateInvoices[j].amount;
            const diff = Math.abs(sum - txnAmount);
            if (diff / txnAmount <= tolerance) {
                return {
                    invoices: [candidateInvoices[i], candidateInvoices[j]],
                    totalAmount: sum,
                    diff: diff,
                };
            }
        }
    }

    // Try triplets (rarer, but happens)
    if (candidateInvoices.length >= 3) {
        for (let i = 0; i < candidateInvoices.length; i++) {
            for (let j = i + 1; j < candidateInvoices.length; j++) {
                for (let k = j + 1; k < candidateInvoices.length; k++) {
                    const sum = candidateInvoices[i].amount + candidateInvoices[j].amount + candidateInvoices[k].amount;
                    const diff = Math.abs(sum - txnAmount);
                    if (diff / txnAmount <= tolerance) {
                        return {
                            invoices: [candidateInvoices[i], candidateInvoices[j], candidateInvoices[k]],
                            totalAmount: sum,
                            diff: diff,
                        };
                    }
                }
            }
        }
    }

    return null;
}

// ============================================================
// Noise Detection
// ============================================================

const NOISE_KEYWORDS = [
    'ATM', 'SALARY', 'PERSONAL', 'GST REFUND', 'INTEREST CREDIT',
    'RENT DEPOSIT', 'INSURANCE CLAIM', 'ELECTRICITY BILL', 'EMI BOUNCE',
    'LOAN DISBURSEMENT', 'FD MATURITY', 'DIVIDEND CREDIT', 'MISC CREDIT',
    'TDS REFUND', 'SECURITY DEPOSIT', 'CASH WITHDRAWAL',
    'VENDOR ADVANCE', 'ADVANCE REFUND',
];

export function isLikelyNoise(narration: string): boolean {
    if (!narration) return false;
    const upper = narration.toUpperCase();
    return NOISE_KEYWORDS.some(kw => upper.includes(kw));
}

// ============================================================
// Main Reconciliation Engine
// ============================================================

export class ReconciliationEngine {
    matchThreshold: number;
    reviewThreshold: number;
    combinedTolerance: number;
    ambiguityGap: number;

    constructor(options: EngineOptions = {}) {
        // Thresholds (conservative — false matches are the worst outcome)
        this.matchThreshold = options.matchThreshold ?? 0.72;
        this.reviewThreshold = options.reviewThreshold ?? 0.35;
        this.combinedTolerance = options.combinedTolerance ?? 0.005; // 0.5% (tight to avoid coincidental sums)
        this.ambiguityGap = options.ambiguityGap ?? 0.15; // min gap between best and 2nd-best
    }

    /**
     * Run full reconciliation.
     * @param invoices - Invoice register rows
     * @param transactions - Bank statement rows
     * @returns { results: [...], summary: {...} }
     */
    reconcile(invoices: InvoiceRecord[], transactions: TransactionRecord[]) {
        // Track state
        const invoiceState = new Map<string, EngineInvoice>(); // invoice_id → { ...invoice, status, remainingAmount }
        const txnState = new Map<string, EngineTransaction>();     // transaction_id → { ...txn, assigned: bool }

        // Initialize
        invoices.forEach(inv => {
            invoiceState.set(inv.invoice_id, {
                ...inv,
                amount: typeof inv.amount === 'string' ? parseFloat(inv.amount) : inv.amount,
                status: 'open',
                remainingAmount: typeof inv.amount === 'string' ? parseFloat(inv.amount) : inv.amount,
                matchedTransactions: [],
                candidateTransactions: [],
                confidence: 0,
                matchType: null,
                notes: [],
            });
        });

        transactions.forEach(txn => {
            txnState.set(txn.transaction_id, {
                ...txn,
                amount: typeof txn.amount === 'string' ? parseFloat(txn.amount) : txn.amount,
                assigned: false,
                assignedTo: [],
            });
        });

        // Filter out likely noise transactions early
        const noiseTxns: string[] = [];
        const candidateTxns: EngineTransaction[] = [];
        for (const [txnId, txn] of Array.from(txnState.entries())) {
            if (isLikelyNoise(txn.narration)) {
                txn.assigned = true; // skip noise
                noiseTxns.push(txnId);
            } else {
                candidateTxns.push(txn);
            }
        }

        // ── Pass 1: Invoice ID in narration (highest confidence) ──
        this._passInvoiceIdMatch(invoiceState, candidateTxns);

        // ── Pass 2: Strong single matches (client name + amount) ──
        this._passStrongSingleMatch(invoiceState, candidateTxns);

        // ── Pass 3: Combined payment detection ──
        this._passCombinedPayments(invoiceState, candidateTxns);

        // ── Pass 3.5: Cross-client combined payment suggestions (review only) ──
        this._passCrossClientCombined(invoiceState, candidateTxns);

        // ── Pass 4: Partial payments ──
        this._passPartialPayments(invoiceState, candidateTxns);

        // ── Pass 5: Score remaining and build candidates for review ──
        this._passScoreRemaining(invoiceState, candidateTxns);

        // Build final results
        return this._buildResults(invoiceState, noiseTxns);
    }

    /**
     * Pass 1: Look for invoice IDs directly mentioned in narrations.
     * Handles both single-invoice and multi-invoice narrations.
     */
    private _passInvoiceIdMatch(invoiceState: Map<string, EngineInvoice>, candidateTxns: EngineTransaction[]) {
        for (const txn of candidateTxns) {
            if (txn.assigned) continue;

            const narrationUpper = (txn.narration || '').toUpperCase();

            // Find ALL invoice IDs mentioned in this narration
            const mentionedInvoices: EngineInvoice[] = [];
            for (const [invId, inv] of Array.from(invoiceState.entries())) {
                if (inv.status !== 'open') continue;
                if (narrationUpper.includes(invId.toUpperCase())) {
                    mentionedInvoices.push(inv);
                }
            }

            if (mentionedInvoices.length === 0) continue;

            if (mentionedInvoices.length === 1) {
                // Single invoice ID — standard match
                const inv = mentionedInvoices[0];
                const amtResult = scoreAmount(txn.amount, inv.remainingAmount);
                if (amtResult.score >= 0.70) {
                    this._assignMatch(inv, txn, {
                        confidence: Math.min(0.98, 0.60 + amtResult.score * 0.40),
                        matchType: amtResult.type === 'exact' ? 'exact' : amtResult.type,
                        paidAmount: txn.amount,
                        note: `Invoice ID "${inv.invoice_id}" found in narration. Amount ${amtResult.type}.`,
                    });
                }
            } else {
                // Multiple invoice IDs in narration — combined payment
                const totalAmount = mentionedInvoices.reduce((s, inv) => s + inv.amount, 0);
                const diff = Math.abs(totalAmount - txn.amount);
                const tolerance = totalAmount * 0.02; // 2% tolerance

                if (diff <= tolerance) {
                    for (const inv of mentionedInvoices) {
                        this._assignMatch(inv, txn, {
                            confidence: 0.95,
                            matchType: 'combined',
                            paidAmount: inv.amount,
                            note: `Combined payment: invoice IDs ${mentionedInvoices.map(i => i.invoice_id).join(' + ')} found in narration.`,
                        });
                    }
                }
            }
        }
    }

    /**
     * Pass 2: Strong single matches — good narration + amount match.
     */
    private _passStrongSingleMatch(invoiceState: Map<string, EngineInvoice>, candidateTxns: EngineTransaction[]) {
        for (const txn of candidateTxns) {
            if (txn.assigned) continue;

            let bestMatch: any = null;
            let secondBest: any = null;

            for (const [invId, inv] of Array.from(invoiceState.entries())) {
                if (inv.status !== 'open') continue;

                const amtResult = scoreAmount(txn.amount, inv.remainingAmount);
                if (amtResult.score < 0.70) continue; // amount must be close

                const dateResult = scoreDate(txn.date, inv.due_date, inv.issue_date);
                const narrResult = scoreNarration(txn.narration, inv.client_name, inv.invoice_id);

                // Need at least some narration signal for a strong match
                if (narrResult.score < 0.35) continue;

                const composite = computeComposite(amtResult.score, dateResult, narrResult);

                const candidate = {
                    invoice: inv,
                    amountScore: amtResult.score,
                    amountType: amtResult.type,
                    dateScore: dateResult,
                    narrationScore: narrResult.score,
                    narrationDetail: narrResult.clientNameScore,
                    composite: composite,
                };

                if (!bestMatch || composite > bestMatch.composite) {
                    secondBest = bestMatch;
                    bestMatch = candidate;
                } else if (!secondBest || composite > secondBest.composite) {
                    secondBest = candidate;
                }
            }

            if (!bestMatch) continue;

            // Check if match is unambiguous (clear gap over 2nd-best)
            const gap = secondBest ? bestMatch.composite - secondBest.composite : 1.0;
            const isAmbiguous = gap < this.ambiguityGap && secondBest;

            if (bestMatch.composite >= this.matchThreshold && !isAmbiguous) {
                // Extra safety: for non-exact amounts (TDS, partial), require stronger evidence
                // to prevent a partial payment for Invoice A being wrongly matched to Invoice B
                const isNonExact = bestMatch.amountType !== 'exact' && bestMatch.amountType !== 'rounding';
                const invoiceIdInNarration = txn.narration.toUpperCase().includes(bestMatch.invoice.invoice_id.toUpperCase());
                
                if (isNonExact && !invoiceIdInNarration && bestMatch.composite < 0.85) {
                    // Not confident enough for a non-exact match without invoice ID — flag for review
                    continue;
                }

                this._assignMatch(bestMatch.invoice, txn, {
                    confidence: bestMatch.composite,
                    matchType: bestMatch.amountType,
                    paidAmount: txn.amount,
                    note: `Strong match: amount=${bestMatch.amountScore.toFixed(2)}, narration=${bestMatch.narrationScore.toFixed(2)}, date=${bestMatch.dateScore.toFixed(2)}`,
                });
            }
        }
    }

    /**
     * Pass 3: Detect combined payments — one transaction covering multiple invoices.
     * CONSERVATIVE: requires strong narration signal (client name) to auto-match.
     * Generic narrations like 'Bulk payment' are flagged for review, never auto-matched.
     */
    private _passCombinedPayments(invoiceState: Map<string, EngineInvoice>, candidateTxns: EngineTransaction[]) {
        for (const txn of candidateTxns) {
            if (txn.assigned) continue;

            // Skip if narration looks like noise
            if (isLikelyNoise(txn.narration)) continue;

            // Group open invoices by client name
            const clientInvoices = new Map<string, EngineInvoice[]>();
            for (const [invId, inv] of Array.from(invoiceState.entries())) {
                if (inv.status !== 'open') continue;
                if (!clientInvoices.has(inv.client_name)) {
                    clientInvoices.set(inv.client_name, []);
                }
                clientInvoices.get(inv.client_name)!.push(inv);
            }

            // Check narration for client name hints
            // STRICT: require strong client name match to avoid coincidental amount sums
            let bestCombined: any = null;
            let bestNarrScore = 0;

            for (const [clientName, invs] of Array.from(clientInvoices.entries())) {
                if (invs.length < 2) continue;

                const narrResult = scoreNarration(txn.narration, clientName, '');
                // Require STRONG narration match — 0.55 minimum (up from 0.30)
                if (narrResult.score < 0.55) continue;

                const combined = detectCombinedPayment(
                    txn.amount, invs, this.combinedTolerance
                );

                if (combined && narrResult.score > bestNarrScore) {
                    bestCombined = combined;
                    bestNarrScore = narrResult.score;
                }
            }

            if (bestCombined) {
                // Only auto-match if narration clearly identifies the client
                const confidence = bestNarrScore >= 0.70 ? 0.85 : 0.50;

                if (confidence >= this.matchThreshold) {
                    for (const inv of bestCombined.invoices) {
                        this._assignMatch(inv, txn, {
                            confidence: confidence,
                            matchType: 'combined',
                            paidAmount: inv.amount,
                            note: `Combined payment: ${bestCombined.invoices.map((i: any) => i.invoice_id).join(' + ')} = ₹${bestCombined.totalAmount} (diff ₹${bestCombined.diff.toFixed(2)}). Client narration score: ${bestNarrScore.toFixed(2)}`,
                        });
                    }
                } else {
                    // Flag as low-confidence combined — human must confirm
                    for (const inv of bestCombined.invoices) {
                        inv.candidateTransactions.push({
                            transaction_id: txn.transaction_id,
                            amount: txn.amount,
                            date: txn.date,
                            narration: txn.narration,
                            confidence: confidence,
                            matchType: 'combined',
                            note: `Possible combined payment (narration too weak to auto-confirm: ${bestNarrScore.toFixed(2)})`,
                        });
                    }
                }
            }
        }
    }

    /**
     * Pass 3.5: Cross-client combined payment suggestions.
     * For large unmatched transactions with generic narrations ("Bulk payment"),
     * try to find invoice subsets across ALL clients that sum to the amount.
     * NEVER auto-matches — only adds candidates for human review.
     */
    private _passCrossClientCombined(invoiceState: Map<string, EngineInvoice>, candidateTxns: EngineTransaction[]) {
        for (const txn of candidateTxns) {
            if (txn.assigned) continue;
            if (isLikelyNoise(txn.narration)) continue;

            // Collect all open invoices (across all clients)
            const openInvoices: EngineInvoice[] = [];
            for (const [invId, inv] of Array.from(invoiceState.entries())) {
                if (inv.status !== 'open') continue;
                openInvoices.push(inv);
            }

            if (openInvoices.length < 2) continue;

            // Try to find pairs that sum to the transaction amount
            const tolerance = txn.amount * 0.005; // 0.5%
            let bestPair: EngineInvoice[] | null = null;
            let bestDiff = Infinity;

            for (let i = 0; i < openInvoices.length; i++) {
                for (let j = i + 1; j < openInvoices.length; j++) {
                    const sum = openInvoices[i].amount + openInvoices[j].amount;
                    const diff = Math.abs(sum - txn.amount);
                    if (diff <= tolerance && diff < bestDiff) {
                        bestDiff = diff;
                        bestPair = [openInvoices[i], openInvoices[j]];
                    }
                }
            }

            // Also try triplets if no pair found
            if (!bestPair && openInvoices.length >= 3) {
                for (let i = 0; i < Math.min(openInvoices.length, 15); i++) {
                    for (let j = i + 1; j < Math.min(openInvoices.length, 15); j++) {
                        for (let k = j + 1; k < Math.min(openInvoices.length, 15); k++) {
                            const sum = openInvoices[i].amount + openInvoices[j].amount + openInvoices[k].amount;
                            const diff = Math.abs(sum - txn.amount);
                            if (diff <= tolerance && diff < bestDiff) {
                                bestDiff = diff;
                                bestPair = [openInvoices[i], openInvoices[j], openInvoices[k]];
                            }
                        }
                    }
                }
            }

            if (bestPair) {
                const totalAmount = bestPair.reduce((s, inv) => s + inv.amount, 0);
                const clients = [...new Set(bestPair.map(inv => inv.client_name))];
                const isCrossClient = clients.length > 1;

                // Flag as low-confidence candidate — NEVER auto-match cross-client
                for (const inv of bestPair) {
                    // Don't add duplicate candidates
                    const alreadyHas = inv.candidateTransactions.some(
                        c => c.transaction_id === txn.transaction_id
                    );
                    if (alreadyHas) continue;

                    inv.candidateTransactions.push({
                        transaction_id: txn.transaction_id,
                        amount: txn.amount,
                        date: txn.date,
                        narration: txn.narration,
                        confidence: 0.40,
                        matchType: 'combined',
                        note: `Possible ${isCrossClient ? 'cross-client ' : ''}combined payment: ${bestPair.map(i => i.invoice_id).join(' + ')} = ₹${totalAmount.toFixed(2)} (diff ₹${bestDiff.toFixed(2)}). Clients: ${clients.join(', ')}`,
                    });
                }
            }
        }
    }

    /**
     * Pass 4: Partial payments — transaction is a fraction of an invoice.
     */
    private _passPartialPayments(invoiceState: Map<string, EngineInvoice>, candidateTxns: EngineTransaction[]) {
        for (const txn of candidateTxns) {
            if (txn.assigned) continue;

            let bestMatch: any = null;

            for (const [invId, inv] of Array.from(invoiceState.entries())) {
                if (inv.status !== 'open') continue;

                const ratio = txn.amount / inv.remainingAmount;
                if (ratio < 0.40 || ratio >= 0.98) continue; // not a partial payment

                const narrResult = scoreNarration(txn.narration, inv.client_name, inv.invoice_id);
                if (narrResult.score < 0.35) continue; // need narration signal for partials

                const dateResult = scoreDate(txn.date, inv.due_date, inv.issue_date);

                // Partial payment confidence: weighted by narration (partials are risky)
                const confidence = 0.20 * (ratio * 0.8) + 0.25 * dateResult + 0.55 * narrResult.score;

                if (!bestMatch || confidence > bestMatch.confidence) {
                    bestMatch = {
                        invoice: inv,
                        confidence: confidence,
                        ratio: ratio,
                        paidAmount: txn.amount,
                        narrationScore: narrResult.score,
                        dateScore: dateResult,
                        txn: txn,
                    };
                }
            }

            if (!bestMatch) continue;

            if (bestMatch.confidence >= this.matchThreshold) {
                this._assignMatch(bestMatch.invoice, bestMatch.txn, {
                    confidence: bestMatch.confidence,
                    matchType: 'partial',
                    paidAmount: bestMatch.paidAmount,
                    note: `Partial payment: ₹${bestMatch.paidAmount} of ₹${bestMatch.invoice.remainingAmount} (${(bestMatch.ratio * 100).toFixed(1)}%). Narration=${bestMatch.narrationScore.toFixed(2)}`,
                });
            } else if (bestMatch.confidence >= this.reviewThreshold) {
                bestMatch.invoice.candidateTransactions.push({
                    transaction_id: bestMatch.txn.transaction_id,
                    amount: bestMatch.txn.amount,
                    date: bestMatch.txn.date,
                    narration: bestMatch.txn.narration,
                    confidence: bestMatch.confidence,
                    matchType: 'partial',
                    note: `Possible partial payment (${(bestMatch.ratio * 100).toFixed(1)}%)`,
                });
            }
        }
    }

    /**
     * Pass 5: Score all remaining open invoices against unassigned transactions.
     * Build candidate lists for manual review.
     */
    private _passScoreRemaining(invoiceState: Map<string, EngineInvoice>, candidateTxns: EngineTransaction[]) {
        for (const [invId, inv] of Array.from(invoiceState.entries())) {
            if (inv.status !== 'open') continue;

            const unassigned = candidateTxns.filter(t => !t.assigned);

            for (const txn of unassigned) {
                const amtResult = scoreAmount(txn.amount, inv.remainingAmount);
                if (amtResult.score < 0.20) continue; // skip obviously unrelated

                const dateResult = scoreDate(txn.date, inv.due_date, inv.issue_date);
                const narrResult = scoreNarration(txn.narration, inv.client_name, inv.invoice_id);
                const composite = computeComposite(amtResult.score, dateResult, narrResult);

                if (composite >= this.reviewThreshold) {
                    inv.candidateTransactions.push({
                        transaction_id: txn.transaction_id,
                        amount: txn.amount,
                        date: txn.date,
                        narration: txn.narration,
                        confidence: composite,
                        matchType: amtResult.type || 'unknown',
                        amountScore: amtResult.score,
                        dateScore: dateResult,
                        narrationScore: narrResult.score,
                        note: `Candidate: amt=${amtResult.score.toFixed(2)}, narr=${narrResult.score.toFixed(2)}, date=${dateResult.toFixed(2)}`,
                    });
                }
            }

            // Sort candidates by confidence (best first)
            inv.candidateTransactions.sort((a, b) => b.confidence - a.confidence);

            // Deduplicate candidates (keep best per transaction)
            const seen = new Set<string>();
            inv.candidateTransactions = inv.candidateTransactions.filter(c => {
                if (seen.has(c.transaction_id)) return false;
                seen.add(c.transaction_id);
                return true;
            });

            // If we have candidates but no match, mark as low_confidence
            if (inv.candidateTransactions.length > 0 && inv.status === 'open') {
                inv.status = 'low_confidence';
                inv.confidence = inv.candidateTransactions[0].confidence;
                inv.notes.push(`Best candidate: ${inv.candidateTransactions[0].transaction_id} (confidence=${inv.candidateTransactions[0].confidence.toFixed(2)})`);
            }
        }
    }

    /**
     * Assign a confirmed match between an invoice and a transaction.
     */
    private _assignMatch(inv: EngineInvoice, txn: EngineTransaction, { confidence, matchType, paidAmount, note }: { confidence: number, matchType: string, paidAmount: number, note: string }) {
        const actualPaid = Math.min(paidAmount, inv.remainingAmount);

        inv.matchedTransactions.push({
            transaction_id: txn.transaction_id,
            amount: txn.amount,
            paidAmount: actualPaid,
            date: txn.date,
            narration: txn.narration,
            confidence: confidence,
            matchType: matchType,
        });

        inv.remainingAmount = +(inv.remainingAmount - actualPaid).toFixed(2);
        inv.confidence = confidence;
        inv.matchType = matchType;
        inv.notes.push(note);

        if (inv.remainingAmount <= 0.01) {
            inv.status = 'matched';
        } else {
            inv.status = 'partial';
        }

        txn.assigned = true;
        txn.assignedTo.push(inv.invoice_id);
    }

    /**
     * Build final output from internal state.
     */
    private _buildResults(invoiceState: Map<string, EngineInvoice>, noiseTxns: string[]) {
        const results: any[] = [];
        const summary: Record<string, number> = { matched: 0, partial: 0, low_confidence: 0, unmatched: 0 };

        for (const [invId, inv] of Array.from(invoiceState.entries())) {
            // Finalize status
            if (inv.status === 'open') inv.status = 'unmatched';

            const result = {
                invoice_id: inv.invoice_id,
                client_name: inv.client_name,
                invoice_amount: inv.amount,
                status: inv.status,
                confidence: +inv.confidence.toFixed(3),
                match_type: inv.matchType || null,
                paid_amount: +(inv.amount - inv.remainingAmount).toFixed(2),
                remaining_amount: +inv.remainingAmount.toFixed(2),
                matched_transactions: inv.matchedTransactions.map(t => ({
                    transaction_id: t.transaction_id,
                    amount: t.amount,
                    paid_amount: t.paidAmount,
                    date: t.date,
                    narration: t.narration,
                    confidence: +t.confidence.toFixed(3),
                })),
                candidate_transactions: inv.candidateTransactions.slice(0, 3).map(c => ({
                    transaction_id: c.transaction_id,
                    amount: c.amount,
                    date: c.date,
                    narration: c.narration,
                    confidence: +c.confidence.toFixed(3),
                    match_type: c.matchType,
                    note: c.note,
                })),
                notes: inv.notes,
            };

            results.push(result);
            summary[inv.status] = (summary[inv.status] || 0) + 1;
        }

        return {
            results: results.sort((a, b) => a.invoice_id.localeCompare(b.invoice_id)),
            summary,
            noise_transactions_filtered: noiseTxns.length,
        };
    }
}
