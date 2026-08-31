import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Helpers
// ============================================================
function parseCsv<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return [];
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
// Main Execution
// ============================================================
function main() {
    const dataset = process.argv[2] || 'tuning';
    const baseDir = path.resolve(__dirname, '..');
    const dataDir = path.join(baseDir, 'data', dataset);
    const outputDir = path.join(baseDir, 'output');

    console.log(`===========================================================`);
    console.log(`  DAY 4 ?" RISK PRIORITY ENGINE`);
    console.log(`  Dataset: "${dataset}"`);
    console.log(`===========================================================\n`);

    // --- STEP 0: Load everything ---
    const riskScores = parseCsv<any>(path.join(outputDir, `client_risk_scores_${dataset}.csv`));
    let reconData: any = { results: [] };
    try {
        reconData = JSON.parse(fs.readFileSync(path.join(outputDir, `reconciliation_${dataset}.json`), 'utf-8'));
    } catch (e) {
        console.warn('Warning: Could not load reconciliation output, assuming no outstanding balances.');
    }
    const invoices = parseCsv<any>(path.join(dataDir, 'invoices.csv'));
    const groundTruth = parseCsv<any>(path.join(dataDir, 'ground_truth.csv'));
    const bankStatement = parseCsv<any>(path.join(dataDir, 'bank_statement.csv'));

    // Map transaction dates
    const txnDates = new Map<string, string>();
    for (const txn of bankStatement) {
        txnDates.set(txn.transaction_id, txn.date);
    }

    // Map client risk tiers
    const clientTiers = new Map<string, string>();
    const clientHistoryCounts = new Map<string, number>();
    for (const row of riskScores) {
        clientTiers.set(row.client_name, row.risk_tier);
        clientHistoryCounts.set(row.client_name, parseInt(row.total_invoices) || 0);
    }

    // --- STEP 1: Empirical Probability Calibration ---
    const tierStats = {
        'Low': { paid: 0, late: 0 },
        'Medium': { paid: 0, late: 0 },
        'High': { paid: 0, late: 0 }
    };

    for (const inv of invoices) {
        const gt = groundTruth.find((g: any) => g.invoice_id === inv.invoice_id);
        if (gt && gt.match_type !== 'unpaid' && gt.transaction_id) {
            const payDate = txnDates.get(gt.transaction_id);
            if (payDate) {
                const tier = clientTiers.get(inv.client_name) || 'Low';
                if (tierStats[tier as keyof typeof tierStats]) {
                    tierStats[tier as keyof typeof tierStats].paid++;
                    
                    const dDue = new Date(inv.due_date);
                    const dPay = new Date(payDate);
                    // if pay date is strictly greater than due date, it's late
                    if (dPay > dDue) {
                        tierStats[tier as keyof typeof tierStats].late++;
                    }
                }
            }
        }
    }

    const probabilities: Record<string, number> = {};
    console.log(`STEP 1: Empirical Probability Calibration`);
    for (const [tier, stats] of Object.entries(tierStats)) {
        const prob = stats.paid > 0 ? stats.late / stats.paid : 0;
        probabilities[tier] = prob;
        console.log(`  - ${tier.padEnd(6)}: ${stats.late}/${stats.paid} paid late (${(prob*100).toFixed(1)}%)`);
    }
    console.log();

    // --- STEP 3: Current Outstanding from Reconciliation ---
    const outstandingMap = new Map<string, number>();
    for (const res of reconData.results) {
        // Any invoice not "matched" has remaining amount we need to chase
        if (res.status !== 'matched' && res.remaining_amount > 0) {
            const current = outstandingMap.get(res.client_name) || 0;
            outstandingMap.set(res.client_name, current + res.remaining_amount);
        }
    }

    // --- STEP 2 & 4: Calculate expected_amount_at_risk with Minimum History Threshold ---
    const MIN_HISTORY = 3;
    const priorityQueue: any[] = [];

    let skippedCount = 0;
    
    for (const [client_name, tier] of clientTiers.entries()) {
        const historyCount = clientHistoryCounts.get(client_name) || 0;
        const outstanding = outstandingMap.get(client_name) || 0;
        
        let finalTier = tier;
        let expectedRisk = 0;
        let prob = 0;

        if (historyCount < MIN_HISTORY) {
            finalTier = 'Insufficient History';
            skippedCount++;
        } else {
            prob = probabilities[tier] || 0;
            expectedRisk = prob * outstanding;
        }

        priorityQueue.push({
            client_name,
            history_count: historyCount,
            tier: finalTier,
            probability: prob,
            current_outstanding: outstanding,
            expected_amount_at_risk: expectedRisk
        });
    }

    // --- STEP 5: Sort Queue ---
    priorityQueue.sort((a, b) => b.expected_amount_at_risk - a.expected_amount_at_risk);

    const outPath = path.join(outputDir, `client_priority_queue_${dataset}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
        calibration: probabilities,
        queue: priorityQueue
    }, null, 2));

    console.log(`STEP 5: Priority Queue Generated`);
    console.log(`  - Total clients processed: ${priorityQueue.length}`);
    console.log(`  - Clients excluded (Insufficient History < ${MIN_HISTORY}): ${skippedCount}`);
    console.log(`\nTop 5 Priority Clients to Chase:`);
    
    for (let i = 0; i < Math.min(5, priorityQueue.length); i++) {
        const c = priorityQueue[i];
        console.log(`  ${i+1}. ${c.client_name.padEnd(20)} | ₹${c.expected_amount_at_risk.toLocaleString('en-IN', {maximumFractionDigits: 0})} at risk (Owes: ₹${c.current_outstanding.toLocaleString('en-IN')}, Tier: ${c.tier})`);
    }

    console.log(`\nSaved priority queue to: ${outPath}`);
}

main();
