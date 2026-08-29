import test from "node:test";
import assert from "node:assert/strict";
import { scoreClaim } from "../src/quality.mjs";

const evidence = (overrides = {}) => [{
  url: "https://docs.example.com/api",
  source_type: "official_api_docs",
  checked_at: "2026-08-27T00:00:00.000Z",
  http_status: 200,
  statement: "The official API documentation directly supports the claim.",
  ...overrides
}];

test("quality is high only when direct first-party evidence is fresh and independently corroborated", () => {
  const result = scoreClaim({ field: "public_api_available", value: "yes", status: "supported", evidence: evidence() }, {
    identityStatus: "confirmed",
    verifier: { status: "agree", independent_source_found: true, source_overlap: false },
    asOf: "2026-08-27T12:00:00.000Z"
  });
  assert.equal(result.tier, "high");
});

test("blocked or stale evidence remains low quality", () => {
  const result = scoreClaim({ field: "public_api_available", value: "unknown", status: "unknown", evidence: evidence({ http_status: 403, checked_at: "2024-01-01T00:00:00.000Z" }) }, {
    identityStatus: "unresolved",
    asOf: "2026-08-27T12:00:00.000Z"
  });
  assert.equal(result.tier, "low");
});
