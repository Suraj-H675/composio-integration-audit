import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEvidenceCache } from "./cache.mjs";
import { collectAppSources, classifyApp } from "./researcher.mjs";
import { rankRecords } from "./priority.mjs";
import { collectComposioCoverage } from "./sources/composio.mjs";
import { discoverFirstPartySources } from "./sources/discovery.mjs";
import { scoreClaim } from "./quality.mjs";
import { claimMap, ENUMS } from "./schema.mjs";
import { validateRecord } from "./validate.mjs";
import { verifyClaim } from "./verifier.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(ROOT, "config", "calibration_manifest.json");
const outputDirectory = path.join(ROOT, "data", "calibration");
const HUMAN_REVIEW_APPS = ["Salesforce", "GitHub", "Stripe", "Notion", "Vercel", "iPayX", "Otter AI", "Paygent Connect"];

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function publicSource(source) {
  return {
    id: source.id,
    url: source.url,
    final_url: source.final_url,
    source_type: source.source_type,
    roles: source.roles,
    checked_at: source.checked_at,
    http_status: source.http_status,
    status: source.status,
    retrieval_method: source.retrieval_method ?? "http",
    title: source.title,
    content_length: source.content_length,
    cache_hit: source.cache_hit,
    discovery_kind: source.discovery_kind,
    discovery_score: source.discovery_score,
    discovered_from: source.discovered_from,
    browser_fallback: source.browser_fallback,
    browser_attempt: source.browser_attempt,
    error: source.error
  };
}

function makeAdjudication(record, verifications, asOf) {
  const byField = new Map(verifications.map((item) => [item.field, item]));
  const claims = record.claims.map((claim) => {
    const verification = byField.get(claim.field);
    const quality = scoreClaim(claim, {
      identityStatus: record.identity.status,
      verifier: verification,
      asOf
    });
    if (!verification) return { ...claim, verification_status: "not_challenged", evidence_quality: quality };
    return {
      ...claim,
      verification_status: verification.status === "agree" ? "agreed" : verification.status,
      verification_evidence: verification.evidence,
      evidence_quality: quality,
      reason: `${claim.reason} ${verification.rationale}`
    };
  });
  const identityEscalation = ["ambiguous", "unresolved"].includes(record.identity.status)
    ? [{
        field: "identity",
        status: record.identity.status,
        observed_value: record.identity.product,
        rationale: record.identity.rationale,
        evidence: record.identity.evidence
      }]
    : [];
  const verifierEscalations = verifications.filter((item) => ["disagree", "correction", "partial"].includes(item.status)).map((item) => ({
    field: item.field,
    status: item.status,
    observed_value: item.observed_value,
    rationale: item.rationale,
    evidence: item.evidence
  }));
  const escalations = [...identityEscalation, ...verifierEscalations];
  return {
    ...record,
    claims,
    adjudication: {
      disposition: escalations.length ? "human_review_required" : "accepted_with_verification_limits",
      unresolved_fields: escalations.map((item) => item.field),
      rationale: escalations.length
        ? "Identity ambiguity or verifier contradictions remain; no automatic overwrite was performed."
        : "No verifier contradiction was found. Unable-to-verify fields remain explicitly unresolved.",
      escalations
    }
  };
}

const VERIFIER_DEFINITIONS = {
  identity: "The proposed vendor and product must be the assignment app, not an adjacent same-name product.",
  description: "A neutral one-line description of the identified product, supported by a current first-party source.",
  auth_methods: "Authentication mechanisms documented for the API or integration surface, not dashboard login methods.",
  primary_auth: "The normal API or integration authentication path.",
  credential_access: "The general documented credential path, separate from test/live access and friction.",
  sandbox_access: "Whether test or development credentials can be obtained and used.",
  production_access: "Whether live production credentials can be obtained and used; test accounts do not qualify.",
  public_api_available: "Whether a public developer API is documented, including limited surfaces.",
  api_styles: "The documented API or programmatic transport styles.",
  api_breadth: "The breadth of documented operations, from broad resources to one action or local CLI.",
  webhooks: "Whether the product documents webhook/event delivery and in which direction when known.",
  vendor_official_mcp: "An MCP server published or maintained by the vendor or its official organization; lifecycle stage is a separate field.",
  vendor_mcp_stage: "The explicitly documented lifecycle label for an official MCP server; unknown is valid when ownership is clear but stage is not labeled.",
  community_mcp: "An MCP implementation from a community source, separate from vendor MCP.",
  composio_toolkit_exists: "Whether the current Composio native catalog contains an exact or configured strong-alias toolkit.",
  technical_buildability: "Whether a useful agent toolkit can technically use the documented API, SDK, local tool, or MCP today; commercial and setup friction do not downgrade this field.",
  commercial_friction: "Pricing, plan, quota, or free-tier restrictions that affect use but not technical implementability.",
  setup_friction: "OAuth, administrator, review, underwriting, or other configuration needed to connect.",
  main_blocker: "The primary evidence-backed blocker, if any, using the separate technical/access/commercial/setup categories."
};

const ENUM_BY_FIELD = {
  auth_methods: "auth_method",
  primary_auth: "auth_method",
  credential_access: "credential_access",
  sandbox_access: "access_status",
  production_access: "access_status",
  public_api_available: "public_api_available",
  api_styles: "api_style",
  api_breadth: "api_breadth",
  webhooks: "webhooks",
  vendor_official_mcp: "vendor_official_mcp",
  vendor_mcp_stage: "vendor_mcp_stage",
  community_mcp: "community_mcp",
  composio_toolkit_exists: "composio_toolkit_exists",
  technical_buildability: "technical_buildability",
  commercial_friction: "commercial_friction",
  setup_friction: "setup_friction",
  main_blocker: "main_blocker"
};

function verifierRubric(field) {
  const enumName = ENUM_BY_FIELD[field];
  return {
    field,
    definition: VERIFIER_DEFINITIONS[field] ?? "Challenge the proposed field value against current first-party evidence.",
    allowed_values: enumName ? ENUMS[enumName] : undefined
  };
}

function summarizeMetrics({ manifest, sourceRows, researcherRows, validationRows, verifierRows, finalRows, startedAt, finishedAt }) {
  const verificationCounts = verifierRows.flatMap((row) => row.verifications).reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const claimCounts = researcherRows.flatMap((row) => row.record.claims).reduce((counts, claim) => {
    counts[claim.status] = (counts[claim.status] ?? 0) + 1;
    return counts;
  }, {});
  const comparable = (verificationCounts.agree ?? 0) + (verificationCounts.disagree ?? 0) + (verificationCounts.partial ?? 0) + (verificationCounts.correction ?? 0);
  const agreementRate = comparable ? (verificationCounts.agree ?? 0) / comparable : null;
  const escalations = finalRows.flatMap((row) => row.adjudication.escalations.map((item) => ({
    app: row.app,
    field: item.field,
    status: item.status,
    rationale: item.rationale
  })));
  const liveSources = sourceRows.flatMap((row) => row.sources).filter((source) => source.status === "live").length;
  const verifierItems = verifierRows.flatMap((row) => row.verifications);
  const overlapCount = verifierItems.filter((item) => item.source_overlap).length;
  const disjointCount = verifierItems.filter((item) => item.independent_source_found && !item.source_overlap).length;
  const independentOpportunityCount = verifierItems.filter((item) => item.independent_source_found).length;
  const disjointOpportunityRate = independentOpportunityCount ? disjointCount / independentOpportunityCount : null;
  const qualityCounts = finalRows.flatMap((row) => row.claims).reduce((counts, claim) => {
    const tier = claim.evidence_quality?.tier ?? "low";
    counts[tier] = (counts[tier] ?? 0) + 1;
    return counts;
  }, {});
  return {
    calibration_only: true,
    apps: manifest.apps.map((app) => app.app),
    app_count: manifest.apps.length,
    source_count: sourceRows.reduce((sum, row) => sum + row.sources.length, 0),
    live_source_count: liveSources,
    claim_count: researcherRows.reduce((sum, row) => sum + row.record.claims.length, 0),
    claim_status_counts: claimCounts,
    validation_error_count: validationRows.reduce((sum, row) => sum + row.errors.length, 0),
    validation_warning_count: validationRows.reduce((sum, row) => sum + row.warnings.length, 0),
    verifier_challenge_count: verifierRows.reduce((sum, row) => sum + row.verifications.length, 0),
    verifier_status_counts: verificationCounts,
    verifier_observed_agreement: {
      numerator: verificationCounts.agree ?? 0,
      denominator: comparable,
      rate: agreementRate,
      excludes_unverifiable: true,
      includes_corrections_as_non_agreement: true
    },
    verifier_independence: {
      challenges_with_source_overlap: overlapCount,
      challenges_without_source_overlap: disjointCount,
      source_disjoint_rate: verifierItems.length ? disjointCount / verifierItems.length : null,
      independent_source_opportunities: independentOpportunityCount,
      source_disjoint_rate_when_available: disjointOpportunityRate,
      required_rate_when_available: manifest.verification_policy?.minimum_source_disjoint_rate ?? 0.7,
      target_met: disjointOpportunityRate === null || disjointOpportunityRate >= (manifest.verification_policy?.minimum_source_disjoint_rate ?? 0.7),
      baseline_calibration: {
        challenges: 29,
        source_disjoint_challenges: 11,
        source_disjoint_rate: 11 / 29
      },
      note: "The verifier receives only the proposed value and a disjoint first-party source when one is available. If no alternate source exists, it falls back transparently and marks overlap; agreement is not ground-truth accuracy."
    },
    evidence_quality_distribution: qualityCounts,
    remaining_unresolved_claims: finalRows.flatMap((row) => row.claims
      .filter((claim) => claim.status === "unknown" || ["disagree", "correction", "partial"].includes(claim.verification_status))
      .map((claim) => ({ app: row.app, field: claim.field, status: claim.status, verification_status: claim.verification_status }))),
    human_review_count: escalations.length,
    human_review_fields: escalations,
    accuracy: {
      status: "not_measured",
      reason: "The ground-truth protocol is pre-registered, but human labels have not been collected and locked yet. Verifier agreement is reported separately and is not accuracy."
    },
    runtime_seconds: (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    started_at: startedAt,
    finished_at: finishedAt,
    external_api_keys_used: process.env.COMPOSIO_API_KEY ? ["COMPOSIO_API_KEY"] : [],
    paid_services_used: []
  };
}

function packetEvidence(items = []) {
  return items.slice(0, 2).map((item) => ({
    url: item.url,
    source_type: item.source_type,
    retrieval_method: item.retrieval_method ?? "http",
    checked_at: item.checked_at,
    statement: String(item.statement ?? "").slice(0, 360)
  }));
}

function packetVerifier(verification) {
  if (!verification) return { status: "not_challenged" };
  return {
    status: verification.status,
    verifier_value: verification.verifier_value ?? verification.observed_value,
    researcher_value: verification.researcher_value,
    independent_source_found: verification.independent_source_found,
    source_overlap: verification.source_overlap,
    rationale: verification.rationale,
    evidence: packetEvidence(verification.evidence)
  };
}

function makeHumanReviewPacket(finalRows, verifierRows, generatedAt) {
  const finalByApp = new Map(finalRows.map((record) => [record.app, record]));
  const verifierByApp = new Map(verifierRows.map((row) => [row.app, new Map(row.verifications.map((item) => [item.field, item]))]));
  const fields = ["auth_methods", "primary_auth", "production_access", "public_api_available", "api_breadth", "vendor_official_mcp", "vendor_mcp_stage", "technical_buildability", "main_blocker"];
  const apps = HUMAN_REVIEW_APPS.map((app) => {
    const record = finalByApp.get(app);
    const claims = claimMap(record);
    const verifications = verifierByApp.get(app) ?? new Map();
    const claimPackets = fields.map((field) => {
      const claim = claims.get(field);
      return {
        field,
        proposed_value: claim?.value ?? "unknown",
        status: claim?.status ?? "unknown",
        confidence: claim?.confidence ?? "unknown",
        best_first_party_evidence: packetEvidence((claim?.evidence ?? []).filter((item) => item.source_type?.startsWith("official_"))),
        verifier: packetVerifier(verifications.get(field)),
        contradiction: verifications.get(field) && ["disagree", "partial", "correction"].includes(verifications.get(field).status)
          ? packetVerifier(verifications.get(field))
          : null
      };
    });
    const identityVerification = verifications.get("identity");
    return {
      app,
      identity: {
        proposed_value: {
          vendor: record.identity.vendor,
          product: record.identity.product,
          status: record.identity.status,
          canonical_url: record.identity.canonical_url,
          hint_status: record.identity.hint_status
        },
        best_first_party_evidence: packetEvidence(record.identity_evidence),
        candidates: (record.identity.candidates ?? []).map((candidate) => ({
          id: candidate.id,
          vendor: candidate.vendor,
          product: candidate.product,
          matched: candidate.matched,
          matches_assignment_hint: candidate.matches_assignment_hint,
          hint_conflict: candidate.hint_conflict,
          evidence_for: candidate.evidence_for,
          evidence_against: candidate.evidence_against,
          evidence_source_urls: candidate.evidence_source_urls,
          rejection_reason: candidate.rejection_reason
        })),
        verifier: packetVerifier(identityVerification),
        contradiction: identityVerification && ["disagree", "partial", "correction"].includes(identityVerification.status) ? packetVerifier(identityVerification) : null
      },
      claims: claimPackets
    };
  });
  return {
    version: 1,
    generated_at: generatedAt,
    review_status: "pending_human_review",
    reviewed_by: null,
    reviewed_at: null,
    ground_truth: null,
    instructions: "This packet is an unreviewed proposal. A human adjudicator must independently review each proposed value against the cited first-party evidence and record decisions outside this generated run before accuracy is measured.",
    apps
  };
}

function renderHumanReviewMarkdown(packet) {
  const lines = [
    "# Calibration human review packet",
    "",
    `Status: **${packet.review_status}**. This is a proposal, not ground truth.`,
    "",
    "Review each proposed value against the linked first-party evidence. Record human decisions and corrections separately; do not edit this generated file as if it were an automated verdict.",
    ""
  ];
  for (const item of packet.apps) {
    lines.push(`## ${item.app}`, "", `Identity: **${item.identity.proposed_value.status}** — ${item.identity.proposed_value.vendor ?? "unresolved"} / ${item.identity.proposed_value.product ?? "unresolved"}`);
    if (item.identity.proposed_value.hint_status) lines.push(`Assignment-hint status: **${item.identity.proposed_value.hint_status}**`);
    for (const evidence of item.identity.best_first_party_evidence) lines.push(`- [identity evidence](${evidence.url}) — ${evidence.statement}`);
    for (const candidate of item.identity.candidates.filter((candidate) => candidate.evidence_for?.length || candidate.evidence_against?.length)) {
      lines.push(`- Candidate ${candidate.product}: hint=${candidate.matches_assignment_hint}; ${candidate.rejection_reason ?? "no automatic rejection"}`);
      for (const note of candidate.evidence_for ?? []) lines.push(`  - for: ${note}`);
      for (const note of candidate.evidence_against ?? []) lines.push(`  - against: ${note}`);
      for (const url of candidate.evidence_source_urls ?? []) lines.push(`  - [candidate source](${url})`);
    }
    lines.push(`- Verifier: **${item.identity.verifier.status}**${item.identity.verifier.rationale ? ` — ${item.identity.verifier.rationale}` : ""}`, "", "| Claim | Proposed value | Verifier | Evidence |", "|---|---|---|---|");
    for (const claim of item.claims) {
      const evidence = claim.best_first_party_evidence.map((item) => `[source](${item.url}) ${item.statement}`).join("<br>") || "No direct first-party support; review the fallback evidence in the JSON packet.";
      const verifier = `${claim.verifier.status}${claim.verifier.verifier_value === undefined ? "" : ` (${JSON.stringify(claim.verifier.verifier_value)})`}`;
      lines.push(`| ${claim.field} | ${JSON.stringify(claim.proposed_value)} | ${verifier} | ${evidence} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function applyComposioClaim(record, coverage) {
  return {
    ...record,
    claims: record.claims.map((claim) => claim.field === "composio_toolkit_exists"
      ? {
          ...claim,
          value: coverage.value,
          status: coverage.value === "unknown" ? "unknown" : "supported",
          confidence: coverage.confidence,
          evidence: coverage.evidence,
          reason: coverage.reason
        }
      : claim)
  };
}

function selectVerifierSources(record, sources, rule) {
  const byId = rule.source_ids?.length
    ? sources.filter((source) => rule.source_ids.includes(source.id))
    : sources.filter((source) => source.roles?.includes("verify"));
  const configured = rule.source_hosts?.length
    ? byId.filter((source) => {
        try {
          const hostname = new URL(source.final_url || source.url).hostname;
          return rule.source_hosts.some((expected) => hostname === expected || hostname.endsWith(`.${expected}`));
        } catch {
          return false;
        }
      })
    : byId;
  const claim = rule.field === "identity"
    ? { evidence: record.identity_evidence ?? [] }
    : record.claims.find((item) => item.field === rule.field);
  const researcherUrls = new Set((claim?.evidence ?? []).map((item) => item.url));
  const disjoint = configured.filter((source) => !researcherUrls.has(source.final_url || source.url));
  return {
    sources: disjoint.length ? disjoint : configured,
    researcherUrls,
    independentSourceFound: disjoint.length > 0
  };
}

function makeCorrectionLog(manifest, verifierRows, generatedAt) {
  const verifierCorrections = verifierRows.flatMap((row) => row.verifications
    .filter((item) => ["disagree", "correction"].includes(item.status))
    .map((item) => ({
      app: row.app,
      field: item.field,
      kind: "verifier_escalation",
      status: item.status,
      observed_value: item.observed_value,
      rationale: item.rationale,
      evidence: item.evidence
    })));
  return {
    generated_at: generatedAt,
    automatic_claim_corrections_applied: false,
    field_corrections: [...(manifest.correction_log ?? []), ...verifierCorrections],
    note: "No claim was silently overwritten. Verifier disagreements and unresolved decisions remain visible in verifier_pass.json and adjudication.json."
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const manifest = await readJson(manifestPath);
  if (!manifest.calibration_only || manifest.apps.length !== 10) {
    throw new Error("Calibration manifest must contain exactly ten apps");
  }
  await mkdir(outputDirectory, { recursive: true });
  const cache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "evidence-vfinal") });
  const composioCache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "composio-vfinal") });

  const collected = await mapLimit(manifest.apps, 3, async (app) => {
    const sources = await collectAppSources(app, { cache });
    const discovery = app.discovery
      ? await discoverFirstPartySources({
          seedUrls: app.discovery.seed_source_ids.map((id) => sources.find((source) => source.id === id)?.final_url || sources.find((source) => source.id === id)?.url).filter(Boolean),
          allowedHosts: app.discovery.allowed_hosts,
          keywords: app.discovery.keywords,
          maxSources: app.discovery.max_sources,
          pageCache: createEvidenceCache({ directory: path.join(ROOT, ".cache", "discovery", "pages") }),
          sourceCache: createEvidenceCache({ directory: path.join(ROOT, ".cache", "discovery", "sources-vfinal") }),
          fetchImpl: cache.fetchImpl
        })
      : { pages: [], links: [], sources: [] };
    return { app: app.app, sources: [...sources, ...discovery.sources], discovery };
  });
  const composioResult = await collectComposioCoverage(manifest.apps, { cache: composioCache });
  await writeJson(path.join(outputDirectory, "composio_catalog.json"), {
    endpoint: composioResult.catalog.endpoint,
    checked_at: composioResult.catalog.checked_at,
    http_status: composioResult.catalog.http_status,
    pages: composioResult.catalog.pages,
    cache_hits: composioResult.catalog.cache_hits,
    total_items: composioResult.catalog.total_items,
    error: composioResult.catalog.error ?? null,
    coverage: composioResult.coverage.map((item) => ({
      app: item.app,
      value: item.value,
      match_status: item.match_status,
      confidence: item.confidence,
      matched_toolkits: item.matched_toolkits,
      near_matches: item.near_matches,
      evidence: item.evidence,
      reason: item.reason
    }))
  });
  await writeJson(path.join(outputDirectory, "evidence_ledger.json"), {
    generated_at: new Date().toISOString(),
    sources: collected.map((row) => ({ app: row.app, sources: row.sources.map(publicSource) }))
  });
  await writeJson(path.join(outputDirectory, "discovery.json"), collected.map((row) => ({
    app: row.app,
    pages: row.discovery.pages.map((page) => ({
      url: page.url,
      final_url: page.final_url,
      checked_at: page.checked_at,
      http_status: page.http_status,
      status: page.status,
      cache_hit: page.cache_hit,
      error: page.error
    })),
    links: row.discovery.links
  })));

  const researcherRows = collected.map((row, index) => {
    const app = manifest.apps[index];
    const composio = composioResult.coverage[index];
    const researchApp = { ...app, assignment_hint_required: app.assignment_hint_required ?? manifest.assignment_hint_required };
    const record = applyComposioClaim(classifyApp(researchApp, row.sources), composio);
    const validation = validateRecord(record, {
      requireAll: true,
      expectedHosts: record.identity.expected_hosts
    });
    return { app, record, validation };
  });
  await writeJson(path.join(outputDirectory, "researcher_pass.json"), researcherRows.map((row) => ({
    app: row.record.app,
    record: row.record
  })));
  await writeJson(path.join(outputDirectory, "validation.json"), researcherRows.map((row) => ({
    app: row.record.app,
    errors: row.validation.errors,
    warnings: row.validation.warnings
  })));
  await writeJson(path.join(outputDirectory, "priority_queue.json"), rankRecords(researcherRows));

  const verifierRows = researcherRows.map(({ app, record }) => {
    const sources = collected.find((row) => row.app === app.app).sources;
    const claims = claimMap(record);
    const verifications = (app.verification_rules ?? []).map((rule) => {
      const claim = claims.get(rule.field) ?? (rule.field === "identity"
        ? { field: "identity", value: record.identity.product ?? record.identity.status }
        : null);
      if (!claim) throw new Error(`Verification rule has no claim: ${app.app}/${rule.field}`);
      const selection = selectVerifierSources(record, sources, rule);
      const rubric = verifierRubric(rule.field);
      const verification = verifyClaim({
        app: app.app,
        identity: {
          vendor: record.identity.vendor,
          product: record.identity.product,
          canonical_url: record.identity.canonical_url,
          status: record.identity.status
        },
        rubric,
        claim: { field: claim.field, value: claim.value },
        sources: selection.sources,
        rule,
        researcherSourceUrls: selection.researcherUrls,
        independentSourceFound: selection.independentSourceFound
      });
      return {
        ...verification,
        rubric,
        researcher_source_urls: [...selection.researcherUrls],
        source_overlap_ids: selection.sources.filter((source) => selection.researcherUrls.has(source.final_url || source.url)).map((source) => source.id)
      };
    });
    return { app: app.app, verifications };
  });
  await writeJson(path.join(outputDirectory, "verifier_pass.json"), verifierRows);

  const finalRows = researcherRows.map(({ record }, index) => makeAdjudication(record, verifierRows[index].verifications, new Date().toISOString()));
  await writeJson(path.join(outputDirectory, "adjudication.json"), finalRows);
  const humanPacket = makeHumanReviewPacket(finalRows, verifierRows, new Date().toISOString());
  await writeJson(path.join(outputDirectory, "human_review_packet.json"), humanPacket);
  await writeFile(path.join(outputDirectory, "human_review_packet.md"), renderHumanReviewMarkdown(humanPacket));

  const finishedAt = new Date().toISOString();
  await writeJson(path.join(outputDirectory, "corrections.json"), makeCorrectionLog(manifest, verifierRows, finishedAt));
  const metrics = summarizeMetrics({
    manifest,
    sourceRows: collected.map((row) => ({ app: row.app, sources: row.sources.map(publicSource) })),
    researcherRows,
    validationRows: researcherRows.map((row) => row.validation),
    verifierRows,
    finalRows,
    startedAt,
    finishedAt
  });
  if (!metrics.verifier_independence.target_met) {
    throw new Error(`Source-disjoint verification target was not met: ${metrics.verifier_independence.source_disjoint_rate_when_available}`);
  }
  await writeJson(path.join(outputDirectory, "metrics.json"), metrics);

  console.log(JSON.stringify({
    app_count: metrics.app_count,
    source_count: metrics.source_count,
    live_source_count: metrics.live_source_count,
    claim_count: metrics.claim_count,
    validation_error_count: metrics.validation_error_count,
    validation_warning_count: metrics.validation_warning_count,
    verifier_challenge_count: metrics.verifier_challenge_count,
    verifier_status_counts: metrics.verifier_status_counts,
    observed_agreement_rate: metrics.verifier_observed_agreement.rate,
    verifier_source_overlap_challenges: metrics.verifier_independence.challenges_with_source_overlap,
    human_review_count: metrics.human_review_count,
    accuracy: metrics.accuracy.status,
    runtime_seconds: metrics.runtime_seconds
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
