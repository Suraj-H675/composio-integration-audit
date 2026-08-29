export const CATEGORIES = [
  "crm_sales",
  "customer_support",
  "communication",
  "marketing_analytics",
  "commerce",
  "data_seo_scraping",
  "developer_tools",
  "productivity",
  "finance_payments",
  "ai_media"
];

export const FIELDS = [
  "description",
  "auth_methods",
  "primary_auth",
  "credential_access",
  "customer_credential_access",
  "sandbox_access",
  "production_access",
  "distributed_integration_access",
  "public_api_available",
  "api_styles",
  "api_breadth",
  "webhooks",
  "vendor_official_mcp",
  "vendor_mcp_type",
  "vendor_mcp_stage",
  "community_mcp",
  "composio_toolkit_exists",
  "technical_buildability",
  "commercial_friction",
  "setup_friction",
  "main_blocker"
];

export const ENUMS = {
  identity_status: ["confirmed", "probable", "ambiguous", "unresolved"],
  auth_method: [
    "api_key", "oauth1", "oauth2", "oauth2_pkce", "oauth2_client_credentials",
    "basic_auth", "bearer_token", "jwt", "hmac_signature", "service_account",
    "personal_access_token", "webhook_secret", "saml", "not_applicable", "other", "unknown"
  ],
  credential_access: [
    "self_serve_free", "self_serve_trial", "self_serve_paid", "approval_required",
    "admin_required", "partner_gated", "unavailable", "not_applicable", "unknown"
  ],
  access_status: [
    "self_serve_free", "self_serve_trial", "self_serve_paid", "approval_required",
    "admin_required", "partner_gated", "unavailable", "not_applicable", "unknown"
  ],
  customer_credential_access: [
    "self_serve_free", "self_serve_trial", "self_serve_paid", "admin_required",
    "vendor_approval_required", "partner_gated", "unavailable", "not_applicable", "unknown"
  ],
  distributed_integration_access: [
    "open_self_serve", "app_review_required", "partner_program_required",
    "vendor_approval_required", "enterprise_contract_required", "customer_managed_only",
    "unsupported", "not_applicable", "unknown"
  ],
  public_api_available: ["yes", "limited", "no", "unknown"],
  api_style: ["rest", "graphql", "grpc", "websocket", "rpc", "sdk_only", "webhooks_only", "other", "unknown"],
  api_breadth: ["broad", "moderate", "narrow", "read_only", "action_specific", "unknown"],
  webhooks: ["yes", "limited", "no", "unknown"],
  vendor_official_mcp: [true, false, "unknown"],
  vendor_mcp_type: ["product_action", "documentation", "developer_tooling", "mixed", "unknown", "not_applicable"],
  vendor_mcp_stage: ["ga", "public_preview", "beta", "eap", "announced", "deprecated", "unknown"],
  community_mcp: ["available", "limited", "none_found", "unknown"],
  composio_toolkit_exists: ["yes", "no", "unknown"],
  technical_buildability: ["yes", "limited", "no", "unknown"],
  commercial_friction: ["none", "free_tier_limited", "paid_plan_required", "enterprise_plan_required", "usage_pricing", "unknown"],
  setup_friction: ["none", "oauth_configuration", "admin_configuration", "app_review", "merchant_underwriting", "other", "unknown"],
  main_blocker: ["none", "interface_limited", "credential_access", "commercial_friction", "setup_friction", "identity_unresolved", "other", "unknown"],
  claim_status: ["supported", "partially_supported", "contradicted", "unknown", "not_found"],
  confidence: ["high", "medium", "low", "unknown"],
  source_type: [
    "official_api_docs", "official_auth_docs", "official_product_docs", "official_announcement",
    "official_github", "composio_catalog", "community_repo", "secondary_source", "search_result_only", "inaccessible"
  ],
  retrieval_method: ["http", "browser"]
};

export function isEnumValue(enumName, value) {
  return ENUMS[enumName]?.includes(value) ?? false;
}

export function createUnknownClaim(field, evidence = [], reason = "No supported current evidence was found.") {
  return {
    field,
    value: field === "auth_methods" || field === "api_styles" ? ["unknown"] : "unknown",
    status: "unknown",
    confidence: "unknown",
    evidence,
    reason
  };
}

export function claimMap(record) {
  return new Map((record.claims ?? []).map((claim) => [claim.field, claim]));
}
