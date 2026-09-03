/**
 * Day 7 Enhanced Analysis
 * 
 * 1. Match rate broken down by match type
 * 2. Rupee-weighted match rate
 * 3. TDS pass contribution quantified
 * 4. TST-0592 false match root cause
 */

import * as fs from 'fs';
import * as path from 'path';

const testResults = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'output', 'reconciliation_test.json'), 'utf-8')
);
const groundTruth = parseCsv(path.join(__dirname, '..', 'data', 'test', 'ground_truth.csv'));
const invoices = parseCsv(path.join(__dirname, '..', 'data', 'test', 'invoices.csv'));
const bankStmt = parseCsv(path.join(__dirname, '..', 'data', 'test', 'bank_statement.csv'));

function parseCsv(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  const lines = content.split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values: string[] = [];
    let current = '', inQuotes = false;
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

const results: any[] = testResults.results;

// Build GT map
const gtMap = new Map<string, any>();
groundTruth.forEach((gt: any) => { gtMap.set(gt.invoice_id, gt); });

console.log('════════════════════════════════════════════════════════════');
console.log('  DAY 7 ENHANCED ANALYSIS');
console.log('════════════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════
// 1. MATCH RATE BY TYPE
// ═══════════════════════════════════════════
console.log('── 1. MATCH RATE BREAKDOWN BY MATCH TYPE ──\n');

const matchedResults = results.filter(r => r.status === 'matched' || r.status === 'partial');
const typeBreakdown: Record<string, { count: number; correct: number; value: number; correctValue: number }> = {};

matchedResults.forEach(r => {
  const mtype = r.match_type || 'unknown';
  if (!typeBreakdown[mtype]) typeBreakdown[mtype] = { count: 0, correct: 0, value: 0, correctValue: 0 };
  typeBreakdown[mtype].count++;
  typeBreakdown[mtype].value += r.paid_amount || 0;
  
  const gt = gtMap.get(r.invoice_id);
  if (gt && gt.match_type !== 'unpaid' && gt.transaction_id) {
    const matchedTxn = r.matched_transactions[0]?.transaction_id || '';
    if (matchedTxn === gt.transaction_id) {
      typeBreakdown[mtype].correct++;
      typeBreakdown[mtype].correctValue += r.paid_amount || 0;
    }
  }
});

// Also count GT by type for the denominator
const gtByType: Record<string, { count: number; value: number }> = {};
groundTruth.forEach((gt: any) => {
  if (gt.match_type !== 'unpaid' && gt.transaction_id) {
    const mtype = gt.match_type || 'unknown';
    if (!gtByType[mtype]) gtByType[mtype] = { count: 0, value: 0 };
    gtByType[mtype].count++;
    // Find invoice amount
    const inv = results.find((r: any) => r.invoice_id === gt.invoice_id);
    gtByType[mtype].value += inv?.invoice_amount || 0;
  }
});

// Classify matched results by engine pass (using notes + match_type)
const passCounts: Record<string, { count: number; value: number }> = {
  'Pass 1: Invoice ID in narration': { count: 0, value: 0 },
  'Pass 2: Client name + exact amount': { count: 0, value: 0 },
  'Pass 2: TDS-adjusted match': { count: 0, value: 0 },
  'Pass 3: Combined payment': { count: 0, value: 0 },
  'Pass 4: Partial payment': { count: 0, value: 0 },
  'Other': { count: 0, value: 0 },
};

matchedResults.forEach(r => {
  const notes = (r.notes || []).join(' ').toLowerCase();
  const mtype = r.match_type || '';
  const paidAmt = r.paid_amount || 0;

  if (notes.includes('combined payment') || mtype === 'combined') {
    passCounts['Pass 3: Combined payment'].count++;
    passCounts['Pass 3: Combined payment'].value += paidAmt;
  } else if (mtype === 'tds' || notes.includes('tds')) {
    passCounts['Pass 2: TDS-adjusted match'].count++;
    passCounts['Pass 2: TDS-adjusted match'].value += paidAmt;
  } else if (r.status === 'partial' || mtype === 'partial') {
    passCounts['Pass 4: Partial payment'].count++;
    passCounts['Pass 4: Partial payment'].value += paidAmt;
  } else if (notes.includes('invoice id') || notes.includes('reference found')) {
    passCounts['Pass 1: Invoice ID in narration'].count++;
    passCounts['Pass 1: Invoice ID in narration'].value += paidAmt;
  } else {
    passCounts['Pass 2: Client name + exact amount'].count++;
    passCounts['Pass 2: Client name + exact amount'].value += paidAmt;
  }
});

const totalMatched = matchedResults.length;
console.log(`  Total auto-matched: ${totalMatched} invoices\n`);

Object.entries(passCounts).forEach(([pass, data]) => {
  if (data.count === 0) return;
  const pct = ((data.count / totalMatched) * 100).toFixed(1);
  console.log(`  ${pass}: ${data.count} invoices (${pct}%) — ₹${(data.value).toLocaleString('en-IN')}`);
});

console.log(`\n  By ground-truth match type in test set:`);
Object.entries(gtByType).forEach(([type, data]) => {
  console.log(`    ${type}: ${data.count} invoices (₹${data.value.toLocaleString('en-IN')})`);
});

// ═══════════════════════════════════════════
// 2. RUPEE-WEIGHTED MATCH RATE
// ═══════════════════════════════════════════
console.log('\n── 2. RUPEE-WEIGHTED MATCH RATE ──\n');

let totalInvoiceValue = 0;
let matchedValue = 0;
let unmatchedValue = 0;
let reviewValue = 0;
let partialPaidValue = 0;
let partialRemainingValue = 0;

results.forEach((r: any) => {
  totalInvoiceValue += r.invoice_amount;
  if (r.status === 'matched') {
    matchedValue += r.invoice_amount;
  } else if (r.status === 'partial') {
    partialPaidValue += r.paid_amount || 0;
    partialRemainingValue += r.remaining_amount || 0;
    matchedValue += r.paid_amount || 0; // Count the paid portion
  } else if (r.status === 'low_confidence') {
    reviewValue += r.invoice_amount;
  } else if (r.status === 'unmatched') {
    unmatchedValue += r.invoice_amount;
  }
});

const valueMatchRate = ((matchedValue / totalInvoiceValue) * 100).toFixed(1);
const countMatchRate = (((matchedResults.length) / results.length) * 100).toFixed(1);

console.log(`  Total invoice value:     ₹${totalInvoiceValue.toLocaleString('en-IN')}`);
console.log(`  Auto-reconciled value:   ₹${matchedValue.toLocaleString('en-IN')} (${valueMatchRate}%)`);
console.log(`  Flagged for review:      ₹${reviewValue.toLocaleString('en-IN')} (${((reviewValue/totalInvoiceValue)*100).toFixed(1)}%)`);
console.log(`  Unmatched value:         ₹${unmatchedValue.toLocaleString('en-IN')} (${((unmatchedValue/totalInvoiceValue)*100).toFixed(1)}%)`);
console.log(`  Partial remaining:       ₹${partialRemainingValue.toLocaleString('en-IN')}`);
console.log('');
console.log(`  Count-based match rate:  ${countMatchRate}% (${matchedResults.length}/${results.length} invoices)`);
console.log(`  Value-based match rate:  ${valueMatchRate}% (₹${matchedValue.toLocaleString('en-IN')} / ₹${totalInvoiceValue.toLocaleString('en-IN')})`);

// ═══════════════════════════════════════════
// 3. TDS PASS CONTRIBUTION
// ═══════════════════════════════════════════
console.log('\n── 3. TDS PASS CONTRIBUTION ──\n');

const tdsMatches = matchedResults.filter(r => {
  const mtype = r.match_type || '';
  const notes = (r.notes || []).join(' ').toLowerCase();
  return mtype === 'tds' || notes.includes('tds');
});

let tdsRecoveredValue = 0;
const tdsDetails: { id: string; amount: number; paid: number; rate: string; client: string }[] = [];

tdsMatches.forEach(r => {
  const paid = r.paid_amount || 0;
  const invAmt = r.invoice_amount;
  tdsRecoveredValue += paid;
  
  // Determine TDS rate
  const ratio = paid / invAmt;
  let rate = 'unknown';
  if (Math.abs(ratio - 0.99) < 0.01) rate = '1% (194Q)';
  else if (Math.abs(ratio - 0.98) < 0.01) rate = '2% (194C)';
  else if (Math.abs(ratio - 0.95) < 0.01) rate = '5% (194J)';
  else if (Math.abs(ratio - 0.90) < 0.01) rate = '10% (194J)';
  else if (Math.abs(ratio - 0.80) < 0.01) rate = '20% (No-PAN)';

  tdsDetails.push({ id: r.invoice_id, amount: invAmt, paid, rate, client: r.client_name });
});

console.log(`  TDS-adjusted matches:  ${tdsMatches.length} invoices`);
console.log(`  Value recovered:       ₹${tdsRecoveredValue.toLocaleString('en-IN')}`);
console.log(`  Invoice value covered: ₹${tdsMatches.reduce((s, r) => s + r.invoice_amount, 0).toLocaleString('en-IN')}`);
console.log(`  Without TDS pass:      These ${tdsMatches.length} invoices would be flagged as exceptions`);
console.log(`                         (payment ≠ invoice amount, no obvious match)`);
console.log('');
console.log('  Breakdown by TDS rate:');

const rateGroups: Record<string, { count: number; value: number }> = {};
tdsDetails.forEach(d => {
  if (!rateGroups[d.rate]) rateGroups[d.rate] = { count: 0, value: 0 };
  rateGroups[d.rate].count++;
  rateGroups[d.rate].value += d.paid;
});
Object.entries(rateGroups).forEach(([rate, data]) => {
  console.log(`    ${rate}: ${data.count} invoices — ₹${data.value.toLocaleString('en-IN')} recovered`);
});

console.log('\n  Individual TDS matches:');
tdsDetails.forEach(d => {
  console.log(`    ${d.id} | ${d.client} | Invoice ₹${d.amount.toLocaleString('en-IN')} → Paid ₹${d.paid.toLocaleString('en-IN')} (${d.rate})`);
});

// ═══════════════════════════════════════════
// 4. TST-0592 FALSE MATCH ROOT CAUSE
// ═══════════════════════════════════════════
console.log('\n── 4. TST-0592 FALSE MATCH — ROOT CAUSE ANALYSIS ──\n');

const falseMatch = results.find((r: any) => r.invoice_id === 'TST-0592');
const falseGt = gtMap.get('TST-0592');
const matchedTxnId = falseMatch?.matched_transactions?.[0]?.transaction_id;
const matchedTxn = falseMatch?.matched_transactions?.[0];

console.log('  Invoice:');
console.log(`    ID:          ${falseMatch?.invoice_id}`);
console.log(`    Client:      ${falseMatch?.client_name}`);
console.log(`    Amount:      ₹${falseMatch?.invoice_amount?.toLocaleString('en-IN')}`);
console.log(`    Status:      ${falseMatch?.status}`);
console.log(`    Confidence:  ${falseMatch?.confidence}`);
console.log(`    Match type:  ${falseMatch?.match_type}`);
console.log('');
console.log('  Matched transaction:');
console.log(`    TXN ID:      ${matchedTxn?.transaction_id}`);
console.log(`    Amount:      ₹${matchedTxn?.amount?.toLocaleString('en-IN')}`);
console.log(`    Paid amount: ₹${matchedTxn?.paid_amount?.toLocaleString('en-IN')}`);
console.log(`    Date:        ${matchedTxn?.date}`);
console.log(`    Narration:   "${matchedTxn?.narration}"`);
console.log(`    Confidence:  ${matchedTxn?.confidence}`);
console.log('');
console.log('  Ground truth:');
console.log(`    Match type:  ${falseGt?.match_type}`);
console.log(`    True TXN:    ${falseGt?.transaction_id || '(none — unpaid)'}`);
console.log(`    Notes:       ${falseGt?.notes}`);
console.log('');
console.log('  Notes from engine:');
falseMatch?.notes?.forEach((n: string) => console.log(`    - ${n}`));

// Who was TXN the real match for?
const realOwner = groundTruth.find((gt: any) => gt.transaction_id === matchedTxnId && gt.match_type !== 'unpaid');
if (realOwner) {
  console.log('');
  console.log(`  TXN-${matchedTxnId} actually belongs to:`);
  console.log(`    Invoice:     ${realOwner.invoice_id}`);
  console.log(`    Match type:  ${realOwner.match_type}`);
  console.log(`    Notes:       ${realOwner.notes}`);
  
  // Check what happened to the real owner
  const realResult = results.find((r: any) => r.invoice_id === realOwner.invoice_id);
  if (realResult) {
    console.log(`    Engine result for ${realOwner.invoice_id}: status=${realResult.status}, matched to=${realResult.matched_transactions?.[0]?.transaction_id || 'none'}`);
  }
}

// Find the bank statement entry
const bankTxn = bankStmt.find((t: any) => t.transaction_id === matchedTxnId);
if (bankTxn) {
  console.log('');
  console.log('  Raw bank statement entry:');
  console.log(`    TXN ID:      ${bankTxn.transaction_id}`);
  console.log(`    Amount:      ₹${bankTxn.amount}`);
  console.log(`    Narration:   "${bankTxn.narration}"`);
  console.log(`    Date:        ${bankTxn.date}`);
  console.log(`    Type:        ${bankTxn.type}`);
}

// Check if the amounts suggest a specific collision type
console.log('\n  DIAGNOSIS:');
const invAmt = falseMatch?.invoice_amount || 0;
const txnAmt = matchedTxn?.amount || 0;
const ratio = txnAmt / invAmt;
console.log(`    Invoice amount:    ₹${invAmt.toLocaleString('en-IN')}`);
console.log(`    Transaction amount: ₹${txnAmt.toLocaleString('en-IN')}`);
console.log(`    Ratio (txn/inv):    ${ratio.toFixed(4)}`);

if (Math.abs(ratio - 1) < 0.02) {
  console.log('    → COLLISION TYPE: Amount near-exact match (within rounding tolerance)');
} else if ([0.99, 0.98, 0.95, 0.90, 0.80].some(r => Math.abs(ratio - r) < 0.01)) {
  console.log('    → COLLISION TYPE: Looks like a TDS rate match — decoy TDS collision');
} else if (ratio < 1 && ratio > 0.5) {
  console.log('    → COLLISION TYPE: Partial payment range — coincidental amount overlap');
} else {
  console.log('    → COLLISION TYPE: Other — check narration similarity');
}

console.log('\n════════════════════════════════════════════════════════════\n');
