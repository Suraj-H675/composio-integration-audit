import { CATEGORIES, FIELDS, claimMap } from "./schema.mjs";

export const PRESENTATION_FIELDS = [
  "description",
  "auth_methods",
  "primary_auth",
  "customer_credential_access",
  "sandbox_access",
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

const FIRST_PARTY_TYPES = new Set([
  "official_api_docs",
  "official_auth_docs",
  "official_product_docs",
  "official_announcement",
  "official_github"
]);

const DISTRIBUTION_GATES = new Set([
  "app_review_required",
  "partner_program_required",
  "vendor_approval_required",
  "enterprise_contract_required"
]);

const CUSTOMER_SELF_SERVE = new Set(["self_serve_free", "self_serve_trial", "self_serve_paid"]);

function normalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).trim().replace(/\/$/, "");
  }
}

export function getClaim(record, field) {
  return claimMap(record).get(field);
}

export function fieldValue(record, field) {
  if (field === "identity") return record.identity?.status ?? "unknown";
  return getClaim(record, field)?.value ?? "unknown";
}

export function isUnknown(value) {
  return value === "unknown" || (Array.isArray(value) && value.includes("unknown"));
}

export function count(values) {
  return values.reduce((result, value) => {
    const key = String(value);
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

export function percentage(numerator, denominator) {
  return denominator ? Number((100 * numerator / denominator).toFixed(1)) : 0;
}

function metric(label, numerator, denominator, definition, display = null) {
  return {
    label,
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
    percent: percentage(numerator, denominator),
    display: display ?? `${numerator}/${denominator}`,
    definition
  };
}

function sourceRows(ledger) {
  return (ledger?.sources ?? []).flatMap((row) => row.sources ?? []);
}

function sourceCounts(ledger) {
  const sources = sourceRows(ledger);
  return {
    rows: sources.length,
    uniqueUrls: new Set(sources.map((source) => normalizeUrl(source.final_url || source.url)).filter(Boolean)).size,
    live: sources.filter((source) => source.status === "live").length,
    retrieval: count(sources.map((source) => source.retrieval_method ?? "unknown"))
  };
}

function qualityScore(record) {
  const tiers = (record.claims ?? []).map((claim) => claim.evidence_quality?.tier).filter(Boolean);
  return tiers.includes("high") ? 2 : tiers.includes("medium") ? 1 : 0;
}

function usefulSurface(record) {
  return fieldValue(record, "public_api_available") === "yes"
    || (fieldValue(record, "vendor_official_mcp") === true && fieldValue(record, "vendor_mcp_type") === "product_action");
}

function compactReasons(record, bucket) {
  const reasons = ["technical_buildability=yes", "useful API or product-action MCP"];
  if (bucket !== "customer_managed") reasons.push("no Composio toolkit");
  if (bucket === "easy") {
    reasons.push("open_self_serve distribution");
    reasons.push(`${fieldValue(record, "customer_credential_access")} customer credentials`);
  } else if (bucket === "partnership") {
    reasons.push(fieldValue(record, "distributed_integration_access"));
  } else {
    reasons.push("customer_managed_only distribution");
  }
  return reasons;
}

export function rankedOpportunityBuckets(apps) {
  const easy = [];
  const partnership = [];
  const customerManaged = [];
  for (const record of apps) {
    const customer = fieldValue(record, "customer_credential_access");
    const distribution = fieldValue(record, "distributed_integration_access");
    const noToolkit = fieldValue(record, "composio_toolkit_exists") === "no";
    if (record.identity?.status === "confirmed" && fieldValue(record, "technical_buildability") === "yes" && usefulSurface(record) && noToolkit && distribution === "open_self_serve" && CUSTOMER_SELF_SERVE.has(customer)) {
      easy.push({
        app: record.app,
        score: 8 + (customer === "self_serve_free" ? 1 : 0) + qualityScore(record),
        reasons: compactReasons(record, "easy")
      });
    }
    if (record.identity?.status === "confirmed" && fieldValue(record, "technical_buildability") === "yes" && usefulSurface(record) && noToolkit && DISTRIBUTION_GATES.has(distribution)) {
      partnership.push({
        app: record.app,
        score: 7 + (fieldValue(record, "public_api_available") === "yes" ? 1 : 0) + qualityScore(record),
        reasons: compactReasons(record, "partnership")
      });
    }
    if (fieldValue(record, "technical_buildability") === "yes" && usefulSurface(record) && distribution === "customer_managed_only") {
      customerManaged.push({
        app: record.app,
        score: 5 + (noToolkit ? 1 : 0) + qualityScore(record),
        reasons: compactReasons(record, "customer_managed")
      });
    }
  }
  const finish = (items) => items
    .sort((left, right) => right.score - left.score || left.app.localeCompare(right.app))
    .map((item, index) => ({ rank: index + 1, ...item }));
  return {
    engineering_easy_wins: finish(easy),
    partnership_review_opportunities: finish(partnership),
    customer_managed_only_opportunities: finish(customerManaged)
  };
}

export function categoryPatterns(apps) {
  const result = {};
  for (const category of CATEGORIES) {
    const records = apps.filter((record) => record.category === category);
    result[category] = {
      app_count: records.length,
      technical_buildability: count(records.map((record) => fieldValue(record, "technical_buildability"))),
      customer_credential_access: count(records.map((record) => fieldValue(record, "customer_credential_access"))),
      distributed_integration_access: count(records.map((record) => fieldValue(record, "distributed_integration_access"))),
      auth_methods: count(records.flatMap((record) => fieldValue(record, "auth_methods") ?? ["unknown"])),
      official_mcp: records.filter((record) => fieldValue(record, "vendor_official_mcp") === true).length,
      product_action_mcp: records.filter((record) => fieldValue(record, "vendor_official_mcp") === true && fieldValue(record, "vendor_mcp_type") === "product_action").length,
      composio_toolkit: records.filter((record) => fieldValue(record, "composio_toolkit_exists") === "yes").length
    };
  }
  return result;
}

function holdoutMetrics(holdout) {
  const rows = holdout?.comparison_rows ?? [];
  const exact = rows.filter((row) => JSON.stringify(row.proposed_value) === JSON.stringify(row.approved_value)).length;
  const correct = rows.filter((row) => row.status === "correct").length;
  const wrong = rows.filter((row) => row.status === "wrong" || row.status === "partial").length;
  const humanUnresolved = rows.filter((row) => row.status === "human_unresolved").length;
  const automationAbstentions = rows.filter((row) => row.status === "automation_abstention").length;
  return {
    appCount: holdout?.reviewed_app_count ?? 0,
    fieldCount: rows.length,
    exact: metric("Exact field agreement", exact, rows.length, "Exact equality across all human-adjudicable v2 fields; approved unknown values are included.", `${exact}/${rows.length}`),
    resolved: metric("Resolved-field accuracy", correct, correct + wrong, "correct / (correct + wrong); abstentions and human-unresolved fields are excluded.", `${correct}/${correct + wrong}`),
    automationAbstentions: metric("Automation abstention rate", automationAbstentions, rows.length, "Pre-human proposal was unknown.", `${automationAbstentions}/${rows.length}`),
    humanUnresolved: metric("Human-unresolved rate", humanUnresolved, rows.length, "Approved value remains unknown.", `${humanUnresolved}/${rows.length}`)
  };
}

function verificationMetrics(verification) {
  const entries = (verification?.entries ?? []).flatMap((row) => row.verifications ?? []);
  const determinate = entries.filter((item) => ["agree", "correction", "disagree"].includes(item.status));
  const alternate = entries.filter((item) => item.independent_source_found === true);
  const disjoint = entries.filter((item) => item.source_overlap === false);
  const disjointAlternate = alternate.filter((item) => item.source_overlap === false);
  const agreements = entries.filter((item) => item.status === "agree").length;
  return {
    challengeCount: entries.length,
    agreement: metric("Observed verifier agreement", agreements, determinate.length, "Agreement is a process signal, not ground-truth accuracy.", `${agreements}/${determinate.length}`),
    sourceDisjoint: metric("Source-disjoint verification", disjoint.length, entries.length, "Verified claims whose verifier source did not overlap the researcher source.", `${disjoint.length}/${entries.length}`),
    sourceDisjointWhenAlternate: metric("Source-disjoint when alternate evidence existed", disjointAlternate.length, alternate.length, "Source-disjoint checks among challenges where the verifier found an alternate source.", `${disjointAlternate.length}/${alternate.length}`)
  };
}

export function computePresentationMetrics({ apps, ledger, verification, holdout, lock }) {
  const source = sourceCounts(ledger);
  const values = (field) => apps.map((record) => fieldValue(record, field));
  const officialApps = apps.filter((record) => fieldValue(record, "vendor_official_mcp") === true);
  const officialMcp = officialApps.length;
  const lifecycleAmongOfficial = count(officialApps.map((record) => fieldValue(record, "vendor_mcp_stage")));
  const lifecycleAcrossApps = count(values("vendor_mcp_stage"));
  const buildable = values("technical_buildability").filter((value) => value === "yes").length;
  const openDistribution = values("distributed_integration_access").filter((value) => value === "open_self_serve").length;
  const distributionGated = values("distributed_integration_access").filter((value) => DISTRIBUTION_GATES.has(value)).length;
  const customerEasyDistributionGated = apps.filter((record) => CUSTOMER_SELF_SERVE.has(fieldValue(record, "customer_credential_access")) && DISTRIBUTION_GATES.has(fieldValue(record, "distributed_integration_access"))).length;
  const composio = count(values("composio_toolkit_exists"));
  const productAction = officialApps.filter((record) => fieldValue(record, "vendor_mcp_type") === "product_action").length;
  const documentation = officialApps.filter((record) => fieldValue(record, "vendor_mcp_type") === "documentation").length;
  const mixed = officialApps.filter((record) => fieldValue(record, "vendor_mcp_type") === "mixed").length;
  const unknownType = officialApps.filter((record) => fieldValue(record, "vendor_mcp_type") === "unknown").length;
  const absentToolkit = (record) => fieldValue(record, "composio_toolkit_exists") === "no";
  const publicApiAbsent = apps.filter((record) => fieldValue(record, "public_api_available") === "yes" && absentToolkit(record)).length;
  const buildableAbsent = apps.filter((record) => fieldValue(record, "technical_buildability") === "yes" && absentToolkit(record)).length;
  const officialAbsent = officialApps.filter(absentToolkit).length;
  const productActionAbsent = officialApps.filter((record) => fieldValue(record, "vendor_mcp_type") === "product_action" && absentToolkit(record)).length;
  const identities = count(apps.map((record) => record.identity?.status ?? "unknown"));
  const holdoutDerived = holdoutMetrics(holdout);
  const schemaRepair = holdout?.schema_repair_improvement ?? {};
  const verificationDerived = verificationMetrics(verification);
  const unknownByField = Object.fromEntries(PRESENTATION_FIELDS.map((field) => [field, values(field).filter(isUnknown).length]));
  const primaryUnknown = Object.values(unknownByField).reduce((sum, value) => sum + value, 0);
  const buckets = rankedOpportunityBuckets(apps);
  const categories = categoryPatterns(apps);
  return {
    datasetId: lock.dataset_id,
    schemaVersion: lock.schema_version,
    appCount: apps.length,
    source,
    claims: {
      count: apps.reduce((sum, record) => sum + (record.claims?.length ?? 0), 0),
      evidenceBacked: apps.flatMap((record) => record.claims ?? []).filter((claim) => (claim.evidence ?? []).length > 0).length
    },
    unknown: {
      primary: metric("Unknown primary fields", primaryUnknown, apps.length * PRESENTATION_FIELDS.length, "Counts unknown values across presentation fields; legacy production_access and credential_access are excluded.", `${primaryUnknown}/${apps.length * PRESENTATION_FIELDS.length}`),
      byField: unknownByField,
      legacy: {
        credential_access: values("credential_access").filter(isUnknown).length,
        production_access: values("production_access").filter(isUnknown).length
      }
    },
    identity: {
      distribution: identities,
      unresolved: identities.unresolved ?? 0
    },
    headline: {
      technicallyBuildable: metric("Technically buildable", buildable, apps.length, "Count of records with technical_buildability=yes; pricing, admin setup, and distribution gates do not downgrade this field.", `${percentage(buildable, apps.length)}%`),
      openDistribution: metric("Open distribution", openDistribution, apps.length, "Count of records with distributed_integration_access=open_self_serve.", `${openDistribution}`),
      productActionMcp: metric("Product-action official MCPs", productAction, officialMcp, "Count of official vendor MCPs classified as product_action; denominator is official MCPs.", `${productAction}`),
      productActionMcpAbsent: metric("Product-action MCPs absent from Composio", productActionAbsent, apps.length, "Count of product-action official MCP apps whose Composio toolkit value is no.", `${productActionAbsent}`),
      composioCoverage: metric("Composio toolkit coverage", composio.yes ?? 0, apps.length, "Count of apps with composio_toolkit_exists=yes.", `${composio.yes ?? 0}/${apps.length}`),
      resolvedHoldoutAccuracy: holdoutDerived.resolved,
      paidCost: { label: "Paid research cost", value: lock.paid_cost_usd, display: `$${lock.paid_cost_usd}`, definition: "Paid services reported by the frozen dataset lock." },
      unresolvedIdentities: metric("Unresolved identities", identities.unresolved ?? 0, apps.length, "Count of records whose identity status is unresolved.", `${identities.unresolved ?? 0}`)
    },
    distribution: {
      customerCredentialAccess: count(values("customer_credential_access")),
      distributedIntegrationAccess: count(values("distributed_integration_access")),
      customerEasyDistributionGated: metric("Customer-self-serve but distribution-gated", customerEasyDistributionGated, apps.length, "Customer credential access is self-serve while distributed integration access is app, partner, vendor, or enterprise gated.", `${customerEasyDistributionGated}`),
      documentedDistributionGates: metric("Documented distribution gates", distributionGated, apps.length, "Count of app-review, partner-program, vendor-approval, or enterprise-contract distribution values.", `${distributionGated}`)
    },
    buildability: count(values("technical_buildability")),
    api: {
      public: count(values("public_api_available")),
      breadth: count(values("api_breadth")),
      styles: count(values("api_styles").flat())
    },
    mcp: {
      officialCount: officialMcp,
      officialDistribution: count(values("vendor_official_mcp")),
      typeAmongOfficial: { product_action: productAction, mixed, documentation, unknown: unknownType },
      lifecycleAmongOfficial,
      lifecycleAcrossAllApps: lifecycleAcrossApps,
      unknownStageAmongOfficial: lifecycleAmongOfficial.unknown ?? 0,
      unknownStageAcrossAllApps: lifecycleAcrossApps.unknown ?? 0,
      nonOfficialUnknownStage: (lifecycleAcrossApps.unknown ?? 0) - (lifecycleAmongOfficial.unknown ?? 0),
      sanityExplanation: "The 67 figure is scoped to the 75 apps with confirmed official MCP ownership. The 92 figure counts every app whose lifecycle is unknown: 67 official MCPs without a documented lifecycle label plus 25 apps without confirmed official MCP ownership."
    },
    composio: {
      distribution: composio,
      publicApiAbsent: publicApiAbsent,
      technicallyBuildableAbsent: buildableAbsent,
      officialMcpAbsent: officialAbsent,
      productActionMcpAbsent: productActionAbsent,
      catalogSnapshot: lock.catalog_snapshot ?? null
    },
    verification: verificationDerived,
    holdout: {
      ...holdoutDerived,
      schemaRepair: {
        repaired: schemaRepair.repaired_field_count ?? 0,
        accepted: schemaRepair.accepted_v2_values ?? 0,
        stillNeeded: schemaRepair.still_needed_human_correction ?? 0,
        acceptedPercent: schemaRepair.repaired_field_count ? Number((100 * (schemaRepair.accepted_v2_values ?? 0) / schemaRepair.repaired_field_count).toFixed(2)) : 0,
        denominator: schemaRepair.denominator ?? schemaRepair.repaired_field_count ?? 0
      }
    },
    evidenceQuality: count(apps.flatMap((record) => (record.claims ?? []).map((claim) => claim.evidence_quality?.tier ?? "unknown"))),
    opportunities: {
      easyWins: buckets.engineering_easy_wins,
      partnership: buckets.partnership_review_opportunities,
      customerManaged: buckets.customer_managed_only_opportunities
    },
    categoryPatterns: categories,
    calculationDefinitions: {
      percentages: "Percentages are computed from the frozen 100-app records and rounded to one decimal place for display.",
      legacy: "Legacy credential_access and production_access remain in the audit data but do not drive headline recommendations.",
      ranking: "Opportunity scores are deterministic triage scores, not probabilities; ties break alphabetically.",
      holdout: "Holdout metrics use the exact saved 30-app comparison_rows and exclude obsolete production_access.",
      schemaRepair: "Schema-repair acceptance is accepted_v2_values divided by repaired_field_count from the same holdout's immutable v1→v2 comparison."
    }
  };
}

function compactEvidence(item) {
  if (!item) return null;
  const statement = item.statement ?? item.supporting_excerpt ?? "";
  return {
    url: item.final_url || item.url,
    originalUrl: item.original_url || item.url,
    sourceType: item.source_type ?? "unknown",
    retrievalMethod: item.retrieval_method ?? "http",
    checkedAt: item.checked_at ?? null,
    httpStatus: item.http_status ?? null,
    statement: String(statement).replace(/\s+/g, " ").trim().slice(0, 420)
  };
}

export function compactApp(record) {
  const claims = (record.claims ?? []).map((claim) => ({
    field: claim.field,
    value: claim.value,
    status: claim.status,
    confidence: claim.confidence,
    reason: claim.reason ?? null,
    evidenceQuality: claim.evidence_quality?.tier ?? "unknown",
    humanApproved: claim.human_adjudication?.status === "approved" || record.final_human_adjudication?.status === "approved",
    evidence: (claim.evidence ?? []).slice(0, 2).map(compactEvidence).filter(Boolean)
  }));
  const claim = (field) => claims.find((item) => item.field === field)?.value ?? "unknown";
  const quality = count(claims.map((item) => item.evidenceQuality));
  return {
    app: record.app,
    category: record.category,
    assignmentHint: record.assignment_hint,
    oneLiner: record.one_liner || claim("description"),
    identity: {
      vendor: record.identity?.vendor ?? null,
      product: record.identity?.product ?? null,
      status: record.identity?.status ?? "unknown",
      hintStatus: record.identity?.hint_status ?? null,
      conflict: Boolean(record.identity_hint_conflict)
    },
    identityEvidence: (record.identity?.evidence ?? record.identity_evidence ?? []).slice(0, 4).map(compactEvidence).filter(Boolean),
    technicalBuildability: claim("technical_buildability"),
    customerCredentialAccess: claim("customer_credential_access"),
    distributedIntegrationAccess: claim("distributed_integration_access"),
    sandboxAccess: claim("sandbox_access"),
    publicApiAvailable: claim("public_api_available"),
    apiBreadth: claim("api_breadth"),
    apiStyles: claim("api_styles"),
    authMethods: claim("auth_methods"),
    primaryAuth: claim("primary_auth"),
    webhooks: claim("webhooks"),
    vendorOfficialMcp: claim("vendor_official_mcp"),
    vendorMcpType: claim("vendor_mcp_type"),
    vendorMcpStage: claim("vendor_mcp_stage"),
    communityMcp: claim("community_mcp"),
    composioToolkitExists: claim("composio_toolkit_exists"),
    composioToolkitMatchType: record.composio_toolkit_match_type ?? null,
    composioToolkitIdentifier: record.composio_toolkit_identifier ?? null,
    commercialFriction: claim("commercial_friction"),
    setupFriction: claim("setup_friction"),
    mainBlocker: claim("main_blocker"),
    confidence: count(claims.map((item) => item.confidence)),
    evidenceQuality: quality,
    unknowns: record.unknowns ?? [],
    humanReviewed: record.final_human_adjudication?.status === "approved",
    claims
  };
}

function evidenceCount(record) {
  const urls = new Set();
  for (const claim of record.claims ?? []) for (const item of claim.evidence ?? []) {
    const url = normalizeUrl(item.final_url || item.url);
    if (url) urls.add(url);
  }
  return { uniqueUrls: urls.size, claimEvidenceRows: (record.claims ?? []).reduce((sum, claim) => sum + (claim.evidence?.length ?? 0), 0) };
}

function hasFirstPartyMcpEvidence(claim) {
  return (claim?.evidence ?? []).some((item) => {
    const sourceType = item.source_type ?? item.sourceType;
    const httpStatus = item.http_status ?? item.httpStatus;
    return FIRST_PARTY_TYPES.has(sourceType) && httpStatus >= 200 && httpStatus < 400;
  });
}

function replayChecks(record) {
  const claims = record.claims ?? [];
  const byField = claimMap(record);
  const errors = [];
  const warnings = [];
  if (new Set(claims.map((claim) => claim.field)).size !== claims.length) errors.push("duplicate claim fields");
  for (const field of FIELDS) if (!byField.has(field)) errors.push(`missing ${field}`);
  if (fieldValue(record, "public_api_available") === "no" && fieldValue(record, "api_breadth") === "broad") errors.push("API absence conflicts with broad breadth");
  if (fieldValue(record, "vendor_official_mcp") === true && !hasFirstPartyMcpEvidence(byField.get("vendor_official_mcp"))) errors.push("official MCP lacks first-party evidence");
  if (fieldValue(record, "vendor_official_mcp") !== true && fieldValue(record, "vendor_mcp_stage") !== "unknown") errors.push("MCP stage asserted without confirmed official MCP");
  if (fieldValue(record, "vendor_official_mcp") === false && fieldValue(record, "vendor_mcp_type") !== "not_applicable") errors.push("MCP type should be not_applicable");
  if (fieldValue(record, "vendor_official_mcp") === "unknown" && !["unknown", "not_applicable"].includes(fieldValue(record, "vendor_mcp_type"))) errors.push("MCP type asserted while ownership is unknown");
  if (["unresolved", "ambiguous"].includes(record.identity?.status) && fieldValue(record, "technical_buildability") === "yes") errors.push("buildability asserted with unresolved identity");
  if (fieldValue(record, "composio_toolkit_exists") === "yes" && fieldValue(record, "technical_buildability") === "no") warnings.push("Composio coverage conflicts with technical_buildability=no");
  if ((record.identity?.hint_status ?? record.identity?.hintStatus) === "conflict" || record.identity_hint_conflict || record.identity?.conflict) warnings.push("assignment identity hint conflict is intentionally unresolved");
  return { errors, warnings };
}

export function replayAudit(record, lock) {
  const checks = replayChecks(record);
  const evidence = evidenceCount(record);
  const identityStatus = record.identity?.status ?? "unknown";
  const humanApproved = record.humanReviewed === true || record.final_human_adjudication?.status === "approved";
  return {
    app: record.app,
    generatedFrom: "frozen final record",
    steps: [
      { id: "identity", label: "Identity resolution", status: identityStatus === "confirmed" ? "pass" : "warn", detail: identityStatus === "confirmed" ? `${record.identity.vendor} / ${record.identity.product}` : "Identity remains unresolved or requires escalation." },
      { id: "evidence", label: "Evidence loaded", status: evidence.uniqueUrls > 0 ? "pass" : "warn", detail: `${evidence.uniqueUrls} unique claim-source URLs; evidence is preserved per field.` },
      { id: "classification", label: "Access + API classification", status: "pass", detail: `${fieldValue(record, "technical_buildability")} technical buildability · ${fieldValue(record, "distributed_integration_access")} distribution` },
      { id: "mcp", label: "MCP + Composio classification", status: "pass", detail: `${String(fieldValue(record, "vendor_official_mcp"))} official MCP · ${fieldValue(record, "vendor_mcp_type")} type · ${fieldValue(record, "composio_toolkit_exists")} Composio toolkit` },
      { id: "validators", label: "Deterministic validators", status: checks.errors.length ? "fail" : checks.warnings.length ? "warn" : "pass", detail: checks.errors.length ? checks.errors.join("; ") : checks.warnings.length ? checks.warnings.join("; ") : "No replayed consistency errors." },
      { id: "human", label: "Human review", status: humanApproved ? "pass" : "warn", detail: humanApproved ? "Included in the approved 30-app holdout." : "No human approval overlay on this record." },
      { id: "frozen", label: "Frozen result", status: lock?.dataset_status === "frozen" ? "pass" : "warn", detail: `${lock?.dataset_id ?? "unknown dataset"} · no mutation performed` }
    ],
    final: {
      technicalBuildability: fieldValue(record, "technical_buildability"),
      customerCredentialAccess: fieldValue(record, "customer_credential_access"),
      distributedIntegrationAccess: fieldValue(record, "distributed_integration_access"),
      publicApiAvailable: fieldValue(record, "public_api_available"),
      vendorOfficialMcp: fieldValue(record, "vendor_official_mcp"),
      vendorMcpType: fieldValue(record, "vendor_mcp_type"),
      composioToolkitExists: fieldValue(record, "composio_toolkit_exists"),
      mainBlocker: fieldValue(record, "main_blocker")
    }
  };
}

export function validatePresentationPayload(payload) {
  const apps = payload?.apps ?? [];
  const errors = [];
  if (payload?.dataset?.appCount !== 100) errors.push("presentation dataset metadata does not declare 100 apps");
  if (apps.length !== 100) errors.push(`presentation payload contains ${apps.length} apps`);
  if (new Set(apps.map((app) => app.app)).size !== apps.length) errors.push("presentation app names are not unique");
  for (const app of apps) {
    if (!app.app || !app.category || !app.identity || !Array.isArray(app.claims)) errors.push(`${app.app ?? "unknown app"} is missing compact record fields`);
  }
  return { ok: errors.length === 0, errors };
}
