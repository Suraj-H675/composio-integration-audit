import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { computePresentationMetrics, rankedOpportunityBuckets, validatePresentationPayload } from "../src/presentation_logic.mjs";

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));

const [apps, ledger, frozenMetrics, analysis, holdout, verification, lock, payload, presentationMetrics] = await Promise.all([
  readJson("data/final/apps.json"),
  readJson("data/final/evidence_ledger.json"),
  readJson("data/final/metrics.json"),
  readJson("data/final/analysis.json"),
  readJson("data/final/holdout_metrics.json"),
  readJson("data/final/verification.json"),
  readJson("data/final/DATASET_LOCK.json"),
  readJson("data/presentation.json"),
  readJson("data/final/presentation_metrics.json")
]);

const derived = computePresentationMetrics({ apps, ledger, verification, holdout, lock });

test("presentation payload is a 100-app unique table", () => {
  const result = validatePresentationPayload(payload);
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(new Set(payload.apps.map((app) => app.app)).size, 100);
});

test("displayed headline metrics are recomputed from frozen records", () => {
  assert.equal(presentationMetrics.appCount, 100);
  assert.equal(presentationMetrics.headline.technicallyBuildable.numerator, frozenMetrics.technical_buildability_distribution.yes);
  assert.equal(presentationMetrics.headline.openDistribution.numerator, frozenMetrics.distributed_integration_access_distribution.open_self_serve);
  assert.equal(presentationMetrics.mcp.officialCount, 75);
  assert.equal(presentationMetrics.mcp.unknownStageAmongOfficial, 67);
  assert.equal(presentationMetrics.mcp.unknownStageAcrossAllApps, 92);
  assert.equal(presentationMetrics.mcp.unknownStageAmongOfficial + presentationMetrics.mcp.nonOfficialUnknownStage, presentationMetrics.mcp.unknownStageAcrossAllApps);
  assert.equal(presentationMetrics.mcp.nonOfficialUnknownStage, 25);
  assert.equal(presentationMetrics.headline.productActionMcp.numerator, 65);
  assert.equal(presentationMetrics.headline.productActionMcpAbsent.numerator, 24);
  assert.equal(presentationMetrics.headline.composioCoverage.numerator, 55);
  assert.equal(presentationMetrics.holdout.resolved.numerator, holdout.resolved_field_accuracy.numerator);
  assert.equal(presentationMetrics.holdout.resolved.denominator, holdout.resolved_field_accuracy.denominator);
  assert.deepEqual(presentationMetrics.holdout.schemaRepair, {
    repaired: 86,
    accepted: 71,
    stillNeeded: 15,
    acceptedPercent: 82.56,
    denominator: 86
  });
  assert.equal(derived.headline.technicallyBuildable.numerator, presentationMetrics.headline.technicallyBuildable.numerator);
  assert.deepEqual(derived.buildability, presentationMetrics.buildability);
});

test("MCP lifecycle scope is explicit and not serialized as a contradictory headline", () => {
  assert.equal(presentationMetrics.mcp.lifecycleAmongOfficial.unknown, 67);
  assert.equal(presentationMetrics.mcp.lifecycleAcrossAllApps.unknown, 92);
  assert.match(presentationMetrics.mcp.sanityExplanation, /75 apps with confirmed official MCP ownership/);
  assert.match(presentationMetrics.metricSanityCheck.explanation, /67.*75/);
});

test("opportunity rankings use the frozen deterministic ordering", () => {
  const buckets = rankedOpportunityBuckets(apps);
  assert.deepEqual(buckets.engineering_easy_wins.map((item) => item.app), analysis.ranked_opportunity_buckets.engineering_easy_wins.map((item) => item.app));
  assert.deepEqual(buckets.partnership_review_opportunities.map((item) => item.app), analysis.ranked_opportunity_buckets.partnership_review_opportunities.map((item) => item.app));
  assert.deepEqual(buckets.customer_managed_only_opportunities.map((item) => item.app), analysis.ranked_opportunity_buckets.customer_managed_only_opportunities.map((item) => item.app));
});

test("non-unknown load-bearing claims retain evidence links", () => {
  const fields = new Set([
    "technical_buildability",
    "customer_credential_access",
    "distributed_integration_access",
    "public_api_available",
    "vendor_official_mcp",
    "vendor_mcp_type",
    "vendor_mcp_stage",
    "composio_toolkit_exists",
    "main_blocker"
  ]);
  for (const app of apps) {
    for (const claim of app.claims.filter((item) => fields.has(item.field))) {
      const unknown = claim.value === "unknown" || (Array.isArray(claim.value) && claim.value.length === 1 && claim.value[0] === "unknown");
      if (!unknown) assert.ok(claim.evidence?.length > 0, `${app.app}/${claim.field} is displayed without evidence`);
      for (const evidence of claim.evidence ?? []) assert.ok(/^https?:\/\//.test(evidence.final_url || evidence.url), `${app.app}/${claim.field} has an invalid evidence URL`);
    }
  }
});

test("unresolved identities and legacy access fields remain out of final recommendation math", () => {
  const unresolved = payload.apps.filter((app) => app.identity.status === "unresolved").map((app) => app.app).sort();
  assert.deepEqual(unresolved, ["Paygent Connect", "fanbasis"].sort());
  assert.equal(presentationMetrics.unknown.primary.denominator, 100 * 19);
  assert.match(payload.methodology.legacy, /do not drive the final Product Ops recommendations/);
  assert.equal(presentationMetrics.headline.openDistribution.numerator, 27);
});

test("presentation APIs are read-only and generated output contains no secret", async () => {
  const [integritySource, replaySource, payloadText] = await Promise.all([
    readFile(new URL("../app/api/integrity/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/replay/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/presentation.json", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(integritySource, /writeFile|writeFileSync|unlink|rmSync/);
  assert.doesNotMatch(replaySource, /writeFile|writeFileSync|unlink|rmSync/);
  if (process.env.COMPOSIO_API_KEY) assert.doesNotMatch(payloadText, new RegExp(process.env.COMPOSIO_API_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(payloadText, /COMPOSIO_API_KEY/);
});
