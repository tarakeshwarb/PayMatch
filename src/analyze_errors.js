/**
 * Day 3 — Deep analysis of remaining errors
 * Examines which combined payments are being missed and why
 */

const fs = require('fs');
const path = require('path');

function parseCsv(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const lines = content.split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = [];
        let current = '', inQ = false;
        for (const c of lines[i]) {
            if (c === '"') inQ = !inQ;
            else if (c === ',' && !inQ) { values.push(current.trim()); current = ''; }
            else current += c;
        }
        values.push(current.trim());
        const row = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
        rows.push(row);
    }
    return rows;
}

const data = JSON.parse(fs.readFileSync('./output/reconciliation_tuning.json', 'utf-8'));
const gt = parseCsv('./data/tuning/ground_truth.csv');
const bank = parseCsv('./data/tuning/bank_statement.csv');
const invoices = parseCsv('./data/tuning/invoices.csv');

console.log('═══════════════════════════════════════════════════════════');
console.log('  DAY 3 — DEEP ERROR ANALYSIS');
console.log('═══════════════════════════════════════════════════════════\n');

// Analyze MEDIUM errors (completely unmatched combined payments)
const mediums = data.errors.filter(e => e.severity === 'MEDIUM');
console.log(`=== UNMATCHED COMBINED PAYMENTS (${mediums.length} invoices) ===\n`);

const seenTxns = new Set();
mediums.forEach(err => {
    const gtEntry = gt.find(g => g.invoice_id === err.invoice_id);
    if (!gtEntry || seenTxns.has(gtEntry.transaction_id)) return;
    seenTxns.add(gtEntry.transaction_id);

    const txn = bank.find(b => b.transaction_id === gtEntry.transaction_id);
    const invResult = data.results.find(r => r.invoice_id === err.invoice_id);

    // Find all invoices in this combined payment
    const combinedInvs = gt.filter(g => g.transaction_id === gtEntry.transaction_id);
    const totalAmount = combinedInvs.reduce((s, g) => s + parseFloat(g.paid_amount), 0);

    console.log(`Transaction: ${txn.transaction_id} | ₹${txn.amount} | "${txn.narration}"`);
    console.log(`  Covers ${combinedInvs.length} invoices (total ₹${totalAmount}):`);
    combinedInvs.forEach(g => {
        const inv = invoices.find(i => i.invoice_id === g.invoice_id);
        const result = data.results.find(r => r.invoice_id === g.invoice_id);
        console.log(`    ${g.invoice_id} | ${inv.client_name} | ₹${inv.amount} | status: ${result?.status}`);
    });
    console.log(`  Cross-client? ${new Set(combinedInvs.map(g => invoices.find(i => i.invoice_id === g.invoice_id)?.client_name)).size > 1 ? 'YES (different clients!)' : 'NO (same client)'}`);
    console.log();
});

// Analyze LOW errors (flagged for review)
const lows = data.errors.filter(e => e.severity === 'LOW');
console.log(`\n=== LOW-CONFIDENCE COMBINED PAYMENTS (${lows.length} invoices) ===\n`);

const seenTxns2 = new Set();
lows.forEach(err => {
    const gtEntry = gt.find(g => g.invoice_id === err.invoice_id);
    if (!gtEntry || seenTxns2.has(gtEntry.transaction_id)) return;
    seenTxns2.add(gtEntry.transaction_id);

    const txn = bank.find(b => b.transaction_id === gtEntry.transaction_id);
    const combinedInvs = gt.filter(g => g.transaction_id === gtEntry.transaction_id);

    console.log(`Transaction: ${txn.transaction_id} | ₹${txn.amount} | "${txn.narration}"`);
    console.log(`  Covers ${combinedInvs.length} invoices:`);
    combinedInvs.forEach(g => {
        const inv = invoices.find(i => i.invoice_id === g.invoice_id);
        const result = data.results.find(r => r.invoice_id === g.invoice_id);
        const hasCandidates = result?.candidate_transactions?.length > 0;
        console.log(`    ${g.invoice_id} | ${inv.client_name} | ₹${inv.amount} | status: ${result?.status} | has_candidates: ${hasCandidates}`);
        if (result?.candidate_transactions?.length > 0) {
            result.candidate_transactions.slice(0, 2).forEach(c => {
                const isCorrect = c.transaction_id === gtEntry.transaction_id ? '✅ CORRECT' : '❌ wrong';
                console.log(`      candidate: ${c.transaction_id} | ₹${c.amount} | conf=${c.confidence} | ${isCorrect}`);
            });
        }
    });
    const clients = new Set(combinedInvs.map(g => invoices.find(i => i.invoice_id === g.invoice_id)?.client_name));
    console.log(`  Cross-client? ${clients.size > 1 ? 'YES — ' + [...clients].join(', ') : 'NO (same client)'}`);
    console.log();
});

// Summary statistics
console.log('\n=== PATTERN SUMMARY ===');
const allErrors = [...mediums, ...lows];
const allGtEntries = allErrors.map(e => gt.find(g => g.invoice_id === e.invoice_id)).filter(Boolean);
const crossClientTxns = new Set();
const sameClientTxns = new Set();

allGtEntries.forEach(entry => {
    const combinedInvs = gt.filter(g => g.transaction_id === entry.transaction_id);
    const clients = new Set(combinedInvs.map(g => invoices.find(i => i.invoice_id === g.invoice_id)?.client_name));
    if (clients.size > 1) crossClientTxns.add(entry.transaction_id);
    else sameClientTxns.add(entry.transaction_id);
});

console.log(`  Same-client combined payments missed: ${sameClientTxns.size} transactions`);
console.log(`  Cross-client combined payments missed: ${crossClientTxns.size} transactions`);
console.log(`  (Cross-client means the data generator paired invoices from different clients into one bank transaction)`);
