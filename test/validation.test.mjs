import test from "node:test";
import assert from "node:assert/strict";
import { validateRecord } from "../src/validate.mjs";

const evidence = (field, url = "https://docs.example.com/api", overrides = {}) => ({
  url,
  source_type: "official_api_docs",
  retrieval_method: "http",
  checked_at: "2026-08-27T00:00:00.000Z",
  http_status: 200,
  supports: field,
  statement: `Current documentation supports ${field}. Production credentials and access are documented.`,
  ...overrides
});

const baseRecord = {
  app: "Example",
  category: "developer_tools",
  identity: {
    vendor: "Example, Inc.",
    product: "Example",
    canonical_url: "https://example.com",
    status: "confirmed",
    hint_status: "matched",
    rationale: "Official developer documentation identifies the product."
  },
  claims: [
    { field: "credential_access", value: "self_serve_free", status: "supported", confidence: "high", evidence: [evidence("credential_access")] },
    { field: "sandbox_access", value: "self_serve_free", status: "supported", confidence: "high", evidence: [evidence("sandbox_access")] },
    { field: "production_access", value: "self_serve_free", status: "supported", confidence: "high", evidence: [evidence("production_access")] },
    { field: "public_api_available", value: "yes", status: "supported", confidence: "high", evidence: [evidence("public_api_available")] },
    { field: "api_styles", value: ["rest"], status: "supported", confidence: "high", evidence: [evidence("api_styles")] },
    { field: "api_breadth", value: "broad", status: "supported", confidence: "high", evidence: [evidence("api_breadth")] },
    { field: "vendor_official_mcp", value: true, status: "supported", confidence: "high", evidence: [evidence("vendor_official_mcp")] },
    { field: "vendor_mcp_stage", value: "unknown", status: "supported", confidence: "high", evidence: [evidence("vendor_mcp_stage")] },
    { field: "technical_buildability", value: "yes", status: "supported", confidence: "high", evidence: [evidence("technical_buildability")] }
  ]
};

test("valid record crosses the validator seam", () => {
  assert.deepEqual(validateRecord(baseRecord).errors, []);
});

test("official ownership and lifecycle stage are independent", () => {
  assert.deepEqual(validateRecord(baseRecord).errors, []);
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "vendor_official_mcp").value = false;
  record.claims.find((claim) => claim.field === "vendor_mcp_stage").value = "beta";
  assert.ok(validateRecord(record).errors.some((item) => item.code === "mcp_stage_without_official_server"));
});

test("official MCP requires first-party evidence", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "vendor_official_mcp").evidence = [evidence("vendor_official_mcp", "https://community.example.com/mcp", { source_type: "community_repo" })];
  const result = validateRecord(record);
  assert.ok(result.errors.some((item) => item.code === "official_mcp_not_first_party"));
});

test("public API absence cannot be paired with broad breadth", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "public_api_available").value = "no";
  assert.ok(validateRecord(record).errors.some((item) => item.code === "api_breadth_without_api"));
});

test("production self-service needs access evidence", () => {
  const record = structuredClone(baseRecord);
  const claim = record.claims.find((item) => item.field === "production_access");
  claim.evidence = [evidence("public_api_available", "https://docs.example.com/api", { statement: "The public API reference is available." })];
  assert.ok(validateRecord(record).errors.some((item) => item.code === "self_serve_without_access_evidence"));
});

test("sandbox self-service does not promote production access", () => {
  const record = structuredClone(baseRecord);
  const production = record.claims.find((item) => item.field === "production_access");
  production.value = "unknown";
  production.evidence = [evidence("production_access", "https://docs.example.com/api", { statement: "The production path was checked but self-service access was not established." })];
  assert.equal(validateRecord(record).errors.some((item) => item.code === "sandbox_promoted_to_production"), false);
  assert.equal(production.value, "unknown");
});

test("technical buildability is not downgraded by access or setup friction", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((item) => item.field === "production_access").value = "approval_required";
  record.claims.push({ field: "commercial_friction", value: "paid_plan_required", status: "supported", confidence: "high", evidence: [evidence("commercial_friction")] });
  record.claims.push({ field: "setup_friction", value: "admin_configuration", status: "supported", confidence: "high", evidence: [evidence("setup_friction")] });
  assert.equal(validateRecord(record).errors.some((item) => item.code === "buildable_without_production_access"), false);
  assert.equal(validateRecord(record).errors.some((item) => item.code === "buildable_with_setup_friction"), false);
});

test("Composio catalog evidence cannot establish vendor-official MCP", () => {
  const record = structuredClone(baseRecord);
  const mcp = record.claims.find((claim) => claim.field === "vendor_official_mcp");
  mcp.evidence = [evidence("vendor_official_mcp", "https://backend.composio.dev/api/v3.1/toolkits", { source_type: "composio_catalog" })];
  const composio = { field: "composio_toolkit_exists", value: "yes", status: "supported", confidence: "high", evidence: [evidence("composio_toolkit_exists", "https://backend.composio.dev/api/v3.1/toolkits", { source_type: "composio_catalog" })] };
  record.claims.push(composio);
  const result = validateRecord(record);
  assert.ok(result.errors.some((item) => item.code === "official_mcp_not_first_party"));
  assert.equal(result.errors.some((item) => item.code === "composio_claim_without_catalog"), false);
});

test("community MCP cannot establish vendor-official MCP", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "vendor_official_mcp").evidence = [evidence("vendor_official_mcp", "https://community.example.com/mcp", { source_type: "community_repo" })];
  assert.ok(validateRecord(record).errors.some((item) => item.code === "official_mcp_not_first_party"));
});

test("Composio contradictions are warnings, not silent overwrites", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "public_api_available").value = "no";
  record.claims.find((claim) => claim.field === "technical_buildability").value = "no";
  record.claims.push({ field: "composio_toolkit_exists", value: "yes", status: "supported", confidence: "high", evidence: [evidence("composio_toolkit_exists", "https://backend.composio.dev/api/v3.1/toolkits", { source_type: "composio_catalog" })] });
  const result = validateRecord(record);
  assert.ok(result.warnings.some((item) => item.code === "composio_buildability_contradiction"));
  assert.ok(result.warnings.some((item) => item.code === "composio_api_contradiction"));
});

test("ambiguous identity forces an escalation warning", () => {
  const record = structuredClone(baseRecord);
  record.identity.status = "ambiguous";
  assert.ok(validateRecord(record).warnings.some((item) => item.code === "identity_requires_escalation"));
});

test("unresolved identity blocks a confident buildability verdict", () => {
  const record = structuredClone(baseRecord);
  record.identity.status = "unresolved";
  assert.ok(validateRecord(record).errors.some((item) => item.code === "buildable_with_uncertain_identity"));
});

test("assignment hint conflict forces escalation", () => {
  const record = structuredClone(baseRecord);
  record.identity.status = "unresolved";
  record.identity.hint_status = "conflict";
  record.identity.candidates = [{ id: "wrong", hint_conflict: true }];
  const result = validateRecord(record);
  assert.ok(result.errors.some((item) => item.code === "identity_hint_conflict"));
  assert.ok(result.warnings.some((item) => item.code === "identity_requires_escalation"));
});

test("local tools may mark authentication not applicable", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "credential_access").value = "not_applicable";
  record.claims.find((claim) => claim.field === "sandbox_access").value = "not_applicable";
  record.claims.find((claim) => claim.field === "production_access").value = "not_applicable";
  record.claims.find((claim) => claim.field === "api_styles").value = ["sdk_only"];
  assert.deepEqual(validateRecord(record).errors, []);
});

test("customer self-serve cannot be inferred from sandbox evidence", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "customer_credential_access", value: "self_serve_free", status: "supported", confidence: "high", evidence: [evidence("sandbox_access", "https://docs.example.com/sandbox", { statement: "Sandbox credentials are available for testing." })] });
  assert.ok(validateRecord(record).errors.some((item) => item.code === "customer_access_without_credential_evidence"));
});

test("customer-managed-only access still requires customer credential evidence", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "customer_credential_access", value: "customer_managed_only", status: "supported", confidence: "high", evidence: [evidence("customer_credential_access", "https://docs.example.com/api", { statement: "The API reference is available." })] });
  assert.ok(validateRecord(record).errors.some((item) => item.code === "customer_access_without_credential_evidence"));
  record.claims.find((item) => item.field === "customer_credential_access").evidence = [evidence("customer_credential_access", "https://docs.example.com/auth", { statement: "An administrator can create an API key for their own organization." })];
  assert.equal(validateRecord(record).errors.some((item) => item.code === "customer_access_without_credential_evidence"), false);
});

test("open distribution requires distribution evidence", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "distributed_integration_access", value: "open_self_serve", status: "supported", confidence: "high", evidence: [evidence("api_styles", "https://docs.example.com/api", { statement: "The REST API reference is available." })] });
  assert.ok(validateRecord(record).errors.some((item) => item.code === "open_distribution_without_evidence"));
});

test("partner and app-review distribution values require matching evidence", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "distributed_integration_access", value: "partner_program_required", status: "supported", confidence: "high", evidence: [evidence("distributed_integration_access", "https://docs.example.com/partners", { statement: "The developer partner program is required for public distribution." })] });
  assert.deepEqual(validateRecord(record).errors, []);
  const review = structuredClone(record);
  review.claims.find((claim) => claim.field === "distributed_integration_access").value = "app_review_required";
  assert.ok(validateRecord(review).errors.some((item) => item.code === "app_review_without_evidence"));
});

test("MCP capability type is independent from ownership and stage", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "vendor_mcp_type", value: "product_action", status: "supported", confidence: "high", evidence: [evidence("vendor_mcp_type", "https://docs.example.com/mcp", { statement: "The official MCP can query customer records and update projects." })] });
  assert.deepEqual(validateRecord(record).errors, []);
  const unknownOwner = structuredClone(record);
  unknownOwner.claims.find((claim) => claim.field === "vendor_official_mcp").value = "unknown";
  assert.ok(validateRecord(unknownOwner).errors.some((item) => item.code === "mcp_type_without_known_ownership"));
});

test("documentation-only MCP is distinct from a product-action MCP", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "vendor_mcp_type", value: "documentation", status: "supported", confidence: "high", evidence: [evidence("vendor_mcp_type", "https://docs.example.com/mcp", { statement: "The documentation MCP exposes vendor API docs, tutorials, and code examples." })] });
  assert.deepEqual(validateRecord(record).errors, []);
});

test("official MCP ownership false requires a not-applicable MCP type", () => {
  const record = structuredClone(baseRecord);
  record.claims.push({ field: "vendor_mcp_type", value: "product_action", status: "supported", confidence: "high", evidence: [evidence("vendor_mcp_type", "https://docs.example.com/mcp", { statement: "The MCP can query customer records." })] });
  record.claims.find((claim) => claim.field === "vendor_official_mcp").value = false;
  assert.ok(validateRecord(record).errors.some((item) => item.code === "mcp_type_without_official_server"));
});

test("limited buildability requires an interface limitation, not pricing alone", () => {
  const record = structuredClone(baseRecord);
  record.claims.find((claim) => claim.field === "technical_buildability").value = "limited";
  record.claims.find((claim) => claim.field === "technical_buildability").reason = "A paid plan is required.";
  assert.ok(validateRecord(record).errors.some((item) => item.code === "limited_without_interface_limitation"));
  assert.ok(validateRecord(record).errors.some((item) => item.code === "paid_friction_invalid_limited_reason"));
});
