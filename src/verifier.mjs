import { excerpt } from "./fetcher.mjs";

function matchesAny(text, patterns = []) {
  return patterns.find((pattern) => new RegExp(pattern, "i").test(text));
}

function inferredContradictionValue(field, text, rule) {
  if (rule.contradiction_value) return rule.contradiction_value;
  if (["production_access", "credential_access"].includes(field) && /sales|approval|partner|contact/.test(text.toLowerCase())) return "approval_required";
  if (field === "public_api_available" && /no public api|does not offer an api/.test(text.toLowerCase())) return "no";
  if (field === "webhooks" && /no webhook|webhooks? (?:are )?not/.test(text.toLowerCase())) return "no";
  return "unknown";
}

function makeEvidence(source, field, pattern, statementPrefix) {
  return {
    url: source.final_url || source.url,
    original_url: source.url,
    source_type: source.source_type,
    retrieval_method: source.retrieval_method ?? "http",
    checked_at: source.checked_at,
    http_status: source.http_status,
    supports: field,
    statement: `${statementPrefix} ${excerpt(source.content_text, pattern)}`
  };
}

function verdictMetadata(claim, observedValue, liveSources, researcherSourceUrls, independentSourceFound) {
  const overlap = liveSources.some((source) => researcherSourceUrls.has(source.final_url || source.url));
  return {
    verifier_value: observedValue,
    researcher_value: claim?.value ?? "unknown",
    source_overlap: overlap,
    independent_source_found: independentSourceFound ?? liveSources.some((source) => !(researcherSourceUrls.has(source.final_url || source.url)))
  };
}

export function verifyClaim({ app, identity = null, rubric, claim, sources, rule = {}, researcherSourceUrls = [], independentSourceFound = null }) {
  const liveSources = sources.filter((source) => source.status === "live" && source.content_text);
  const text = liveSources.map((source) => source.content_text).join(" ");
  const contradictionPattern = matchesAny(text, rule.contradiction_patterns);
  const supportPattern = matchesAny(text, rule.support_patterns);
  const partialPattern = matchesAny(text, rule.partial_patterns);
  const evidence = [];
  const researcherSources = new Set(researcherSourceUrls);

  if (contradictionPattern) {
    const source = liveSources.find((item) => new RegExp(contradictionPattern, "i").test(item.content_text));
    const observedValue = inferredContradictionValue(claim.field, text, rule);
    evidence.push(makeEvidence(source, claim.field, contradictionPattern, "Independent verifier found a contradiction:"));
    return {
      app,
      identity,
      field: rubric.field ?? claim.field,
      status: "disagree",
      observed_value: observedValue,
      evidence,
      checked_source_ids: liveSources.map((sourceItem) => sourceItem.id),
      rationale: "A verifier source matched a contradiction pattern.",
      ...verdictMetadata(claim, observedValue, liveSources, researcherSources, independentSourceFound)
    };
  }

  if (supportPattern) {
    const source = liveSources.find((item) => new RegExp(supportPattern, "i").test(item.content_text));
    evidence.push(makeEvidence(source, claim.field, supportPattern, "Independent verifier found supporting evidence:"));
    const claimIsUnknown = claim.value === "unknown" || (Array.isArray(claim.value) && claim.value.includes("unknown"));
    return {
      app,
      identity,
      field: rubric.field ?? claim.field,
      status: claimIsUnknown ? "correction" : "agree",
      observed_value: rule.supported_value ?? claim.value,
      evidence,
      checked_source_ids: liveSources.map((sourceItem) => sourceItem.id),
      rationale: claimIsUnknown
        ? "The verifier found a possible value for an unknown field; adjudication is required before acceptance."
        : "A verifier source supported the proposed value.",
      ...verdictMetadata(claim, rule.supported_value ?? claim.value, liveSources, researcherSources, independentSourceFound)
    };
  }

  if (partialPattern) {
    const source = liveSources.find((item) => new RegExp(partialPattern, "i").test(item.content_text));
    const observedValue = rule.partial_value ?? "unknown";
    return {
      app,
      identity,
      field: rubric.field ?? claim.field,
      status: "partial",
      observed_value: observedValue,
      evidence: [makeEvidence(source, claim.field, partialPattern, "Independent verifier found partial support:")],
      checked_source_ids: liveSources.map((sourceItem) => sourceItem.id),
      rationale: "The verifier found evidence that supports only part of the proposed classification.",
      ...verdictMetadata(claim, observedValue, liveSources, researcherSources, independentSourceFound)
    };
  }

  return {
    app,
    identity,
    field: rubric.field ?? claim.field,
    status: "unverifiable",
    observed_value: "unknown",
    evidence: liveSources.slice(0, 1).map((source) => makeEvidence(source, claim.field, ".{0,1}", "Verifier checked the source but found no configured support or contradiction:")),
    checked_source_ids: liveSources.map((sourceItem) => sourceItem.id),
    rationale: "No independent support or contradiction was found; this is not agreement.",
    ...verdictMetadata(claim, "unknown", liveSources, researcherSources, independentSourceFound)
  };
}
