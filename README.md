# Agent Buildability Audit

An evidence-first Product Ops case study for the Composio AI Product Ops Intern take-home. It audits 100 apps across 10 categories and separates four decisions that are easy to conflate:

- Can a useful agent toolkit be built technically?
- Can a customer authorize their own account?
- Can a platform distribute the integration to many customers?
- Does an official MCP operate on product data, or mainly expose documentation?

The frozen research snapshot is `2026-08-28.final.v2`. The presentation is generated from that snapshot; it does not research, reclassify, or mutate it.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm test
npm run build:presentation
npm run dev
```

Open `http://localhost:3000`. The production check is:

```bash
npm run build
npm start
```

`npm run build:presentation` verifies the frozen lock and artifact hashes, recomputes presentation metrics, checks them against the frozen metrics/analysis, and writes:

- `data/presentation.json` — compact app records, claims, evidence links, metrics, and integrity hashes for the page.
- `data/final/presentation_metrics.json` — calculation definitions and derived presentation metrics.

No research network call or credential is needed to build the case study.

## Architecture

The research pipeline is staged and resumable:

```text
manifest → identity resolution → first-party evidence → claims
        → deterministic validation → adversarial verification
        → human holdout → frozen dataset → presentation data
```

Each final claim keeps field-level evidence, source type, retrieval method, timestamp, and confidence. HTTP retrieval is attempted first; local Playwright is used only for justified browser fallbacks. Composio coverage is recorded as a separate catalog observation and is never treated as vendor MCP ownership.

The case study adds two read-only proof routes:

- `GET /api/integrity` checks the frozen dataset ID, count, uniqueness, required fields, and SHA-256 hash.
- `POST /api/replay` replays deterministic identity, evidence, classification, MCP/Composio, validation, human-review, and freeze checks for one app.

## Frozen data

The authoritative snapshot lives in `data/final/`:

- `apps.json` — 100 canonical app records with claims and provenance.
- `evidence_ledger.json` — retrieval and source ledger.
- `metrics.json` and `analysis.json` — deterministic research outputs.
- `holdout_metrics.json` and `human_adjudication.json` — the approved 30-app review record.
- `DATASET_LOCK.json` — frozen status, schema version, app count, cost, and artifact hashes.

## Verification and accuracy

The final story distinguishes verifier process signals from human-reviewed results. The reported `93.6%` is resolved-field accuracy on the preregistered 30-app human-reviewed holdout, not an accuracy estimate for all 100 apps. Exact agreement, automation abstention, human-unresolved fields, verifier source-disjoint rate, and schema-repair acceptance are shown with their denominators.

Run the complete local suite with `npm test`. It covers schema and enum contracts, evidence and identity rules, access separation, MCP ownership/type/stage, Composio matching, frozen hashes, presentation metrics, read-only replay routes, and secret non-persistence.

## Deployment

The app is a standard Next.js project and can be deployed with an authorized Vercel account:

```bash
npx vercel deploy --yes --name composio-integration-audit
```

Live case study: https://composio-integration-audit.vercel.app

Source: https://github.com/Suraj-H675/composio-integration-audit

The preview serves the generated compact presentation payload and frozen lock so the deployed bundle stays small; the local build path still verifies the complete frozen artifacts before generating that payload.
