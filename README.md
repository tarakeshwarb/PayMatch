# PayMatch

An automated pipeline that reconciles bank statements against invoice registers, builds risk profiles for clients, and orchestrates an escalating chaser email queue based on those risk profiles.

## Architecture

The system operates as a 5-stage pipeline:

1. **Reconciliation Engine** (Pass 1-5 fuzzy matching, TDS detection)
   - *Inputs:* `invoices.csv`, `bank_statement.csv`
   - *Outputs:* Reconciled matched, partials, and low-confidence exceptions
2. **Risk Model**
   - *Inputs:* Reconciled payment history
   - *Outputs:* Risk tier per client based on days late
3. **Priority Engine**
   - *Inputs:* Risk tiers, outstanding balances
   - *Outputs:* Priority queue sorted by Expected Amount at Risk (EAR)
4. **Chaser Engine**
   - *Inputs:* Priority queue
   - *Outputs:* Escalating follow-up emails with dynamic timelines
5. **Dashboard**
   - *Inputs:* All outputs
   - *Outputs:* Interactive Web UI for human review

> **Note:** You can view the interactive node-based architecture diagram directly in the Dashboard by clicking the "Architecture" tab.

## Setup & Running Locally

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Generate synthetic data:**
   ```bash
   npm run generate
   ```

3. **Run the full pipeline:**
   ```bash
   npm run pipeline
   ```
   *(Alternatively, run individual steps: `npm run recon`, `npm run risk`, `npm run priority`, `npm run chaser`)*

4. **Start the Dashboard:**
   ```bash
   npm run dashboard
   ```
   Then open `http://localhost:3000` in your browser to view the interactive dashboard, review exceptions, and see the architecture diagram.

## Evaluation

To evaluate the pipeline against held-out ground truth data (from the `test` dataset):
```bash
npx tsx src/run_reconciliation.ts test
npx tsx src/run_risk_model.ts test
npx tsx src/analyze_day7.ts
```
Detailed metrics are saved in `output/day7_evaluation_report.md`.
