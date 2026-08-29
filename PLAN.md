# Build plan

Status: final v2 research dataset frozen after human adjudication and cache-only consistency validation; the final case-study presentation has not started

- [x] Define the assignment schema, enums, evidence requirements, and preregistered accuracy method.
- [x] Implement cached, resumable first-party evidence collection and bounded discovery.
- [x] Separate credential access, sandbox access, production access, technical buildability, commercial friction, setup friction, and MCP ownership/stage.
- [x] Add assignment-hint identity resolution with candidate evidence and conflict escalation.
- [x] Add current read-only Composio catalog coverage with exact/alias/ambiguous matching.
- [x] Add deterministic validation and Composio contradiction warnings.
- [x] Add an optional local Playwright browser fallback for targeted incomplete or blocked pages.
- [x] Add source-disjoint falsification checks and independence metrics.
- [x] Run the corrected 10-app calibration without paid provider integrations.
- [x] Generate the unreviewed eight-app human review packet.
- [x] Human-adjudicate the packet and record field-level ground truth/corrections.
- [x] Lock the rubric and source rules from human review.
- [x] Run the full 100-app research after explicit authorization.
- [x] Apply the authorized v2 schema repair discovered by holdout review.
- [x] Migrate all 100 apps cache-first and regenerate deterministic metrics, analysis, corrections, and the same holdout packet.
- [x] Preserve the pre-human holdout, record final adjudication, run the two authorized cache-only consistency sweeps, and freeze/hash the final dataset.
- [x] Generate the final case-study UI from the frozen dataset after explicit authorization.

## Current gate

The frozen snapshot produces exactly 100 app records at `data/final/apps.json`, with the preserved field-level evidence ledger, deterministic validation, verifier challenges, current Composio catalog provenance, deterministic metrics/analysis, and the same 30-app holdout after human adjudication. The immutable proposal is at `data/final_review/holdout_pre_human.json`; the approved adjudication is at `data/final_review/human_adjudication.json`; the dataset lock is at `data/final/DATASET_LOCK.json`.

The current policy requires source-disjoint verification for at least 70% of challenges for which an alternate first-party source is available. The run reports both that conditional rate and the overall rate because single-source claims cannot honestly be made disjoint.

## Presentation gate

The case study is implemented as a single responsive Next.js page generated from `data/presentation.json`. The presentation build verifies the frozen research hashes and recomputes every displayed headline metric. Local UI QA, production build QA, and the Vercel deployment checks are complete below.

- [x] Reconcile presentation metrics against the frozen snapshot.
- [x] Build the responsive answer-first case study and explorer.
- [x] Add read-only replay and integrity proof routes.
- [x] Run production build and desktop/mobile interaction QA.
- [x] Create a Vercel deployment and confirm it reached READY.

## Runtime stages

1. Load the canonical manifest and rubric.
2. Check cache before fetching a configured URL.
3. Retrieve HTTP evidence and use targeted browser fallback only when justified.
4. Resolve identity against the assignment hint/context before classifying app-specific API/access fields.
5. Produce one auditable claim per requested field.
6. Validate enums, evidence completeness, domains, access separation, MCP ownership/stage, identity conflicts, and buildability consistency.
7. Check current Composio toolkit coverage as a separate provenance-bearing observation.
8. Ask an independent verifier to search for supporting or contradictory first-party evidence, preferring a disjoint source.
9. Preserve disagreements and escalation decisions without automatic claim overwrites.
10. Write deterministic metrics and the human review packet.
