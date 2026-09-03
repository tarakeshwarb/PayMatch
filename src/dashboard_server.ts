/**
 * Day 6 — Dashboard Server
 *
 * Express backend that:
 *  - Serves the dashboard HTML
 *  - Serves pre-computed output files as JSON (demo mode)
 *  - Accepts CSV uploads and re-runs the full pipeline
 *  - Handles confirm/reject for low-confidence matches
 *  - Handles promise-to-pay saves
 *  - Handles mark-as-sent for chaser messages
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const app = express();
const PORT = 3000;
const BASE_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const DATA_DIR = path.join(BASE_DIR, 'data', 'tuning');
const PROMISES_PATH = path.join(BASE_DIR, 'data', 'promises.json');
const HISTORY_PATH = path.join(BASE_DIR, 'data', 'match_history.json');
const SENT_PATH = path.join(OUTPUT_DIR, 'sent_log.json');

app.use(cors());
app.use(express.json());

// Serve dashboard HTML
app.get('/', (_req, res) => {
    res.sendFile(path.join(BASE_DIR, 'dashboard.html'));
});

// ─────────────────────────────────────────────────────────────
// GET /api/results — returns all pipeline outputs in one shot
// ─────────────────────────────────────────────────────────────
app.get('/api/results', (_req, res) => {
    try {
        const dataset = 'tuning';

        const reconPath = path.join(OUTPUT_DIR, `reconciliation_${dataset}.json`);
        const priorityPath = path.join(OUTPUT_DIR, `client_priority_queue_${dataset}.json`);
        const chaserPath = path.join(OUTPUT_DIR, `chaser_queue_${dataset}.json`);
        const riskScoresPath = path.join(OUTPUT_DIR, `client_risk_scores_${dataset}.csv`);

        const recon = fs.existsSync(reconPath)
            ? JSON.parse(fs.readFileSync(reconPath, 'utf-8'))
            : null;

        const priority = fs.existsSync(priorityPath)
            ? JSON.parse(fs.readFileSync(priorityPath, 'utf-8').replace(/^\uFEFF/, ''))
            : null;

        const chaserRaw = fs.existsSync(chaserPath)
            ? JSON.parse(fs.readFileSync(chaserPath, 'utf-8'))
            : [];

        const sentLog: Record<string, boolean> = fs.existsSync(SENT_PATH)
            ? JSON.parse(fs.readFileSync(SENT_PATH, 'utf-8'))
            : {};

        // Mark sent invoices in the chaser queue
        const chaser = chaserRaw.map((c: any) => ({
            ...c,
            sent: sentLog[c.invoice_id] === true
        }));

        // Parse risk scores CSV into JSON
        const riskScores: any[] = [];
        if (fs.existsSync(riskScoresPath)) {
            const lines = fs.readFileSync(riskScoresPath, 'utf-8').trim().split('\n');
            const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
            for (let i = 1; i < lines.length; i++) {
                const values: string[] = [];
                let cur = '', inQ = false;
                for (const ch of lines[i]) {
                    if (ch === '"') { inQ = !inQ; }
                    else if (ch === ',' && !inQ) { values.push(cur.trim()); cur = ''; }
                    else { cur += ch; }
                }
                values.push(cur.trim());
                const row: any = {};
                headers.forEach((h, idx) => { row[h] = values[idx]?.replace(/"/g, '') || ''; });
                riskScores.push(row);
            }
        }

        // Compute summary metrics
        const summary = computeSummary(recon, priority, chaser);

        let history: any[] = [];
        if (fs.existsSync(HISTORY_PATH)) {
            history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
        }

        res.json({ recon, priority, chaser, riskScores, summary, history });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/run — upload CSVs and re-run full pipeline
// ─────────────────────────────────────────────────────────────
const upload = multer({ dest: path.join(OUTPUT_DIR, 'uploads') });

app.post('/api/run', upload.fields([
    { name: 'invoices', maxCount: 1 },
    { name: 'bank_statement', maxCount: 1 }
]), (req, res) => {
    try {
        const files = req.files as Record<string, Express.Multer.File[]>;
        if (!files?.invoices || !files?.bank_statement) {
            return res.status(400).json({ error: 'Both invoices.csv and bank_statement.csv are required' });
        }

        // Move uploaded files into tuning dataset
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.copyFileSync(files.invoices[0].path, path.join(DATA_DIR, 'invoices.csv'));
        fs.copyFileSync(files.bank_statement[0].path, path.join(DATA_DIR, 'bank_statement.csv'));

        // Clean up temp files
        fs.unlinkSync(files.invoices[0].path);
        fs.unlinkSync(files.bank_statement[0].path);

        // Run pipeline in sequence
        const tsxPath = path.join(BASE_DIR, 'node_modules', '.bin', 'tsx');
        const steps = [
            `"${tsxPath}" src/run_reconciliation.ts tuning`,
            `"${tsxPath}" src/run_risk_model.ts tuning`,
            `"${tsxPath}" src/risk_priority_engine.ts tuning`,
            `"${tsxPath}" src/chaser_engine.ts tuning`
        ];

        const logs: string[] = [];
        for (const step of steps) {
            try {
                const out = execSync(step, { cwd: BASE_DIR, encoding: 'utf-8', timeout: 60000 });
                logs.push(out);
            } catch (e: any) {
                logs.push(`ERROR: ${e.message}`);
            }
        }

        // Pipeline complete. Compute new summary for history.
        const dataset = 'tuning';
        const reconNew = fs.existsSync(path.join(OUTPUT_DIR, `reconciliation_${dataset}.json`))
            ? JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, `reconciliation_${dataset}.json`), 'utf-8')) : null;
        const priorityNew = fs.existsSync(path.join(OUTPUT_DIR, `client_priority_queue_${dataset}.json`))
            ? JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, `client_priority_queue_${dataset}.json`), 'utf-8').replace(/^\uFEFF/, '')) : null;
        const chaserNewRaw = fs.existsSync(path.join(OUTPUT_DIR, `chaser_queue_${dataset}.json`))
            ? JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, `chaser_queue_${dataset}.json`), 'utf-8')) : [];
            
        const newSummary = computeSummary(reconNew, priorityNew, chaserNewRaw);
        
        let history: any[] = [];
        if (fs.existsSync(HISTORY_PATH)) {
            history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
        }
        
        const runNum = history.length + 1;
        history.push({ run: `Run ${runNum}`, match_rate: parseFloat(newSummary.match_rate_pct) });
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

        return res.json({ success: true, logs });
    } catch (err: any) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/promise — save a promise-to-pay date
// ─────────────────────────────────────────────────────────────
app.post('/api/promise', (req, res) => {
    try {
        const { invoice_id, promise_date } = req.body;
        if (!invoice_id || !promise_date) {
            return res.status(400).json({ error: 'invoice_id and promise_date required' });
        }

        const promises: Record<string, string> = fs.existsSync(PROMISES_PATH)
            ? JSON.parse(fs.readFileSync(PROMISES_PATH, 'utf-8').replace(/^\uFEFF/, ''))
            : {};

        promises[invoice_id] = promise_date;
        fs.writeFileSync(PROMISES_PATH, JSON.stringify(promises, null, 2));

        // Re-run chaser engine to update statuses
        const tsxPath = path.join(BASE_DIR, 'node_modules', '.bin', 'tsx');
        execSync(`"${tsxPath}" src/chaser_engine.ts tuning`, { cwd: BASE_DIR, encoding: 'utf-8' });

        return res.json({ success: true });
    } catch (err: any) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/mark-sent — mark a chaser message as sent
// ─────────────────────────────────────────────────────────────
app.post('/api/mark-sent', (req, res) => {
    try {
        const { invoice_id } = req.body;
        if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

        const log: Record<string, boolean> = fs.existsSync(SENT_PATH)
            ? JSON.parse(fs.readFileSync(SENT_PATH, 'utf-8'))
            : {};

        log[invoice_id] = true;
        fs.writeFileSync(SENT_PATH, JSON.stringify(log, null, 2));
        return res.json({ success: true });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// Helper: compute summary metrics
// ─────────────────────────────────────────────────────────────
function computeSummary(recon: any, priority: any, chaser: any[]) {
    const results = recon?.results ?? [];
    const total = results.length;
    const matched = results.filter((r: any) => r.status === 'matched').length;
    const partial = results.filter((r: any) => r.status === 'partial').length;
    const lowConf = results.filter((r: any) => r.status === 'low_confidence').length;
    const unmatched = results.filter((r: any) => r.status === 'unmatched').length;

    const matchRate = total > 0 ? ((matched + partial) / total * 100).toFixed(1) : '0.0';

    const totalOutstanding = (priority?.queue ?? []).reduce(
        (sum: number, c: any) => sum + (c.current_outstanding || 0), 0
    );

    const totalAtRisk = (priority?.queue ?? []).reduce(
        (sum: number, c: any) => sum + (c.expected_amount_at_risk || 0), 0
    );

    const brokenPromises = chaser.filter((c: any) => c.broken_promise).length;
    const drafted = chaser.filter((c: any) => c.status === 'DRAFTED' && !c.sent).length;
    const paused = chaser.filter((c: any) => c.status === 'PAUSED').length;

    return {
        total_invoices: total,
        matched,
        partial,
        low_confidence: lowConf,
        unmatched,
        match_rate_pct: matchRate,
        total_outstanding: totalOutstanding,
        total_at_risk: totalAtRisk,
        broken_promises: brokenPromises,
        chaser_drafted: drafted,
        chaser_paused: paused
    };
}

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
