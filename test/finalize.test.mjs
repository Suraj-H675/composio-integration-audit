import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { enterpriseAccessEvidence, mcpStageEvidence } from "../src/finalize.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (content, title = "Vendor MCP") => ({
  url: "https://vendor.example/docs",
  final_url: "https://vendor.example/docs",
  source_type: "official_product_docs",
  retrieval_method: "http",
  checked_at: "2026-08-28T00:00:00.000Z",
  http_status: 200,
  status: "live",
  title,
  content_text: content
});

test("MCP lifecycle terms must be tied to the MCP surface", () => {
  assert.ok(mcpStageEvidence("beta", [source("The vendor MCP server is in public beta.")]))
  assert.equal(mcpStageEvidence("beta", [source("The REST API is in beta. The page also links to MCP.")]), null);
  assert.equal(mcpStageEvidence("deprecated", [source("The legacy SSE transport is deprecated for MCP clients.")]), null);
  assert.ok(mcpStageEvidence("deprecated", [source("The vendor MCP server is deprecated.")]))
});

test("enterprise-tier existence is not an enterprise-only integration requirement", () => {
  assert.equal(enterpriseAccessEvidence([source("Pricing includes Free, Pro and Enterprise plans. The REST API is documented here.", "API and pricing")]), null);
  assert.ok(enterpriseAccessEvidence([source("The public API is available for all Enterprise workspaces.", "Public API")]))
});

test("the frozen snapshot has the exact manifest and holdout shape", async () => {
  const apps = JSON.parse(await readFile(path.join(ROOT, "data/final/apps.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(ROOT, "config/assignment_manifest.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(ROOT, "data/final/DATASET_LOCK.json"), "utf8"));
  const adjudication = JSON.parse(await readFile(path.join(ROOT, "data/final/human_adjudication.json"), "utf8"));
  const baseline = JSON.parse(await readFile(path.join(ROOT, "data/final_review/holdout_pre_human.json"), "utf8"));
  const expectedHoldout = ["Grain", "Devin", "BigCommerce", "Squarespace", "Vonage", "Aircall", "Twenty", "Podio", "Gladly", "Gorgias", "Ahrefs", "Bright Data", "Cloudflare", "Neo4j", "Xero", "Binance", "LinkedIn Ads", "Pinterest", "Airtable", "Harvest", "Ramp", "SE Ranking", "Clay", "Reducto", "Supabase", "Pylon", "Datadog", "Attio", "Amazon Selling Partner", "Close"];
  assert.equal(apps.length, 100);
  assert.equal(new Set(apps.map((app) => app.app)).size, 100);
  assert.deepEqual(apps.map((app) => app.app), manifest.apps.map((app) => app.app));
  assert.equal(adjudication.review_status, "approved");
  assert.equal(adjudication.sample_size_apps, 30);
  assert.deepEqual(baseline.apps.map((app) => app.app), expectedHoldout);
  assert.equal(lock.dataset_status, "frozen");
  assert.equal(lock.app_count, 100);
  assert.equal(lock.holdout_size, 30);
});

test("final claims retain every pre-human evidence URL", async () => {
  const before = JSON.parse(await readFile(path.join(ROOT, "data/final_review/apps_pre_human.json"), "utf8"));
  const after = JSON.parse(await readFile(path.join(ROOT, "data/final/apps.json"), "utf8"));
  const afterByApp = new Map(after.map((app) => [app.app, new Map(app.claims.map((claim) => [claim.field, claim]))]));
  for (const app of before) {
    for (const claim of app.claims) {
      const finalClaim = afterByApp.get(app.app).get(claim.field);
      const urls = new Set((finalClaim.evidence ?? []).map((item) => item.url));
      for (const evidence of claim.evidence ?? []) assert.equal(urls.has(evidence.url), true, `${app.app}.${claim.field}`);
    }
  }
});

test("human-approved holdout values remain in the canonical snapshot", async () => {
  const apps = JSON.parse(await readFile(path.join(ROOT, "data/final/apps.json"), "utf8"));
  const byApp = new Map(apps.map((app) => [app.app, new Map(app.claims.map((claim) => [claim.field, claim.value]))]));
  assert.equal(byApp.get("Grain").get("technical_buildability"), "yes");
  assert.equal(byApp.get("Grain").get("customer_credential_access"), "self_serve_paid");
  assert.equal(byApp.get("Twenty").get("vendor_mcp_type"), "product_action");
  assert.equal(byApp.get("Podio").get("distributed_integration_access"), "open_self_serve");
  assert.equal(byApp.get("Paygent Connect").get("technical_buildability"), "unknown");
});

test("final artifact hashes match DATASET_LOCK and no API key is persisted", async () => {
  const lock = JSON.parse(await readFile(path.join(ROOT, "data/final/DATASET_LOCK.json"), "utf8"));
  const secret = process.env.COMPOSIO_API_KEY;
  for (const [name, expected] of Object.entries(lock.artifact_hashes)) {
    const bytes = await readFile(path.join(ROOT, "data/final", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
    if (secret) assert.equal(bytes.includes(Buffer.from(secret)), false, name);
  }
});
