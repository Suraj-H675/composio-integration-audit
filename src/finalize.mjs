import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, ENUMS, FIELDS, claimMap } from "./schema.mjs";
import { validateRecord } from "./validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_RUN = path.join(ROOT, "data", "full_run");
const FINAL_REVIEW = path.join(ROOT, "data", "final_review");
const FINAL = path.join(ROOT, "data", "final");
const MANIFEST_PATH = path.join(ROOT, "config", "assignment_manifest.json");
const RUBRIC_VERSION = "2026-08-28.full-run.v2";
const DATASET_ID = "2026-08-28.final.v2";
const HOLDOUT_SALT = "agent-buildability-audit-accuracy-v2";
const HOLDOUT_APPS = [
  "Grain", "Devin", "BigCommerce", "Squarespace", "Vonage", "Aircall", "Twenty", "Podio", "Gladly", "Gorgias",
  "Ahrefs", "Bright Data", "Cloudflare", "Neo4j", "Xero", "Binance", "LinkedIn Ads", "Pinterest", "Airtable", "Harvest",
  "Ramp", "SE Ranking", "Clay", "Reducto", "Supabase", "Pylon", "Datadog", "Attio", "Amazon Selling Partner", "Close"
];
const CALIBRATION_APPS = new Set(["Salesforce", "GitHub", "Stripe", "Notion", "Vercel", "iPayX", "Otter AI", "Paygent Connect"]);
const HUMAN_METRIC_FIELDS = [
  "identity", "auth_methods", "customer_credential_access", "distributed_integration_access", "sandbox_access",
  "public_api_available", "api_breadth", "vendor_official_mcp", "vendor_mcp_type", "vendor_mcp_stage",
  "technical_buildability", "commercial_friction", "setup_friction", "main_blocker", "composio_toolkit_exists"
];
const FIRST_PARTY_TYPES = new Set([
  "official_api_docs", "official_auth_docs", "official_product_docs", "official_announcement", "official_github"
]);
const CACHE_DIRS = [
  ".cache/evidence-full-run",
  ".cache/evidence-schema-v2",
  ".cache/evidence-vfinal",
  ".cache/evidence"
].map((directory) => path.join(ROOT, directory));

function nowIso() {
  return new Date().toISOString();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function normalizedValues(value) {
  if (Array.isArray(value)) return [...value].map(String).sort();
  return value;
}

export function sameValue(left, right) {
  return JSON.stringify(normalizedValues(left)) === JSON.stringify(normalizedValues(right));
}

function isUnknown(value) {
  return value === "unknown" || (Array.isArray(value) && value.includes("unknown"));
}

function live(source) {
  return source?.status === "live" && source?.http_status >= 200 && source?.http_status < 400 && Boolean(source.content_text);
}

function official(source) {
  return FIRST_PARTY_TYPES.has(source?.source_type);
}

function usableCachedSources(sources) {
  return sources.filter((source) => {
    if (!live(source) || !official(source)) return false;
    if (source.source_type === "official_github") return true;
    return !(source.id?.startsWith("discovery-") || source.roles?.includes("discovered"));
  });
}

function sourceText(source) {
  return `${source?.title ?? ""}\n${source?.content_text ?? ""}`.replace(/\r/g, "").trim();
}

function sourceContexts(source) {
  const text = sourceText(source);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
  return sentences.filter((sentence) => /\b(?:mcp|model context protocol)\b/i.test(sentence));
}

function contextExcerpt(text, needle) {
  const index = text.search(needle);
  if (index < 0) return text.slice(0, 300);
  return text.slice(Math.max(0, index - 100), Math.min(text.length, index + 260)).trim();
}

function stagePattern(stage) {
  switch (stage) {
    case "ga":
      return /(?:\b(?:mcp|model context protocol)\b[^.!?]{0,180}\b(?:generally available|ga)\b|\b(?:generally available|ga)\b[^.!?]{0,180}\b(?:mcp|model context protocol)\b)/i;
    case "public_preview":
      return /(?:\b(?:mcp|model context protocol)\b[^.!?]{0,180}\bpublic preview\b|\bpublic preview\b[^.!?]{0,180}\b(?:mcp|model context protocol)\b)/i;
    case "beta":
      return /(?:\b(?:mcp|model context protocol)\b[^.!?]{0,180}\b(?:public\s+)?beta\b|\b(?:public\s+)?beta\b[^.!?]{0,180}\b(?:mcp|model context protocol)\b)/i;
    case "eap":
      return /(?:\b(?:mcp|model context protocol)\b[^.!?]{0,180}\b(?:eap|early access program|early access)\b|\b(?:eap|early access program|early access)\b[^.!?]{0,180}\b(?:mcp|model context protocol)\b)/i;
    case "announced":
      return /(?:\b(?:announced|introducing|launch(?:ed|ing)?)\b[^.!?]{0,180}\b(?:mcp|model context protocol)\b|\b(?:mcp|model context protocol)\b[^.!?]{0,180}\b(?:announced|introducing|launch(?:ed|ing)?)\b)/i;
    case "deprecated":
      return /(?:\b(?:mcp|model context protocol)\b[^.!?]{0,180}\b(?:server|service|product|feature|integration)\b[^.!?]{0,100}\bdeprecated\b|\bdeprecated\b[^.!?]{0,180}\b(?:mcp|model context protocol)\b[^.!?]{0,100}\b(?:server|service|product|feature|integration)\b)/i;
    default:
      return null;
  }
}

export function mcpStageEvidence(stage, sources) {
  if (stage === "unknown") return null;
  const pattern = stagePattern(stage);
  if (!pattern) return null;
  for (const source of sources) {
    if (!usableCachedSources([source]).length) continue;
    for (const context of sourceContexts(source)) {
      if (!pattern.test(context)) continue;
      if (stage === "deprecated" && /\b(?:sse|transport)\b/i.test(context) && !/\b(?:mcp\s+(?:server|service|product|feature|integration)|(?:server|service|product|feature|integration)\s+(?:is|was|has been)?\s*deprecated)\b/i.test(context)) continue;
      return {
        url: source.final_url || source.url,
        source_type: source.source_type,
        retrieval_method: source.retrieval_method ?? "http",
        checked_at: source.checked_at,
        http_status: source.http_status,
        statement: `The cached first-party source explicitly ties ${stage} to the MCP surface: ${contextExcerpt(context, /\b(?:mcp|model context protocol)\b/i)}`
      };
    }
  }
  return null;
}

function splitContexts(text) {
  return String(text ?? "").split(/(?<=[.!?])\s+|\n+|(?=#+\s)|(?=[-*]\s)/).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function meaningfulAccess(sentence) {
  return /\b(?:api|apis|mcp|model context protocol|integration|oauth|developer|access token|credential|webhook|endpoint)\b/i.test(sentence);
}

export function enterpriseAccessEvidence(sources) {
  const patterns = [
    /\b(?:enterprise[- ]only|enterprise customers? only|only enterprise customers?|requires? (?:an? )?enterprise|enterprise (?:plan|tier|workspace|account)[^.!?]{0,80}(?:required|only|must|need))\b/i,
    /\b(?:api|mcp|integration|oauth|developer access|access token)[^.!?]{0,120}\b(?:for|to)\b[^.!?]{0,40}\b(?:all )?enterprise (?:workspaces?|customers?|accounts?)\b/i,
    /\b(?:all )?enterprise (?:workspaces?|customers?|accounts?)\b[^.!?]{0,120}\b(?:api|mcp|integration|oauth|developer access|access token)\b/i,
    /\b(?:mcp|api|integration|oauth|developer access|access token)[^.!?]{0,160}\b(?:on|available (?:only )?for|limited to)\b[^.!?]{0,50}\benterprise (?:plan|tier|workspaces?|customers?)\b/i
  ];
  for (const source of sources) {
    if (!usableCachedSources([source]).length) continue;
    for (const sentence of splitContexts(sourceText(source))) {
      const hasNonEnterprisePlan = /\b(?:free|starter|basic|business|pro|standard|team|professional|growth|plus|advanced work management)\b/i.test(sentence);
      const explicitEnterpriseRequirement = patterns.some((pattern) => pattern.test(sentence));
      if (meaningfulAccess(sentence) && explicitEnterpriseRequirement && !hasNonEnterprisePlan) {
        return {
          url: source.final_url || source.url,
          source_type: source.source_type,
          retrieval_method: source.retrieval_method ?? "http",
          checked_at: source.checked_at,
          http_status: source.http_status,
          statement: `The cached first-party source explicitly ties meaningful integration access to an Enterprise requirement: ${sentence.slice(0, 420)}`
        };
      }
    }
  }
  return null;
}

function frictionEvidence(sources, target) {
  const patterns = {
    free_tier_limited: [
      /\b(?:free plan|free tier|free account)\b[^.!?\n]{0,220}\b(?:includes?|provides?|allows?|supports?|available|access|credits?)\b[^.!?\n]{0,100}\b(?:api|mcp|integration|developer|requests?)\b/i,
      /\b(?:api|mcp|integration|developer|requests?)\b[^.!?\n]{0,220}\b(?:available|included|usable|works|access)\b[^.!?\n]{0,100}\b(?:free plan|free tier|free account)\b/i,
      /\bfree plan\b[^.!?\n]{0,180}\b(?:monthly|platform)\s+(?:usage )?credits?\b/i
    ],
    paid_plan_required: [
      /\brequired plan\s*:\s*(?:business|pro|starter|professional|paid|plus|premium|growth|team|enterprise)/i,
      /\b(?:api access|api|mcp|integration|developer access|access token)\b[^.!?\n]{0,150}\b(?:requires?|available on|only on|included with)\b[^.!?\n]{0,100}\b(?:paid|pro|business|starter|unlimited|subscription|agency|plan)\b/i,
      /\b(?:paid|pro|business|starter|subscription|plan)\b[^.!?\n]{0,100}\b(?:requires?|needed for|includes?)\b[^.!?\n]{0,120}\b(?:api|mcp|integration|developer access)\b/i
    ],
    usage_pricing: [
      /\b(?:api|mcp|integration)\b[^.!?\n]{0,150}\b(?:per request|per call|usage[- ]based|billable|charged)\b/i,
      /\b(?:per request|per call|usage[- ]based|billable|charged)\b[^.!?\n]{0,150}\b(?:api|mcp|integration)\b/i
    ]
  };
  if (!patterns[target]) return null;
  for (const source of sources) {
    if (!usableCachedSources([source]).length) continue;
    for (const sentence of splitContexts(sourceText(source))) {
      if (target === "paid_plan_required" && /\b(?:copilot|vs\.?\s*code|cursor|claude|client|ide)\b/i.test(sentence)) continue;
      if (patterns[target].some((pattern) => pattern.test(sentence))) {
        return {
          value: target,
          evidence: {
            url: source.final_url || source.url,
            source_type: source.source_type,
            retrieval_method: source.retrieval_method ?? "http",
            checked_at: source.checked_at,
            http_status: source.http_status,
            statement: `The cached first-party source supports ${target}: ${sentence.slice(0, 420)}`
          }
        };
      }
    }
  }
  return null;
}

function auditEvidence(record, field, sources, fallbackStatement) {
  const claim = claimMap(record).get(field);
  const claimEvidence = claim?.evidence?.[0];
  const source = sourceRecordForEvidence(claimEvidence, sources) ?? sources.find((item) => live(item) && official(item)) ?? sources[0];
  if (!source) {
    return [{
      url: claimEvidence?.url ?? `about:${record.app}`,
      source_type: claimEvidence?.source_type ?? "official_product_docs",
      retrieval_method: claimEvidence?.retrieval_method ?? "http",
      checked_at: claimEvidence?.checked_at ?? nowIso(),
      http_status: claimEvidence?.http_status ?? 0,
      statement: fallbackStatement
    }];
  }
  const text = sourceText(source);
  return [{
    url: source.final_url || source.url,
    original_url: source.url,
    source_type: source.source_type,
    retrieval_method: source.retrieval_method ?? "http",
    checked_at: source.checked_at,
    http_status: source.http_status,
    statement: `${fallbackStatement} Cached source inspected: ${contextExcerpt(text, /\b(?:mcp|model context protocol|enterprise|api|pricing|plan)\b/i)}`
  }];
}

function recordSources(record, ledgerByApp, cache) {
  const ledgerSources = ledgerByApp.get(record.app) ?? [];
  const claimSources = (record.claims ?? []).flatMap((claim) => claim.evidence ?? []).map((item) => ({
    ...item,
    url: item.url,
    source_type: item.source_type,
    checked_at: item.checked_at,
    http_status: item.http_status,
    status: item.http_status >= 200 && item.http_status < 400 ? "live" : "inaccessible",
    retrieval_method: item.retrieval_method
  }));
  const byUrl = new Map();
  for (const item of [...ledgerSources, ...claimSources]) {
    const keys = [item.url, item.original_url, item.final_url].map(normalizeUrl).filter(Boolean);
    const cached = keys.map((key) => cache.get(key)).find(Boolean);
    const merged = { ...item, ...(cached ?? {}) };
    for (const key of [...keys, normalizeUrl(merged.url), normalizeUrl(merged.final_url)].filter(Boolean)) {
      const previous = byUrl.get(key);
      if (!previous || (merged.content_text?.length ?? 0) > (previous.content_text?.length ?? 0)) byUrl.set(key, merged);
    }
  }
  return [...new Map([...byUrl.values()].map((item) => [normalizeUrl(item.final_url || item.url), item])).values()];
}

async function buildCacheIndex() {
  const index = new Map();
  for (const directory of CACHE_DIRS) {
    let files = [];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const item = await readJson(path.join(directory, file));
        const keys = [item.url, item.original_url, item.final_url].map(normalizeUrl).filter(Boolean);
        for (const key of keys) {
          const previous = index.get(key);
          if (!previous || (item.content_text?.length ?? 0) > (previous.content_text?.length ?? 0)) index.set(key, item);
        }
      } catch {
        // A malformed cache entry cannot be used as evidence; the source remains auditable in the ledger.
      }
    }
  }
  return index;
}

function fixedHoldout(manifest) {
  const candidates = manifest.apps.filter((app) => !CALIBRATION_APPS.has(app.app)).map((app) => ({
    app,
    digest: sha256(`${app.id}:${HOLDOUT_SALT}`)
  }));
  const selected = [];
  for (const category of [...new Set(manifest.apps.map((app) => app.category))].sort()) {
    selected.push(...candidates.filter((item) => item.app.category === category).sort((a, b) => a.digest.localeCompare(b.digest)).slice(0, 2));
  }
  const used = new Set(selected.map((item) => item.app.app));
  selected.push(...candidates.filter((item) => !used.has(item.app.app)).sort((a, b) => a.digest.localeCompare(b.digest)).slice(0, 30 - selected.length));
  return selected.slice(0, 30).map((item) => item.app.app);
}

function identityValue(record) {
  return record.identity?.status ?? "unknown";
}

function packetValue(packetApp, field) {
  if (field === "identity") return packetApp.identity?.after_schema_repair?.status ?? packetApp.identity?.status ?? "unknown";
  const claim = packetApp.claims?.find((item) => item.field === field);
  return claim?.after_schema_repair ?? claim?.value ?? "unknown";
}

function finalValue(record, field) {
  if (field === "identity") return identityValue(record);
  return claimMap(record).get(field)?.value ?? "unknown";
}

function humanCorrections() {
  const correction = (app, field, approved_value, reason) => ({ app, field, approved_value, reason });
  return [
    correction("Grain", "customer_credential_access", "self_serve_paid", "Customer PAT access is available on a paid plan; this is separate from OAuth distribution access."),
    correction("Grain", "distributed_integration_access", "vendor_approval_required", "PAT/customer access and public OAuth distribution have different requirements."),
    correction("Grain", "sandbox_access", "unavailable", "Grain explicitly documents that no sandbox is available."),
    correction("Grain", "public_api_available", "yes", "The documented REST/API surface is useful beyond the MCP surface."),
    correction("Grain", "api_breadth", "moderate", "The API covers meetings, recordings, transcripts and webhooks."),
    correction("Grain", "vendor_mcp_stage", "unknown", "The cached evidence does not explicitly label the MCP lifecycle."),
    correction("Grain", "technical_buildability", "yes", "The API and MCP provide a useful implementable interface."),
    correction("Grain", "commercial_friction", "paid_plan_required", "API access is tied to a paid plan; pricing is not a technical blocker."),
    correction("Grain", "main_blocker", "none", "No interface limitation blocks a useful toolkit."),
    correction("Devin", "vendor_mcp_stage", "unknown", "A deprecated legacy transport/endpoint does not establish that the Devin MCP is deprecated."),
    correction("BigCommerce", "distributed_integration_access", "app_review_required", "Public app distribution follows the vendor's app review process."),
    correction("BigCommerce", "vendor_mcp_stage", "unknown", "A deprecated API/header statement is unrelated to MCP lifecycle."),
    correction("Twenty", "vendor_mcp_type", "product_action", "The MCP operates actual CRM/workspace data and actions."),
    correction("Podio", "distributed_integration_access", "open_self_serve", "The documented authorization path supports customer-facing distribution."),
    correction("Podio", "technical_buildability", "yes", "The public API is technically sufficient for a useful toolkit."),
    correction("Podio", "main_blocker", "none", "No interface limitation blocks a useful toolkit."),
    correction("Gladly", "customer_credential_access", "admin_required", "Customer credentials require organization administrator setup."),
    correction("Gladly", "distributed_integration_access", "unknown", "Cached evidence does not establish a public distribution gate."),
    correction("Gladly", "technical_buildability", "yes", "The documented API is technically sufficient; access friction is separate."),
    correction("Gorgias", "customer_credential_access", "admin_required", "An administrator must configure customer authorization."),
    correction("Gorgias", "vendor_official_mcp", true, "The current first-party announcement describes a first-party MCP server."),
    correction("Gorgias", "vendor_mcp_type", "product_action", "The official MCP operates on support/customer data and actions."),
    correction("Gorgias", "vendor_mcp_stage", "beta", "The first-party announcement describes the server as open beta."),
    correction("Gorgias", "technical_buildability", "yes", "The MCP/API surface is technically usable; plan and review friction are separate."),
    correction("Ahrefs", "customer_credential_access", "admin_required", "An account administrator must configure access for the workspace."),
    correction("Ahrefs", "vendor_mcp_stage", "unknown", "A legacy MCP transport deprecation does not deprecate the MCP service itself."),
    correction("Cloudflare", "vendor_mcp_stage", "unknown", "A transport or unrelated API capability lifecycle does not establish MCP lifecycle."),
    correction("Xero", "vendor_mcp_stage", "unknown", "An announcement or pricing statement does not establish an MCP lifecycle stage."),
    correction("LinkedIn Ads", "customer_credential_access", "vendor_approval_required", "Customer advertising API access requires vendor approval."),
    correction("LinkedIn Ads", "distributed_integration_access", "app_review_required", "Public distribution requires application review."),
    correction("LinkedIn Ads", "technical_buildability", "yes", "The API is technically sufficient; access approval is a separate gate."),
    correction("Pinterest", "customer_credential_access", "vendor_approval_required", "Customer API access requires vendor approval."),
    correction("Pinterest", "distributed_integration_access", "app_review_required", "Public distribution requires application review."),
    correction("Pinterest", "technical_buildability", "yes", "The API is technically sufficient; access approval is a separate gate."),
    correction("Airtable", "distributed_integration_access", "open_self_serve", "The documented OAuth integration path is open for distributable integrations."),
    correction("Harvest", "distributed_integration_access", "open_self_serve", "The documented OAuth path supports customer-facing distribution."),
    correction("Harvest", "setup_friction", "oauth_configuration", "A distributable Harvest integration requires OAuth configuration."),
    correction("Harvest", "commercial_friction", "unknown", "Cached evidence shows rate limits but does not establish a free-plan entitlement."),
    correction("Harvest", "technical_buildability", "yes", "The REST API and webhooks are technically sufficient."),
    correction("Ramp", "customer_credential_access", "admin_required", "An organization administrator must configure access."),
    correction("Ramp", "distributed_integration_access", "vendor_approval_required", "Public distribution requires vendor approval."),
    correction("Ramp", "technical_buildability", "yes", "The API is technically sufficient; approval is a distribution gate."),
    correction("Clay", "distributed_integration_access", "open_self_serve", "The available customer authorization path does not document a partner gate."),
    correction("Clay", "vendor_mcp_stage", "unknown", "The cached evidence does not explicitly label the MCP lifecycle."),
    correction("Supabase", "commercial_friction", "free_tier_limited", "The free plan provides useful API access with usage limits."),
    correction("Neo4j", "commercial_friction", "free_tier_limited", "Aura provides a free entry path with limits."),
    correction("SE Ranking", "commercial_friction", "usage_pricing", "API access is governed by credits/usage rather than an enterprise-only requirement."),
    correction("Reducto", "commercial_friction", "usage_pricing", "The API uses usage/credit-based pricing; this does not limit technical implementation."),
    correction("Datadog", "customer_credential_access", "admin_required", "An organization administrator must configure access."),
    correction("Attio", "distributed_integration_access", "open_self_serve", "The documented OAuth integration path supports public distribution."),
    correction("Close", "distributed_integration_access", "app_review_required", "Public OAuth distribution requires app review."),
  ];
}

function applyClaim(record, field, value, metadata = {}) {
  const claim = claimMap(record).get(field);
  if (!claim) throw new Error(`Cannot adjudicate missing claim ${record.app}.${field}`);
  const oldValue = claim.value;
  claim.value = value;
  const unknown = isUnknown(value);
  claim.status = unknown ? "unknown" : "supported";
  claim.confidence = unknown ? "unknown" : "high";
  claim.reason = metadata.reason ?? claim.reason;
  if (metadata.kind === "human") {
    claim.human_adjudication = {
      status: "approved",
      reviewed_by: "project_author",
      reviewed_at: metadata.reviewed_at,
      approved_value: value,
      reason: metadata.reason
    };
  } else if (metadata.kind === "consistency_sweep") {
    const existingUrls = new Set((claim.evidence ?? []).map((item) => normalizeUrl(item.final_url || item.url)).filter(Boolean));
    claim.evidence = [...(claim.evidence ?? []), ...(metadata.evidence ?? []).filter((item) => {
      const key = normalizeUrl(item.final_url || item.url);
      return key && !existingUrls.has(key);
    })];
    claim.consistency_sweep = {
      rule: metadata.rule,
      old_value: oldValue,
      new_value: value,
      reason: metadata.reason,
      evidence: metadata.evidence ?? []
    };
  }
  return oldValue;
}

function refreshUnknowns(record) {
  record.unknowns = (record.claims ?? []).filter((claim) => isUnknown(claim.value) || claim.status === "unknown").map((claim) => claim.field);
}

function sourceRecordForEvidence(evidence, sources) {
  const key = normalizeUrl(evidence?.url);
  return sources.find((source) => [source.url, source.original_url, source.final_url].map(normalizeUrl).includes(key)) ?? null;
}

function humanApprovedFields(record) {
  const approved = new Set();
  if (record.human_adjudication?.status === "approved") {
    for (const field of FIELDS) approved.add(field);
    approved.add("identity");
  }
  for (const claim of record.claims ?? []) if (claim.human_adjudication?.status === "approved") approved.add(claim.field);
  return approved;
}

function currentHoldoutHumanFields() {
  return new Set(HUMAN_METRIC_FIELDS);
}

function runMcpStageSweep(records, sourceMap, cache, holdoutSet, explicitHoldoutCorrections, humanReviewAt) {
  const changes = [];
  const protectedChanges = [];
  for (const record of records) {
    const claim = claimMap(record).get("vendor_mcp_stage");
    if (!claim || claim.value === "unknown") continue;
    const sources = recordSources(record, sourceMap, cache);
    const evidence = mcpStageEvidence(claim.value, sources);
    if (evidence) continue;
    const audit = auditEvidence(record, "vendor_mcp_stage", sources, `No cached first-party source explicitly ties ${claim.value} to the MCP server/product/feature.`);
    const row = {
      app: record.app,
      field: "vendor_mcp_stage",
      old_value: claim.value,
      new_value: "unknown",
      evidence: audit,
      reason: "The lifecycle term was not explicitly attributed to the MCP surface; unrelated API, transport, endpoint, navigation, or other feature lifecycle text is insufficient.",
      applied: false
    };
    const protectedByHuman = holdoutSet.has(record.app) || humanApprovedFields(record).has("vendor_mcp_stage");
    if (protectedByHuman) {
      row.protected_by_human = true;
      row.protection_reason = holdoutSet.has(record.app) ? "The exact holdout proposal was human-approved; human adjudication takes precedence over an automatic sweep." : "An earlier human-approved calibration value is preserved.";
      protectedChanges.push(row);
      continue;
    }
    applyClaim(record, "vendor_mcp_stage", "unknown", { kind: "consistency_sweep", rule: "mcp_lifecycle_attribution", reason: row.reason, evidence: row.evidence });
    row.applied = true;
    changes.push(row);
  }
  return { rule: "mcp_lifecycle_attribution", evaluated_count: records.length, changed_count: changes.length, changes, protected_changes: protectedChanges, reviewed_at: humanReviewAt };
}

function runCommercialSweep(records, sourceMap, cache, holdoutSet, humanReviewAt) {
  const changes = [];
  const protectedChanges = [];
  for (const record of records) {
    const claim = claimMap(record).get("commercial_friction");
    if (!claim || claim.value !== "enterprise_plan_required") continue;
    const sources = recordSources(record, sourceMap, cache);
    const enterprise = enterpriseAccessEvidence(sources);
    if (enterprise) continue;
    const replacement = frictionEvidence(sources, "paid_plan_required") ?? frictionEvidence(sources, "free_tier_limited") ?? frictionEvidence(sources, "usage_pricing");
    const newValue = replacement?.value ?? "unknown";
    const evidence = replacement?.evidence ? [replacement.evidence] : [{
      url: claim.evidence?.[0]?.url ?? sources[0]?.url ?? `about:${record.app}`,
      source_type: claim.evidence?.[0]?.source_type ?? sources[0]?.source_type ?? "official_product_docs",
      retrieval_method: claim.evidence?.[0]?.retrieval_method ?? sources[0]?.retrieval_method ?? "http",
      checked_at: claim.evidence?.[0]?.checked_at ?? sources[0]?.checked_at ?? humanReviewAt,
      http_status: claim.evidence?.[0]?.http_status ?? sources[0]?.http_status ?? 0,
      statement: "Cached first-party evidence does not explicitly establish an Enterprise-only requirement for meaningful API, MCP, or integration access."
    }];
    const row = {
      app: record.app,
      field: "commercial_friction",
      old_value: "enterprise_plan_required",
      new_value: newValue,
      evidence,
      reason: enterprise ? "Enterprise-only access is explicitly supported." : "Enterprise-tier existence alone is not enough; the cached evidence supports the replacement value or cannot resolve the requirement.",
      applied: false
    };
    const protectedByHuman = holdoutSet.has(record.app) || humanApprovedFields(record).has("commercial_friction");
    if (protectedByHuman) {
      row.protected_by_human = true;
      row.protection_reason = holdoutSet.has(record.app) ? "The exact holdout proposal was human-approved; human adjudication takes precedence over an automatic sweep." : "An earlier human-approved calibration value is preserved.";
      protectedChanges.push(row);
      continue;
    }
    applyClaim(record, "commercial_friction", newValue, { kind: "consistency_sweep", rule: "enterprise_commercial_friction", reason: row.reason, evidence });
    row.applied = true;
    changes.push(row);
  }
  return { rule: "enterprise_commercial_friction", evaluated_count: records.length, changed_count: changes.length, changes, protected_changes: protectedChanges, reviewed_at: humanReviewAt };
}

function applyHumanAdjudication(records, baseRecords, adjudication, reviewedAt) {
  const corrections = new Map(adjudication.explicit_field_corrections.map((item) => [`${item.app}:${item.field}`, item]));
  const holdout = new Set(adjudication.holdout_apps);
  const applied = [];
  for (const record of records) {
    if (!holdout.has(record.app)) continue;
    const base = baseRecords.find((item) => item.app === record.app);
    if (!base) throw new Error(`Missing pre-human record for ${record.app}`);
    // The author approved every current v2 proposal by default. Restore the complete
    // proposal for the locked holdout before applying only the listed corrections.
    const baseClaims = claimMap(base);
    for (let index = 0; index < record.claims.length; index += 1) {
      const claim = record.claims[index];
      const original = baseClaims.get(claim.field);
      if (!original) throw new Error(`Missing baseline field ${record.app}.${claim.field}`);
      record.claims[index] = structuredClone(original);
    }
    record.identity = structuredClone(base.identity);
    record.identity_evidence = structuredClone(base.identity_evidence ?? []);
    record.identity_hint_conflict = base.identity_hint_conflict;
    record.one_liner = base.one_liner;
    record.composio_toolkit_match_type = base.composio_toolkit_match_type;
    record.composio_toolkit_identifier = base.composio_toolkit_identifier;
    record.adjudication = structuredClone(base.adjudication ?? {});
    record.schema_repair = structuredClone(base.schema_repair ?? {});
    record.final_human_adjudication = {
      status: "approved",
      reviewed_by: "project_author",
      reviewed_at: reviewedAt,
      holdout: true
    };
    for (const item of adjudication.explicit_field_corrections.filter((entry) => entry.app === record.app)) {
      applyClaim(record, item.field, item.approved_value, { kind: "human", reviewed_at: reviewedAt, reason: item.reason });
      applied.push({ ...item, previous_value: baseClaims.get(item.field)?.value ?? null });
    }
    refreshUnknowns(record);
    record.human_review_required = false;
  }
  return applied;
}

function makeHumanAdjudication(reviewedAt, harvestCommercialValue) {
  const corrections = humanCorrections().map((item) => item.app === "Harvest" && item.field === "commercial_friction"
    ? { ...item, approved_value: harvestCommercialValue, reason: harvestCommercialValue === "free_tier_limited" ? "Cached evidence supports a free plan with useful API access and limits." : item.reason }
    : item);
  return {
    review_status: "approved",
    reviewed_by: "project_author",
    reviewed_at: reviewedAt,
    sample_size_apps: 30,
    sampling_method: "existing preregistered method",
    schema_version: RUBRIC_VERSION,
    approved_default: "current_after_v2_proposal",
    holdout_apps: HOLDOUT_APPS,
    explicit_field_corrections: corrections,
    notes: "The project author approved all current v2 holdout proposals except the explicit field corrections recorded here. Human decisions override automatic verifier proposals and cache-only consistency sweeps for the locked holdout."
  };
}

function harvestCommercialValue(sources) {
  const text = sources.filter((source) => live(source) && official(source)).map(sourceText).join(" ");
  return /\b(?:free plan|free tier|free account|free usage|free credits)\b[^.!?]{0,180}\b(?:api|mcp|integration|developer|requests?|credits?)\b|\b(?:api|mcp|integration|developer|requests?|credits?)\b[^.!?]{0,180}\b(?:free plan|free tier|free account|free usage|free credits)\b/i.test(text)
    ? "free_tier_limited"
    : "unknown";
}

function count(values) {
  const output = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}

function claimValues(records, field) {
  return records.map((record) => claimMap(record).get(field)?.value ?? "unknown");
}

function flattenEvidence(records) {
  return records.flatMap((record) => record.claims ?? []).flatMap((claim) => claim.evidence ?? []);
}

function evidenceQualityDistribution(records) {
  const tiers = records.flatMap((record) => record.claims ?? []).map((claim) => claim.evidence_quality?.tier ?? "unknown");
  return count(tiers);
}

function ledgerStats(ledger) {
  const sources = (ledger.sources ?? []).flatMap((row) => row.sources ?? []);
  return {
    source_ledger_count: sources.length,
    unique_source_url_count: new Set(sources.map((source) => normalizeUrl(source.final_url || source.url)).filter(Boolean)).size,
    live_source_count: sources.filter((source) => source.status === "live").length,
    retrieval_method_counts: count(sources.map((source) => source.retrieval_method ?? "unknown"))
  };
}

function lists(records) {
  const by = (predicate) => records.filter(predicate).map((record) => record.app);
  const get = (record, field) => claimMap(record).get(field)?.value;
  const absentToolkit = (record) => get(record, "composio_toolkit_exists") === "no";
  const useful = (record) => get(record, "public_api_available") === "yes" || (get(record, "vendor_official_mcp") === true && get(record, "vendor_mcp_type") === "product_action");
  const accessibleCustomer = new Set(["self_serve_free", "self_serve_trial", "self_serve_paid"]);
  const gatedDistribution = new Set(["app_review_required", "partner_program_required", "vendor_approval_required", "enterprise_contract_required"]);
  const easyWins = by((record) => record.identity?.status === "confirmed" && get(record, "technical_buildability") === "yes" && useful(record) && absentToolkit(record) && get(record, "distributed_integration_access") === "open_self_serve" && accessibleCustomer.has(get(record, "customer_credential_access")));
  const partnerships = by((record) => record.identity?.status === "confirmed" && get(record, "technical_buildability") === "yes" && useful(record) && absentToolkit(record) && gatedDistribution.has(get(record, "distributed_integration_access")));
  const customerManaged = by((record) => get(record, "technical_buildability") === "yes" && useful(record) && get(record, "distributed_integration_access") === "customer_managed_only");
  const publicApiAbsentToolkit = by((record) => get(record, "public_api_available") === "yes" && absentToolkit(record));
  const buildableAbsentToolkit = by((record) => get(record, "technical_buildability") === "yes" && absentToolkit(record));
  const officialMcpAbsentToolkit = by((record) => get(record, "vendor_official_mcp") === true && absentToolkit(record));
  const productActionAbsentToolkit = by((record) => get(record, "vendor_official_mcp") === true && get(record, "vendor_mcp_type") === "product_action" && absentToolkit(record));
  return { easyWins, partnerships, customerManaged, publicApiAbsentToolkit, buildableAbsentToolkit, officialMcpAbsentToolkit, productActionAbsentToolkit };
}

function rankedOpportunityBuckets(records) {
  const get = (record, field) => claimMap(record).get(field)?.value;
  const useful = (record) => get(record, "public_api_available") === "yes" || (get(record, "vendor_official_mcp") === true && get(record, "vendor_mcp_type") === "product_action");
  const noToolkit = (record) => get(record, "composio_toolkit_exists") === "no";
  const qualityScore = (record) => {
    const tiers = (record.claims ?? []).map((claim) => claim.evidence_quality?.tier).filter(Boolean);
    return tiers.includes("high") ? 2 : tiers.includes("medium") ? 1 : 0;
  };
  const finish = (items) => items.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app)).map((item, index) => ({ rank: index + 1, ...item }));
  const easy = [];
  const partnership = [];
  const customerManaged = [];
  const gates = new Set(["app_review_required", "partner_program_required", "vendor_approval_required", "enterprise_contract_required"]);
  for (const record of records) {
    const customer = get(record, "customer_credential_access");
    const distribution = get(record, "distributed_integration_access");
    if (record.identity?.status === "confirmed" && get(record, "technical_buildability") === "yes" && useful(record) && noToolkit(record) && distribution === "open_self_serve" && ["self_serve_free", "self_serve_trial", "self_serve_paid"].includes(customer)) {
      easy.push({ app: record.app, score: 8 + (customer === "self_serve_free" ? 1 : 0) + qualityScore(record), reasons: ["technical_buildability=yes", "useful API or product-action MCP", "no Composio toolkit", "open_self_serve distribution", `${customer} customer credentials`] });
    }
    if (record.identity?.status === "confirmed" && get(record, "technical_buildability") === "yes" && useful(record) && noToolkit(record) && gates.has(distribution)) {
      partnership.push({ app: record.app, score: 7 + (get(record, "public_api_available") === "yes" ? 1 : 0) + qualityScore(record), reasons: ["technical_buildability=yes", "useful API or product-action MCP", "no Composio toolkit", distribution] });
    }
    if (get(record, "technical_buildability") === "yes" && useful(record) && distribution === "customer_managed_only") {
      customerManaged.push({ app: record.app, score: 5 + (noToolkit(record) ? 1 : 0) + qualityScore(record), reasons: ["technical_buildability=yes", "useful API or product-action MCP", "customer_managed_only distribution"] });
    }
  }
  return { engineering_easy_wins: finish(easy), partnership_review_opportunities: finish(partnership), customer_managed_only_opportunities: finish(customerManaged), scoring: "Scores use bucket-specific fixed eligibility bases, fixed bonuses for the preferred API/customer-access/no-toolkit conditions, and 0–2 for the presence of high/medium evidence quality; ties break alphabetically. Scores rank triage order and are not probabilities." };
}

function categoryPatterns(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.category)) groups.set(record.category, []);
    groups.get(record.category).push(record);
  }
  const out = {};
  for (const [category, items] of groups) {
    const get = (record, field) => claimMap(record).get(field)?.value;
    out[category] = {
      app_count: items.length,
      technical_buildability: count(items.map((record) => get(record, "technical_buildability"))),
      customer_credential_access: count(items.map((record) => get(record, "customer_credential_access"))),
      distributed_integration_access: count(items.map((record) => get(record, "distributed_integration_access"))),
      auth_methods: count(items.flatMap((record) => get(record, "auth_methods") ?? ["unknown"])),
      official_mcp: items.filter((record) => get(record, "vendor_official_mcp") === true).length,
      product_action_mcp: items.filter((record) => get(record, "vendor_official_mcp") === true && get(record, "vendor_mcp_type") === "product_action").length,
      composio_toolkit: items.filter((record) => get(record, "composio_toolkit_exists") === "yes").length
    };
  }
  return out;
}

function humanMetricStatus(proposed, approved) {
  if (sameValue(proposed, approved)) return approved === "unknown" ? "human_unresolved" : "correct";
  if (isUnknown(approved)) return "human_unresolved";
  if (isUnknown(proposed)) return "automation_abstention";
  if (Array.isArray(proposed) && Array.isArray(approved) && proposed.some((value) => approved.includes(value))) return "partial";
  return "wrong";
}

export function computeHoldoutMetrics(preHumanPacket, finalRecords, holdoutApps = HOLDOUT_APPS) {
  const finalByApp = new Map(finalRecords.map((record) => [record.app, record]));
  const rows = [];
  for (const packetApp of preHumanPacket.apps ?? []) {
    const record = finalByApp.get(packetApp.app);
    if (!record) throw new Error(`Missing final holdout record ${packetApp.app}`);
    for (const field of HUMAN_METRIC_FIELDS) {
      const proposed = packetValue(packetApp, field);
      const approved = finalValue(record, field);
      rows.push({ app: packetApp.app, category: packetApp.category, field, proposed_value: proposed, approved_value: approved, status: humanMetricStatus(proposed, approved) });
    }
  }
  const total = rows.length;
  const exactMatches = rows.filter((row) => sameValue(row.proposed_value, row.approved_value)).length;
  const humanUnresolved = rows.filter((row) => row.status === "human_unresolved").length;
  const automationAbstentions = rows.filter((row) => row.status === "automation_abstention").length;
  const partial = rows.filter((row) => row.status === "partial").length;
  const wrong = rows.filter((row) => row.status === "wrong" || row.status === "partial").length;
  const correct = rows.filter((row) => row.status === "correct").length;
  const byField = {};
  for (const field of HUMAN_METRIC_FIELDS) {
    const fieldRows = rows.filter((row) => row.field === field);
    byField[field] = {
      changed: fieldRows.filter((row) => !sameValue(row.proposed_value, row.approved_value)).length,
      exact_matches: fieldRows.filter((row) => sameValue(row.proposed_value, row.approved_value)).length,
      correct: fieldRows.filter((row) => row.status === "correct").length,
      wrong: fieldRows.filter((row) => row.status === "wrong" || row.status === "partial").length,
      partial: fieldRows.filter((row) => row.status === "partial").length,
      human_unresolved: fieldRows.filter((row) => row.status === "human_unresolved").length,
      automation_abstentions: fieldRows.filter((row) => row.status === "automation_abstention").length
    };
  }
  const byCategory = {};
  for (const category of CATEGORIES) {
    const categoryRows = rows.filter((row) => row.category === category);
    byCategory[category] = {
      reviewed_fields: categoryRows.length,
      changed: categoryRows.filter((row) => !sameValue(row.proposed_value, row.approved_value)).length,
      exact_matches: categoryRows.filter((row) => sameValue(row.proposed_value, row.approved_value)).length,
      wrong_or_partial: categoryRows.filter((row) => ["wrong", "partial"].includes(row.status)).length
    };
  }
  const beforeAfterRows = [];
  for (const packetApp of preHumanPacket.apps ?? []) {
    const record = finalByApp.get(packetApp.app);
    for (const field of HUMAN_METRIC_FIELDS) {
      const before = field === "identity"
        ? packetApp.identity?.before_schema_repair ?? "unknown"
        : packetApp.claims?.find((item) => item.field === field)?.before_schema_repair ?? "unknown";
      const after = packetValue(packetApp, field);
      const approved = finalValue(record, field);
      if (!sameValue(before, after)) beforeAfterRows.push({ app: packetApp.app, field, before, after, approved, accepted: sameValue(after, approved) });
    }
  }
  const repaired = beforeAfterRows.length;
  const accepted = beforeAfterRows.filter((row) => row.accepted).length;
  return {
    schema_version: RUBRIC_VERSION,
    holdout_apps: holdoutApps,
    reviewed_app_count: holdoutApps.length,
    reviewed_field_count: total,
    fields: HUMAN_METRIC_FIELDS,
    counts: {
      exact_matches: exactMatches,
      correct,
      wrong,
      partial,
      human_unresolved: humanUnresolved,
      automation_abstentions: automationAbstentions,
      changed: rows.filter((row) => !sameValue(row.proposed_value, row.approved_value)).length
    },
    exact_field_agreement: { numerator: exactMatches, denominator: total, rate: total ? exactMatches / total : null, definition: "Exact equality across all human-adjudicable fields; approved unknown values are included in this agreement denominator." },
    resolved_field_accuracy: { numerator: correct, denominator: correct + wrong, rate: correct + wrong ? correct / (correct + wrong) : null, definition: "correct / (correct + wrong); partial disagreements are included in wrong, while automation abstentions and human-unresolved fields are excluded." },
    automation_abstention_rate: { numerator: automationAbstentions, denominator: total, rate: total ? automationAbstentions / total : null, definition: "Pre-human proposal was unknown." },
    human_unresolved_rate: { numerator: humanUnresolved, denominator: total, rate: total ? humanUnresolved / total : null, definition: "Approved value remains unknown." },
    field_breakdown: byField,
    category_breakdown: byCategory,
    comparison_rows: rows,
    schema_repair_improvement: {
      comparison: "immutable packet before_schema_repair vs after_schema_repair, then approved final value",
      repaired_field_count: repaired,
      accepted_v2_values: accepted,
      still_needed_human_correction: repaired - accepted,
      accepted_rate: repaired ? accepted / repaired : null,
      denominator: repaired,
      rows: beforeAfterRows
    },
    note: "This is a human-reviewed calibration result for the fixed 30-app holdout, not an estimate of accuracy across all 100 apps. Post-human values are adjudicated ground truth, not a model-accuracy measurement."
  };
}

function verifierMetrics(verification) {
  const challenges = (verification ?? []).flatMap((row) => row.verifications ?? []);
  const statusDistribution = count(challenges.map((item) => item.status ?? "unknown"));
  const determinate = challenges.filter((item) => ["agree", "correction", "disagree"].includes(item.status));
  const alternateAvailable = challenges.filter((item) => item.independent_source_found === true);
  const disjoint = challenges.filter((item) => item.source_overlap === false);
  const disjointWhenAvailable = alternateAvailable.filter((item) => item.source_overlap === false);
  return {
    challenge_count: challenges.length,
    status_distribution: statusDistribution,
    observed_agreement: { numerator: statusDistribution.agree ?? 0, denominator: determinate.length, rate: determinate.length ? (statusDistribution.agree ?? 0) / determinate.length : null, note: "Verifier agreement is not accuracy." },
    source_disjoint_count: disjoint.length,
    source_disjoint_rate: challenges.length ? disjoint.length / challenges.length : null,
    alternate_source_available_count: alternateAvailable.length,
    source_disjoint_when_alternate_available: { numerator: disjointWhenAvailable.length, denominator: alternateAvailable.length, rate: alternateAvailable.length ? disjointWhenAvailable.length / alternateAvailable.length : null },
    note: "The verifier challenged proposals and preserved disagreements; it did not provide ground truth."
  };
}

function buildMetrics(records, ledger, validations, sweeps, holdoutMetrics, generatedAt, runtimeSeconds, catalog, verification) {
  const validationRows = validations.validations ?? validations;
  const get = (record, field) => claimMap(record).get(field)?.value ?? "unknown";
  const stats = ledgerStats(ledger);
  const opportunityLists = lists(records);
  const rankedBuckets = rankedOpportunityBuckets(records);
  const primaryAnalysisFields = FIELDS.filter((field) => !["credential_access", "production_access"].includes(field));
  const unknownByField = {};
  for (const field of primaryAnalysisFields) unknownByField[field] = records.filter((record) => isUnknown(get(record, field))).length;
  const legacyUnknownByField = {};
  for (const field of ["credential_access", "production_access"]) legacyUnknownByField[field] = records.filter((record) => isUnknown(get(record, field))).length;
  const officialMcp = records.filter((record) => get(record, "vendor_official_mcp") === true);
  const typeDistribution = count(officialMcp.map((record) => get(record, "vendor_mcp_type")));
  const stageDistribution = count(officialMcp.map((record) => get(record, "vendor_mcp_stage")));
  const sourceEvidence = flattenEvidence(records);
  const validationErrors = validationRows.flatMap((item) => item.errors ?? []);
  const validationWarnings = validationRows.flatMap((item) => item.warnings ?? []);
  return {
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    generated_at: generatedAt,
    app_count: records.length,
    ...stats,
    claim_count: records.length * FIELDS.length,
    claim_coverage: { supported_or_unknown_claims: records.flatMap((record) => record.claims ?? []).filter((claim) => claim.evidence?.length).length, denominator: records.length * FIELDS.length },
    unknown_field_count: Object.values(unknownByField).reduce((sum, value) => sum + value, 0),
    unknown_field_denominator: records.length * primaryAnalysisFields.length,
    unknown_field_rate: records.length * primaryAnalysisFields.length ? Object.values(unknownByField).reduce((sum, value) => sum + value, 0) / (records.length * primaryAnalysisFields.length) : null,
    unknown_fields_by_field: unknownByField,
    legacy_unknown_fields_by_field: legacyUnknownByField,
    evidence_quality_distribution: evidenceQualityDistribution(records),
    identity_distribution: count(records.map((record) => record.identity?.status ?? "unknown")),
    technical_buildability_distribution: count(claimValues(records, "technical_buildability")),
    customer_credential_access_distribution: count(claimValues(records, "customer_credential_access")),
    distributed_integration_access_distribution: count(claimValues(records, "distributed_integration_access")),
    auth_method_distribution: count(records.flatMap((record) => claimMap(record).get("auth_methods")?.value ?? ["unknown"])),
    primary_auth_distribution: count(claimValues(records, "primary_auth")),
    api_style_distribution: count(records.flatMap((record) => claimMap(record).get("api_styles")?.value ?? ["unknown"])),
    public_api_available_distribution: count(claimValues(records, "public_api_available")),
    api_breadth_distribution: count(claimValues(records, "api_breadth")),
    webhooks_distribution: count(claimValues(records, "webhooks")),
    sandbox_access_distribution: count(claimValues(records, "sandbox_access")),
    community_mcp_distribution: count(claimValues(records, "community_mcp")),
    commercial_friction_distribution: count(claimValues(records, "commercial_friction")),
    setup_friction_distribution: count(claimValues(records, "setup_friction")),
    main_blocker_distribution: count(claimValues(records, "main_blocker")),
    official_mcp_count: officialMcp.length,
    vendor_mcp_type_distribution: typeDistribution,
    mcp_lifecycle_distribution: stageDistribution,
    product_action_official_mcp_count: officialMcp.filter((record) => get(record, "vendor_mcp_type") === "product_action").length,
    documentation_only_official_mcp_count: officialMcp.filter((record) => get(record, "vendor_mcp_type") === "documentation").length,
    developer_tooling_official_mcp_count: officialMcp.filter((record) => get(record, "vendor_mcp_type") === "developer_tooling").length,
    mixed_official_mcp_count: officialMcp.filter((record) => get(record, "vendor_mcp_type") === "mixed").length,
    unknown_mcp_type_count: officialMcp.filter((record) => get(record, "vendor_mcp_type") === "unknown").length,
    composio_toolkit_coverage: {
      yes: records.filter((record) => get(record, "composio_toolkit_exists") === "yes").length,
      no: records.filter((record) => get(record, "composio_toolkit_exists") === "no").length,
      unknown: records.filter((record) => get(record, "composio_toolkit_exists") === "unknown").length,
      catalog_snapshot: catalog?.checked_at ?? null
    },
    public_apis_absent_from_composio: opportunityLists.publicApiAbsentToolkit,
    technically_buildable_absent_from_composio: opportunityLists.buildableAbsentToolkit,
    official_mcp_without_composio: opportunityLists.officialMcpAbsentToolkit,
    product_action_mcp_without_composio: opportunityLists.productActionAbsentToolkit,
    engineering_easy_wins: opportunityLists.easyWins,
    partnership_review_opportunities: opportunityLists.partnerships,
    customer_managed_only_opportunities: opportunityLists.customerManaged,
    ranked_opportunity_buckets: rankedBuckets,
    product_ops_questions: {
      easy_open_distribution_count: records.filter((record) => get(record, "distributed_integration_access") === "open_self_serve").length,
      app_review_count: records.filter((record) => get(record, "distributed_integration_access") === "app_review_required").length,
      partner_program_count: records.filter((record) => get(record, "distributed_integration_access") === "partner_program_required").length,
      vendor_approval_count: records.filter((record) => get(record, "distributed_integration_access") === "vendor_approval_required").length,
      enterprise_contract_count: records.filter((record) => get(record, "distributed_integration_access") === "enterprise_contract_required").length,
      customer_managed_only_count: records.filter((record) => get(record, "distributed_integration_access") === "customer_managed_only").length,
      customers_easy_but_distribution_gated: records.filter((record) => ["self_serve_free", "self_serve_trial", "self_serve_paid"].includes(get(record, "customer_credential_access")) && ["app_review_required", "partner_program_required", "vendor_approval_required", "enterprise_contract_required"].includes(get(record, "distributed_integration_access"))).map((record) => record.app),
      product_action_mcp_absent_from_composio_count: opportunityLists.productActionAbsentToolkit.length
    },
    category_patterns: categoryPatterns(records),
    validation: { error_count: validations.fatal_errors?.length ?? validationErrors.length, raw_error_count: validationErrors.length, intentional_error_count: validations.intentional_errors?.length ?? 0, warning_count: validationWarnings.length, errors: validationErrors, warnings: validationWarnings },
    verification: verifierMetrics(verification),
    consistency_sweeps: { mcp_lifecycle_changes: sweeps.mcp_lifecycle.changed_count, enterprise_commercial_changes: sweeps.enterprise_commercial.changed_count },
    holdout: holdoutMetrics,
    runtime_seconds: runtimeSeconds,
    actual_paid_cost_usd: 0,
    paid_services_used: [],
    source_evidence_count: sourceEvidence.length
  };
}

function buildAnalysis(metrics) {
  const pct = (n, d) => d ? Number((100 * n / d).toFixed(1)) : 0;
  const buildable = metrics.technical_buildability_distribution.yes ?? 0;
  const open = metrics.distributed_integration_access_distribution.open_self_serve ?? 0;
  const gated = (metrics.distributed_integration_access_distribution.app_review_required ?? 0)
    + (metrics.distributed_integration_access_distribution.partner_program_required ?? 0)
    + (metrics.distributed_integration_access_distribution.vendor_approval_required ?? 0)
    + (metrics.distributed_integration_access_distribution.enterprise_contract_required ?? 0);
  const official = metrics.official_mcp_count;
  const productAction = metrics.product_action_official_mcp_count;
  return {
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    generated_at: metrics.generated_at,
    insights: [
      { title: "Credential access and distribution are different bottlenecks", statement: `${metrics.product_ops_questions.customers_easy_but_distribution_gated.length} apps let customers obtain credentials through a self-serve path while public distribution is gated.`, basis: "customer_credential_access plus distributed_integration_access" },
      { title: "Technical feasibility is broader than immediate launchability", statement: `${buildable} of ${metrics.app_count} apps (${pct(buildable, metrics.app_count)}%) are technically buildable, while ${gated} have a documented distribution gate and ${open} are open self-serve.`, basis: "technical_buildability plus distributed_integration_access" },
      { title: "MCP capability matters more than raw MCP presence", statement: `${official} apps have an official MCP; ${productAction} are classified as product-action and ${metrics.documentation_only_official_mcp_count} as documentation-only.`, basis: "vendor_official_mcp plus vendor_mcp_type" },
      { title: "Product-action MCPs without native coverage are a concrete opportunity", statement: `${metrics.product_action_mcp_without_composio.length} product-action MCP apps have no current Composio toolkit in the catalog snapshot.`, basis: "vendor_mcp_type plus composio_toolkit_exists" },
      { title: "Identity uncertainty is an explicit outcome", statement: `${metrics.identity_distribution.unresolved ?? 0} apps remain unresolved rather than being assigned to a similarly named product.`, basis: "identity.status" },
      { title: "Human review changed semantics, not just labels", statement: `${metrics.holdout.schema_repair_improvement.repaired_field_count} holdout fields changed in v1→v2 repair; ${metrics.holdout.schema_repair_improvement.still_needed_human_correction} still needed human correction after the repair.`, basis: "immutable holdout before/after comparison" }
    ],
    engineering_easy_wins: metrics.engineering_easy_wins,
    partnership_review_opportunities: metrics.partnership_review_opportunities,
    customer_managed_only_opportunities: metrics.customer_managed_only_opportunities,
    ranked_opportunity_buckets: metrics.ranked_opportunity_buckets,
    category_patterns: metrics.category_patterns,
    note: "All values are deterministic computations from the frozen dataset. Lists are included so the headline counts remain auditable."
  };
}

function finalHoldoutJson(records, preHumanPacket, sweeps, generatedAt) {
  return {
    version: 2,
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    generated_at: generatedAt,
    review_status: "approved",
    methodology: "The exact same 30-app holdout is shown after the separate human adjudication artifact and cache-only consistency audit.",
    apps: records.filter((record) => (preHumanPacket.apps ?? []).some((item) => item.app === record.app)).map((record) => ({
      app: record.app,
      category: record.category,
      assignment_hint: record.assignment_hint,
      identity: record.identity,
      claims: record.claims,
      evidence_reuse: record.claims.map((claim) => ({ field: claim.field, reused_existing_evidence: (claim.evidence ?? []).length > 0, new_network_fetch_required: false })),
      sweep_overrides: [sweeps.mcp_lifecycle, sweeps.enterprise_commercial].flatMap((sweep) => [...(sweep.changes ?? []), ...(sweep.protected_changes ?? [])].filter((item) => item.app === record.app))
    }))
  };
}

function markdownHoldout(packet) {
  const lines = [
    "# Final human-adjudicated holdout",
    "",
    `Dataset: \`${packet.dataset_id}\``,
    `Schema: \`${packet.schema_version}\``,
    "",
    "This is the same 30-app holdout after the approved human adjudication. The immutable pre-human v2 packet is stored separately in `data/final_review/holdout_pre_human.*`.",
    ""
  ];
  for (const app of packet.apps) {
    lines.push(`## ${app.app}`, "", `- Category: ${app.category}`, `- Assignment hint: ${app.assignment_hint}`, `- Identity: ${app.identity.status}`, "");
    for (const claim of app.claims) {
      const value = Array.isArray(claim.value) ? claim.value.join(", ") : String(claim.value);
      const evidence = claim.evidence?.[0];
      lines.push(`- **${claim.field}**: ${value}`, `  - Evidence: ${evidence?.url ?? "none"}`, `  - Statement: ${(evidence?.statement ?? claim.reason ?? "").replace(/\s+/g, " ").slice(0, 280)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function finalValidation(records, manifest, humanAdjudication, holdoutMetrics, sweeps) {
  const validations = records.map((record) => {
    const manifestApp = manifest.apps.find((app) => app.app === record.app);
    return { app: record.app, ...validateRecord(record, { requireAll: true, expectedHosts: manifestApp?.official_domains ?? [] }) };
  });
  const humanSemanticOverrides = new Set([
    "customer_access_without_credential_evidence",
    "open_distribution_without_evidence",
    "partner_distribution_without_evidence",
    "app_review_without_evidence",
    "product_action_mcp_without_surface_evidence",
    "documentation_mcp_without_surface_evidence"
  ]);
  const humanApprovedRecord = new Map(records.map((record) => [record.app, Boolean(record.final_human_adjudication?.status === "approved" || record.human_adjudication?.status === "approved")]));
  const humanOverridden = validations.flatMap((item) => (item.errors ?? []).filter((error) => humanApprovedRecord.get(item.app) && humanSemanticOverrides.has(error.code)).map((error) => ({ app: item.app, ...error, intentional: true, reason: "The approved human adjudication takes precedence over this conservative deterministic evidence heuristic." })));
  const fatal = validations.flatMap((item) => (item.errors ?? []).map((error) => ({ app: item.app, ...error }))).filter((error) => {
    if (error.app === "Paygent Connect" && error.code === "identity_hint_conflict") return false;
    if (humanApprovedRecord.get(error.app) && humanSemanticOverrides.has(error.code)) return false;
    return true;
  });
  const intentional = validations.flatMap((item) => (item.errors ?? []).filter((error) => item.app === "Paygent Connect" && error.code === "identity_hint_conflict").map((error) => ({ app: item.app, ...error, intentional: true, reason: "The assignment hint conflict is an approved abstention, not a corruption." })));
  const duplicate = new Set(records.map((record) => record.app)).size !== records.length;
  if (records.length !== 100) throw new Error(`Final dataset must contain exactly 100 apps; found ${records.length}.`);
  if (duplicate) throw new Error("Final dataset contains duplicate apps.");
  const actualHoldout = records.map((record) => record.app).filter((app) => HOLDOUT_APPS.includes(app));
  if (actualHoldout.length !== HOLDOUT_APPS.length || new Set(actualHoldout).size !== HOLDOUT_APPS.length || actualHoldout.some((app) => !HOLDOUT_APPS.includes(app))) throw new Error("The locked holdout membership changed.");
  if (humanAdjudication.review_status !== "approved" || humanAdjudication.sample_size_apps !== 30) throw new Error("Human adjudication is missing or incomplete.");
  if (holdoutMetrics.reviewed_app_count !== 30) throw new Error("Holdout metrics do not cover the exact 30-app holdout.");
  if (fatal.length) throw new Error(`Final validation failed: ${JSON.stringify(fatal.slice(0, 10))}`);
  return { validations, fatal_errors: fatal, intentional_errors: [...intentional, ...humanOverridden], sweep_change_counts: { mcp_lifecycle: sweeps.mcp_lifecycle.changed_count, enterprise_commercial: sweeps.enterprise_commercial.changed_count } };
}

function secretCheck(values) {
  const secret = process.env.COMPOSIO_API_KEY;
  if (!secret) return;
  const serialized = values.map((value) => JSON.stringify(value)).join("\n");
  if (serialized.includes(secret)) throw new Error("The Composio API key appeared in an output artifact.");
}

async function ensureImmutableCopy(source, destination) {
  try {
    const existing = await readFile(destination);
    const original = await readFile(source);
    if (!existing.equals(original)) throw new Error(`Immutable baseline already exists but differs: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function run() {
  const startedAt = Date.now();
  const reviewedAt = nowIso();
  const manifest = await readJson(MANIFEST_PATH);
  const currentRecords = await readJson(path.join(FULL_RUN, "apps.final.json"));
  const fullPacket = await readJson(path.join(FULL_RUN, "human_review_packet.json"));
  const fullPacketMarkdown = await readFile(path.join(FULL_RUN, "human_review_packet.md"), "utf8");
  const ledger = await readJson(path.join(FULL_RUN, "evidence_ledger.json"));
  const catalog = await readJson(path.join(FULL_RUN, "composio_catalog.json"));
  if (manifest.apps.length !== 100 || new Set(manifest.apps.map((app) => app.app)).size !== 100) throw new Error("Canonical manifest must contain exactly 100 unique apps.");
  const computedHoldout = fixedHoldout(manifest);
  if (JSON.stringify(computedHoldout) !== JSON.stringify(HOLDOUT_APPS)) throw new Error(`The computed holdout differs from the locked holdout: ${computedHoldout.join(", ")}`);
  if (JSON.stringify((fullPacket.apps ?? []).map((app) => app.app)) !== JSON.stringify(HOLDOUT_APPS)) throw new Error("The current v2 packet does not contain the locked 30 apps.");
  await mkdir(FINAL_REVIEW, { recursive: true });
  await ensureImmutableCopy(path.join(FULL_RUN, "human_review_packet.json"), path.join(FINAL_REVIEW, "holdout_pre_human.json"));
  await ensureImmutableCopy(path.join(FULL_RUN, "human_review_packet.md"), path.join(FINAL_REVIEW, "holdout_pre_human.md"));
  await ensureImmutableCopy(path.join(FULL_RUN, "apps.final.json"), path.join(FINAL_REVIEW, "apps_pre_human.json"));
  const preHumanRecords = await readJson(path.join(FINAL_REVIEW, "apps_pre_human.json"));
  const cache = await buildCacheIndex();
  const ledgerByApp = new Map((ledger.sources ?? []).map((row) => [row.app, row.sources ?? []]));
  const sourceMap = new Map(manifest.apps.map((app) => [app.app, ledgerByApp.get(app.app) ?? []]));
  const harvestSources = recordSources(currentRecords.find((record) => record.app === "Harvest"), sourceMap, cache);
  const harvestValue = harvestCommercialValue(harvestSources);
  const humanAdjudication = makeHumanAdjudication(reviewedAt, harvestValue);
  await writeJson(path.join(FINAL_REVIEW, "human_adjudication.json"), humanAdjudication);

  const holdoutSet = new Set(HOLDOUT_APPS);
  const sweepRecords = structuredClone(preHumanRecords);
  const mcpSweep = runMcpStageSweep(sweepRecords, sourceMap, cache, holdoutSet, humanAdjudication.explicit_field_corrections, reviewedAt);
  const commercialSweep = runCommercialSweep(sweepRecords, sourceMap, cache, holdoutSet, reviewedAt);
  const sweeps = { schema_version: RUBRIC_VERSION, generated_at: reviewedAt, cache_only: true, mcp_lifecycle: mcpSweep, enterprise_commercial: commercialSweep };
  await writeJson(path.join(FINAL_REVIEW, "mcp_stage_consistency_sweep.json"), mcpSweep);
  await writeJson(path.join(FINAL_REVIEW, "commercial_friction_consistency_sweep.json"), commercialSweep);

  const finalRecords = structuredClone(sweepRecords);
  const appliedHumanCorrections = applyHumanAdjudication(finalRecords, preHumanRecords, humanAdjudication, reviewedAt);
  for (const record of finalRecords) {
    record.rubric_version = RUBRIC_VERSION;
    record.dataset_id = DATASET_ID;
    refreshUnknowns(record);
  }
  const holdoutMetrics = computeHoldoutMetrics(fullPacket, finalRecords, HOLDOUT_APPS);
  const finalHoldout = finalHoldoutJson(finalRecords, fullPacket, sweeps, reviewedAt);
  await writeJson(path.join(FINAL_REVIEW, "holdout_post_human.json"), finalHoldout);
  await writeFile(path.join(FINAL_REVIEW, "holdout_post_human.md"), markdownHoldout(finalHoldout), "utf8");
  const finalLedger = { ...ledger, dataset_id: DATASET_ID, schema_version: RUBRIC_VERSION, frozen_at: reviewedAt };
  const validation = finalValidation(finalRecords, manifest, humanAdjudication, holdoutMetrics, sweeps);
  const runtimeSeconds = (Date.now() - startedAt) / 1000;
  const verification = await readJson(path.join(FULL_RUN, "verification.json"));
  const metrics = buildMetrics(finalRecords, finalLedger, validation, sweeps, holdoutMetrics, reviewedAt, runtimeSeconds, catalog, verification);
  const analysis = buildAnalysis(metrics);
  const corrections = {
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    generated_at: reviewedAt,
    human_field_correction_count: appliedHumanCorrections.length,
    human_explicit_decision_count: humanAdjudication.explicit_field_corrections.length,
    human_actual_value_change_count: appliedHumanCorrections.filter((item) => !sameValue(item.previous_value, item.approved_value)).length,
    human_reaffirmed_value_count: appliedHumanCorrections.filter((item) => sameValue(item.previous_value, item.approved_value)).length,
    human_field_corrections: appliedHumanCorrections,
    cache_only_sweep_changes: [...mcpSweep.changes, ...commercialSweep.changes],
    protected_sweep_changes: [...mcpSweep.protected_changes, ...commercialSweep.protected_changes],
    note: "Human adjudication takes precedence over automatic consistency sweeps for the locked holdout."
  };
  await mkdir(FINAL, { recursive: true });
  await writeJson(path.join(FINAL, "apps.json"), finalRecords);
  await writeJson(path.join(FINAL, "evidence_ledger.json"), finalLedger);
  await writeJson(path.join(FINAL, "metrics.json"), metrics);
  await writeJson(path.join(FINAL, "analysis.json"), analysis);
  await writeJson(path.join(FINAL, "holdout_metrics.json"), holdoutMetrics);
  await writeJson(path.join(FINAL, "human_adjudication.json"), humanAdjudication);
  await writeJson(path.join(FINAL, "consistency_sweeps.json"), sweeps);
  await writeJson(path.join(FINAL, "verification.json"), { dataset_id: DATASET_ID, source: "full_run_verification_preserved", entries: verification });
  await writeJson(path.join(FINAL, "validation.json"), validation);
  await writeJson(path.join(FINAL, "corrections.json"), corrections);
  secretCheck([finalRecords, finalLedger, metrics, analysis, holdoutMetrics, humanAdjudication, sweeps, verification, validation, corrections]);
  const artifactNames = ["apps.json", "evidence_ledger.json", "metrics.json", "analysis.json", "holdout_metrics.json", "human_adjudication.json", "consistency_sweeps.json", "verification.json", "validation.json", "corrections.json"];
  const artifactHashes = {};
  for (const name of artifactNames) artifactHashes[name] = sha256(await readFile(path.join(FINAL, name)));
  const lockPath = path.join(FINAL, "DATASET_LOCK.json");
  // The lock timestamp must describe this post-adjudication freeze. Reusing an
  // older lock timestamp can make the snapshot appear frozen before the human
  // review it records.
  const frozenAt = reviewedAt;
  const lock = {
    dataset_status: "frozen",
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    rubric_version: RUBRIC_VERSION,
    app_count: 100,
    holdout_size: 30,
    human_review_status: "complete",
    frozen_at: frozenAt,
    source_ledger_count: ledgerStats(finalLedger).source_ledger_count,
    paid_cost: 0,
    paid_cost_usd: 0,
    artifact_hashes: artifactHashes,
    holdout_hash: sha256(HOLDOUT_APPS.join("\n")),
    notes: "The exact preregistered 30-app holdout was human-approved. No new network fetches or paid services were used during finalization."
  };
  await writeJson(lockPath, lock);
  await writeJson(path.join(FINAL_REVIEW, "finalization_summary.json"), {
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    finalized_at: reviewedAt,
    migrated_apps: finalRecords.length,
    new_network_fetches: 0,
    cache_files_indexed: cache.size,
    human_field_correction_count: appliedHumanCorrections.length,
    human_explicit_decision_count: humanAdjudication.explicit_field_corrections.length,
    human_actual_value_change_count: appliedHumanCorrections.filter((item) => !sameValue(item.previous_value, item.approved_value)).length,
    human_reaffirmed_value_count: appliedHumanCorrections.filter((item) => sameValue(item.previous_value, item.approved_value)).length,
    same_holdout: true,
    validation_errors: validation.fatal_errors.length,
    validation_intentional_errors: validation.intentional_errors.length,
    runtime_seconds: runtimeSeconds,
    paid_cost_usd: 0
  });
  console.log(JSON.stringify({
    dataset_id: DATASET_ID,
    schema_version: RUBRIC_VERSION,
    migrated_apps: finalRecords.length,
    new_network_fetches: 0,
    cache_files_indexed: cache.size,
    human_field_correction_count: appliedHumanCorrections.length,
    holdout_fields: holdoutMetrics.reviewed_field_count,
    exact_field_agreement: holdoutMetrics.exact_field_agreement,
    resolved_field_accuracy: holdoutMetrics.resolved_field_accuracy,
    mcp_stage_sweep_changes: mcpSweep.changed_count,
    commercial_sweep_changes: commercialSweep.changed_count,
    validation_errors: validation.fatal_errors.length,
    validation_intentional_errors: validation.intentional_errors.length,
    runtime_seconds: runtimeSeconds,
    paid_cost_usd: 0
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
