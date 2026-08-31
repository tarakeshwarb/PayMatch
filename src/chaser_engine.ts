import * as fs from 'fs';
import * as path from 'path';

export interface Invoice {
    invoice_id: string;
    client_name: string;
    amount: number;
    issue_date: string;
    due_date: string;
    payment_terms_days: number;
}

export interface ClientPriority {
    client_name: string;
    history_count: number;
    tier: string;
    probability: number;
    current_outstanding: number;
    expected_amount_at_risk: number;
}

export interface ChaserMessage {
    invoice_id: string;
    client_name: string;
    amount: number;
    days_overdue: number;
    expected_risk: number; // Added to surface the risk score
    risk_band: 'Critical' | 'Standard' | 'Low' | 'Insufficient History';
    tier: string;
    status: 'DRAFTED' | 'PAUSED';
    reason?: string;
    broken_promise: boolean;
    message_subject: string;
    message_body: string;
}

export class ChaserEngine {
    private currentDate: Date;
    private riskMap: Map<string, ClientPriority>;
    private top20Threshold: number;
    private bottom20Threshold: number;

    constructor(currentDateStr: string, priorityQueue: ClientPriority[] = []) {
        this.currentDate = new Date(currentDateStr);
        this.riskMap = new Map();
        
        // Populate risk map
        for (const c of priorityQueue) {
            this.riskMap.set(c.client_name, c);
        }

        // Calculate thresholds for 20/60/20 split based on sorted expected_amount_at_risk
        // Only include clients who have history AND actually owe money — clients with
        // zero outstanding shouldn't dilute the band calculation
        const eligibleClients = priorityQueue.filter(
            c => c.tier !== 'Insufficient History' && c.expected_amount_at_risk > 0
        );
        eligibleClients.sort((a, b) => b.expected_amount_at_risk - a.expected_amount_at_risk);
        
        if (eligibleClients.length >= 5) {
            const top20Index = Math.max(0, Math.floor(eligibleClients.length * 0.2) - 1);
            const bottom20Index = Math.min(eligibleClients.length - 1, Math.floor(eligibleClients.length * 0.8));
            
            this.top20Threshold = eligibleClients[top20Index].expected_amount_at_risk;
            this.bottom20Threshold = eligibleClients[bottom20Index].expected_amount_at_risk;
        } else {
            // Not enough clients to meaningfully split, default to Standard for everyone eligible
            this.top20Threshold = Infinity;
            this.bottom20Threshold = -Infinity;
        }
    }

    private getRiskBand(client_name: string): 'Critical' | 'Standard' | 'Low' | 'Insufficient History' {
        const clientRisk = this.riskMap.get(client_name);
        if (!clientRisk || clientRisk.tier === 'Insufficient History') {
            return 'Insufficient History';
        }
        if (clientRisk.expected_amount_at_risk >= this.top20Threshold) return 'Critical';
        if (clientRisk.expected_amount_at_risk <= this.bottom20Threshold) return 'Low';
        return 'Standard';
    }

    public generateQueue(invoices: Invoice[], paidInvoiceIds: Set<string>, promises: Record<string, string>): ChaserMessage[] {
        const queue: ChaserMessage[] = [];

        for (const inv of invoices) {
            if (paidInvoiceIds.has(inv.invoice_id)) continue;

            const dueDate = new Date(inv.due_date);
            const daysOverdue = Math.floor((this.currentDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

            if (daysOverdue <= 0) continue; // Not overdue yet

            const promiseDateStr = promises[inv.invoice_id];
            let isPaused = false;
            let pauseReason = "";
            let isBrokenPromise = false;

            if (promiseDateStr) {
                const promiseDate = new Date(promiseDateStr);
                // We use UTC start of day comparison to avoid time zone issues
                if (promiseDate.getTime() >= this.currentDate.getTime()) {
                    isPaused = true;
                    pauseReason = `Client promised to pay on ${promiseDateStr}`;
                } else {
                    isBrokenPromise = true;
                }
            }

            const riskBand = this.getRiskBand(inv.client_name);
            const clientRisk = this.riskMap.get(inv.client_name);
            const expectedRisk = clientRisk ? clientRisk.expected_amount_at_risk : 0;

            const { tier, subject, body } = this.getTemplate(inv, daysOverdue, riskBand, isBrokenPromise, promiseDateStr);

            queue.push({
                invoice_id: inv.invoice_id,
                client_name: inv.client_name,
                amount: inv.amount,
                days_overdue: daysOverdue,
                expected_risk: expectedRisk,
                risk_band: riskBand,
                tier,
                status: isPaused ? 'PAUSED' : 'DRAFTED',
                reason: isPaused ? pauseReason : undefined,
                broken_promise: isBrokenPromise,
                message_subject: subject,
                message_body: body
            });
        }

        // Sort by expected risk descending, then days overdue
        queue.sort((a, b) => {
            if (b.expected_risk !== a.expected_risk) {
                return b.expected_risk - a.expected_risk;
            }
            return b.days_overdue - a.days_overdue;
        });

        return queue;
    }

    private getTemplate(
        inv: Invoice, 
        daysOverdue: number, 
        riskBand: string, 
        isBrokenPromise: boolean,
        promiseDateStr?: string
    ): { tier: string, subject: string, body: string } {
        const amountStr = `₹${inv.amount.toLocaleString('en-IN')}`;
        
        let timelineIndex = 0; // 0 = Polite, 1 = Firm, 2 = Formal, 3 = Final

        // Dynamic timeline bending
        if (riskBand === 'Critical') {
            if (daysOverdue >= 15) timelineIndex = 3;
            else if (daysOverdue >= 8) timelineIndex = 2;
            else if (daysOverdue >= 3) timelineIndex = 1;
            else timelineIndex = 0;
        } else if (riskBand === 'Low') {
            if (daysOverdue >= 45) timelineIndex = 3;
            else if (daysOverdue >= 31) timelineIndex = 2;
            else if (daysOverdue >= 15) timelineIndex = 1;
            else timelineIndex = 0;
        } else {
            // Standard or Insufficient History
            if (daysOverdue >= 30) timelineIndex = 3;
            else if (daysOverdue >= 16) timelineIndex = 2;
            else if (daysOverdue >= 8) timelineIndex = 1;
            else timelineIndex = 0;
        }

        // Broken Promise Override - Escalate immediately to at least Formal Notice
        if (isBrokenPromise && timelineIndex < 2) {
            timelineIndex = 2; 
        }

        // Generate Text based on final timeline index
        if (timelineIndex === 3) {
            return {
                tier: 'Final Escalation',
                subject: `URGENT: Final Notice for Overdue Invoice ${inv.invoice_id}`,
                body: `Dear ${inv.client_name} Team,\n\nDespite multiple reminders, invoice ${inv.invoice_id} for ${amountStr} remains unpaid and is now ${daysOverdue} days overdue (Due date: ${inv.due_date}).\n\nPlease remit payment immediately. Failure to resolve this balance may result in suspension of services and further escalation.\n\nRegards,\nAccounts Team`
            };
        } else if (timelineIndex === 2) {
            let bodyText = `Dear ${inv.client_name} Team,\n\nThis is a formal reminder that invoice ${inv.invoice_id} for ${amountStr} is now past its due date (${inv.due_date}).\n\n`;
            
            if (isBrokenPromise && promiseDateStr) {
                bodyText += `You previously indicated that this payment would be settled by ${promiseDateStr}, but we have not yet received it. `;
            } else {
                bodyText += `It is now ${daysOverdue} days overdue. `;
            }
            
            bodyText += `Please process this payment immediately or let us know if there is any issue preventing transfer.\n\nRegards,\nAccounts Team`;

            return {
                tier: 'Formal Notice',
                subject: isBrokenPromise 
                    ? `Action Required: Broken Payment Commitment for Invoice ${inv.invoice_id}` 
                    : `Second Reminder: Invoice ${inv.invoice_id} is significantly overdue`,
                body: bodyText
            };
        } else if (timelineIndex === 1) {
            return {
                tier: 'Firm Follow-up',
                subject: `Action Required: Invoice ${inv.invoice_id} is Overdue`,
                body: `Hi ${inv.client_name},\n\nWe are following up on invoice ${inv.invoice_id} for ${amountStr}, which was due on ${inv.due_date}.\n\nPlease arrange for payment at your earliest convenience. If you have already initiated the transfer, please share the reference number.\n\nThanks,\nAccounts Team`
            };
        } else {
            return {
                tier: 'Polite Reminder',
                subject: `Friendly Reminder: Invoice ${inv.invoice_id} is due`,
                body: `Hi ${inv.client_name},\n\nJust a friendly reminder that invoice ${inv.invoice_id} for ${amountStr} was due on ${inv.due_date}.\n\nPlease let us know when we can expect the payment to be processed.\n\nThanks,\nAccounts Team`
            };
        }
    }
}

// ---------------------------------------------------------
// CLI execution
// ---------------------------------------------------------
if (require.main === module) {
    const dataset = process.argv[2] || 'tuning';
    const baseDir = path.resolve(__dirname, '..');
    const fs = require('fs');
    
    const invoicesPath = path.join(baseDir, 'data', dataset, 'invoices.csv');
    const gtPath = path.join(baseDir, 'data', dataset, 'ground_truth.csv');
    const promisesPath = path.join(baseDir, 'data', 'promises.json');
    const priorityQueuePath = path.join(baseDir, 'output', `client_priority_queue_${dataset}.json`);
    const outPath = path.join(baseDir, 'output', `chaser_queue_${dataset}.json`);

    // Load inputs
    const invoicesData = fs.readFileSync(invoicesPath, 'utf-8').trim().split('\n').slice(1);
    const invoices: Invoice[] = invoicesData.map(line => {
        const parts = line.split(',');
        return {
            invoice_id: parts[0],
            client_name: parts[1],
            amount: parseFloat(parts[2]),
            issue_date: parts[3],
            due_date: parts[4],
            payment_terms_days: parseInt(parts[5])
        };
    });

    const gtData = fs.readFileSync(gtPath, 'utf-8').trim().split('\n').slice(1);
    const paidInvoiceIds = new Set<string>();
    for (const line of gtData) {
        const parts = line.split(',');
        const matchType = parts[2];
        if (matchType !== 'unpaid') {
            paidInvoiceIds.add(parts[0]);
        }
    }

    let promises: Record<string, string> = {};
    if (fs.existsSync(promisesPath)) {
        const raw = fs.readFileSync(promisesPath, 'utf-8').replace(/^\uFEFF/, '');
        promises = JSON.parse(raw);
    }

    let priorityQueue: ClientPriority[] = [];
    if (fs.existsSync(priorityQueuePath)) {
        const raw = fs.readFileSync(priorityQueuePath, 'utf-8').replace(/^\uFEFF/, '');
        const pqData = JSON.parse(raw);
        priorityQueue = pqData.queue || [];
    } else {
        console.warn('Warning: Priority Queue output not found. Operating without risk bands.');
    }

    const engine = new ChaserEngine('2025-10-10', priorityQueue);
    const queue = engine.generateQueue(invoices, paidInvoiceIds, promises);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(queue, null, 2));

    console.log(`===========================================================`);
    console.log(`  DAY 5 ?" CHASER ENGINE QUEUE (RISK-DRIVEN)`);
    console.log(`  Dataset: "${dataset}"`);
    console.log(`===========================================================\n`);
    console.log(`Total unpaid invoices: ${queue.length}`);
    
    const paused = queue.filter(q => q.status === 'PAUSED').length;
    const drafted = queue.length - paused;
    const broken = queue.filter(q => q.broken_promise).length;
    
    console.log(`  - Ready to send (DRAFTED): ${drafted}`);
    console.log(`  - Paused (Promises to pay): ${paused}`);
    console.log(`  - BROKEN PROMISES detected: ${broken}\n`);

    console.log(`Top 3 Chasers to Send:`);
    const draftsOnly = queue.filter(q => q.status === 'DRAFTED');
    for (let i = 0; i < Math.min(3, draftsOnly.length); i++) {
        const d = draftsOnly[i];
        console.log(`  ${i+1}. [${d.tier}] ${d.client_name} (Risk Band: ${d.risk_band}, ${d.days_overdue} days late)`);
    }

    console.log(`\nSaved full drafted queue to: ${outPath}`);
}
