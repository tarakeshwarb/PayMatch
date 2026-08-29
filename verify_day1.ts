/**
 * Day 1 Verification Script
 * Checks every requirement from the build plan is actually met.
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE = path.resolve(__dirname);
let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail: string = '') {
    if (condition) {
        console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

interface CsvData {
    headers: string[];
    rows: Record<string, string>[];
}

function parseCsv(filePath: string): CsvData {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const lines = content.split('\n');
    const headers = lines[0].split(',');
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
        // Simple CSV parse (handles our data which has minimal quoting)
        const values: string[] = [];
        let current = '';
        let inQuotes = false;
        for (const char of lines[i]) {
            if (char === '"') { inQuotes = !inQuotes; }
            else if (char === ',' && !inQuotes) { values.push(current); current = ''; }
            else { current += char; }
        }
        values.push(current);
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => row[h.trim()] = (values[idx] || '').trim());
        rows.push(row);
    }
    return { headers, rows };
}

console.log('═══════════════════════════════════════════════');
console.log('  DAY 1 VERIFICATION — Scope + Data');
console.log('═══════════════════════════════════════════════\n');

// ── 1. Check all files exist ──
console.log('1️⃣  FILE EXISTENCE');
const requiredFiles = [
    'data/generate_synthetic_data.ts', // Updated to .ts since we renamed it
    'data/tuning/invoices.csv',
    'data/tuning/bank_statement.csv',
    'data/tuning/ground_truth.csv',
    'data/tuning/client_risk_profiles.csv',
    'data/test/invoices.csv',
    'data/test/bank_statement.csv',
    'data/test/ground_truth.csv',
    'data/test/client_risk_profiles.csv',
];
requiredFiles.forEach(f => {
    check(f, fs.existsSync(path.join(BASE, f)));
});

// ── 2. Check invoice register schema ──
console.log('\n2️⃣  INVOICE REGISTER SCHEMA');
const tuningInv = parseCsv(path.join(BASE, 'data/tuning/invoices.csv'));
const requiredInvCols = ['invoice_id', 'client_name', 'amount', 'issue_date', 'due_date', 'payment_terms_days'];
requiredInvCols.forEach(col => {
    check(`Column "${col}" exists`, tuningInv.headers.map(h => h.trim()).includes(col));
});
check('100+ invoices in tuning set', tuningInv.rows.length >= 100, `${tuningInv.rows.length} rows`);

// ── 3. Check bank statement schema ──
console.log('\n3️⃣  BANK STATEMENT SCHEMA');
const tuningBank = parseCsv(path.join(BASE, 'data/tuning/bank_statement.csv'));
const requiredBankCols = ['transaction_id', 'date', 'amount', 'narration', 'type'];
requiredBankCols.forEach(col => {
    check(`Column "${col}" exists`, tuningBank.headers.map(h => h.trim()).includes(col));
});

// ── 4. Check realistic mess is injected ──
console.log('\n4️⃣  REALISTIC MESS IN DATA');
const tuningGT = parseCsv(path.join(BASE, 'data/tuning/ground_truth.csv'));
const matchTypes: Record<string, number> = {};
tuningGT.rows.forEach(r => {
    matchTypes[r.match_type] = (matchTypes[r.match_type] || 0) + 1;
});
console.log('   Ground truth match type distribution:');
Object.entries(matchTypes).forEach(([type, count]) => {
    console.log(`     ${type}: ${count}`);
});

check('Has partial payments', (matchTypes['partial'] || 0) > 0, `${matchTypes['partial'] || 0} cases`);
check('Has combined payments (1 txn → 2+ invoices)', (matchTypes['combined'] || 0) > 0, `${matchTypes['combined'] || 0} cases`);
check('Has typos in narration', (matchTypes['typo'] || 0) > 0, `${matchTypes['typo'] || 0} cases`);
check('Has rounding differences', (matchTypes['rounding'] || 0) > 0, `${matchTypes['rounding'] || 0} cases`);
check('Has unpaid invoices (genuinely overdue)', (matchTypes['unpaid'] || 0) > 0, `${matchTypes['unpaid'] || 0} cases`);

// Check noise transactions (bank txns with no matching invoice)
const invoiceIds = new Set(tuningGT.rows.filter(r => r.transaction_id).map(r => r.transaction_id));
const noiseTxns = tuningBank.rows.filter(r => !invoiceIds.has(r.transaction_id));
check('Has noise transactions (no matching invoice)', noiseTxns.length > 0, `${noiseTxns.length} noise txns`);

// Check for typo examples in narrations
const typoNarrations = tuningBank.rows.filter(r =>
    r.narration && (
        r.narration.includes('Enterprizes') ||
        r.narration.includes('Industris') ||
        r.narration.includes('Elctronics') ||
        r.narration.includes('Constructions') ||
        r.narration.includes('Bros') ||
        r.narration.includes('Guptha') ||
        r.narration.includes('Shrma') ||
        r.narration.includes('Kapur') ||
        r.narration.includes('Bhat ')
    )
);
check('Typo examples visible in narrations', typoNarrations.length > 0, `e.g. "${typoNarrations[0]?.narration}"`);

// Check for duplicate-looking amounts (same amount, different transactions)
const amountCounts: Record<string, number> = {};
tuningBank.rows.forEach(r => {
    amountCounts[r.amount] = (amountCounts[r.amount] || 0) + 1;
});
const duplicateAmounts = Object.entries(amountCounts).filter(([_, count]) => count > 1);
check('Has duplicate-looking amounts (same amount, different txns)', duplicateAmounts.length > 0,
    `${duplicateAmounts.length} amounts appear more than once`);

// ── 5. Check train/test split — no overlap ──
console.log('\n5️⃣  TRAIN/TEST SPLIT — NO OVERLAP');
const testInv = parseCsv(path.join(BASE, 'data/test/invoices.csv'));
const testGT = parseCsv(path.join(BASE, 'data/test/ground_truth.csv'));

const tuningInvIds = new Set(tuningInv.rows.map(r => r.invoice_id));
const testInvIds = new Set(testInv.rows.map(r => r.invoice_id));
const overlap = [...tuningInvIds].filter(id => testInvIds.has(id));
check('Zero invoice ID overlap between tuning and test', overlap.length === 0,
    overlap.length > 0 ? `OVERLAP: ${overlap.join(', ')}` : 'tuning=INV-*, test=TST-*');

check('Different ID prefixes', 
    tuningInv.rows[0].invoice_id.startsWith('INV-') && testInv.rows[0].invoice_id.startsWith('TST-'),
    `tuning="${tuningInv.rows[0].invoice_id}", test="${testInv.rows[0].invoice_id}"`);

check('Test set has 50 invoices', testInv.rows.length === 50, `${testInv.rows.length} rows`);

// ── 6. Check client risk profiles ──
console.log('\n6️⃣  CLIENT RISK PROFILES');
const profiles = parseCsv(path.join(BASE, 'data/tuning/client_risk_profiles.csv'));
const riskCounts: Record<string, number> = { low: 0, medium: 0, high: 0 };
profiles.rows.forEach(r => { if (riskCounts[r.true_risk] !== undefined) riskCounts[r.true_risk]++; });

check('Multiple clients defined', profiles.rows.length >= 15, `${profiles.rows.length} clients`);
check('Has Low risk clients', riskCounts.low > 0, `${riskCounts.low} clients`);
check('Has Medium risk clients', riskCounts.medium > 0, `${riskCounts.medium} clients`);
check('Has High risk clients', riskCounts.high > 0, `${riskCounts.high} clients`);

// ── 7. Data sanity checks ──
console.log('\n7️⃣  DATA SANITY CHECKS');
const amounts = tuningInv.rows.map(r => parseFloat(r.amount));
check('All invoice amounts are positive', amounts.every(a => a > 0));
check('Amount range is realistic (₹5K-₹500K)', 
    Math.min(...amounts) >= 5000 && Math.max(...amounts) <= 500000,
    `min=₹${Math.min(...amounts).toLocaleString()}, max=₹${Math.max(...amounts).toLocaleString()}`);

const dates = tuningInv.rows.map(r => new Date(r.due_date));
check('All due dates are valid', dates.every(d => !isNaN(d.getTime())));
check('Due dates are after issue dates', tuningInv.rows.every(r => r.due_date > r.issue_date));

// ── Summary ──
console.log('\n═══════════════════════════════════════════════');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('  🎉 ALL DAY 1 CHECKS PASSED');
} else {
    console.log('  ⚠️  SOME CHECKS FAILED — review above');
}
console.log('═══════════════════════════════════════════════\n');
