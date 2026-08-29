/**
 * Day 3 — Validate, Tune & Generate Exception List
 * 
 * This script:
 *   1. Runs the reconciliation engine on tuning data
 *   2. Evaluates against ground truth
 *   3. Generates a formal metrics report (CSV)
 *   4. Generates the EXCEPTION LIST — low-confidence cases with closest
 *      candidate transactions formatted for one-click human confirm/reject
 *   5. Logs everything to output/
 * 
 * Usage: npx tsx src/validate_and_tune.ts [tuning|test]
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReconciliationEngine, InvoiceRecord, TransactionRecord } from './reconciliation_engine';

// ============================================================
// CSV Parser
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
        rows.push(row);
    }
    return rows;
}

// ============================================================
// Evaluation
// ============================================================
interface GroundTruth {
    invoice_id: string;
    transaction_id: string;
    match_type: string;
    paid_amount: string;
    notes: string;
}

function evaluate(results: any[], groundTruth: GroundTruth[]) {
    const gtMap = new Map<string, GroundTruth[]>();
    groundTruth.forEach(gt => {
        if (!gtMap.has(gt.invoice_id)) gtMap.set(gt.invoice_id, []);
        gtMap.get(gt.invoice_id)!.push(gt);
    });

    let truePositives = 0, falsePositives = 0, trueNegatives = 0, falseNegatives = 0;
    let correctPartials = 0, correctCombined = 0;
    let lowConfCorrectInCandidates = 0;
    const errors: any[] = [];

    for (const result of results) {
        const gtEntries = gtMap.get(result.invoice_id) || [];
        const gtEntry = gtEntries[0];
        if (!gtEntry) continue;

        const gtTxnId = gtEntry.transaction_id || '';
        const gtMatchType = gtEntry.match_type;
        const isGtPaid = gtMatchType !== 'unpaid' && gtTxnId !== '';

        if (result.status === 'matched' || result.status === 'partial') {
            const matchedTxnId = result.matched_transactions[0]?.transaction_id || '';
            if (isGtPaid) {
                if (matchedTxnId === gtTxnId) {
                    truePositives++;
                    if (gtMatchType === 'partial') correctPartials++;
                    if (gtMatchType === 'combined') correctCombined++;
                } else {
                    falsePositives++;
                    errors.push({
                        invoice_id: result.invoice_id, type: 'wrong_transaction',
                        detail: `Matched to ${matchedTxnId} but ground truth is ${gtTxnId}`,
                        severity: 'HIGH',
                    });
                }
            } else {
                falsePositives++;
                errors.push({
                    invoice_id: result.invoice_id, type: 'false_match',
                    detail: `Engine marked paid (${matchedTxnId}) but invoice is genuinely unpaid`,
                    severity: 'CRITICAL',
                });
            }
        } else if (result.status === 'low_confidence') {
            if (isGtPaid) {
                const correctInCandidates = result.candidate_transactions.some(
                    (c: any) => c.transaction_id === gtTxnId
                );
                if (correctInCandidates) lowConfCorrectInCandidates++;
                falseNegatives++;
                errors.push({
                    invoice_id: result.invoice_id, type: 'missed_match',
                    detail: `Should match ${gtTxnId} (${gtMatchType}). Correct in candidates: ${correctInCandidates}`,
                    severity: 'LOW',
                });
            } else {
                trueNegatives++;
            }
        } else if (result.status === 'unmatched') {
            if (isGtPaid) {
                falseNegatives++;
                errors.push({
                    invoice_id: result.invoice_id, type: 'missed_completely',
                    detail: `Should match ${gtTxnId} (${gtMatchType}) but no candidates found`,
                    severity: 'MEDIUM',
                });
            } else {
                trueNegatives++;
            }
        }
    }

    const uniquePaidInvoices = new Set(
        groundTruth.filter(gt => gt.match_type !== 'unpaid' && gt.transaction_id).map(gt => gt.invoice_id)
    ).size;

    const autoMatchRate = uniquePaidInvoices > 0 ? truePositives / uniquePaidInvoices : 0;
    const falseMatchRate = (truePositives + falsePositives) > 0
        ? falsePositives / (truePositives + falsePositives) : 0;

    return {
        metrics: {
            auto_match_rate: +(autoMatchRate * 100).toFixed(1),
            false_match_rate: +(falseMatchRate * 100).toFixed(1),
            precision: +((truePositives / Math.max(1, truePositives + falsePositives)) * 100).toFixed(1),
            recall: +(autoMatchRate * 100).toFixed(1),
            true_positives: truePositives,
            false_positives: falsePositives,
            true_negatives: trueNegatives,
            false_negatives: falseNegatives,
            correct_partials: correctPartials,
            correct_combined: correctCombined,
            low_conf_correct_in_candidates: lowConfCorrectInCandidates,
            total_paid_in_gt: uniquePaidInvoices,
            total_unpaid_in_gt: groundTruth.filter(gt => gt.match_type === 'unpaid').length,
        },
        errors: errors.sort((a, b) => {
            const sev: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
            return (sev[a.severity] ?? 4) - (sev[b.severity] ?? 4);
        }),
    };
}

// ============================================================
// Exception List Generator
// ============================================================
function generateExceptionList(results: any[]): string {
    const exceptions = results.filter(r =>
        r.status === 'low_confidence' || r.status === 'unmatched'
    );

    if (exceptions.length === 0) return 'No exceptions — all invoices matched or confirmed unpaid.\n';

    let output = '';
    output += 'invoice_id,client_name,invoice_amount,status,best_candidate_txn,candidate_amount,candidate_date,candidate_narration,confidence,match_type,action_needed,reason\n';

    for (const exc of exceptions) {
        const candidate = exc.candidate_transactions[0]; // best candidate

        if (candidate) {
            output += [
                exc.invoice_id,
                `"${exc.client_name}"`,
                exc.invoice_amount,
                exc.status,
                candidate.transaction_id,
                candidate.amount,
                candidate.date,
                `"${candidate.narration}"`,
                candidate.confidence,
                candidate.match_type,
                'CONFIRM_OR_REJECT',
                `"${candidate.note}"`,
            ].join(',') + '\n';
        } else {
            output += [
                exc.invoice_id,
                `"${exc.client_name}"`,
                exc.invoice_amount,
                exc.status,
                '',
                '',
                '',
                '',
                0,
                '',
                'MANUAL_SEARCH',
                '"No candidate transaction found — requires manual investigation"',
            ].join(',') + '\n';
        }
    }

    return output;
}

// ============================================================
// Metrics Report Generator (CSV)
// ============================================================
function generateMetricsReport(metrics: any, dataset: string): string {
    const timestamp = new Date().toISOString();
    let report = '';
    report += 'metric,value,dataset,timestamp\n';

    for (const [key, value] of Object.entries(metrics)) {
        report += `${key},${value},${dataset},${timestamp}\n`;
    }

    return report;
}

// ============================================================
// Match Details Report (for every invoice)
// ============================================================
function generateMatchDetails(results: any[]): string {
    let output = 'invoice_id,client_name,invoice_amount,status,confidence,match_type,paid_amount,remaining_amount,matched_txn_id,matched_txn_amount,matched_txn_narration,num_candidates\n';

    for (const r of results) {
        const mt = r.matched_transactions[0];
        output += [
            r.invoice_id,
            `"${r.client_name}"`,
            r.invoice_amount,
            r.status,
            r.confidence,
            r.match_type || '',
            r.paid_amount,
            r.remaining_amount,
            mt?.transaction_id || '',
            mt?.amount || '',
            mt ? `"${mt.narration}"` : '',
            r.candidate_transactions.length,
        ].join(',') + '\n';
    }

    return output;
}

// ============================================================
// Main
// ============================================================
function main() {
    const dataset = process.argv[2] || 'tuning';
    const dataDir = path.join(__dirname, '..', 'data', dataset);
    const outputDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  DAY 3 — VALIDATE + TUNE + EXCEPTION LIST`);
    console.log(`  Dataset: "${dataset}"`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Load data
    const invoices = parseCsv<InvoiceRecord>(path.join(dataDir, 'invoices.csv'));
    const transactions = parseCsv<TransactionRecord>(path.join(dataDir, 'bank_statement.csv'));
    const groundTruth = parseCsv<GroundTruth>(path.join(dataDir, 'ground_truth.csv'));

    console.log(`Loaded: ${invoices.length} invoices, ${transactions.length} transactions\n`);

    // Run engine
    const engine = new ReconciliationEngine();
    const { results, summary, noise_transactions_filtered } = engine.reconcile(invoices, transactions);

    // Evaluate
    const { metrics, errors } = evaluate(results, groundTruth);

    // ── Print Summary ──
    console.log('── RECONCILIATION SUMMARY ──');
    console.log(`  Matched (auto-confirmed):  ${summary.matched || 0}`);
    console.log(`  Partial (partially paid):  ${summary.partial || 0}`);
    console.log(`  Low-confidence (review):   ${summary.low_confidence || 0}`);
    console.log(`  Unmatched (still open):    ${summary.unmatched || 0}`);
    console.log(`  Noise txns filtered out:   ${noise_transactions_filtered}`);

    console.log('\n── EVALUATION METRICS ──');
    console.log(`  Auto-match rate:              ${metrics.auto_match_rate}%`);
    console.log(`  False-match rate:             ${metrics.false_match_rate}%`);
    console.log(`  Precision:                    ${metrics.precision}%`);
    console.log(`  Recall:                       ${metrics.recall}%`);
    console.log(`  True positives:               ${metrics.true_positives}`);
    console.log(`  False positives:              ${metrics.false_positives}`);
    console.log(`  Low-conf w/ correct candidate:${metrics.low_conf_correct_in_candidates}`);
    console.log(`  Correct partials:             ${metrics.correct_partials}`);
    console.log(`  Correct combined:             ${metrics.correct_combined}`);

    if (errors.length > 0) {
        console.log(`\n── ERRORS (${errors.length}) ──`);
        errors.forEach(err => {
            const icon = err.severity === 'CRITICAL' ? '🔴' :
                         err.severity === 'HIGH' ? '🟠' :
                         err.severity === 'MEDIUM' ? '🟡' : '🔵';
            console.log(`  ${icon} [${err.severity}] ${err.invoice_id}: ${err.detail}`);
        });
    }

    // ── Save Outputs ──

    // 1. Full reconciliation results (JSON)
    const fullResultsPath = path.join(outputDir, `reconciliation_${dataset}.json`);
    fs.writeFileSync(fullResultsPath, JSON.stringify({ results, summary, metrics, errors }, null, 2));
    console.log(`\n📄 Full results:     ${fullResultsPath}`);

    // 2. Metrics report (CSV — append-friendly for tracking across iterations)
    const metricsPath = path.join(outputDir, `metrics_${dataset}.csv`);
    const metricsContent = generateMetricsReport(metrics, dataset);
    fs.writeFileSync(metricsPath, metricsContent);
    console.log(`📊 Metrics report:   ${metricsPath}`);

    // 3. Exception list (CSV — the one-click review queue)
    const exceptionPath = path.join(outputDir, `exception_list_${dataset}.csv`);
    const exceptionContent = generateExceptionList(results);
    fs.writeFileSync(exceptionPath, exceptionContent);
    const exceptionCount = results.filter(r => r.status === 'low_confidence' || r.status === 'unmatched').length;
    console.log(`⚠️  Exception list:   ${exceptionPath} (${exceptionCount} items for review)`);

    // 4. Match details per invoice (CSV)
    const detailsPath = path.join(outputDir, `match_details_${dataset}.csv`);
    const detailsContent = generateMatchDetails(results);
    fs.writeFileSync(detailsPath, detailsContent);
    console.log(`📋 Match details:    ${detailsPath}`);

    console.log('\n✅ Day 3 validation complete.');
}

main();
