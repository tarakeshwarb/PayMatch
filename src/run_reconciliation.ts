/**
 * Run Reconciliation Engine on tuning data and evaluate against ground truth.
 * 
 * Usage: npx ts-node src/run_reconciliation.ts [tuning|test]
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReconciliationEngine, InvoiceRecord, TransactionRecord } from './reconciliation_engine';

// ============================================================
// Types
// ============================================================

interface GroundTruth {
    invoice_id: string;
    transaction_id: string;
    match_type: string;
    paid_amount: string | number;
    notes: string;
}

interface ErrorCase {
    invoice_id: string;
    type: string;
    detail: string;
    severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
}

// ============================================================
// CSV Parser (handles quoted fields)
// ============================================================
function parseCsv<T>(filePath: string): T[] {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const lines = content.split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const rows: T[] = [];

    for (let i = 1; i < lines.length; i++) {
        const values: string[] = [];
        let current = '';
        let inQuotes = false;
        for (const char of lines[i]) {
            if (char === '"') { inQuotes = !inQuotes; }
            else if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
            else { current += char; }
        }
        values.push(current.trim());

        const row: any = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
        rows.push(row as T);
    }
    return rows;
}

// ============================================================
// Evaluation: compare engine output to ground truth
// ============================================================
function evaluate(results: any[], groundTruth: GroundTruth[]) {
    // Build ground truth lookup: invoice_id → { transaction_id, match_type }
    const gtMap = new Map<string, GroundTruth[]>();
    groundTruth.forEach(gt => {
        if (!gtMap.has(gt.invoice_id)) {
            gtMap.set(gt.invoice_id, []);
        }
        gtMap.get(gt.invoice_id)!.push(gt);
    });

    let truePositives = 0;     // correctly matched
    let falsePositives = 0;    // wrongly matched (WORST case)
    let trueNegatives = 0;     // correctly left unmatched/low-confidence
    let falseNegatives = 0;    // missed a match (invoice should be paid but isn't)
    let correctPartials = 0;
    let correctCombined = 0;
    let correctTds = 0;

    const errors: ErrorCase[] = []; // detailed error cases

    for (const result of results) {
        const gtEntries = gtMap.get(result.invoice_id) || [];
        const gtEntry = gtEntries[0]; // primary ground truth

        if (!gtEntry) {
            errors.push({
                invoice_id: result.invoice_id,
                type: 'no_ground_truth',
                detail: 'Invoice not found in ground truth',
            });
            continue;
        }

        const gtTxnId = gtEntry.transaction_id || '';
        const gtMatchType = gtEntry.match_type;
        const isGtPaid = gtMatchType !== 'unpaid' && gtTxnId !== '';

        if (result.status === 'matched' || result.status === 'partial') {
            // Engine says this invoice is paid
            const matchedTxnId = result.matched_transactions[0]?.transaction_id || '';

            if (isGtPaid) {
                // Ground truth says it IS paid
                if (matchedTxnId === gtTxnId) {
                    truePositives++;
                    if (gtMatchType === 'partial') correctPartials++;
                    if (gtMatchType === 'combined') correctCombined++;
                    if (gtMatchType === 'tds') correctTds++;
                } else {
                    // Matched, but to the WRONG transaction
                    falsePositives++;
                    errors.push({
                        invoice_id: result.invoice_id,
                        type: 'wrong_transaction',
                        detail: `Matched to ${matchedTxnId} but ground truth is ${gtTxnId}`,
                        severity: 'HIGH',
                    });
                }
            } else {
                // Ground truth says UNPAID but engine marked as paid → FALSE POSITIVE
                falsePositives++;
                errors.push({
                    invoice_id: result.invoice_id,
                    type: 'false_match',
                    detail: `Engine marked paid (${matchedTxnId}) but invoice is genuinely unpaid`,
                    severity: 'CRITICAL',
                });
            }
        }
        else if (result.status === 'low_confidence') {
            // Engine says "not sure, flag for review"
            if (isGtPaid) {
                // Missed a match, but at least didn't wrongly match
                // Check if the correct transaction is in candidates
                const correctInCandidates = result.candidate_transactions.some(
                    (c: any) => c.transaction_id === gtTxnId
                );
                falseNegatives++;
                if (correctInCandidates) {
                    // The correct answer IS in the candidates — human can find it
                    // This is acceptable behavior
                }
                errors.push({
                    invoice_id: result.invoice_id,
                    type: 'missed_match',
                    detail: `Should match ${gtTxnId} (${gtMatchType}) but flagged for review. Correct in candidates: ${correctInCandidates}`,
                    severity: 'LOW',
                });
            } else {
                // Unpaid and correctly flagged for review (not auto-matched)
                trueNegatives++;
            }
        }
        else if (result.status === 'unmatched') {
            if (isGtPaid) {
                falseNegatives++;
                errors.push({
                    invoice_id: result.invoice_id,
                    type: 'missed_completely',
                    detail: `Should match ${gtTxnId} (${gtMatchType}) but no candidates found`,
                    severity: 'MEDIUM',
                });
            } else {
                trueNegatives++;
            }
        }
    }

    // Calculate metrics
    const totalPaid = groundTruth.filter(gt => gt.match_type !== 'unpaid' && gt.transaction_id).length;
    // Deduplicate combined payments (same txn_id appears for multiple invoices)
    const uniquePaidInvoices = new Set(
        groundTruth.filter(gt => gt.match_type !== 'unpaid' && gt.transaction_id).map(gt => gt.invoice_id)
    ).size;
    const totalUnpaid = groundTruth.filter(gt => gt.match_type === 'unpaid').length;

    const autoMatchRate = uniquePaidInvoices > 0 ? truePositives / uniquePaidInvoices : 0;
    const falseMatchRate = (truePositives + falsePositives) > 0
        ? falsePositives / (truePositives + falsePositives) : 0;
    const precision = (truePositives + falsePositives) > 0
        ? truePositives / (truePositives + falsePositives) : 0;
    const recall = uniquePaidInvoices > 0
        ? truePositives / uniquePaidInvoices : 0;

    return {
        metrics: {
            auto_match_rate: +(autoMatchRate * 100).toFixed(1),
            false_match_rate: +(falseMatchRate * 100).toFixed(1),
            precision: +(precision * 100).toFixed(1),
            recall: +(recall * 100).toFixed(1),
            true_positives: truePositives,
            false_positives: falsePositives,
            true_negatives: trueNegatives,
            false_negatives: falseNegatives,
            correct_partials: correctPartials,
            correct_combined: correctCombined,
            correct_tds: correctTds,
            total_paid_in_gt: uniquePaidInvoices,
            total_unpaid_in_gt: totalUnpaid,
        },
        errors: errors.sort((a, b) => {
            const sev: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
            return (sev[a.severity || 'LOW'] ?? 4) - (sev[b.severity || 'LOW'] ?? 4);
        }),
    };
}

// ============================================================
// Main
// ============================================================
function main() {
    const dataset = process.argv[2] || 'tuning';
    const dataDir = path.join(__dirname, '..', 'data', dataset);

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  RECONCILIATION ENGINE — Running on "${dataset}" dataset`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Load data
    const invoices = parseCsv<InvoiceRecord>(path.join(dataDir, 'invoices.csv'));
    const transactions = parseCsv<TransactionRecord>(path.join(dataDir, 'bank_statement.csv'));
    const groundTruth = parseCsv<GroundTruth>(path.join(dataDir, 'ground_truth.csv'));

    console.log(`Loaded: ${invoices.length} invoices, ${transactions.length} transactions\n`);

    // Run engine
    const engine = new ReconciliationEngine();
    const { results, summary, noise_transactions_filtered } = engine.reconcile(invoices, transactions);

    // Print summary
    console.log('── RECONCILIATION SUMMARY ──');
    console.log(`  Matched (auto-confirmed):  ${summary.matched || 0}`);
    console.log(`  Partial (partially paid):  ${summary.partial || 0}`);
    console.log(`  Low-confidence (review):   ${summary.low_confidence || 0}`);
    console.log(`  Unmatched (still open):    ${summary.unmatched || 0}`);
    console.log(`  Noise txns filtered out:   ${noise_transactions_filtered}`);

    // Evaluate against ground truth
    const { metrics, errors } = evaluate(results, groundTruth);

    console.log('\n── EVALUATION METRICS ──');
    console.log(`  Auto-match rate:    ${metrics.auto_match_rate}% (${metrics.true_positives}/${metrics.total_paid_in_gt} paid invoices correctly matched)`);
    console.log(`  False-match rate:   ${metrics.false_match_rate}% (${metrics.false_positives} wrong matches out of ${metrics.true_positives + metrics.false_positives} total matches)`);
    console.log(`  Precision:          ${metrics.precision}%`);
    console.log(`  Recall:             ${metrics.recall}%`);
    console.log(`  Missed (review):    ${metrics.false_negatives} invoices need human review`);
    console.log(`  Correct partials:   ${metrics.correct_partials}`);
    console.log(`  Correct combined:   ${metrics.correct_combined}`);
    console.log(`  Correct TDS:        ${metrics.correct_tds}`);

    if (errors.length > 0) {
        console.log(`\n── ERRORS & EDGE CASES (${errors.length}) ──`);
        errors.forEach((err) => {
            const icon = err.severity === 'CRITICAL' ? '🔴' :
                         err.severity === 'HIGH' ? '🟠' :
                         err.severity === 'MEDIUM' ? '🟡' : '🔵';
            console.log(`  ${icon} [${err.severity || 'INFO'}] ${err.invoice_id}: ${err.detail}`);
        });
    }

    // Print some example matches for inspection
    console.log('\n── SAMPLE MATCHES (first 10) ──');
    results.slice(0, 10).forEach(r => {
        const txnInfo = r.matched_transactions[0]
            ? `→ ${r.matched_transactions[0].transaction_id} (₹${r.matched_transactions[0].amount})`
            : r.candidate_transactions[0]
                ? `? ${r.candidate_transactions[0].transaction_id} (₹${r.candidate_transactions[0].amount}, conf=${r.candidate_transactions[0].confidence})`
                : '→ (none)';
        const status = r.status === 'matched' ? '✅' :
                       r.status === 'partial' ? '🔶' :
                       r.status === 'low_confidence' ? '⚠️' : '❌';
        console.log(`  ${status} ${r.invoice_id} | ${r.client_name} | ₹${r.invoice_amount} | ${r.status} (${r.confidence}) ${txnInfo}`);
    });

    // Save full results to JSON
    const outputDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `reconciliation_${dataset}.json`);
    fs.writeFileSync(outputPath, JSON.stringify({ results, summary, metrics, errors }, null, 2));
    console.log(`\n✅ Full results saved to: ${outputPath}`);
}

main();
