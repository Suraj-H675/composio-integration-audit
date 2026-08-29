import { CATEGORIES, claimMap, ENUMS, FIELDS, isEnumValue } from "./schema.mjs";

const FIRST_PARTY_TYPES = new Set([
  "official_api_docs",
  "official_auth_docs",
  "official_product_docs",
  "official_announcement",
  "official_github"
]);

const ENUM_BY_FIELD = {
  auth_methods: "auth_method",
  primary_auth: "auth_method",
  credential_access: "credential_access",
  customer_credential_access: "customer_credential_access",
  sandbox_access: "access_status",
  production_access: "access_status",
  distributed_integration_access: "distributed_integration_access",
  public_api_available: "public_api_available",
  api_styles: "api_style",
  api_breadth: "api_breadth",
  webhooks: "webhooks",
  vendor_official_mcp: "vendor_official_mcp",
  vendor_mcp_type: "vendor_mcp_type",
  vendor_mcp_stage: "vendor_mcp_stage",
  community_mcp: "community_mcp",
  composio_toolkit_exists: "composio_toolkit_exists",
  technical_buildability: "technical_buildability",
  commercial_friction: "commercial_friction",
  setup_friction: "setup_friction",
  main_blocker: "main_blocker"
};

function issue(code, message, field = null, severity = "error") {
  return { code, message, field, severity };
}

function valuesForClaim(claim) {
  return Array.isArray(claim.value) ? claim.value : [claim.value];
}

function hasAccessEvidence(claim) {
  return (claim?.evidence ?? []).some((item) => {
    const statement = `${item.supports ?? ""} ${item.statement ?? ""}`.toLowerCase();
    return item.http_status >= 200 && item.http_status < 400 && item.source_type !== "search_result_only" && /production|live mode|credential|access token|api key|self[- ]serve|create .*token/.test(statement);
  });
}

function hasCustomerCredentialEvidence(claim) {
  return (claim?.evidence ?? []).some((item) => {
    const statement = `${item.supporting_excerpt ?? ""} ${item.statement ?? ""}`.toLowerCase();
    const hasDirectCredentialSignal = /credential|access token|authentication token|auth token|api key|oauth|self[- ]serve|create .*token|generate .*key/.test(statement);
    const sandboxOnly = /sandbox|testnet|test mode|demo mode/.test(statement)
      && !/production|live mode|own (?:account|organization|workspace)|your (?:account|organization|workspace)|customer|public api|multi[- ]tenant/.test(statement);
    return item.http_status >= 200 && item.http_status < 400 && item.source_type !== "search_result_only" && !sandboxOnly && hasDirectCredentialSignal;
  });
}

function hasDistributionEvidence(claim) {
  return (claim?.evidence ?? []).some((item) => {
    const statement = `${item.supports ?? ""} ${item.supporting_excerpt ?? item.statement ?? ""}`.toLowerCase();
    return item.http_status >= 200 && item.http_status < 400 && item.source_type !== "search_result_only" && /public|multi[- ]tenant|marketplace|partner|review|approval|production|oauth|distribution|customer/.test(statement);
  });
}

function evidenceText(claim) {
  return (claim?.evidence ?? []).map((item) => `${item.supports ?? ""} ${item.supporting_excerpt ?? item.statement ?? ""}`).join(" ").toLowerCase();
}

function hasFirstPartyEvidence(claim) {
  return (claim?.evidence ?? []).some((item) => FIRST_PARTY_TYPES.has(item.source_type) && item.http_status >= 200 && item.http_status < 400);
}

function hasComposioEvidence(claim) {
  return claim?.evidence?.some((item) => item.source_type === "composio_catalog") ?? false;
}

function hostMatches(host, expected) {
  return host === expected || host.endsWith(`.${expected}`);
}

function isUnknownValue(value) {
  return value === "unknown" || (Array.isArray(value) && value.includes("unknown"));
}

export function validateRecord(record, { requireAll = false, expectedHosts = [] } = {}) {
  const errors = [];
  const warnings = [];
  const seen = new Set();

  if (!record || typeof record !== "object") return { errors: [issue("record_not_object", "Record must be an object.")], warnings };
  if (!record.app) errors.push(issue("missing_app", "Record is missing app name."));
  if (!ENUMS.identity_status.includes(record.identity?.status)) errors.push(issue("invalid_identity_status", "Identity status is not in the rubric.", "identity"));
  if (!CATEGORIES.includes(record.category)) errors.push(issue("invalid_category", "Category is not in the rubric.", "category"));

  const claims = claimMap(record);
  for (const claim of record.claims ?? []) {
    if (seen.has(claim.field)) errors.push(issue("duplicate_field", "A field appears more than once.", claim.field));
    seen.add(claim.field);
    if (!FIELDS.includes(claim.field)) errors.push(issue("unknown_field", "Field is not in the rubric.", claim.field));
    if (!ENUMS.claim_status.includes(claim.status)) errors.push(issue("invalid_claim_status", "Claim status is not in the rubric.", claim.field));
    if (!ENUMS.confidence.includes(claim.confidence)) errors.push(issue("invalid_confidence", "Confidence is not in the rubric.", claim.field));
    const enumName = ENUM_BY_FIELD[claim.field];
    if (enumName) {
      for (const value of valuesForClaim(claim)) {
        if (!isEnumValue(enumName, value)) errors.push(issue("invalid_enum_value", `${value} is not valid for ${claim.field}.`, claim.field));
      }
    }
    if (!Array.isArray(claim.evidence)) errors.push(issue("evidence_not_array", "Claim evidence must be an array.", claim.field));
    for (const item of claim.evidence ?? []) {
      if (!item.url || !item.source_type || !item.checked_at || !item.statement || !item.retrieval_method) {
        errors.push(issue("incomplete_evidence", "Evidence needs url, source_type, checked_at, retrieval_method, and statement.", claim.field));
      }
      if (item.source_type && !ENUMS.source_type.includes(item.source_type)) errors.push(issue("invalid_source_type", "Evidence source type is not in the rubric.", claim.field));
      if (item.retrieval_method && !ENUMS.retrieval_method.includes(item.retrieval_method)) errors.push(issue("invalid_retrieval_method", "Evidence retrieval method is not in the rubric.", claim.field));
      if (item.source_type === "search_result_only" && claim.status === "supported") errors.push(issue("search_only_support", "Search results cannot support a final claim.", claim.field));
    }
  }

  if (requireAll) {
    for (const field of FIELDS) if (!claims.has(field)) errors.push(issue("missing_field", "Required field is missing.", field));
  }

  const api = claims.get("public_api_available");
  const breadth = claims.get("api_breadth");
  if (api?.value === "no" && breadth?.value === "broad") errors.push(issue("api_breadth_without_api", "An API-absent app cannot have broad API breadth.", "api_breadth"));

  const prodAccess = claims.get("production_access");
  if (prodAccess && ["self_serve_free", "self_serve_trial", "self_serve_paid"].includes(prodAccess.value) && !hasAccessEvidence(prodAccess)) {
    errors.push(issue("self_serve_without_access_evidence", "Production self-service requires explicit current access evidence.", "production_access"));
  }

  const customerAccess = claims.get("customer_credential_access");
  if (customerAccess && ["self_serve_free", "self_serve_trial", "self_serve_paid", "customer_managed_only"].includes(customerAccess.value) && !hasCustomerCredentialEvidence(customerAccess)) {
    errors.push(issue("customer_access_without_credential_evidence", "Customer self-serve access requires current evidence about customer credentials, not merely a sandbox or API page.", "customer_credential_access"));
  }

  const distribution = claims.get("distributed_integration_access");
  if (distribution && distribution.value === "open_self_serve" && !hasDistributionEvidence(distribution)) {
    errors.push(issue("open_distribution_without_evidence", "Open multi-customer distribution requires evidence about public/distributable integration setup.", "distributed_integration_access"));
  }
  if (distribution && distribution.value === "partner_program_required" && !/partner|partnership|program/.test(evidenceText(distribution))) {
    errors.push(issue("partner_distribution_without_evidence", "Partner-gated distribution requires evidence of a partner or developer program.", "distributed_integration_access"));
  }
  if (distribution && distribution.value === "app_review_required" && !/review|approval|production|demo mode|public app|public developer|vetting|screen recording|apply for access/.test(evidenceText(distribution))) {
    errors.push(issue("app_review_without_evidence", "App-review distribution requires evidence of review, approval, production gating, or public-app review.", "distributed_integration_access"));
  }

  const mcp = claims.get("vendor_official_mcp");
  const mcpType = claims.get("vendor_mcp_type");
  const mcpStage = claims.get("vendor_mcp_stage");
  if (mcp?.value === true && !hasFirstPartyEvidence(mcp)) errors.push(issue("official_mcp_not_first_party", "Positive vendor MCP status requires first-party evidence.", "vendor_official_mcp"));
  if (mcp && mcpStage && mcp.value !== true && mcpStage.value !== "unknown") errors.push(issue("mcp_stage_without_official_server", "A lifecycle stage cannot be assigned when official MCP ownership is false or unknown.", "vendor_mcp_stage"));
  if (mcpType && mcp?.value === false && mcpType.value !== "not_applicable") errors.push(issue("mcp_type_without_official_server", "An MCP type is not applicable when official MCP ownership is false.", "vendor_mcp_type"));
  if (mcpType && mcp?.value === "unknown" && !["unknown", "not_applicable"].includes(mcpType.value)) errors.push(issue("mcp_type_without_known_ownership", "MCP capability type cannot be asserted while official ownership is unknown.", "vendor_mcp_type"));
  if (mcpType && mcp?.value === true && mcpType.value === "product_action" && !/action|data|record|project|deployment|meeting|customer|workspace|query|create|update|manage|operate|log|payment|audit|transaction|report|rate|tool|operation/.test(evidenceText(mcpType))) errors.push(issue("product_action_mcp_without_surface_evidence", "Product-action MCP requires evidence that actual product data or operations are exposed.", "vendor_mcp_type"));
  if (mcpType && mcp?.value === true && mcpType.value === "documentation" && !/documentation|docs|tutorial|example|knowledge|reference|code sample/.test(evidenceText(mcpType))) errors.push(issue("documentation_mcp_without_surface_evidence", "Documentation MCP requires evidence that the surface primarily exposes vendor documentation or examples.", "vendor_mcp_type"));

  const composio = claims.get("composio_toolkit_exists");
  if (composio && ["yes", "no"].includes(composio.value) && !hasComposioEvidence(composio)) errors.push(issue("composio_claim_without_catalog", "A definitive Composio toolkit value requires current catalog evidence.", "composio_toolkit_exists"));

  const buildable = claims.get("technical_buildability");
  const apiStyles = claims.get("api_styles")?.value;
  const hasSurface = ["yes", "limited"].includes(api?.value) || mcp?.value === true || (Array.isArray(apiStyles) && apiStyles.some((value) => ["sdk_only", "webhooks_only", "other"].includes(value)));
  if (buildable?.value === "yes" && ["unresolved", "ambiguous"].includes(record.identity?.status)) errors.push(issue("buildable_with_uncertain_identity", "A confident buildability verdict requires a resolved identity.", "technical_buildability"));
  if (buildable?.value === "yes" && !hasSurface) errors.push(issue("buildable_without_surface", "Buildable-now requires a documented usable interface.", "technical_buildability"));
  if (buildable?.value === "limited") {
    const rationale = `${buildable.reason ?? ""} ${buildable.evidence ?? ""}`.toLowerCase();
    const hasInterfaceLimitation = /interface|action[- ]specific|read[- ]only|narrow|local cli|local tool|surface limitation/.test(rationale);
    if (!hasInterfaceLimitation) errors.push(issue("limited_without_interface_limitation", "technical_buildability=limited requires an actual interface limitation explanation.", "technical_buildability"));
    if (!hasInterfaceLimitation && /paid|pricing|plan|trial|commercial/.test(rationale)) errors.push(issue("paid_friction_invalid_limited_reason", "Pricing or plan friction alone cannot justify technical_buildability=limited.", "technical_buildability"));
  }

  if (record.identity?.hint_status === "conflict" || record.identity?.candidates?.some((candidate) => candidate.hint_conflict)) {
    errors.push(issue("identity_hint_conflict", "A name-matching candidate conflicts with the assignment hint/context and cannot be accepted automatically.", "identity"));
    warnings.push(issue("identity_requires_escalation", "Identity hint conflict requires deeper research or human review.", "identity", "warning"));
  } else if (["ambiguous", "unresolved"].includes(record.identity?.status)) {
    warnings.push(issue("identity_requires_escalation", "Identity uncertainty requires human or deeper research review.", "identity", "warning"));
  }

  if (composio?.value === "yes" && buildable?.value === "no") warnings.push(issue("composio_buildability_contradiction", "Composio coverage conflicts with technical_buildability=no; explain without overwriting either claim.", "technical_buildability", "warning"));
  if (composio?.value === "yes" && api?.value === "no") warnings.push(issue("composio_api_contradiction", "Composio coverage conflicts with public_api_available=no; investigate the toolkit surface.", "public_api_available", "warning"));

  for (const claim of record.claims ?? []) {
    for (const item of claim.evidence ?? []) {
      try {
        const host = new URL(item.original_url || item.url).hostname;
        const externalCatalogEvidence = claim.field === "composio_toolkit_exists" && item.source_type === "composio_catalog";
        if (expectedHosts.length && !externalCatalogEvidence && !expectedHosts.some((expected) => hostMatches(host, expected))) {
          warnings.push(issue("evidence_domain_mismatch", `Evidence host ${host} is outside the expected vendor domains.`, claim.field, "warning"));
        }
      } catch {
        errors.push(issue("invalid_evidence_url", "Evidence URL is not a valid URL.", claim.field));
      }
    }
  }

  return { errors, warnings };
}
