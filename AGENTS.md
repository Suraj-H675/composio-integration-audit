# Project instructions

This repository is an independent submission for the Composio AI Product Ops Intern take-home assignment. The final system researches 100 named apps across 10 categories and produces an auditable case study.

## Research quality

- Every final factual classification must be regenerated from freshly retrieved, current evidence by this pipeline.
- Prefer official vendor developer/API/auth documentation, then official vendor announcements/help/GitHub, then Composio's current official catalog for Composio-specific coverage, and use secondary sources only when primary evidence genuinely does not exist.
- Never guess. Use explicit `unknown`, `unclear`, or `not_found` values and preserve the reason.
- Every load-bearing field needs field-level evidence: URL, source type, retrieval/check timestamp, short supporting statement, and confidence.
- Resolve product and vendor identity before classifying API or authentication. An unresolved identity must lower confidence and may force escalation.
- Distinguish sandbox/test access from production access, and distinguish a free trial from permanently self-serve production credentials.
- Distinguish vendor-official MCP, community MCP, and a Composio toolkit. Track MCP maturity separately from existence.
- Search snippets are discovery aids, not final evidence. A blocked or stale URL must be classified honestly rather than treated as proof of absence.

## Pipeline and data

- Use a normalized claim/evidence model so each field can be audited independently without storing giant page copies.
- Check the local cache and source ledger before fetching again. Make collection resumable, idempotent where practical, and cheap by default.
- Use adaptive verification: straightforward claims receive lightweight official-source checks; identity ambiguity, access-tier uncertainty, stale pages, contradictions, and missing evidence receive deeper research.
- Keep evidence collection, classification, validation, verification, adjudication, analysis, and rendering as separate stages with explicit files between them.
- Use deterministic code for enums, joins, verdict rules, counts, percentages, and displayed statistics. An LLM may extract or challenge claims but must not calculate final statistics.
- Maintain a field-level correction and adjudication log. Record meaningful human decisions and why escalation was necessary.

## Validation and handoff

- Run schema and enum validation before any verifier.
- Check evidence URL liveness, expected-domain alignment, claim-to-evidence support, identity consistency, access-tier logic, MCP ownership, and buildability consistency.
- Measure first-pass versus final results on a documented blind sample. Never manufacture perfect accuracy or hide disagreements.
- Keep the final repository self-contained: runtime commands must work without private local state, credentials, or network services beyond explicitly documented research inputs.
- Keep the implementation small enough to explain in an interview: clear contracts, reproducible commands, useful logs, and honest limitations.
- The full 100-app research run is authorized and complete for this project. Do not build the polished case-study frontend until that phase is explicitly authorized; paid provider integrations remain out of scope.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
