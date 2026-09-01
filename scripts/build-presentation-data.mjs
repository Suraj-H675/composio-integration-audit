import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESENTATION_FIELDS,
  compactApp,
  computePresentationMetrics,
  rankedOpportunityBuckets,
  validatePresentationPayload
} from "../src/presentation_logic.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINAL = path.join(ROOT, "data", "final");
const OUTPUT = path.join(ROOT, "data", "presentation.json");
const METRICS_OUTPUT = path.join(FINAL, "presentation_metrics.json");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => Array.isArray(value)
  ? value.map(normalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
    : value;
const same = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareLockArtifacts(lock, files) {
  for (const [name, expected] of Object.entries(lock.artifact_hashes ?? {})) {
    const actual = sha256(files[name]);
    assert(actual === expected, `Frozen artifact hash mismatch for ${name}.`);
  }
}

function compareFrozenMetrics(derived, frozen) {
  const checks = [
    [derived.appCount, frozen.app_count, "app count"],
    [derived.source.rows, frozen.source_ledger_count, "source ledger count"],
    [derived.source.uniqueUrls, frozen.unique_source_url_count, "unique source URL count"],
    [derived.source.live, frozen.live_source_count, "live source count"],
    [derived.source.retrieval, frozen.retrieval_method_counts, "retrieval counts"],
    [derived.claims.count, frozen.claim_count, "claim count"],
    [derived.identity.distribution, frozen.identity_distribution, "identity distribution"],
    [derived.buildability, frozen.technical_buildability_distribution, "buildability distribution"],
    [derived.distribution.customerCredentialAccess, frozen.customer_credential_access_distribution, "customer access distribution"],
    [derived.distribution.distributedIntegrationAccess, frozen.distributed_integration_access_distribution, "distribution access distribution"],
    [derived.api.public, frozen.public_api_available_distribution, "public API distribution"],
    [derived.api.breadth, frozen.api_breadth_distribution, "API breadth distribution"],
    [derived.mcp.typeAmongOfficial, frozen.vendor_mcp_type_distribution, "MCP type distribution"],
    [derived.mcp.lifecycleAmongOfficial, frozen.mcp_lifecycle_distribution, "official MCP lifecycle distribution"],
    [{
      yes: derived.composio.distribution.yes ?? 0,
      no: derived.composio.distribution.no ?? 0,
      unknown: derived.composio.distribution.unknown ?? 0
    }, {
      yes: frozen.composio_toolkit_coverage?.yes ?? 0,
      no: frozen.composio_toolkit_coverage?.no ?? 0,
      unknown: frozen.composio_toolkit_coverage?.unknown ?? 0
    }, "Composio coverage"],
    [derived.evidenceQuality, frozen.evidence_quality_distribution, "evidence quality distribution"]
  ];
  for (const [actual, expected, label] of checks) assert(same(actual, expected) || (label === "Composio coverage" && same(actual, { ...expected, catalog_snapshot: undefined })), `Presentation metric mismatch: ${label}.`);
  assert(derived.headline.technicallyBuildable.numerator === (frozen.technical_buildability_distribution.yes ?? 0), "Technical buildability headline mismatch.");
  assert(derived.headline.openDistribution.numerator === (frozen.distributed_integration_access_distribution.open_self_serve ?? 0), "Open distribution headline mismatch.");
  assert(derived.headline.productActionMcp.numerator === frozen.product_action_official_mcp_count, "Product-action MCP headline mismatch.");
  assert(derived.headline.productActionMcpAbsent.numerator === frozen.product_action_mcp_without_composio.length, "Product-action gap headline mismatch.");
}

function compactDatasetMetadata(lock, frozenMetrics) {
  return {
    id: lock.dataset_id,
    schemaVersion: lock.schema_version,
    status: lock.dataset_status,
    frozenAt: lock.frozen_at,
    appCount: lock.app_count,
    holdoutSize: lock.holdout_size,
    humanReviewStatus: lock.human_review_status,
    sourceLedgerCount: lock.source_ledger_count,
    sourceAppsSha256: lock.artifact_hashes?.["apps.json"] ?? null,
    sourceLedgerSha256: lock.artifact_hashes?.["evidence_ledger.json"] ?? null,
    paidCostUsd: lock.paid_cost_usd,
    catalogSnapshot: frozenMetrics.composio_toolkit_coverage?.catalog_snapshot ?? null
  };
}

function buildPayload({ lock, metrics, apps, presentationMetrics }) {
  const compactApps = apps.map(compactApp);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    dataset: compactDatasetMetadata(lock, metrics),
    metrics: presentationMetrics,
    apps: compactApps,
    fieldLabels: {
      technicalBuildability: "Technical buildability",
      customerCredentialAccess: "Customer credential access",
      distributedIntegrationAccess: "Distribution access",
      publicApiAvailable: "Public API",
      apiBreadth: "API breadth",
      vendorOfficialMcp: "Official MCP",
      vendorMcpType: "MCP type",
      vendorMcpStage: "MCP stage",
      composioToolkitExists: "Composio toolkit",
      commercialFriction: "Commercial friction",
      setupFriction: "Setup friction",
      mainBlocker: "Main blocker"
    },
    methodology: {
      thesis: "100-app integration audit covering buildability, access, APIs, MCP, and Composio coverage.",
      evidence: "Claims were preserved from the frozen evidence ledger; this presentation layer does not perform research or change classifications.",
      unknowns: "Unknown is retained when frozen evidence does not support a stronger classification.",
      legacy: "Legacy production_access and credential_access remain auditable but do not drive the final Product Ops recommendations."
    }
  };
  const payloadWithoutHash = JSON.stringify(payload);
  payload.integrity = {
    sourceAppsSha256: lock.artifact_hashes?.["apps.json"] ?? null,
    sourceLedgerSha256: lock.artifact_hashes?.["evidence_ledger.json"] ?? null,
    presentationPayloadSha256: sha256(payloadWithoutHash)
  };
  return payload;
}

export async function buildPresentationData() {
  const paths = {
    apps: path.join(FINAL, "apps.json"),
    ledger: path.join(FINAL, "evidence_ledger.json"),
    frozenMetrics: path.join(FINAL, "metrics.json"),
    analysis: path.join(FINAL, "analysis.json"),
    holdout: path.join(FINAL, "holdout_metrics.json"),
    verification: path.join(FINAL, "verification.json"),
    lock: path.join(FINAL, "DATASET_LOCK.json")
  };
  const [apps, ledger, frozenMetrics, analysis, holdout, verification, lock] = await Promise.all(Object.values(paths).map(readJson));
  assert(lock.dataset_status === "frozen", "The research dataset is not frozen.");
  assert(lock.dataset_id === "2026-08-28.final.v2", "Unexpected frozen dataset ID.");
  assert(lock.schema_version === "2026-08-28.full-run.v2", "Unexpected frozen schema version.");
  assert(apps.length === 100 && new Set(apps.map((app) => app.app)).size === 100, "Frozen dataset must contain exactly 100 unique apps.");
  const lockFiles = {};
  for (const name of Object.keys(lock.artifact_hashes ?? {})) lockFiles[name] = await readFile(path.join(FINAL, name));
  compareLockArtifacts(lock, lockFiles);
  const derived = computePresentationMetrics({ apps, ledger, verification, holdout, lock });
  derived.composio.catalogSnapshot = frozenMetrics.composio_toolkit_coverage?.catalog_snapshot ?? null;
  compareFrozenMetrics(derived, frozenMetrics);
  const buckets = rankedOpportunityBuckets(apps);
  assert(same(buckets.engineering_easy_wins.map((item) => item.app), analysis.ranked_opportunity_buckets.engineering_easy_wins.map((item) => item.app)), "Engineering ranking differs from frozen analysis.");
  assert(same(buckets.partnership_review_opportunities.map((item) => item.app), analysis.ranked_opportunity_buckets.partnership_review_opportunities.map((item) => item.app)), "Partnership ranking differs from frozen analysis.");
  assert(same(buckets.customer_managed_only_opportunities.map((item) => item.app), analysis.ranked_opportunity_buckets.customer_managed_only_opportunities.map((item) => item.app)), "Customer-managed ranking differs from frozen analysis.");
  assert(derived.holdout.resolved.numerator === holdout.resolved_field_accuracy.numerator && derived.holdout.resolved.denominator === holdout.resolved_field_accuracy.denominator, "Holdout accuracy mismatch.");
  assert(derived.mcp.unknownStageAmongOfficial + derived.mcp.nonOfficialUnknownStage === derived.mcp.unknownStageAcrossAllApps, "MCP lifecycle scope reconciliation failed.");
  const presentationMetrics = {
    ...derived,
    sourceArtifactHashes: lock.artifact_hashes,
    metricSanityCheck: {
      officialMcpCount: derived.mcp.officialCount,
      lifecycleAmongOfficial: derived.mcp.lifecycleAmongOfficial,
      lifecycleAcrossAllApps: derived.mcp.lifecycleAcrossAllApps,
      explanation: derived.mcp.sanityExplanation,
      calculation: "unknown lifecycle across all apps = unknown lifecycle among official MCP apps + apps without confirmed official MCP ownership"
    },
    displayedNumberPolicy: "Every number shown by the case study is read from this generated object; this file is derived from the frozen artifacts and does not contain research classifications."
  };
  const payload = buildPayload({ lock, metrics: frozenMetrics, apps, presentationMetrics });
  const payloadValidation = validatePresentationPayload(payload);
  assert(payloadValidation.ok, payloadValidation.errors.join("; "));
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(METRICS_OUTPUT, `${JSON.stringify(presentationMetrics, null, 2)}\n`, "utf8");
  return { output: OUTPUT, metricsOutput: METRICS_OUTPUT, appCount: apps.length, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), sourceAppsSha256: lock.artifact_hashes?.["apps.json"] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildPresentationData(), null, 2));
}
