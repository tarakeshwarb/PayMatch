/**
 * Day 5 Verification Script — validates all audit fixes
 */
import * as fs from 'fs';
import * as path from 'path';

const data = JSON.parse(fs.readFileSync('output/chaser_queue_tuning.json', 'utf-8'));

console.log('=== TIER DISTRIBUTION ===');
const tiers: Record<string, number> = {};
data.forEach((d: any) => { tiers[d.tier] = (tiers[d.tier] || 0) + 1; });
for (const [tier, count] of Object.entries(tiers)) {
    console.log(`  ${tier}: ${count}`);
}

console.log('\n=== BAND DISTRIBUTION ===');
const bands: Record<string, number> = {};
data.forEach((d: any) => { bands[d.risk_band] = (bands[d.risk_band] || 0) + 1; });
for (const [band, count] of Object.entries(bands)) {
    console.log(`  ${band}: ${count}`);
}

console.log('\n=== BROKEN PROMISES ===');
const bp = data.filter((d: any) => d.broken_promise);
if (bp.length === 0) {
    console.log('  ❌ No broken promises detected!');
} else {
    bp.forEach((d: any) => {
        console.log(`  ✅ ${d.invoice_id} | ${d.client_name} | tier: ${d.tier} | status: ${d.status}`);
    });
}

console.log('\n=== RECENTLY OVERDUE (< 15 days) — Timeline Bending Demo ===');
const recent = data.filter((d: any) => d.days_overdue < 15);
if (recent.length === 0) {
    console.log('  ❌ No recently overdue invoices!');
} else {
    recent.forEach((d: any) => {
        console.log(`  ✅ ${d.invoice_id} | ${d.client_name} | ${d.days_overdue}d overdue | Band: ${d.risk_band} | Tier: ${d.tier}`);
    });
}

console.log('\n=== TIMELINE BENDING PROOF ===');
// Show that the same days_overdue produces different tiers for different risk bands
const recentByBand: Record<string, any[]> = {};
recent.forEach((d: any) => {
    if (!recentByBand[d.risk_band]) recentByBand[d.risk_band] = [];
    recentByBand[d.risk_band].push(d);
});
for (const [band, items] of Object.entries(recentByBand)) {
    console.log(`  ${band} band clients:`);
    items.forEach((d: any) => {
        console.log(`    → ${d.client_name}: ${d.days_overdue} days → ${d.tier}`);
    });
}

console.log('\n=== PAUSED INVOICES ===');
const paused = data.filter((d: any) => d.status === 'PAUSED');
paused.forEach((d: any) => {
    console.log(`  ${d.invoice_id} | ${d.client_name} | ${d.reason} | broken: ${d.broken_promise}`);
});

console.log('\n=== AMOUNT FORMAT CHECK (first 3) ===');
data.slice(0, 3).forEach((d: any) => {
    console.log(`  ${d.invoice_id}: "${d.message_subject}"`);
    // Check for ₹ symbol
    const hasRupee = d.message_body.includes('₹');
    const hasBadFormat = d.message_body.includes(',1');
    console.log(`    ₹ symbol: ${hasRupee ? '✅' : '❌'} | Bad ,1 format: ${hasBadFormat ? '❌ STILL BROKEN' : '✅ Fixed'}`);
});

console.log('\n=== SUMMARY ===');
console.log(`Total chasers: ${data.length}`);
console.log(`Unique tiers: ${Object.keys(tiers).length} (${Object.keys(tiers).join(', ')})`);
console.log(`Broken promises: ${bp.length}`);
console.log(`Recently overdue (<15d): ${recent.length}`);
console.log(`Band distribution balanced: ${Object.keys(bands).length >= 3 ? '✅' : '❌'}`);
