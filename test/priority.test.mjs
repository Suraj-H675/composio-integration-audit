import test from "node:test";
import assert from "node:assert/strict";
import { scoreRecord } from "../src/priority.mjs";

test("priority score sends unresolved identity and unknown fields to the front", () => {
  const result = scoreRecord({
    app: "Unclear",
    identity: { status: "unresolved" },
    claims: [
      { field: "public_api_available", value: "unknown" },
      { field: "vendor_official_mcp", value: "unknown" }
    ]
  }, { errors: [], warnings: [{ code: "identity_requires_escalation" }] });

  assert.equal(result.priority_score, 12);
  assert.deepEqual(result.reasons, ["identity_unresolved", "2_unknown_claims", "1_validation_warnings"]);
});
