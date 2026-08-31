export interface InvoiceHistory {
    invoice_id: string;
    client_name: string;
    amount: number;
    issue_date: string;
    due_date: string;
    payment_date: string | null; // null if still unpaid
    paid_amount: number;
}

export interface ClientRiskProfile {
    client_name: string;
    avgDaysLate: number;
    maxDaysLate: number;
    lateFrequency: number;
    consistency: number;
    avgInvoiceSize: number;
    totalInvoices: number;
    riskTier: 'Low' | 'Medium' | 'High';
    contributingFactors: string[];
}

export class RiskModel {
    public evaluateClients(history: InvoiceHistory[], currentDateStr: string): ClientRiskProfile[] {
        const currentDate = new Date(currentDateStr);
        const clientGroups = new Map<string, InvoiceHistory[]>();

        for (const inv of history) {
            if (!clientGroups.has(inv.client_name)) {
                clientGroups.set(inv.client_name, []);
            }
            clientGroups.get(inv.client_name)!.push(inv);
        }

        const profiles: ClientRiskProfile[] = [];

        for (const [client_name, invoices] of clientGroups.entries()) {
            profiles.push(this._evaluateClient(client_name, invoices, currentDate));
        }

        return profiles;
    }

    private _evaluateClient(client_name: string, invoices: InvoiceHistory[], currentDate: Date): ClientRiskProfile {
        const delays: number[] = [];
        let maxDaysLate = -Infinity;
        let lateCount = 0;
        let totalAmount = 0;
        let paidCount = 0;

        for (const inv of invoices) {
            totalAmount += inv.amount;
            const dueDate = new Date(inv.due_date);
            
            if (inv.payment_date) {
                const payDate = new Date(inv.payment_date);
                const delayDays = Math.floor((payDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
                delays.push(delayDays);
                paidCount++;
                
                if (delayDays > maxDaysLate) maxDaysLate = delayDays;
                if (delayDays > 0) lateCount++;
            }
        }

        const totalInvoices = invoices.length;
        const lateFrequency = paidCount > 0 ? lateCount / paidCount : 0;
        const avgInvoiceSize = totalInvoices > 0 ? totalAmount / totalInvoices : 0;
        
        let sumDelays = 0;
        for (const d of delays) sumDelays += d;
        const avgDaysLate = paidCount > 0 ? sumDelays / paidCount : 0;
        
        // Robust features: median delay
        let medianDaysLate = 0;
        if (delays.length > 0) {
            const sorted = [...delays].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            medianDaysLate = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        }

        let variance = 0;
        if (paidCount > 1) {
            let sumSq = 0;
            for (const d of delays) {
                sumSq += Math.pow(d - avgDaysLate, 2);
            }
            variance = sumSq / paidCount;
        }
        const consistency = Math.sqrt(variance);

        let riskTier: 'Low' | 'Medium' | 'High' = 'Low';
        const factors: string[] = [];

        if (medianDaysLate >= 14) {
            riskTier = 'High';
            factors.push(`Typical delay is very high (Median ${medianDaysLate} days)`);
            if (maxDaysLate > 45) factors.push(`Extreme max delay (${maxDaysLate} days)`);
        } else if (medianDaysLate >= 4) {
            riskTier = 'Medium';
            factors.push(`Typical delay is notable (Median ${medianDaysLate} days)`);
            if (lateFrequency > 0.5) factors.push(`Often pays late (Freq ${Math.round(lateFrequency * 100)}%)`);
        } else {
            riskTier = 'Low';
            factors.push('Mostly pays on time');
        }

        return {
            client_name,
            avgDaysLate: +medianDaysLate.toFixed(1), // Output median as the "average" for better representation
            maxDaysLate: maxDaysLate === -Infinity ? 0 : maxDaysLate,
            lateFrequency: +(lateFrequency * 100).toFixed(1),
            consistency: +consistency.toFixed(1),
            avgInvoiceSize: Math.round(avgInvoiceSize),
            totalInvoices,
            riskTier,
            contributingFactors: factors
        };
    }
}
