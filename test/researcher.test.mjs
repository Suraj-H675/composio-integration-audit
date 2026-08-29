import test from "node:test";
import assert from "node:assert/strict";
import { resolveIdentity } from "../src/researcher.mjs";

const source = (id, text, url = "https://candidate.example.com/") => ({
  id,
  url,
  final_url: url,
  status: "live",
  content_text: text,
  source_type: "official_product_docs",
  retrieval_method: "http",
  checked_at: "2026-08-28T00:00:00.000Z",
  http_status: 200
});

test("a product name match that conflicts with the assignment hint stays unresolved", () => {
  const app = {
    app: "Paygent Connect",
    assignment_hint_required: true,
    identity_options: [{
      id: "same-name",
      vendor: "Paygent",
      product: "Paygent Connect",
      canonical_url: "https://candidate.example.com/",
      expected_hosts: ["candidate.example.com"],
      source_ids: ["candidate"],
      patterns: ["Paygent Connect"],
      hint_patterns: ["NMI"]
    }]
  };
  const result = resolveIdentity(app, [source("candidate", "Paygent Connect marketplace API")]);
  assert.equal(result.status, "unresolved");
  assert.equal(result.hint_status, "conflict");
  assert.equal(result.candidates[0].matches_assignment_hint, "no");
  assert.equal(result.candidates[0].hint_conflict, true);
});
