import * as fs from 'fs';
import * as path from 'path';
import { RiskModel, InvoiceHistory } from './risk_model';

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
// Main
// ============================================================
function main() {
    const dataset = process.argv[2] || 'tuning';
    const dataDir = path.join(__dirname, '..', 'data', dataset);
    const outputDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  DAY 4 — LATE-PAYMENT RISK MODEL`);
    console.log(`  Dataset: "${dataset}"`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // 1. Load Data
    const invoices = parseCsv<any>(path.join(dataDir, 'invoices.csv'));
    const groundTruth = parseCsv<any>(path.join(dataDir, 'ground_truth.csv'));
    const bankStatement = parseCsv<any>(path.join(dataDir, 'bank_statement.csv'));
    const trueProfiles = parseCsv<any>(path.join(dataDir, 'client_risk_profiles.csv'));

    console.log(`Loaded ${invoices.length} invoices for ${trueProfiles.length} clients.\n`);

    // Map transaction dates
    const txnDates = new Map<string, string>();
    for (const txn of bankStatement) {
        txnDates.set(txn.transaction_id, txn.date);
    }

    // Build historical ledger
    const history: InvoiceHistory[] = [];
    for (const inv of invoices) {
        // Find ground truth entry for this invoice
        const gt = groundTruth.find(g => g.invoice_id === inv.invoice_id);
        
        let payment_date: string | null = null;
        let paid_amount = 0;

        if (gt && gt.match_type !== 'unpaid' && gt.transaction_id) {
            payment_date = txnDates.get(gt.transaction_id) || null;
            paid_amount = parseFloat(gt.paid_amount) || 0;
        }

        history.push({
            invoice_id: inv.invoice_id,
            client_name: inv.client_name,
            amount: parseFloat(inv.amount),
            issue_date: inv.issue_date,
            due_date: inv.due_date,
            payment_date,
            paid_amount
        });
    }

    // Define "Current Date" as the maximum transaction date + 1 day
    let maxDate = new Date('2025-01-01');
    for (const txn of bankStatement) {
        const d = new Date(txn.date);
        if (d > maxDate) maxDate = d;
    }
    maxDate.setDate(maxDate.getDate() + 1);
    const currentDateStr = maxDate.toISOString().split('T')[0];

    // 2. Run Risk Model
    const model = new RiskModel();
    const profiles = model.evaluateClients(history, currentDateStr);

    // 3. Evaluate against Ground Truth
    let correctCount = 0;
    
    console.log('── RISK EVALUATION RESULTS ──');
    for (const profile of profiles) {
        const trueProfile = trueProfiles.find(p => p.client_name === profile.client_name);
        const trueRisk = trueProfile ? trueProfile.true_risk.toLowerCase() : 'unknown';
        const predRisk = profile.riskTier.toLowerCase();
        
        const isCorrect = trueRisk === predRisk;
        if (isCorrect) correctCount++;

        const icon = isCorrect ? '✅' : '❌';
        console.log(`  ${icon} ${profile.client_name.padEnd(25)} | Pred: ${profile.riskTier.padEnd(7)} | True: ${trueRisk.toUpperCase().padEnd(7)}`);
        
        if (!isCorrect) {
            console.log(`      > Model saw: Avg ${profile.avgDaysLate} days late, Max ${profile.maxDaysLate} days, ${profile.lateFrequency}% late freq.`);
            console.log(`      > True prof: Avg ${trueProfile.avg_delay_days} days late, Std ${trueProfile.delay_std_days}`);
        }
    }

    const accuracy = (correctCount / profiles.length) * 100;
    console.log(`\n── METRICS ──`);
    console.log(`  Accuracy: ${accuracy.toFixed(1)}% (${correctCount}/${profiles.length} clients correctly classified)`);

    // 4. Save Outputs
    let outputCsv = 'client_name,risk_tier,avg_days_late,max_days_late,late_frequency_pct,consistency_days,avg_invoice_size,total_invoices,contributing_factors\n';
    for (const p of profiles) {
        outputCsv += `"${p.client_name}",${p.riskTier},${p.avgDaysLate},${p.maxDaysLate},${p.lateFrequency},${p.consistency},${p.avgInvoiceSize},${p.totalInvoices},"${p.contributingFactors.join('; ')}"\n`;
    }
    
    const outputPath = path.join(outputDir, `client_risk_scores_${dataset}.csv`);
    fs.writeFileSync(outputPath, outputCsv);
    console.log(`\n📄 Saved risk scores to: ${outputPath}`);
}

main();
