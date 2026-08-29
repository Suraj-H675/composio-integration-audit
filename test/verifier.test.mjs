import test from "node:test";
import assert from "node:assert/strict";
import { verifyClaim } from "../src/verifier.mjs";

const source = (id, text) => ({
  id,
  url: `https://docs.example.com/${id}`,
  source_type: "official_api_docs",
  checked_at: "2026-08-27T00:00:00.000Z",
  http_status: 200,
  status: "live",
  content_text: text
});

test("verifier records contradiction instead of rubber-stamping the claim", () => {
  const result = verifyClaim({
    app: "Example",
    rubric: { field: "production_access" },
    claim: {
      field: "production_access",
      value: "self_serve",
      evidence: [{ url: "https://docs.example.com/access", source_type: "official_api_docs" }]
    },
    sources: [source("pricing", "Production access requires contacting sales for approval.")],
    rule: {
      support_patterns: ["self[- ]serve"],
      contradiction_patterns: ["contact(?:ing)? sales", "approval required"]
    }
  });

  assert.equal(result.status, "disagree");
  assert.equal(result.observed_value, "approval_required");
  assert.equal(result.verifier_value, "approval_required");
  assert.equal(result.researcher_value, "self_serve");
  assert.equal(result.independent_source_found, true);
  assert.ok(result.evidence.length > 0);
});

test("verifier can independently support a claim", () => {
  const result = verifyClaim({
    app: "Example",
    rubric: { field: "public_api_available" },
    claim: { field: "public_api_available", value: "yes", evidence: [] },
    sources: [source("reference", "The REST API reference lists endpoints and authentication.")],
    rule: { support_patterns: ["REST API reference"], contradiction_patterns: ["no public API"] }
  });

  assert.equal(result.status, "agree");
  assert.equal(result.observed_value, "yes");
  assert.equal(result.source_overlap, false);
});
