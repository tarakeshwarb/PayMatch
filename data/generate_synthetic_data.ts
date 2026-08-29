/**
 * Synthetic Data Generator for Invoice Reconciliation
 * 
 * Generates:
 *   - Mock invoice register (invoice ID, client, amount, due date)
 *   - Mock bank statement (date, amount, narration text)
 *   - Ground truth mapping (for validation)
 *   - Client risk profiles (for risk model validation)
 * 
 * Deliberately injects realistic mess:
 *   - Partial payments
 *   - Combined payments (one transaction covering 2+ invoices)
 *   - Typos in narration
 *   - Rounding differences
 *   - Duplicate-looking transactions (same amount, different clients)
 *   - Noise transactions (no matching invoice)
 *   - Genuinely unpaid invoices
 * 
 * Produces TWO separate sets:
 *   - tuning/  (100 invoices) — for Days 2-3 matcher tuning
 *   - test/    (50 invoices)  — held-out for Day 7 final eval, no overlap
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Types
// ============================================================
interface Client {
    name: string;
    risk: string;
    avgDelay: number;
    delayStd: number;
}

interface Invoice {
    invoice_id: string;
    client_name: string;
    amount: number;
    issue_date: string;
    due_date: string;
    payment_terms_days: number;
    _risk: string;
    _avgDelay: number;
    _delayStd: number;
}

interface Transaction {
    transaction_id: string;
    date: string;
    amount: number;
    narration: string;
    type: string;
}

interface GroundTruth {
    invoice_id: string;
    transaction_id: string;
    match_type: string;
    paid_amount: number;
    notes: string;
}

interface ClientProfile {
    client_name: string;
    true_risk: string;
    avg_delay_days: number;
    delay_std_days: number;
}

// ============================================================
// Seeded PRNG (Mulberry32) for reproducibility
// ============================================================
function mulberry32(seed: number) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

let rng: () => number;

function seedRng(seed: number) {
    rng = mulberry32(seed);
}

function random() {
    return rng();
}

function randInt(min: number, max: number) {
    return Math.floor(random() * (max - min + 1)) + min;
}

function randChoice<T>(arr: T[]): T {
    return arr[Math.floor(random() * arr.length)];
}

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Approximate normal distribution (Box-Muller)
function randNormal(mean: number, std: number) {
    const u1 = random();
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
    return mean + std * z;
}

// ============================================================
// Date utilities
// ============================================================
function addDays(date: Date, days: number) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function formatDate(date: Date) {
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ============================================================
// Client definitions with payment behavior profiles
// ============================================================
const CLIENTS: Client[] = [
    { name: "Priya Enterprises",      risk: "low",    avgDelay: 0,  delayStd: 2  },
    { name: "Sharma Trading Co",      risk: "low",    avgDelay: 1,  delayStd: 3  },
    { name: "Mehta Electronics",      risk: "medium", avgDelay: 8,  delayStd: 5  },
    { name: "Gupta & Sons Pvt Ltd",   risk: "high",   avgDelay: 20, delayStd: 10 },
    { name: "Rajesh Textiles",        risk: "low",    avgDelay: -2, delayStd: 3  },
    { name: "Anand Pharma",           risk: "medium", avgDelay: 10, delayStd: 4  },
    { name: "Singh Brothers",         risk: "low",    avgDelay: 0,  delayStd: 1  },
    { name: "Patel Construction",     risk: "high",   avgDelay: 25, delayStd: 15 },
    { name: "Verma Logistics",        risk: "medium", avgDelay: 7,  delayStd: 5  },
    { name: "Kapoor Industries",      risk: "low",    avgDelay: -1, delayStd: 2  },
    { name: "Bhatt & Associates",     risk: "high",   avgDelay: 18, delayStd: 8  },
    { name: "Desai Agro",             risk: "medium", avgDelay: 5,  delayStd: 4  },
    { name: "Iyer Technologies",      risk: "low",    avgDelay: 0,  delayStd: 2  },
    { name: "Nair Exports",           risk: "medium", avgDelay: 12, delayStd: 6  },
    { name: "Joshi Packaging",        risk: "low",    avgDelay: 2,  delayStd: 3  },
    { name: "Chopra Foods",           risk: "high",   avgDelay: 22, delayStd: 12 },
    { name: "Malhotra Auto Parts",    risk: "medium", avgDelay: 6,  delayStd: 4  },
    { name: "Reddy Chemicals",        risk: "low",    avgDelay: -1, delayStd: 2  },
    { name: "Bose Engineering",       risk: "high",   avgDelay: 15, delayStd: 7  },
    { name: "Das Furniture",          risk: "medium", avgDelay: 9,  delayStd: 5  },
];

// Typo variants for fuzzy matching mess
const TYPO_MAP: Record<string, string[]> = {
    "Priya Enterprises":    ["Priya Enterprizes", "Prya Enterprises", "Priya Enterrprises"],
    "Sharma Trading Co":    ["Sharma Trding Co", "Shrma Trading Co", "Sharma Trading"],
    "Gupta & Sons Pvt Ltd": ["Guptha & Sons", "Gupta and Sons Pvt Ltd", "Gupta & Son Pvt"],
    "Mehta Electronics":    ["Mehta Elctronics", "Metha Electronics", "Mehta Electroncs"],
    "Patel Construction":   ["Patel Constructions", "Patl Construction", "Patel Constuction"],
    "Singh Brothers":       ["Singh Bros", "Sing Brothers", "Singh Brothrs"],
    "Bhatt & Associates":   ["Bhatt & Assoc", "Bhat & Associates", "Bhatt and Associates"],
    "Kapoor Industries":    ["Kapur Industries", "Kapoor Industris", "Kapoor Ind"],
    "Nair Exports":         ["Nair Expports", "Niar Exports", "Nair Export"],
    "Chopra Foods":         ["Chopra Fods", "Chpra Foods", "Chopra Food"],
};

// ============================================================
// Invoice generation
// ============================================================
function generateInvoices(numInvoices: number, startId: number, startDate: Date, prefix: string): Invoice[] {
    const invoices: Invoice[] = [];
    const amountRanges = [
        [5000, 15000],
        [15000, 50000],
        [50000, 150000],
        [150000, 500000],
    ];

    for (let i = 0; i < numInvoices; i++) {
        const invoiceId = `${prefix}-${String(startId + i).padStart(4, '0')}`;
        const client = randChoice(CLIENTS);

        // Pick a realistic amount
        const range = randChoice(amountRanges);
        let amount = range[0] + random() * (range[1] - range[0]);
        // Round to nearest 500 or 100 for realism (B2B invoices are usually round)
        if (random() < 0.6) {
            amount = Math.round(amount / 500) * 500;
        } else if (random() < 0.8) {
            amount = Math.round(amount / 100) * 100;
        } else {
            amount = Math.round(amount * 100) / 100;
        }

        // Issue date spread over several months
        const issueDate = addDays(startDate, randInt(0, 180));
        // Payment terms: 15, 30, or 45 days
        const paymentTerms = randChoice([15, 30, 45]);
        const dueDate = addDays(issueDate, paymentTerms);

        invoices.push({
            invoice_id: invoiceId,
            client_name: client.name,
            amount: amount,
            issue_date: formatDate(issueDate),
            due_date: formatDate(dueDate),
            payment_terms_days: paymentTerms,
            // Internal fields (not exported to CSV, used for generation)
            _risk: client.risk,
            _avgDelay: client.avgDelay,
            _delayStd: client.delayStd,
        });
    }

    return invoices;
}

// ============================================================
// Narration generation
// ============================================================
function generateNarration(inv: Invoice, { clean = true, partial = false, forceTypo = false } = {}) {
    let clientName = inv.client_name;

    if (forceTypo && TYPO_MAP[clientName]) {
        clientName = randChoice(TYPO_MAP[clientName]);
    } else if (forceTypo) {
        // Generic typo: swap or drop a character
        const chars = clientName.split('');
        const idx = randInt(1, chars.length - 2);
        if (random() < 0.5 && idx + 1 < chars.length) {
            [chars[idx], chars[idx + 1]] = [chars[idx + 1], chars[idx]];
        } else {
            chars.splice(idx, 1);
        }
        clientName = chars.join('');
    }

    let templates: string[];
    if (clean) {
        templates = [
            `NEFT-${clientName}-${inv.invoice_id}`,
            `UPI/${clientName}/${inv.invoice_id}`,
            `IMPS FROM ${clientName} REF ${inv.invoice_id}`,
            `Payment for ${inv.invoice_id} from ${clientName}`,
            `RTGS-${clientName}-${inv.invoice_id}-PAYMENT`,
        ];
    } else {
        templates = [
            `NEFT FROM ${clientName}`,
            `UPI CREDIT ${clientName}`,
            `IMPS-${clientName}`,
            `Payment from ${clientName}`,
            `RTGS ${clientName}`,
            `CR ${clientName}`,
            `NEFT ${randInt(100000, 999999)} ${clientName}`,
        ];
    }

    if (partial) {
        templates.push(
            `Part payment ${clientName}`,
            `NEFT-${clientName}-PARTIAL-${inv.invoice_id}`,
            `Advance from ${clientName}`,
        );
    }

    return randChoice(templates);
}

// ============================================================
// Bank transaction generation (with realistic mess)
// ============================================================
function generateBankTransactions(invoices: Invoice[]) {
    const transactions: Transaction[] = [];
    const groundTruth: GroundTruth[] = [];
    let txnCounter = 1;

    const shuffled = shuffle(invoices);
    let i = 0;

    while (i < shuffled.length) {
        const inv = shuffled[i];
        const dueDate = new Date(inv.due_date);

        // Determine payment delay from client profile
        let delayDays = Math.round(randNormal(inv._avgDelay, inv._delayStd));
        if (inv._avgDelay >= 0) delayDays = Math.max(0, delayDays);

        const paymentDate = addDays(dueDate, delayDays);
        const scenario = random();

        // ~8% — Invoice has NO payment (genuinely unpaid/overdue)
        if (scenario < 0.08) {
            groundTruth.push({
                invoice_id: inv.invoice_id,
                transaction_id: "",
                match_type: "unpaid",
                paid_amount: 0,
                notes: "No payment received",
            });
            i++;
            continue;
        }

        const messType = random();
        const txnId = `TXN-${String(txnCounter).padStart(5, '0')}`;
        txnCounter++;

        if (messType < 0.45) {
            // ── 45% — Clean exact payment ──
            const narration = generateNarration(inv, { clean: random() < 0.5 });

            transactions.push({
                transaction_id: txnId,
                date: formatDate(paymentDate),
                amount: inv.amount,
                narration: narration,
                type: "CREDIT",
            });
            groundTruth.push({
                invoice_id: inv.invoice_id,
                transaction_id: txnId,
                match_type: "exact",
                paid_amount: inv.amount,
                notes: "Exact amount match",
            });
            i++;
        }
        else if (messType < 0.60) {
            // ── 15% — Partial payment ──
            const partialPct = 0.5 + random() * 0.45; // 50-95%
            let partialAmount = inv.amount * partialPct;
            if (random() < 0.5) {
                partialAmount = Math.round(partialAmount / 100) * 100;
            } else {
                partialAmount = Math.round(partialAmount * 100) / 100;
            }

            const narration = generateNarration(inv, { clean: random() < 0.4, partial: true });

            transactions.push({
                transaction_id: txnId,
                date: formatDate(paymentDate),
                amount: partialAmount,
                narration: narration,
                type: "CREDIT",
            });
            groundTruth.push({
                invoice_id: inv.invoice_id,
                transaction_id: txnId,
                match_type: "partial",
                paid_amount: partialAmount,
                notes: `Partial payment: ${partialAmount} of ${inv.amount}`,
            });
            i++;
        }
        else if (messType < 0.72 && i + 1 < shuffled.length) {
            // ── 12% — Combined payment (one txn covers 2 invoices) ──
            const inv2 = shuffled[i + 1];
            const combinedAmount = +(inv.amount + inv2.amount).toFixed(2);

            let narration;
            if (inv.client_name === inv2.client_name) {
                narration = randChoice([
                    `Payment from ${inv.client_name}`,
                    `NEFT-${inv.client_name}-${inv.invoice_id}/${inv2.invoice_id}`,
                    `Combined payment ${inv.invoice_id} ${inv2.invoice_id}`,
                ]);
            } else {
                narration = randChoice([
                    `Payment ${inv.invoice_id} and ${inv2.invoice_id}`,
                    `Bulk payment`,
                    `NEFT BULK CREDIT`,
                ]);
            }

            transactions.push({
                transaction_id: txnId,
                date: formatDate(paymentDate),
                amount: combinedAmount,
                narration: narration,
                type: "CREDIT",
            });
            groundTruth.push({
                invoice_id: inv.invoice_id,
                transaction_id: txnId,
                match_type: "combined",
                paid_amount: inv.amount,
                notes: `Combined with ${inv2.invoice_id}`,
            });
            groundTruth.push({
                invoice_id: inv2.invoice_id,
                transaction_id: txnId,
                match_type: "combined",
                paid_amount: inv2.amount,
                notes: `Combined with ${inv.invoice_id}`,
            });
            i += 2;
        }
        else if (messType < 0.85) {
            // ── 13% — Rounding difference ──
            const roundingDiff = randChoice([-1, 1, -2, 2, -5, 5, -10, 10, -50, 50, -0.50, 0.50]);
            const roundedAmount = +(inv.amount + roundingDiff).toFixed(2);

            const narration = generateNarration(inv, { clean: random() < 0.5 });

            transactions.push({
                transaction_id: txnId,
                date: formatDate(paymentDate),
                amount: roundedAmount,
                narration: narration,
                type: "CREDIT",
            });
            groundTruth.push({
                invoice_id: inv.invoice_id,
                transaction_id: txnId,
                match_type: "rounding",
                paid_amount: roundedAmount,
                notes: `Rounding diff: ${roundingDiff}`,
            });
            i++;
        }
        else {
            // ── 15% — Typo in narration with exact amount ──
            const narration = generateNarration(inv, { clean: false, forceTypo: true });

            transactions.push({
                transaction_id: txnId,
                date: formatDate(paymentDate),
                amount: inv.amount,
                narration: narration,
                type: "CREDIT",
            });
            groundTruth.push({
                invoice_id: inv.invoice_id,
                transaction_id: txnId,
                match_type: "typo",
                paid_amount: inv.amount,
                notes: "Narration has typo in client name",
            });
            i++;
        }
    }

    // ── Add noise transactions (no matching invoice) ──
    const noiseNarrations = [
        "ATM CASH WITHDRAWAL",
        "SALARY TRANSFER - AUG",
        "NEFT FROM PERSONAL ACCT",
        "GST REFUND",
        "INTEREST CREDIT",
        "UPI-UNKNOWN-MERCHANT",
        "RENT DEPOSIT RETURN",
        "INSURANCE CLAIM SETTLEMENT",
        "VENDOR ADVANCE REFUND",
        "ELECTRICITY BILL REFUND",
        "EMI BOUNCE REVERSAL",
        "LOAN DISBURSEMENT",
        "FD MATURITY CREDIT",
        "DIVIDEND CREDIT",
        "MISC CREDIT",
        "TDS REFUND FY2024-25",
        "SECURITY DEPOSIT RETURN",
    ];

    const numNoise = randInt(10, 18);
    for (let j = 0; j < numNoise; j++) {
        const txnId = `TXN-${String(txnCounter).padStart(5, '0')}`;
        txnCounter++;

        const noiseDate = addDays(new Date('2025-01-01'), randInt(0, 210));
        let noiseAmount = 500 + random() * 200000;
        if (random() < 0.5) noiseAmount = Math.round(noiseAmount / 100) * 100;
        else noiseAmount = Math.round(noiseAmount * 100) / 100;

        transactions.push({
            transaction_id: txnId,
            date: formatDate(noiseDate),
            amount: noiseAmount,
            narration: randChoice(noiseNarrations),
            type: "CREDIT",
        });
    }

    // Sort transactions by date for realism
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    return { transactions, groundTruth };
}

// ============================================================
// CSV writer
// ============================================================
function toCsv(data: any[], columns: string[]) {
    const header = columns.join(',');
    const rows = data.map(row =>
        columns.map(col => {
            const val = row[col] ?? '';
            const str = String(val);
            // Quote if contains comma, newline, or quote
            if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }).join(',')
    );
    return header + '\n' + rows.join('\n') + '\n';
}

// ============================================================
// Main
// ============================================================
function main() {
    const baseDir = path.resolve(__dirname, '..');
    const dataDir = path.join(baseDir, 'data');
    const tuningDir = path.join(dataDir, 'tuning');
    const testDir = path.join(dataDir, 'test');

    fs.mkdirSync(tuningDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    // ── Tuning Set (seed=42, 100 invoices) ──
    console.log('Generating tuning dataset...');
    seedRng(42);

    const tuningInvoices = generateInvoices(100, 1, new Date('2025-01-01'), 'INV');
    const { transactions: tuningTxns, groundTruth: tuningGT } = generateBankTransactions(tuningInvoices);

    const invoiceColumns = ['invoice_id', 'client_name', 'amount', 'issue_date', 'due_date', 'payment_terms_days'];
    const txnColumns = ['transaction_id', 'date', 'amount', 'narration', 'type'];
    const gtColumns = ['invoice_id', 'transaction_id', 'match_type', 'paid_amount', 'notes'];
    const profileColumns = ['client_name', 'true_risk', 'avg_delay_days', 'delay_std_days'];

    fs.writeFileSync(path.join(tuningDir, 'invoices.csv'), toCsv(tuningInvoices, invoiceColumns));
    fs.writeFileSync(path.join(tuningDir, 'bank_statement.csv'), toCsv(tuningTxns, txnColumns));
    fs.writeFileSync(path.join(tuningDir, 'ground_truth.csv'), toCsv(tuningGT, gtColumns));

    // Client risk profiles for risk model validation
    const clientProfilesSeen: Record<string, boolean> = {};
    const tuningProfiles: ClientProfile[] = tuningInvoices
        .filter(inv => {
            if (clientProfilesSeen[inv.client_name]) return false;
            clientProfilesSeen[inv.client_name] = true;
            return true;
        })
        .map(inv => ({
            client_name: inv.client_name,
            true_risk: inv._risk,
            avg_delay_days: inv._avgDelay,
            delay_std_days: inv._delayStd,
        }));
    fs.writeFileSync(path.join(tuningDir, 'client_risk_profiles.csv'), toCsv(tuningProfiles, profileColumns));

    // Count match types
    const tuningMatchCounts: Record<string, number> = {};
    tuningGT.forEach(g => { tuningMatchCounts[g.match_type] = (tuningMatchCounts[g.match_type] || 0) + 1; });

    console.log(`  Invoices: ${tuningInvoices.length}`);
    console.log(`  Bank transactions: ${tuningTxns.length}`);
    console.log(`  Ground truth mappings: ${tuningGT.length}`);
    console.log(`  Match types:`, tuningMatchCounts);

    // ── Test Set (seed=123, 50 invoices, different IDs) ──
    console.log('\nGenerating test dataset...');
    seedRng(123);

    const testInvoices = generateInvoices(50, 501, new Date('2025-04-01'), 'TST');
    const { transactions: testTxns, groundTruth: testGT } = generateBankTransactions(testInvoices);

    fs.writeFileSync(path.join(testDir, 'invoices.csv'), toCsv(testInvoices, invoiceColumns));
    fs.writeFileSync(path.join(testDir, 'bank_statement.csv'), toCsv(testTxns, txnColumns));
    fs.writeFileSync(path.join(testDir, 'ground_truth.csv'), toCsv(testGT, gtColumns));

    const testProfilesSeen: Record<string, boolean> = {};
    const testProfiles: ClientProfile[] = testInvoices
        .filter(inv => {
            if (testProfilesSeen[inv.client_name]) return false;
            testProfilesSeen[inv.client_name] = true;
            return true;
        })
        .map(inv => ({
            client_name: inv.client_name,
            true_risk: inv._risk,
            avg_delay_days: inv._avgDelay,
            delay_std_days: inv._delayStd,
        }));
    fs.writeFileSync(path.join(testDir, 'client_risk_profiles.csv'), toCsv(testProfiles, profileColumns));

    const testMatchCounts: Record<string, number> = {};
    testGT.forEach(g => { testMatchCounts[g.match_type] = (testMatchCounts[g.match_type] || 0) + 1; });

    console.log(`  Invoices: ${testInvoices.length}`);
    console.log(`  Bank transactions: ${testTxns.length}`);
    console.log(`  Ground truth mappings: ${testGT.length}`);
    console.log(`  Match types:`, testMatchCounts);

    console.log('\n✅ Done! Files saved to:');
    console.log(`  ${tuningDir}/`);
    console.log(`  ${testDir}/`);
}

main();
