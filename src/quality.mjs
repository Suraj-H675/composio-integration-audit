const FIRST_PARTY = new Set(["official_api_docs", "official_auth_docs", "official_product_docs", "official_announcement", "official_github", "composio_catalog"]);

function dimension(value, reason) {
  return { tier: value, reason };
}

function freshness(checkedAt, asOf) {
  const age = (new Date(asOf).getTime() - new Date(checkedAt).getTime()) / 86400000;
  if (!Number.isFinite(age) || age < 0) return dimension("low", "timestamp is invalid or later than the run");
  if (age <= 30) return dimension("high", "checked within 30 days");
  if (age <= 180) return dimension("medium", "checked within 180 days");
  return dimension("low", "evidence is older than 180 days");
}

export function scoreClaim(claim, { identityStatus = "unresolved", verifier = null, asOf = new Date().toISOString() } = {}) {
  const evidence = claim.evidence ?? [];
  const first = evidence[0];
  const direct = claim.status === "supported" || claim.status === "partially_supported";
  const directness = direct && !String(first?.statement ?? "").includes("no configured support")
    ? dimension("high", "claim matched a configured support rule")
    : dimension("low", "claim is unknown or only has fallback evidence");
  const source = FIRST_PARTY.has(first?.source_type) ? dimension("high", "first-party or catalog source") : first?.source_type === "secondary_source" ? dimension("medium", "secondary source") : dimension("low", "source is not an accepted first-party source");
  const reachability = first?.http_status >= 200 && first?.http_status < 400
    ? dimension("high", "source returned a live response")
    : dimension("low", "source was blocked, inaccessible, or missing a live response");
  const identity = ["confirmed"].includes(identityStatus)
    ? dimension("high", "identity confirmed")
    : identityStatus === "probable" ? dimension("medium", "identity probable") : dimension("low", "identity ambiguous or unresolved");
  const independence = verifier?.independent_source_found && !verifier.source_overlap
    ? dimension("high", "independently corroborated from a disjoint source")
    : verifier?.status === "agree"
      ? dimension("medium", "verifier agreed but source overlap exists")
      : dimension("low", "no independent corroboration recorded");
  const dimensions = { source, directness, freshness: freshness(first?.checked_at, asOf), identity, independence, reachability };
  const lowCount = Object.values(dimensions).filter((item) => item.tier === "low").length;
  const highCount = Object.values(dimensions).filter((item) => item.tier === "high").length;
  const tier = lowCount >= 2 || claim.status === "unknown" ? "low" : highCount >= 4 && lowCount === 0 ? "high" : "medium";
  return {
    tier,
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, value.tier])),
    rationale: Object.values(dimensions).map((item) => item.reason)
  };
}
