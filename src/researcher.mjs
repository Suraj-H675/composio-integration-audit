import { createUnknownClaim, FIELDS } from "./schema.mjs";
import { excerpt, fetchEvidence } from "./fetcher.mjs";
import { fetchBrowserEvidence, shouldUseBrowserFallback } from "./sources/browser.mjs";

const FIRST_PARTY_TYPES = new Set([
  "official_api_docs",
  "official_auth_docs",
  "official_product_docs",
  "official_announcement",
  "official_github"
]);

function patternMatches(text, pattern) {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function matchingSource(sources, patterns = [], requireAll = false) {
  const live = sources.filter((source) => source.status === "live" && source.content_text);
  const matches = live.filter((source) => {
    const text = source.content_text;
    if (requireAll) return patterns.every((pattern) => patternMatches(text, pattern));
    return patterns.length === 0 || patterns.some((pattern) => patternMatches(text, pattern));
  });
  return matches[0] ?? null;
}

function sourcesForRule(sources, rule) {
  const byId = rule.source_ids?.length
    ? sources.filter((source) => rule.source_ids.includes(source.id))
    : sources;
  const selected = rule.source_hosts?.length
    ? byId.filter((source) => {
        try {
          const hostname = new URL(source.final_url || source.url).hostname;
          return rule.source_hosts.some((expected) => hostMatches(hostname, expected));
        } catch {
          return false;
        }
      })
    : byId;
  return selected.length || rule.source_ids?.length || rule.source_hosts?.length ? selected : sources;
}

function evidenceFor(field, rule, source, now, statement) {
  return {
    url: source.final_url || source.url,
    source_type: source.source_type,
    retrieval_method: source.retrieval_method ?? "http",
    checked_at: source.checked_at || now(),
    http_status: source.http_status,
    supports: field,
    statement: `${statement} ${excerpt(source.content_text, rule.match_pattern || rule.support_patterns?.[0] || ".{0,1}")}`.trim()
  };
}

function fallbackEvidence(field, sources, now) {
  const source = sources.find((item) => item.status === "live") ?? sources[0];
  if (!source) return [];
  return [{
    url: source.final_url || source.url,
    source_type: source.source_type,
    retrieval_method: source.retrieval_method ?? "http",
    checked_at: source.checked_at || now(),
    http_status: source.http_status,
    supports: field,
    statement: source.status === "live"
      ? `The source was checked, but no configured support for ${field} was found; this is not evidence of absence.`
      : `The configured source could not be checked (${source.status}); the field remains unknown.`
  }];
}

function confidenceFor(source, identityStatus) {
  if (!source) return "unknown";
  if (identityStatus === "ambiguous" || identityStatus === "unresolved") return "low";
  if (FIRST_PARTY_TYPES.has(source.source_type)) return "high";
  return "medium";
}

function hostMatches(host, expected) {
  return host === expected || host.endsWith(`.${expected}`);
}

function identitySources(identityOption, sources) {
  const explicit = sources.filter((source) => identityOption.source_ids?.includes(source.id));
  const discovered = identityOption.discovery
    ? sources.filter((source) => {
        try {
          return source.roles?.includes("discovered") && identityOption.expected_hosts?.some((expected) => hostMatches(new URL(source.final_url || source.url).hostname, expected));
        } catch {
          return false;
        }
      })
    : [];
  return [...new Map([...explicit, ...discovered].map((source) => [source.id, source])).values()];
}

function assignmentHintStatus(app, identityOption, optionSources) {
  if (["yes", "no", "unknown"].includes(identityOption.matches_assignment_hint)) {
    return identityOption.matches_assignment_hint;
  }
  if (!app.assignment_hint_required) return "not_required";
  if (!identityOption.hint_patterns?.length) return "unknown";
  const text = optionSources.filter((source) => source.status === "live").map((source) => source.content_text).join(" ");
  return identityOption.hint_patterns.every((pattern) => patternMatches(text, pattern)) ? "yes" : "no";
}

export async function collectAppSources(app, { cache, now = () => new Date().toISOString() } = {}) {
  const sources = [];
  for (const definition of app.sources) {
    const httpResult = await fetchEvidence(definition.url, { cache, now });
    let result = httpResult;
    let browserAttempt = null;
    if (definition.browser_fallback && shouldUseBrowserFallback(httpResult)) {
      const browserResult = await fetchBrowserEvidence(definition.url, {
        cache,
        now,
        reason: `HTTP result was ${httpResult.status} with ${httpResult.content_length} extracted characters.`
      });
      browserAttempt = {
        status: browserResult.status,
        retrieval_method: browserResult.retrieval_method,
        checked_at: browserResult.checked_at,
        error: browserResult.error
      };
      if (browserResult.status === "live" && browserResult.content_text) result = browserResult;
    }
    sources.push({
      ...result,
      id: definition.id,
      source_type: definition.source_type,
      expected_hosts: definition.expected_hosts ?? [],
      roles: definition.roles ?? [],
      browser_fallback: definition.browser_fallback ?? false,
      browser_attempt: browserAttempt
    });
  }
  return sources;
}

export function resolveIdentity(app, sources, now = () => new Date().toISOString()) {
  const matches = [];
  const candidates = [];
  for (const identityOption of app.identity_options ?? []) {
    const optionSources = identitySources(identityOption, sources);
    const hintStatus = assignmentHintStatus(app, identityOption, optionSources);
    const candidate = {
      id: identityOption.id,
      vendor: identityOption.vendor,
      product: identityOption.product,
      eligible: identityOption.eligible !== false,
      rejection_reason: identityOption.rejection_reason ?? null,
      matched: false,
      evidence_for: identityOption.evidence_for ?? [],
      evidence_against: identityOption.evidence_against ?? [],
      evidence_source_urls: optionSources.map((source) => source.final_url || source.url),
      matches_assignment_hint: hintStatus,
      hint_conflict: hintStatus === "no"
    };
    if (identityOption.eligible === false && !candidate.rejection_reason) candidate.rejection_reason = "Candidate is retained for audit but is not eligible for automatic acceptance.";
    if (hintStatus === "no") candidate.rejection_reason = candidate.rejection_reason ?? "Candidate matches the product name but conflicts with the assignment hint/context.";
    if (app.assignment_hint_required && hintStatus === "unknown") candidate.rejection_reason = candidate.rejection_reason ?? "Assignment hint could not be verified from the candidate's first-party sources.";
    candidates.push(candidate);
    if (identityOption.eligible === false || hintStatus === "no" || (app.assignment_hint_required && hintStatus === "unknown")) continue;
    const liveText = optionSources.filter((source) => source.status === "live").map((source) => source.content_text).join(" ");
    if (optionSources.some((source) => source.status === "live") && (identityOption.patterns ?? []).every((pattern) => patternMatches(liveText, pattern))) {
      candidate.matched = true;
      matches.push({ identityOption, sources: optionSources.filter((source) => source.status === "live") });
    }
  }

  if (matches.length === 1) {
    const match = matches[0];
    return {
      vendor: match.identityOption.vendor,
      product: match.identityOption.product,
      canonical_url: match.identityOption.canonical_url,
      expected_hosts: match.identityOption.expected_hosts,
      status: match.identityOption.status ?? "confirmed",
      rationale: match.identityOption.rationale,
      hint_status: "matched",
      options: [match.identityOption.id],
      candidates,
      evidence: match.sources.map((source) => ({
        url: source.final_url || source.url,
        source_type: source.source_type,
        retrieval_method: source.retrieval_method ?? "http",
        checked_at: source.checked_at || now(),
        http_status: source.http_status,
        supports: "identity",
        statement: `The first-party source identifies ${match.identityOption.product}. ${excerpt(source.content_text, match.identityOption.patterns[0])}`
      }))
    };
  }

  if (matches.length > 1) {
    return {
      vendor: "Multiple possible vendors",
      product: "Unresolved product identity",
      canonical_url: null,
      expected_hosts: [...new Set(matches.flatMap((match) => match.identityOption.expected_hosts))],
      status: "ambiguous",
      rationale: `Multiple first-party product options matched: ${matches.map((match) => match.identityOption.product).join(", ")}.`,
      hint_status: "matched",
      options: matches.map((match) => match.identityOption.id),
      candidates,
      evidence: matches.flatMap((match) => match.sources.map((source) => ({
        url: source.final_url || source.url,
        source_type: source.source_type,
        retrieval_method: source.retrieval_method ?? "http",
        checked_at: source.checked_at || now(),
        http_status: source.http_status,
        supports: "identity",
        statement: `Product identity evidence for ${match.identityOption.product}: ${excerpt(source.content_text, match.identityOption.patterns[0])}`
      })))
    };
  }

  return {
    vendor: null,
    product: null,
    canonical_url: null,
    expected_hosts: [],
    status: "unresolved",
    rationale: candidates.some((candidate) => candidate.hint_conflict)
      ? "No candidate both matched the product evidence and reconciled with the assignment hint/context."
      : "No configured first-party source provided enough identity evidence.",
    hint_status: candidates.some((candidate) => candidate.hint_conflict) ? "conflict" : "unknown",
    options: [],
    candidates,
    evidence: sources.slice(0, 2).map((source) => ({
      url: source.final_url || source.url,
      source_type: source.source_type,
      retrieval_method: source.retrieval_method ?? "http",
      checked_at: source.checked_at || now(),
      http_status: source.http_status,
      supports: "identity",
      statement: `Identity check result: ${source.status}. No product match was accepted.`
    }))
  };
}

function unknownForRule(field, ruleSources, now, reason) {
  const claim = createUnknownClaim(field, fallbackEvidence(field, ruleSources, now), reason);
  return { ...claim, status: "unknown", confidence: ruleSources.some((source) => source.status === "live") ? "low" : "unknown" };
}

export function classifyApp(app, sources, now = () => new Date().toISOString()) {
  const identity = resolveIdentity(app, sources, now);
  const rules = new Map((app.research_rules ?? []).map((rule) => [rule.field, rule]));
  const claims = [];

  for (const field of FIELDS) {
    const rule = rules.get(field);
    const ruleSources = rule ? sourcesForRule(sources, rule) : sources;
    if (!rule) {
      claims.push(createUnknownClaim(field, fallbackEvidence(field, ruleSources, now), "No configured evidence rule; the field remains unknown."));
      continue;
    }
    if (rule.requires_confirmed_identity && identity.status !== "confirmed" && identity.status !== "probable") {
      claims.push(unknownForRule(field, ruleSources, now, `Identity is ${identity.status}; API and access claims are intentionally withheld.`));
      continue;
    }

    const source = matchingSource(ruleSources, rule.support_patterns, false);
    const allPatternsMatch = !rule.require_patterns?.length || matchingSource(ruleSources, rule.require_patterns, true);
    if (!source || !allPatternsMatch) {
      claims.push(unknownForRule(field, ruleSources, now, `No live source matched the configured support rule for ${field}.`));
      continue;
    }

    const statement = rule.statement ?? `Current first-party evidence supports ${field}.`;
    const unknownValue = rule.value === "unknown" || (Array.isArray(rule.value) && rule.value.includes("unknown"));
    claims.push({
      field,
      value: rule.value,
      status: unknownValue ? "unknown" : "supported",
      confidence: confidenceFor(source, identity.status),
      evidence: [evidenceFor(field, rule, source, now, statement)],
      reason: unknownValue
        ? "The current source was checked but did not establish a more specific value."
        : "Accepted only after a live configured source matched the support rule."
    });
  }

  return {
    app: app.app,
    category: app.category,
    group: app.group,
    identity,
    identity_evidence: identity.evidence,
    claims,
    researcher: {
      id: "deterministic-source-rules-v1",
      completed_at: now(),
      source_count: sources.length,
      live_source_count: sources.filter((source) => source.status === "live").length
    }
  };
}
