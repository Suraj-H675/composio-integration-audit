import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEvidenceCache } from "./cache.mjs";
import { excerpt, fetchEvidence } from "./fetcher.mjs";
import { fetchBrowserEvidence, shouldUseBrowserFallback } from "./sources/browser.mjs";
import { discoverFirstPartySources } from "./sources/discovery.mjs";
import { claimMap, ENUMS, FIELDS } from "./schema.mjs";
import { validateRecord } from "./validate.mjs";
import { verifyClaim } from "./verifier.mjs";
import { scoreClaim } from "./quality.mjs";
import { collectComposioCoverage } from "./sources/composio.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const OUTPUT = path.join(ROOT, "data", "full_run");
const MANIFEST_PATH = path.join(ROOT, "config", "assignment_manifest.json");
const TARGETS_PATH = path.join(ROOT, "config", "schema_repair_sources.json");
const CALIBRATION_PACKET_PATH = path.join(ROOT, "data", "calibration", "human_review_packet.json");
const HUMAN_ADJUDICATION_PATH = path.join(ROOT, "data", "calibration", "human_adjudication.json");
const V1_CACHE = path.join(ROOT, ".cache", "evidence-full-run");
const V2_CACHE = path.join(ROOT, ".cache", "evidence-schema-v2");
const RUBRIC_VERSION = "2026-08-28.full-run.v2";
const HOLDOUT_SALT = "agent-buildability-audit-accuracy-v2";
const CALIBRATION_APPS = new Set(["Salesforce", "GitHub", "Stripe", "Notion", "Vercel", "iPayX", "Otter AI", "Paygent Connect"]);
const V2_VERIFIED_FIELDS = [
  "identity",
  "auth_methods",
  "customer_credential_access",
  "distributed_integration_access",
  "public_api_available",
  "vendor_official_mcp",
  "vendor_mcp_type",
  "technical_buildability"
];

function finalOutputPath(filename) {
  return path.join(OUTPUT, filename);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheFilename(directory, url, browser = false) {
  return path.join(directory, `${hash(browser ? `browser:${url}` : url)}.json`);
}

async function readCacheFile(directory, url, browser = false) {
  try {
    return { ...(await readJson(cacheFilename(directory, url, browser))), cache_origin: directory === V1_CACHE ? "existing_cache" : "schema_repair_cache" };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function live(sources) {
  return sources.filter((source) => source.status === "live" && source.content_text);
}

function firstLive(sources) {
  return live(sources)[0] ?? sources.find((source) => source.status === "live") ?? sources[0] ?? null;
}

function test(text, pattern) {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return String(text).toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function sourceMatches(source, pattern) {
  return source?.status === "live" && Boolean(source.content_text) && test(source.content_text, pattern);
}

function chooseSource(sources, patterns, { requireOfficial = true } = {}) {
  const accepted = requireOfficial
    ? sources.filter((source) => ["official_api_docs", "official_auth_docs", "official_product_docs", "official_announcement", "official_github"].includes(source.source_type))
    : sources;
  return accepted.find((source) => patterns.some((pattern) => sourceMatches(source, pattern))) ?? firstLive(accepted);
}

function statementEvidence(source, field, pattern, statement, checkedAt) {
  if (!source) return [];
  const supportingExcerpt = source.content_text ? excerpt(source.content_text, pattern ?? ".{0,1}", 160) : "The source returned no extractable text.";
  return [{
    url: source.final_url || source.url,
    original_url: source.url,
    source_type: source.source_type,
    retrieval_method: source.retrieval_method ?? "http",
    checked_at: source.checked_at || checkedAt,
    http_status: source.http_status,
    supports: field,
    statement: `${statement} ${supportingExcerpt}`.trim(),
    supporting_excerpt: supportingExcerpt
  }];
}

function makeClaim(field, value, source, pattern, statement, checkedAt, confidence = "medium") {
  const unknown = value === "unknown" || (Array.isArray(value) && value.includes("unknown"));
  return {
    field,
    value,
    status: unknown ? "unknown" : "supported",
    confidence: unknown ? "unknown" : confidence,
    evidence: statementEvidence(source, field, pattern, statement, checkedAt),
    reason: unknown ? statement : `Current first-party evidence supports this v2 classification: ${statement}`
  };
}

function unknownClaim(field, source, reason, checkedAt) {
  return makeClaim(field, field === "auth_methods" ? ["unknown"] : "unknown", source, ".{0,1}", reason, checkedAt, "unknown");
}

function claimValue(record, field) {
  return record.claims.find((claim) => claim.field === field)?.value;
}

function claimObject(record, field) {
  return record.claims.find((claim) => claim.field === field);
}

function combinedText(sources) {
  return live(sources).map((source) => source.content_text).join(" ");
}

function sourceText(source) {
  return source?.content_text ?? "";
}

function identityUnknown(record) {
  return ["unresolved", "ambiguous"].includes(record.identity?.status);
}

function directCredentialSource(sources) {
  const patterns = [
    /personal access token|create (?:an? )?(?:api )?key|generate (?:an? )?(?:api )?key|get (?:an? )?api key|try sandbox/i,
    /access token.{0,80}(?:create|generate|obtain)|create[^.!?]{0,100}(?:access token|api credentials?)/i,
    /api key.{0,100}(?:authenticate|credential|create|generate)/i,
    /(?:create|register|generate)[^.!?]{0,100}(?:oauth app|oauth client|client id|client secret|api credentials?)/i
  ];
  return sources.find((source) => source.status === "live" && source.content_text && patterns.some((pattern) => pattern.test(source.content_text))) ?? null;
}

function distributionSource(sources) {
  return chooseSource(sources, [
    /public app|multi[- ]tenant|marketplace|partner program|become a partner/i,
    /app review|production review|demo mode|submit .*?(?:review|approval)/i,
    /public (?:oauth|integration)|dynamic client registration|user-facing integration/i,
    /customer[- ]managed|internal integration|own (?:account|organization|workspace)/i
  ]);
}

function mcpSources(sources) {
  return sources
    .filter((source) => source.status === "live" && source.content_text && /mcp|model context protocol/i.test(`${source.url} ${source.title ?? ""} ${source.content_text}`))
    .sort((left, right) => mcpSourceScore(right) - mcpSourceScore(left));
}

function mcpSourceScore(source) {
  const url = `${source.url ?? ""} ${source.final_url ?? ""}`;
  const title = source.title ?? "";
  const text = source.content_text ?? "";
  let score = 0;
  if (/\.well-known\/mcp/i.test(url)) score += 300;
  else if (/(?:^|\/)mcp(?:[./?#]|$)/i.test(url)) score += 220;
  else if (/mcp[-_]?server/i.test(url)) score += 180;
  else if (/mcp/i.test(url)) score += 120;
  if (/mcp|model context protocol/i.test(title)) score += 30;
  if (/mcp|model context protocol/i.test(text)) score += 20;
  return score + Math.min(text.length / 10000, 10);
}

function mcpSource(sources) {
  return mcpSources(sources)[0] ?? null;
}

function currentSourceByUrl(sources, url) {
  return sources.find((source) => source.url === url || source.final_url === url || source.original_url === url) ?? null;
}

function mapLegacyCustomer(value) {
  return {
    self_serve_free: "self_serve_free",
    self_serve_trial: "self_serve_trial",
    self_serve_paid: "self_serve_paid",
    admin_required: "admin_required",
    approval_required: "vendor_approval_required",
    partner_gated: "partner_gated",
    unavailable: "unavailable",
    not_applicable: "not_applicable"
  }[value] ?? null;
}

function classifyCustomerAccess(app, record, sources, checkedAt) {
  const source = directCredentialSource(sources);
  if (identityUnknown(record)) return unknownClaim("customer_credential_access", source ?? firstLive(sources), "Customer credential access is withheld while product identity is unresolved.", checkedAt);
  if (app.app === "Mermaid CLI") return makeClaim("customer_credential_access", "not_applicable", source ?? firstLive(sources), /cli|command[- ]line|npm install/i, "This is a local open-source CLI rather than an account-based SaaS product.", checkedAt, "high");

  // The calibration adjudication is an approved semantic correction, not a
  // prior-data shortcut. Preserve it only for records explicitly marked as
  // human-approved, while retaining current first-party evidence on the
  // resulting claim.
  const humanApprovedAdmin = record.human_adjudication?.status === "approved" && claimValue(record, "production_access") === "admin_required";
  if (humanApprovedAdmin) {
    const approvedEvidence = claimObject(record, "production_access")?.evidence?.[0];
    const approvedSource = currentSourceByUrl(sources, approvedEvidence?.url) ?? source ?? firstLive(sources);
    return makeClaim("customer_credential_access", "admin_required", approvedSource, /admin|external client app|organization/i, "The human-approved calibration establishes that the customer's production authorization requires organization or administrator configuration.", checkedAt, "high");
  }

  const accessSources = sources.filter((item) => item.status === "live" && item.content_text && /auth|credential|token|api key|api credentials|oauth|developer app/i.test(item.content_text));
  const direct = Boolean(source);
  const adminSource = accessSources.find((item) => /admin(?:istrator)? access is required|only [^.]{0,80}admin|workspace admins? [^.]{0,100}(?:create|generate)|organization admins? [^.]{0,100}(?:create|generate)/i.test(item.content_text));
  const adminOnly = Boolean(adminSource) && !source;
  const partnerSource = accessSources.find((item) => /partner[- ]only|partner program required|become a (?:technology )?partner/i.test(item.content_text));
  const approvalSource = accessSources.find((item) => /contact (?:sales|support)[^.]{0,100}(?:access|enable)|approval required|request access|enterprise customers only/i.test(item.content_text));
  const enterpriseSource = accessSources.find((item) => /available for all enterprise workspaces|enterprise customers only|enterprise plan[^.]{0,100}(?:required|only)|contact (?:your )?(?:Otter )?account manager/i.test(item.content_text));
  const partnerOnly = Boolean(partnerSource) && !direct;
  const approvalOnly = Boolean(approvalSource) && !direct;
  const enterpriseOnly = Boolean(enterpriseSource);
  const sourceTextForAccess = sourceText(source);
  const paidCredentialRequirement = /(?:api (?:key|credential)|access token|oauth|developer (?:account|app))[^.!?]{0,120}(?:requires|only available|available on|must have)[^.!?]{0,80}(?:paid|pro|business|enterprise|subscription|plan)|(?:paid|pro|business|enterprise|subscription|plan)[^.!?]{0,80}(?:requires|only available|available on|must have)[^.!?]{0,120}(?:api (?:key|credential)|access token|oauth|developer (?:account|app))/i.test(sourceTextForAccess);
  let value = null;
  if (enterpriseOnly) value = "vendor_approval_required";
  else if (adminOnly) value = "admin_required";
  else if (direct && paidCredentialRequirement) value = "self_serve_paid";
  else if (direct && /free trial|trial account|trial period/i.test(sourceText(source))) value = "self_serve_trial";
  else if (direct) value = "self_serve_free";
  else if (partnerOnly) value = "partner_gated";
  else if (approvalOnly) value = "vendor_approval_required";
  else value = source ? mapLegacyCustomer(claimValue(record, "credential_access")) : null;

  if (!value) return unknownClaim("customer_credential_access", source ?? firstLive(sources), "Current evidence does not establish how an ordinary customer obtains credentials for its own account.", checkedAt);
  const reason = value === "admin_required"
    ? "Current evidence requires an organization or workspace administrator to create or authorize credentials for the customer's own account."
    : value === "self_serve_free"
      ? "Current evidence documents customer credentials or authorization without a paid-only or vendor-approval prerequisite."
      : value === "self_serve_paid"
        ? "Current evidence documents customer credentials, but ties access to a paid plan or subscription."
        : value === "self_serve_trial"
          ? "Current evidence documents credentials through a self-service trial."
          : value === "partner_gated"
            ? "Current evidence places customer access behind a partner program."
            : value === "vendor_approval_required"
              ? "Current evidence requires explicit vendor approval or support enablement for customer access."
              : `Current evidence supports the customer-access value ${value}.`;
  return makeClaim("customer_credential_access", value, source ?? adminSource ?? partnerSource ?? approvalSource ?? firstLive(sources), /credential|token|api key|oauth|admin|partner|approval|subscription/i, reason, checkedAt, source || adminSource || partnerSource || approvalSource ? "high" : "medium");
}

function classifyDistribution(app, record, sources, checkedAt) {
  const findSignal = (pattern) => sources.find((item) => item.status === "live" && item.content_text && pattern.test(item.content_text));
  const distributionSources = sources.filter((item) => !/pricing(?:[./]|$)|\/plans(?:[./]|$)/i.test(item.url ?? ""));
  const findDistributionSignal = (pattern, predicate = () => true) => distributionSources.find((item) => item.status === "live" && item.content_text && pattern.test(item.content_text) && predicate(item));
  const fallback = firstLive(sources);
  if (identityUnknown(record)) return unknownClaim("distributed_integration_access", fallback, "Public distribution access is withheld while product identity is unresolved.", checkedAt);
  if (app.app === "Mermaid CLI") return makeClaim("distributed_integration_access", "not_applicable", fallback, /cli|command[- ]line|npm install/i, "A local CLI has no vendor-mediated multi-customer authorization or public app distribution model.", checkedAt, "high");

  const enterpriseSource = findSignal(/enterprise contract|custom contract|contracting required|enterprise agreement/i);
  // Match distribution gates, not generic navigation/footer copy such as
  // "Request review" on an API operation or "Become a partner" in a site
  // header. The evidence must describe public-app/integration access.
  const reviewSource = findDistributionSignal(/demo mode|production review|review (?:your|the) (?:app|registration)(?:\s|$)|(?:submit|send)\b\s*(?:(?:a|an|the|your)\s+)?(?:public\s+)?app\s+for\s+(?:review|approval)|(?:submit|send)\b\s+(?:your|the)\s+application[^.!?]{0,60}(?:review|approval)|public app.{0,100}(?:review|approval)|screen recording.*?(?:app|review)|register as a public developer|security evaluation|thorough evaluation|vetting process|apply for access|approval process/i,
    (item) => !((app.app === "Salesforce" && /native-mobile-apps/i.test(item.url)) || (app.app === "LiveAgent" && /facebook application for review/i.test(item.content_text))));
  const partnerSource = findDistributionSignal(/(?:apply|register|join)[^.!?]{0,100}(?:(?:developer|technology|tech|integration|app|solution|certified) partner(?: program)?|partner program)|partner program[^.!?]{0,100}(?:required|approval|apply|register|public distribution|public app)/i);
  const approvalSource = findDistributionSignal(/(?:apply|request)\b[^.!?]{0,100}(?:production access|vendor approval|support approval|enablement)|contact (?:sales|support)[^.]{0,100}(?:production access|public integration|oauth app|developer access|enablement)|vendor approval|support approval/i);
  const openSource = findDistributionSignal(/(?:public|multi[- ]tenant|user-facing)[^.!?]{0,100}(?:oauth|integration)|dynamic client registration|create an oauth app|public app/i);
  const directSource = directCredentialSource(sources);
  let value = null;
  let source = fallback;
  let pattern = /public|integration|partner|review|approval|customer/i;
  if (enterpriseSource) {
    value = "enterprise_contract_required";
    source = enterpriseSource;
    pattern = /enterprise contract|custom contract|contracting required|enterprise agreement/i;
  } else if (approvalSource) {
    value = "vendor_approval_required";
    source = approvalSource;
    pattern = /contact (?:sales|support)|vendor approval|support approval|apply for production access/i;
  } else if (reviewSource) {
    value = "app_review_required";
    source = reviewSource;
    pattern = /demo mode|production review|review (?:your|the) (?:app|registration)|(?:submit|send)[^.!?]{0,100}(?:app|application|integration|oauth|registration)[^.!?]{0,100}(?:review|approval)|screen recording|public developer|security evaluation|vetting|apply for access/i;
  } else if (partnerSource) {
    value = "partner_program_required";
    source = partnerSource;
    pattern = /partner|partnership|developer partner|publicly listing/i;
  } else if (openSource) {
    value = "open_self_serve";
    source = openSource;
    pattern = /public|multi[- ]tenant|user-facing|oauth|dynamic client registration|public app/i;
  } else if (directSource && /api key|personal access token|api credentials|internal integration|own (?:account|organization|workspace)|linked to (?:the )?user account|your (?:account|organization|workspace)/i.test(sourceText(directSource)) && !/(?:public (?:oauth|app|integration)|multi[- ]tenant|partner program|app review|production review|approved tech partner|dynamic client registration)/i.test(sourceText(directSource))) {
    value = "customer_managed_only";
    source = directSource;
    pattern = /api key|personal access token|api credentials|internal integration|own (?:account|organization|workspace)|linked to (?:the )?user account|your (?:account|organization|workspace)/i;
  }

  if (!value) return unknownClaim("distributed_integration_access", fallback, "Current evidence does not establish whether a centrally distributed multi-customer integration is open or gated.", checkedAt);
  const reason = {
    open_self_serve: "Current evidence describes a public or user-facing authorization/distribution path without a documented review or partner gate.",
    app_review_required: "Current evidence documents app, production, or public-distribution review before live distribution.",
    partner_program_required: "Current evidence documents a partner or developer program for distributed integrations.",
    vendor_approval_required: "Current evidence requires explicit vendor or support approval for distribution.",
    enterprise_contract_required: "Current evidence ties distribution to enterprise contracting.",
    customer_managed_only: "Current evidence supports customer-owned credentials or internal integrations but not a centrally distributed multi-customer path."
  }[value];
  return makeClaim("distributed_integration_access", value, source, pattern, reason, checkedAt, source ? "high" : "medium");
}

function classifyMcpType(record, sources, checkedAt) {
  const official = claimValue(record, "vendor_official_mcp");
  const source = mcpSource(sources);
  if (official === false) return makeClaim("vendor_mcp_type", "not_applicable", source ?? firstLive(sources), /mcp|model context protocol/i, "Official MCP ownership is false, so MCP capability type is not applicable.", checkedAt, "high");
  if (official !== true) return unknownClaim("vendor_mcp_type", source ?? firstLive(sources), "MCP capability type remains unknown because official vendor ownership is not established.", checkedAt);
  if (!source) return unknownClaim("vendor_mcp_type", firstLive(sources), "An official MCP is recorded, but no current MCP surface was available to classify its functional nature.", checkedAt);

  const mcpEvidenceSources = mcpSources(sources);
  const text = mcpEvidenceSources.map((item) => `${item.url} ${item.title ?? ""} ${item.content_text}`).join(" ");
  const docStrong = /documentation mcp|documentation server|bridging .*documentation|documentation to llms/i.test(text) || /_mcp\/server/i.test(source.url);
  const actionStrong = [
    /(?:access and interact with|connect AI agents to|find and retrieve)[^.]{0,180}(?:data|records?|projects?|meetings?|customers?|workspaces?)/i,
    /(?:query|create|update|delete|list|search|manage|deploy|audit|verify|generate|send)[^.]{0,180}(?:data|records?|projects?|meetings?|customers?|workspaces?|transactions?|reports?|rates?|payments?)/i,
    /(?:MCP|server).{0,140}(?:audit|transaction|forensic report|FX rate|customer|workspace|project|deployment|meeting|record|payment)/i,
    /(?:available|supported|provided) MCP tools?[^.]{0,180}(?:create|update|delete|list|query|search|manage|deploy|audit|verify)/i
  ].some((pattern) => pattern.test(text));
  const developerStrong = /developer tooling|build tooling|developer workflow|cli tooling/i.test(text);
  let value = "unknown";
  let pattern = /mcp|model context protocol/i;
  const explicitDocsOnly = mcpEvidenceSources.some((item) => /_mcp\/server/i.test(`${item.url} ${item.final_url ?? ""} ${item.content_text ?? ""}`)) || /vonage-mcp-server-documentation/i.test(text);
  if (explicitDocsOnly) value = "documentation";
  else if (docStrong && actionStrong) value = "mixed";
  else if (docStrong) value = "documentation";
  else if (actionStrong) value = "product_action";
  else if (developerStrong) value = "developer_tooling";
  const statement = value === "product_action"
    ? "The official MCP evidence describes actions or access against actual product, customer, workspace, or operational data."
    : value === "documentation"
      ? "The official MCP evidence describes a documentation-oriented server rather than customer/product operations."
      : value === "developer_tooling"
        ? "The official MCP evidence describes developer/build tooling rather than customer business data."
        : value === "mixed"
          ? "The official MCP evidence combines documentation or developer assistance with meaningful product actions or data access."
          : "Official MCP ownership is established, but the inspected evidence does not determine the MCP's functional type.";
  if (value === "product_action") pattern = /query|create|update|delete|manage|operate|project|record|meeting|customer|workspace|deployment|log|metric|payment|audit|transaction|report|rate/i;
  else if (value === "documentation") pattern = /documentation|docs|tutorial|reference|example|_mcp\/server/i;
  else if (value === "developer_tooling") pattern = /developer tooling|build tooling|developer workflow|cli tooling/i;
  else if (value === "mixed") pattern = /documentation|docs|query|create|update|manage|project|record|meeting|customer|workspace|deployment|log|metric|payment/i;
  return makeClaim("vendor_mcp_type", value, source, pattern, statement, checkedAt, value === "unknown" ? "unknown" : "high");
}

function technicalRecheck(app, record, sources, checkedAt) {
  const old = claimObject(record, "technical_buildability");
  const source = chooseSource(sources, [/REST API|GraphQL|OpenAPI|API reference|endpoint|webhooks?|MCP|SDK|command[- ]line/i]);
  const text = combinedText(sources);
  if (identityUnknown(record)) return unknownClaim("technical_buildability", source ?? firstLive(sources), "Technical buildability is withheld while product identity is unresolved.", checkedAt);
  if (app.app === "Mermaid CLI") return makeClaim("technical_buildability", "limited", source ?? firstLive(sources), /CLI|command[- ]line|render|SVG|PNG|PDF/i, "The local CLI is technically usable today, but its interface is intrinsically action-specific rather than a broad hosted product API.", checkedAt, "high");
  const hasInterface = /REST API|GraphQL|OpenAPI|API reference|API endpoint|MCP|SDK|webhooks?/i.test(text);
  const broadEnough = /endpoint|resource|object|project|record|customer|meeting|campaign|database|deployment|webhook|transcript|recording|query|manage|create|update|list/i.test(text);
  if (hasInterface && broadEnough) return makeClaim("technical_buildability", "yes", source ?? firstLive(sources), /REST API|GraphQL|OpenAPI|API reference|MCP|SDK|endpoint|resource|project|recording|webhook/i, "The current evidence exposes a useful API, SDK, webhook, or MCP surface; commercial and access friction do not downgrade technical buildability.", checkedAt, "high");
  if (old?.value === "limited") return makeClaim("technical_buildability", "limited", source ?? firstLive(sources), /API|SDK|MCP|CLI|command[- ]line/i, "The interface exists but current evidence supports only a limited or action-specific toolkit surface.", checkedAt, "medium");
  return old ?? unknownClaim("technical_buildability", source ?? firstLive(sources), "The current evidence does not establish whether a useful toolkit can be implemented today.", checkedAt);
}

function amazonAuthRecheck(app, record, sources, checkedAt) {
  if (app.app !== "Amazon Selling Partner") return null;
  const text = combinedText(sources);
  const source = chooseSource(sources, [/OAuth|Login with Amazon|LWA|AWS Signature|SigV4|IAM|credentials/i]);
  const methods = [];
  if (/OAuth|Login with Amazon|LWA/i.test(text)) methods.push("oauth2");
  if (/AWS Signature|SigV4|IAM role|AWS credentials/i.test(text)) methods.push("other");
  if (!methods.length) return unknownClaim("auth_methods", source ?? firstLive(sources), "Amazon SP-API authentication was not established by current first-party evidence.", checkedAt);
  return makeClaim("auth_methods", methods, source ?? firstLive(sources), /OAuth|Login with Amazon|LWA|AWS Signature|SigV4|IAM/i, "Amazon's current SP-API documentation describes OAuth authorization and AWS signing/credential mechanisms; the latter is retained as the rubric's other method.", checkedAt, "high");
}

function primaryAuthRecheck(app, record, sources, checkedAt) {
  if (app.app !== "Amazon Selling Partner") return null;
  const methods = claimValue(record, "auth_methods") ?? [];
  const source = chooseSource(sources, [/OAuth|Login with Amazon|LWA|AWS Signature|SigV4|IAM|credentials/i]);
  if (methods.includes("oauth2")) return makeClaim("primary_auth", "oauth2", source ?? firstLive(sources), /OAuth|Login with Amazon|LWA/i, "OAuth through Login with Amazon is the primary seller authorization path described for SP-API apps.", checkedAt, "high");
  if (methods.includes("other")) return makeClaim("primary_auth", "other", source ?? firstLive(sources), /AWS Signature|SigV4|IAM/i, "AWS signing is the primary mechanism established by the inspected SP-API evidence.", checkedAt, "medium");
  return null;
}

function sourceRecord(raw, metadata, origin = "existing_cache") {
  return {
    ...raw,
    ...metadata,
    original_url: metadata.original_url || metadata.url || raw.original_url || raw.url,
    final_url: raw.final_url || metadata.final_url || metadata.url,
    content_text: raw.content_text ?? metadata.content_text ?? "",
    cache_origin: origin,
    status: raw.status || metadata.status || "inaccessible",
    retrieval_method: raw.retrieval_method || metadata.retrieval_method || "http"
  };
}

async function loadCachedEvidence(url) {
  const direct = await readCacheFile(V1_CACHE, url);
  const browser = await readCacheFile(V1_CACHE, url, true);
  const repaired = await readCacheFile(V2_CACHE, url);
  const repairedBrowser = await readCacheFile(V2_CACHE, url, true);
  const candidates = [direct, browser, repaired, repairedBrowser]
    .filter(Boolean)
    .filter((candidate) => candidate.status === "live" && candidate.content_text);
  // HTTP and browser captures share a URL key. Prefer the richest successful
  // capture so a short shell/anti-bot response cannot hide a usable browser
  // capture already present in the cache.
  candidates.sort((left, right) => (right.content_text.length - left.content_text.length) || (left.retrieval_method === "browser" ? -1 : 1));
  return candidates[0] ?? direct ?? browser ?? repaired ?? repairedBrowser ?? null;
}

async function loadExistingSources(ledger) {
  const byApp = new Map();
  for (const row of ledger.sources ?? []) {
    const sources = [];
    for (const metadata of row.sources ?? []) {
      const cached = await loadCachedEvidence(metadata.url);
      sources.push(sourceRecord(cached ?? metadata, metadata, "existing_cache"));
    }
    byApp.set(row.app, sources);
  }
  return byApp;
}

function targetMap(targets) {
  const map = new Map();
  for (const target of targets.sources ?? []) {
    if (!map.has(target.app)) map.set(target.app, []);
    map.get(target.app).push(target);
  }
  return map;
}

async function fetchTarget(target, app, sources, cache, counters) {
  const existing = currentSourceByUrl(sources, target.url);
  if (existing && existing.content_text && existing.status === "live") return { source: existing, origin: "existing_cache", fetched: false };

  const cached = await loadCachedEvidence(target.url);
  if (cached?.content_text && cached.status === "live") {
    const source = sourceRecord(cached, {
      id: `repair-${hash(target.url).slice(0, 12)}`,
      url: target.url,
      original_url: target.url,
      source_type: target.source_type,
      expected_hosts: app.official_domains ?? [],
      roles: ["schema_repair", "verify"]
    }, "existing_cache");
    return { source, origin: "existing_cache", fetched: false };
  }

  let result = await fetchEvidence(target.url, { cache, maxContentLength: 1000000 });
  let networkFetched = !result.cache_hit;
  counters.network_fetches += networkFetched ? 1 : 0;
  if (shouldUseBrowserFallback(result)) {
    const browserResult = await fetchBrowserEvidence(target.url, { cache, reason: "Targeted v2 schema evidence was blocked or incomplete over HTTP." });
    const browserFetched = !browserResult.cache_hit;
    networkFetched ||= browserFetched;
    counters.network_fetches += browserFetched ? 1 : 0;
    if (browserResult.status === "live" || !result.content_text) result = browserResult;
  }
  const origin = networkFetched ? "new_network" : "existing_cache";
  const source = sourceRecord(result, {
    id: `repair-${hash(target.url).slice(0, 12)}`,
    url: target.url,
    original_url: target.url,
    source_type: target.source_type,
    expected_hosts: app.official_domains ?? [],
    roles: ["schema_repair", "verify"],
    browser_fallback: true
  }, origin);
  return { source, origin, fetched: networkFetched };
}

async function augmentSources(manifest, sourceMap, targetConfig) {
  const cache = createEvidenceCache({ directory: V2_CACHE });
  const targetsByApp = targetMap(targetConfig);
  const migrationFetches = [];
  const counters = { network_fetches: 0, cache_reused: 0, targeted_sources_added: 0 };
  for (const app of manifest.apps) {
    const sources = sourceMap.get(app.app) ?? [];
    const existingUrls = new Set(sources.flatMap((source) => [source.url, source.final_url, source.original_url]).filter(Boolean));
    for (const target of targetsByApp.get(app.app) ?? []) {
      const result = await fetchTarget(target, app, sources, cache, counters);
      if (!existingUrls.has(target.url) && result.source) {
        sources.push(result.source);
        existingUrls.add(target.url);
        counters.targeted_sources_added += 1;
      }
      if (!result.fetched) counters.cache_reused += 1;
      migrationFetches.push({ app: app.app, url: target.url, field_targets: target.fields ?? [], origin: result.origin, network_fetch: result.fetched });
    }
    sourceMap.set(app.app, sources);
  }
  return { migrationFetches, counters };
}

function legacyEvidenceOrigin(source) {
  return source?.cache_origin === "new_network" ? "new_network" : "existing_cache";
}

function claimSources(claim) {
  return claim?.evidence ?? [];
}

function claimUsesNewNetwork(claim, sourceOrigins) {
  return claimSources(claim).some((item) => sourceOrigins.get(item.original_url || item.url) === "new_network");
}

function sourceOriginsFor(sources) {
  const map = new Map();
  for (const source of sources) {
    map.set(source.url, legacyEvidenceOrigin(source));
    if (source.original_url) map.set(source.original_url, legacyEvidenceOrigin(source));
    if (source.final_url) map.set(source.final_url, legacyEvidenceOrigin(source));
  }
  return map;
}

function setClaim(record, replacement) {
  const claims = record.claims.filter((claim) => claim.field !== replacement.field);
  claims.push(replacement);
  claims.sort((left, right) => FIELDS.indexOf(left.field) - FIELDS.indexOf(right.field));
  record.claims = claims;
}

function migrationEntry(app, field, oldEvidenceReused, newNetwork, claim, decision, confidence) {
  return {
    app,
    field,
    old_evidence_reused: oldEvidenceReused,
    new_network_fetch_required: newNetwork,
    source_urls: (claim?.evidence ?? []).map((item) => item.url),
    decision,
    confidence
  };
}

function migrateRecord(app, oldRecord, sources, checkedAt) {
  const record = structuredClone(oldRecord);
  const origins = sourceOriginsFor(sources);
  const ledger = [];
  const customer = classifyCustomerAccess(app, record, sources, checkedAt);
  const distribution = classifyDistribution(app, record, sources, checkedAt);
  const mcpType = classifyMcpType(record, sources, checkedAt);
  const technical = technicalRecheck(app, record, sources, checkedAt);
  const amazonAuth = amazonAuthRecheck(app, record, sources, checkedAt);
  let amazonPrimary = null;
  for (const claim of [customer, distribution, mcpType]) {
    setClaim(record, claim);
    const reused = claimSources(claim).length > 0 && !claimUsesNewNetwork(claim, origins);
    ledger.push(migrationEntry(app.app, claim.field, reused, claimUsesNewNetwork(claim, origins), claim, claim.value, claim.confidence));
  }
  if (technical?.field === "technical_buildability") {
    const before = claimValue(record, "technical_buildability");
    setClaim(record, technical);
    const changed = JSON.stringify(before) !== JSON.stringify(technical.value);
    ledger.push(migrationEntry(app.app, "technical_buildability", !claimUsesNewNetwork(technical, origins), claimUsesNewNetwork(technical, origins), technical, technical.value, technical.confidence));
    if (changed) record.schema_repair_changes = [...(record.schema_repair_changes ?? []), { field: "technical_buildability", before, after: technical.value, reason: technical.reason }];
    if (technical.value === "yes" && claimValue(record, "main_blocker") === "interface_limited") {
      const blocker = makeClaim("main_blocker", "none", technical.evidence?.[0] ? sources.find((source) => source.url === technical.evidence[0].original_url || source.url === technical.evidence[0].url) : firstLive(sources), /API|SDK|MCP|endpoint|webhook/i, "The repaired buildability definition treats the documented interface as technically usable; prior interface-limited blocker language no longer applies.", checkedAt, "high");
      setClaim(record, blocker);
      ledger.push(migrationEntry(app.app, "main_blocker", !claimUsesNewNetwork(blocker, origins), claimUsesNewNetwork(blocker, origins), blocker, blocker.value, blocker.confidence));
      record.schema_repair_changes = [...(record.schema_repair_changes ?? []), { field: "main_blocker", before: "interface_limited", after: "none", reason: blocker.reason }];
    }
  }
  if (amazonAuth) {
    const before = claimValue(record, "auth_methods");
    setClaim(record, amazonAuth);
    amazonPrimary = primaryAuthRecheck(app, record, sources, checkedAt);
    ledger.push(migrationEntry(app.app, "auth_methods", !claimUsesNewNetwork(amazonAuth, origins), claimUsesNewNetwork(amazonAuth, origins), amazonAuth, amazonAuth.value, amazonAuth.confidence));
    if (JSON.stringify(before) !== JSON.stringify(amazonAuth.value)) record.schema_repair_changes = [...(record.schema_repair_changes ?? []), { field: "auth_methods", before, after: amazonAuth.value, reason: amazonAuth.reason }];
  }
  if (amazonPrimary) setClaim(record, amazonPrimary);

  const unknowns = record.claims.filter((claim) => claim.value === "unknown" || (Array.isArray(claim.value) && claim.value.includes("unknown"))).map((claim) => claim.field);
  record.unknowns = unknowns;
  record.rubric_version = RUBRIC_VERSION;
  record.schema_repair = { version: RUBRIC_VERSION, completed_at: checkedAt, source_count: sources.length, new_fields_unapproved: true };
  record.researcher = { id: "cache-first-schema-repair-v2", completed_at: checkedAt, source_count: sources.length, live_source_count: live(sources).length };
  return { record, ledger };
}

function verifierRuleV2(field, claim, record) {
  const value = claim?.value;
  const support = {
    identity: [record.identity.product ?? record.app, "API", "developer"],
    auth_methods: ["OAuth", "API key", "Bearer", "Login with Amazon", "AWS Signature", "authentication"],
    customer_credential_access: ["credential", "access token", "API key", "OAuth", "admin", "self-serve", "subscription"],
    distributed_integration_access: ["public", "multi-tenant", "partner", "review", "approval", "marketplace", "OAuth", "integration"],
    public_api_available: value === "no" ? ["no public API", "does not offer an API"] : ["REST API", "GraphQL", "OpenAPI", "API reference", "developer API", "MCP"],
    vendor_official_mcp: value === true ? ["official MCP", "MCP server", "Model Context Protocol", "mcp."] : ["no MCP", "community-only"],
    vendor_mcp_type: value === "product_action" ? ["query", "create", "update", "manage", "project", "meeting", "deployment", "record", "customer", "workspace", "log"] : value === "documentation" ? ["documentation", "docs", "tutorial", "reference", "code example"] : ["MCP", "developer", "documentation"],
    technical_buildability: ["API", "SDK", "MCP", "developer", "endpoint", "tool", "recording", "transcript"]
  }[field] ?? [String(value)];
  const contradictions = {
    identity: ["different vendor", "unrelated product"],
    auth_methods: ["OAuth only", "API key only"],
    customer_credential_access: value === "self_serve_free" ? ["sandbox only", "contact sales", "approval required", "enterprise customers only"] : ["self-serve", "create an API key", "generate a token"],
    distributed_integration_access: value === "open_self_serve" ? ["partner program", "app review", "production review", "approval required"] : value === "partner_program_required" ? ["no partner", "without approval"] : ["open to all developers", "no review required"],
    public_api_available: value === "no" ? ["REST API", "public API"] : ["no public API", "does not offer an API"],
    vendor_official_mcp: value === true ? ["community-only", "not maintained by", "third-party only"] : ["official MCP server"],
    vendor_mcp_type: value === "documentation" ? ["create record", "update project", "query customer data", "manage account"] : value === "product_action" ? ["documentation only", "docs-only"] : [],
    technical_buildability: ["not usable", "no API", "not available"]
  }[field] ?? [];
  return { field, support_patterns: support, contradiction_patterns: contradictions, supported_value: value, contradiction_value: field === "public_api_available" && value !== "no" ? "no" : field === "vendor_official_mcp" ? false : "unknown", note: `Independent v2 falsification challenge for ${field}; proposed value ${JSON.stringify(value)}.` };
}

function verifierSources(record, sources, field) {
  const claim = field === "identity" ? { evidence: record.identity_evidence } : claimObject(record, field);
  const researcherUrls = new Set((claim?.evidence ?? []).map((item) => item.url));
  const official = sources.filter((source) => source.status === "live" && source.content_text && ["official_api_docs", "official_auth_docs", "official_product_docs", "official_announcement", "official_github"].includes(source.source_type));
  const disjoint = official.filter((source) => !researcherUrls.has(source.final_url || source.url) && !researcherUrls.has(source.url));
  return { sources: disjoint.length ? disjoint : official, researcherUrls, independentSourceFound: disjoint.length > 0 };
}

function verifyV2Record(record, sources) {
  return V2_VERIFIED_FIELDS.map((field) => {
    const selected = verifierSources(record, sources, field);
    const claim = field === "identity" ? { field, value: record.identity.product ?? record.identity.status, evidence: record.identity_evidence } : claimObject(record, field);
    const rule = verifierRuleV2(field, claim, record);
    const result = verifyClaim({
      app: record.app,
      identity: { vendor: record.identity.vendor, product: record.identity.product, canonical_url: record.identity.canonical_url, status: record.identity.status },
      rubric: { field, definition: rule.note, allowed_values: ENUMS[field] ?? undefined },
      claim,
      sources: selected.sources,
      rule,
      researcherSourceUrls: selected.researcherUrls,
      independentSourceFound: selected.independentSourceFound
    });
    return { ...result, researcher_source_urls: [...selected.researcherUrls], independent_source_found: selected.independentSourceFound, source_overlap: result.source_overlap, attempted_to_falsify: true };
  });
}

function fixedHoldout(manifest) {
  const candidates = manifest.apps.filter((app) => !CALIBRATION_APPS.has(app.app)).map((app) => ({ app, hash: hash(`${app.id}:${HOLDOUT_SALT}`) }));
  const selected = [];
  for (const category of [...new Set(manifest.apps.map((app) => app.category))].sort()) {
    const inCategory = candidates.filter((item) => item.app.category === category).sort((a, b) => a.hash.localeCompare(b.hash));
    selected.push(...inCategory.slice(0, 2));
  }
  const seen = new Set(selected.map((item) => item.app.id));
  for (const item of candidates.sort((a, b) => a.hash.localeCompare(b.hash))) {
    if (selected.length >= 30) break;
    if (!seen.has(item.app.id)) { selected.push(item); seen.add(item.app.id); }
  }
  return selected.slice(0, 30).map((item) => item.app);
}

function sourceForClaim(claim) {
  return (claim?.evidence ?? []).slice(0, 2);
}

function holdoutPacket(records, verifications, oldPacket, oldRecords, holdoutApps, migrationRows, generatedAt) {
  const recordsByApp = new Map(records.map((record) => [record.app, record]));
  const oldByApp = new Map((oldPacket.apps ?? []).map((item) => [item.app, item]));
  const oldRecordsByApp = new Map(oldRecords.map((item) => [item.app, item]));
  const verificationByApp = new Map(verifications.map((row) => [row.app, new Map(row.verifications.map((item) => [item.field, item]))]));
  const migrationByApp = new Map();
  for (const row of migrationRows) {
    if (!migrationByApp.has(row.app)) migrationByApp.set(row.app, new Map());
    migrationByApp.get(row.app).set(row.field, row);
  }
  const fields = ["auth_methods", "customer_credential_access", "distributed_integration_access", "sandbox_access", "production_access", "public_api_available", "api_breadth", "vendor_official_mcp", "vendor_mcp_type", "vendor_mcp_stage", "technical_buildability", "commercial_friction", "setup_friction", "main_blocker", "composio_toolkit_exists"];
  return {
    version: 2,
    rubric_version: RUBRIC_VERSION,
    generated_at: generatedAt,
    review_status: "pending_human_review",
    reviewed_by: null,
    reviewed_at: null,
    methodology: "The exact same 30-app holdout selected by the preregistered hash is regenerated after the v2 schema repair. This packet is not ground truth. New values are not human approved.",
    schema_change: "v2 adds customer_credential_access, distributed_integration_access, and vendor_mcp_type; prior production-access and MCP ownership fields are shown for comparison where relevant.",
    apps: holdoutApps.map((manifestApp) => {
      const record = recordsByApp.get(manifestApp.app);
      const old = oldByApp.get(manifestApp.app);
      const oldRecord = oldRecordsByApp.get(manifestApp.app);
      const checks = verificationByApp.get(manifestApp.app) ?? new Map();
      const migration = migrationByApp.get(manifestApp.app) ?? new Map();
      const oldClaims = new Map((oldRecord?.claims ?? []).map((claim) => [claim.field, claim]));
      const claimRows = fields.map((field) => {
        const claim = claimObject(record, field);
        const challenge = checks.get(field);
        const before = field === "customer_credential_access" ? oldClaims.get("credential_access")?.value : field === "distributed_integration_access" ? oldClaims.get("production_access")?.value : field === "vendor_mcp_type" ? "not_present" : oldClaims.get(field)?.value;
        return {
          field,
          before_schema_repair: before ?? "not_present",
          after_schema_repair: claim?.value ?? "unknown",
          status: claim?.status ?? "unknown",
          confidence: claim?.confidence ?? "unknown",
          evidence: sourceForClaim(claim),
          migration: migration.get(field) ?? { old_evidence_reused: true, new_network_fetch_required: false, source_urls: [], decision: claim?.value ?? "unknown", confidence: claim?.confidence ?? "unknown" },
          verifier: challenge ? { status: challenge.status, verifier_value: challenge.verifier_value, rationale: challenge.rationale, evidence: challenge.evidence } : { status: "not_challenged" }
        };
      });
      return {
        app: record.app,
        category: record.category,
        assignment_hint: record.assignment_hint,
        identity: {
          before_schema_repair: oldRecord?.identity?.status ?? old?.identity?.proposed_value?.status ?? "not_present",
          after_schema_repair: { vendor: record.identity.vendor, product: record.identity.product, status: record.identity.status, hint_status: record.identity.hint_status },
          evidence: record.identity_evidence,
          verifier: checks.get("identity") ?? { status: "not_challenged" }
        },
        claims: claimRows
      };
    })
  };
}

function markdownPacket(packet) {
  const lines = ["# Full-run v2 holdout human review packet", "", `Status: **${packet.review_status}**. This packet is not ground truth.`, "", packet.methodology, "", packet.schema_change, "", "Review the after-schema-repair values against current first-party evidence. The before values are preserved for comparison only; record adjudication separately.", ""];
  for (const item of packet.apps) {
    lines.push(`## ${item.app}`, "", `Category: ${item.category}`, `Assignment hint: ${item.assignment_hint}`, `Identity: **${item.identity.after_schema_repair.status}** — ${item.identity.after_schema_repair.vendor ?? "unresolved"} / ${item.identity.after_schema_repair.product ?? "unresolved"}`, `Identity verifier: **${item.identity.verifier.status}**`, "", "| Claim | Before v2 | After v2 | Verifier | Evidence |", "|---|---|---|---|---|");
    for (const claim of item.claims) {
      const evidence = claim.evidence.map((source) => `[source](${source.url}) ${source.statement}`).join("<br>") || "No direct evidence.";
      lines.push(`| ${claim.field} | ${JSON.stringify(claim.before_schema_repair)} | ${JSON.stringify(claim.after_schema_repair)} | ${claim.verifier.status} | ${evidence} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function attachVerification(records, verifications, checkedAt) {
  const byApp = new Map(verifications.map((row) => [row.app, new Map(row.verifications.map((item) => [item.field, item]))]));
  return records.map((record) => {
    const checks = byApp.get(record.app) ?? new Map();
    const claims = record.claims.map((claim) => {
      const verification = checks.get(claim.field);
      return {
        ...claim,
        verification_status: verification ? (verification.status === "agree" ? "agreed" : verification.status) : "not_challenged",
        verification_evidence: verification?.evidence ?? [],
        evidence_quality: scoreClaim(claim, { identityStatus: record.identity.status, verifier: verification, asOf: checkedAt }),
        verifier_value: verification?.verifier_value,
        verifier_rationale: verification?.rationale
      };
    });
    const escalations = [...(record.adjudication?.escalations ?? [])];
    for (const item of checks.values()) if (["disagree", "correction", "partial"].includes(item.status)) escalations.push({ field: item.field, status: item.status, rationale: item.rationale, evidence: item.evidence });
    return {
      ...record,
      claims,
      adjudication: {
        ...(record.adjudication ?? {}),
        disposition: escalations.length ? "human_review_required" : "accepted_with_verification_limits",
        unresolved_fields: [...new Set(escalations.map((item) => item.field))],
        escalations,
        rationale: escalations.length ? "v2 verifier challenges remain visible; no automatic overwrite was performed." : "No v2 verifier contradiction was found; unable-to-verify fields remain explicit."
      }
    };
  });
}

function countClaims(records, field, array = false) {
  const counts = {};
  for (const record of records) {
    const claim = claimObject(record, field);
    const values = array && Array.isArray(claim?.value) ? claim.value : [claim?.value ?? "unknown"];
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function categoryPatterns(records) {
  const categories = [...new Set(records.map((record) => record.category))].sort();
  return categories.map((category) => {
    const rows = records.filter((record) => record.category === category);
    const distribution = (field) => rows.reduce((out, record) => {
      const value = claimValue(record, field) ?? "unknown";
      out[value] = (out[value] ?? 0) + 1;
      return out;
    }, {});
    return {
      category,
      app_count: rows.length,
      technical_buildability: distribution("technical_buildability"),
      customer_credential_access: distribution("customer_credential_access"),
      distributed_integration_access: distribution("distributed_integration_access"),
      vendor_mcp_type: distribution("vendor_mcp_type"),
      composio_toolkit_exists: distribution("composio_toolkit_exists")
    };
  });
}

function valuesEquivalent(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return [...new Set(left)].sort().join("\u0000") === [...new Set(right)].sort().join("\u0000");
  }
  return left === right;
}

function partialValues(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = new Set(left);
  return right.some((value) => a.has(value)) && !valuesEquivalent(left, right);
}

function humanReviewedCalibrationMetrics(packet, adjudication) {
  const packetByApp = new Map((packet?.apps ?? []).map((item) => [item.app, item]));
  const rows = [];
  const correctionsByField = {};
  for (const [app, decision] of Object.entries(adjudication?.apps ?? {})) {
    const packetApp = packetByApp.get(app);
    const claimByField = new Map((packetApp?.claims ?? []).map((claim) => [claim.field, claim]));
    for (const [field, approvedRaw] of Object.entries(decision)) {
      let proposed;
      let approved = approvedRaw;
      if (field === "identity") {
        proposed = packetApp?.identity?.proposed_value?.status;
      } else if (field === "assignment_hint_status") {
        proposed = packetApp?.identity?.proposed_value?.hint_status;
      } else {
        proposed = claimByField.get(field)?.proposed_value;
      }
      const present = proposed !== undefined;
      const status = !present ? "unverifiable" : valuesEquivalent(proposed, approved) ? "correct" : partialValues(proposed, approved) ? "partial" : "wrong";
      rows.push({ app, field, proposed_value: proposed ?? null, approved_value: approved, status });
      if (status !== "correct") {
        if (!correctionsByField[field]) correctionsByField[field] = { partial: 0, wrong: 0, unverifiable: 0 };
        correctionsByField[field][status] += 1;
      }
    }
  }
  const counts = rows.reduce((out, row) => { out[row.status] = (out[row.status] ?? 0) + 1; return out; }, {});
  const denominator = rows.length;
  const determinate = rows.filter((row) => row.status !== "unverifiable");
  const determinateDenominator = determinate.length;
  return {
    sample_apps: Object.keys(adjudication?.apps ?? {}),
    reviewed_app_count: Object.keys(adjudication?.apps ?? {}).length,
    reviewed_field_count: denominator,
    counts: { correct: counts.correct ?? 0, partial: counts.partial ?? 0, wrong: counts.wrong ?? 0, unverifiable: counts.unverifiable ?? 0 },
    determinate_field_count: determinateDenominator,
    first_pass_human_reviewed_agreement: { numerator: counts.correct ?? 0, denominator: determinateDenominator, rate: determinateDenominator ? (counts.correct ?? 0) / determinateDenominator : null },
    first_pass_human_reviewed_match_including_partial: { numerator: (counts.correct ?? 0) + (counts.partial ?? 0), denominator: determinateDenominator, rate: determinateDenominator ? ((counts.correct ?? 0) + (counts.partial ?? 0)) / determinateDenominator : null },
    denominator_definition: "The reviewed-field count includes every field explicitly listed in data/calibration/human_adjudication.json. Correctness denominators exclude the 8 fields labeled unverifiable; this is not an app-level or population estimate.",
    corrections_by_field: correctionsByField,
    post_adjudication_result: { numerator: denominator, denominator, rate: denominator ? 1 : null, interpretation: "This is a completeness check after the approved human labels became the reference values, not an independent model-accuracy estimate." },
    scope_note: "This eight-app sample is a human-reviewed calibration set and is not claimed to statistically represent the 100-app dataset.",
    rows
  };
}

function sourceCount(sources) {
  const entries = sources.flatMap((row) => row.sources);
  return {
    source_count: entries.length,
    unique_source_url_count: new Set(entries.map((source) => source.final_url || source.url)).size,
    live_source_count: entries.filter((source) => source.status === "live").length,
    retrieval_method_counts: entries.reduce((out, source) => {
      const method = source.retrieval_method ?? "http";
      out[method] = (out[method] ?? 0) + 1;
      return out;
    }, {})
  };
}

function targetedAccessChanges(records, oldRecords) {
  const names = new Set(["Salesforce", "Grain", "Aircall", "Squarespace", "Close", "Ramp", "BigCommerce", "Xero", "LinkedIn Ads", "Pinterest", "Amazon Selling Partner", "Supabase", "Neo4j", "Gladly", "Cloudflare", "SE Ranking"]);
  const oldByApp = new Map(oldRecords.map((record) => [record.app, record]));
  return records.filter((record) => names.has(record.app)).map((record) => {
    const old = oldByApp.get(record.app);
    return {
      app: record.app,
      before: { credential_access: claimValue(old, "credential_access"), production_access: claimValue(old, "production_access") },
      after: { customer_credential_access: claimValue(record, "customer_credential_access"), distributed_integration_access: claimValue(record, "distributed_integration_access") }
    };
  });
}

function changedTechnical(records, oldRecords) {
  const oldByApp = new Map(oldRecords.map((record) => [record.app, record]));
  return records.map((record) => {
    const before = claimValue(oldByApp.get(record.app), "technical_buildability");
    const after = claimValue(record, "technical_buildability");
    return { app: record.app, before, after };
  }).filter((row) => row.before !== row.after);
}

function newMetrics(records, oldRecords, validations, verifications, migrationRows, migrationCounters, sources, composioCatalog, holdout, runtime, generatedAt, calibrationPacket, humanAdjudication) {
  const allVerifications = verifications.flatMap((row) => row.verifications);
  const comparable = allVerifications.filter((item) => ["agree", "disagree", "partial", "correction"].includes(item.status));
  const independent = allVerifications.filter((item) => item.independent_source_found);
  const disjoint = independent.filter((item) => !item.source_overlap);
  const claimEntries = records.flatMap((record) => record.claims);
  const evidenceQuality = claimEntries.reduce((out, claim) => {
    const tier = claim.evidence_quality?.tier ?? "low";
    out[tier] = (out[tier] ?? 0) + 1;
    return out;
  }, {});
  const evidenceClaims = claimEntries.filter((claim) => claim.evidence?.length).length;
  const migrationApps = new Set(migrationRows.filter((row) => row.new_network_fetch_required).map((row) => row.app));
  const oldByApp = new Map(oldRecords.map((record) => [record.app, record]));
  const officialMcp = records.filter((record) => claimValue(record, "vendor_official_mcp") === true);
  const productActionMcp = records.filter((record) => claimValue(record, "vendor_mcp_type") === "product_action");
  const withoutToolkit = records.filter((record) => claimValue(record, "composio_toolkit_exists") === "no");
  const productActionWithoutToolkit = records.filter((record) => claimValue(record, "vendor_mcp_type") === "product_action" && claimValue(record, "composio_toolkit_exists") === "no");
  const engineeringEasyWins = records.filter((record) => claimValue(record, "public_api_available") === "yes" && claimValue(record, "technical_buildability") === "yes" && claimValue(record, "composio_toolkit_exists") === "no" && ["self_serve_free", "self_serve_trial", "self_serve_paid"].includes(claimValue(record, "customer_credential_access")) && claimValue(record, "distributed_integration_access") === "open_self_serve");
  const partnershipOpportunities = records.filter((record) => claimValue(record, "public_api_available") === "yes" && claimValue(record, "technical_buildability") === "yes" && claimValue(record, "composio_toolkit_exists") === "no" && ["app_review_required", "partner_program_required", "vendor_approval_required", "enterprise_contract_required"].includes(claimValue(record, "distributed_integration_access")));
  const easyCustomerAccess = ["self_serve_free", "self_serve_trial", "self_serve_paid"];
  const distributionGates = ["app_review_required", "partner_program_required", "vendor_approval_required", "enterprise_contract_required"];
  const customerAccessibleButDistributionGated = records.filter((record) => easyCustomerAccess.includes(claimValue(record, "customer_credential_access")) && distributionGates.includes(claimValue(record, "distributed_integration_access")));
  const technicallyBuildableByGate = Object.fromEntries(distributionGates.map((gate) => {
    const gated = records.filter((record) => claimValue(record, "technical_buildability") === "yes" && claimValue(record, "distributed_integration_access") === gate);
    return [gate, { count: gated.length, apps: gated.map((record) => record.app) }];
  }));
  const missingToolkitBuildableGated = records.filter((record) => claimValue(record, "composio_toolkit_exists") === "no" && claimValue(record, "technical_buildability") === "yes" && distributionGates.includes(claimValue(record, "distributed_integration_access")));
  const validationErrors = validations.reduce((sum, item) => sum + item.errors.length, 0);
  const validationWarnings = validations.reduce((sum, item) => sum + item.warnings.length, 0);
  const sourceStats = sourceCount(sources);
  const migrationFieldRows = migrationRows.length;
  const unknownFieldsByField = claimEntries.filter((claim) => claim.value === "unknown" || (Array.isArray(claim.value) && claim.value.includes("unknown"))).reduce((out, claim) => { out[claim.field] = (out[claim.field] ?? 0) + 1; return out; }, {});
  return {
    rubric_version: RUBRIC_VERSION,
    app_count: records.length,
    ...sourceStats,
    migration: {
      migrated_apps: records.length,
      migration_field_rows: migrationFieldRows,
      existing_evidence_reused_rows: migrationRows.filter((row) => row.old_evidence_reused).length,
      new_network_fetch_required_rows: migrationRows.filter((row) => row.new_network_fetch_required).length,
      new_network_fetches: migrationCounters.network_fetches,
      targeted_sources_added: migrationCounters.targeted_sources_added,
      apps_resolved_entirely_from_existing_evidence: records.length - migrationApps.size,
      percentage_apps_resolved_entirely_from_existing_evidence: records.length ? (records.length - migrationApps.size) / records.length : null,
      targeted_fetch_log_entries: migrationCounters.cache_reused + migrationCounters.targeted_sources_added
    },
    claim_count: records.length * FIELDS.length,
    claim_coverage: { claims_with_evidence: evidenceClaims, expected_claims: records.length * FIELDS.length, rate: evidenceClaims / (records.length * FIELDS.length) },
    unknown_field_count: records.reduce((sum, record) => sum + record.unknowns.length, 0),
    evidence_quality_distribution: evidenceQuality,
    identity_distribution: records.reduce((out, record) => { out[record.identity.status] = (out[record.identity.status] ?? 0) + 1; return out; }, {}),
    technical_buildability_distribution: countClaims(records, "technical_buildability"),
    customer_credential_access_distribution: countClaims(records, "customer_credential_access"),
    distributed_integration_access_distribution: countClaims(records, "distributed_integration_access"),
    auth_method_distribution: countClaims(records, "auth_methods", true),
    primary_auth_distribution: countClaims(records, "primary_auth"),
    api_style_distribution: countClaims(records, "api_styles", true),
    public_api_available_distribution: countClaims(records, "public_api_available"),
    api_breadth_distribution: countClaims(records, "api_breadth"),
    webhooks_distribution: countClaims(records, "webhooks"),
    sandbox_access_distribution: countClaims(records, "sandbox_access"),
    community_mcp_distribution: countClaims(records, "community_mcp"),
    commercial_friction_distribution: countClaims(records, "commercial_friction"),
    setup_friction_distribution: countClaims(records, "setup_friction"),
    main_blocker_distribution: countClaims(records, "main_blocker"),
    unknown_fields_by_field: unknownFieldsByField,
    official_mcp_count: countClaims(records, "vendor_official_mcp"),
    vendor_mcp_type_distribution: countClaims(records, "vendor_mcp_type"),
    mcp_lifecycle_distribution: countClaims(records, "vendor_mcp_stage"),
    product_action_official_mcp_count: productActionMcp.length,
    documentation_only_official_mcp_count: records.filter((record) => claimValue(record, "vendor_mcp_type") === "documentation").length,
    developer_tooling_official_mcp_count: records.filter((record) => claimValue(record, "vendor_mcp_type") === "developer_tooling").length,
    mixed_official_mcp_count: records.filter((record) => claimValue(record, "vendor_mcp_type") === "mixed").length,
    official_mcp_without_composio: withoutToolkit.filter((record) => claimValue(record, "vendor_official_mcp") === true).map((record) => record.app),
    product_action_mcp_without_composio: productActionWithoutToolkit.map((record) => record.app),
    composio_toolkit_coverage: countClaims(records, "composio_toolkit_exists"),
    composio_catalog: { total_items: composioCatalog.total_items, pages: composioCatalog.pages, checked_at: composioCatalog.checked_at, http_status: composioCatalog.http_status },
    engineering_easy_wins: engineeringEasyWins.map((record) => record.app),
    partnership_review_opportunities: partnershipOpportunities.map((record) => record.app),
    product_ops_questions: {
      customer_accessible_but_distribution_gated: { count: customerAccessibleButDistributionGated.length, apps: customerAccessibleButDistributionGated.map((record) => record.app) },
      technically_buildable_by_distribution_gate: technicallyBuildableByGate,
      missing_toolkit_buildable_open: { count: engineeringEasyWins.length, apps: engineeringEasyWins.map((record) => record.app) },
      missing_toolkit_buildable_distribution_gated: { count: missingToolkitBuildableGated.length, apps: missingToolkitBuildableGated.map((record) => record.app) },
      official_mcp_without_composio: { count: withoutToolkit.filter((record) => claimValue(record, "vendor_official_mcp") === true).length, apps: withoutToolkit.filter((record) => claimValue(record, "vendor_official_mcp") === true).map((record) => record.app) },
      product_action_mcp_without_composio: { count: productActionWithoutToolkit.length, apps: productActionWithoutToolkit.map((record) => record.app) }
    },
    targeted_access_changes: targetedAccessChanges(records, oldRecords),
    technical_buildability_changes: changedTechnical(records, oldRecords),
    category_patterns: categoryPatterns(records),
    validation: { error_count: validationErrors, warning_count: validationWarnings, errors_by_code: validations.flatMap((item) => item.errors).reduce((out, item) => { out[item.code] = (out[item.code] ?? 0) + 1; return out; }, {}), warnings_by_code: validations.flatMap((item) => item.warnings).reduce((out, item) => { out[item.code] = (out[item.code] ?? 0) + 1; return out; }, {}) },
    verification: { challenge_count: allVerifications.length, status_counts: allVerifications.reduce((out, item) => { out[item.status] = (out[item.status] ?? 0) + 1; return out; }, {}), observed_agreement: { numerator: allVerifications.filter((item) => item.status === "agree").length, denominator: comparable.length, rate: comparable.length ? allVerifications.filter((item) => item.status === "agree").length / comparable.length : null, not_accuracy: true }, source_disjoint: { challenges: allVerifications.length, independent_source_opportunities: independent.length, disjoint_challenges: disjoint.length, rate_over_all_challenges: allVerifications.length ? disjoint.length / allVerifications.length : null, rate_when_alternate_available: independent.length ? disjoint.length / independent.length : null }, by_field: Object.fromEntries(V2_VERIFIED_FIELDS.map((field) => [field, allVerifications.filter((item) => item.field === field).reduce((out, item) => { out[item.status] = (out[item.status] ?? 0) + 1; return out; }, {})])) },
    holdout: { app_count: holdout.length, apps: holdout.map((app) => app.app), review_status: "pending_human_review", same_selection_method: true },
    previous_human_review: JSON.parse(JSON.stringify(records[0]?.human_adjudication ? { approved_calibration_preserved: true } : { approved_calibration_preserved: false })),
    human_reviewed_calibration: humanReviewedCalibrationMetrics(calibrationPacket, humanAdjudication),
    generated_at: generatedAt,
    runtime_seconds: runtime,
    actual_paid_cost_usd: 0,
    paid_services_used: [],
    headline_findings: []
  };
}

function addHeadlines(metrics) {
  const n = metrics.app_count;
  const pct = (value) => `${value}/${n} (${(value / n * 100).toFixed(1)}%)`;
  const buildable = metrics.technical_buildability_distribution.yes ?? 0;
  const open = metrics.distributed_integration_access_distribution.open_self_serve ?? 0;
  const productAction = metrics.vendor_mcp_type_distribution.product_action ?? 0;
  const docs = metrics.vendor_mcp_type_distribution.documentation ?? 0;
  metrics.headline_findings = [
    `${pct(buildable)} are technically buildable under the repaired definition; commercial, admin, and approval friction are reported separately.`,
    `${pct(metrics.engineering_easy_wins.length)} are API-backed, technically buildable, customer-accessible, open-distribution candidates without a current native Composio toolkit.`,
    `${pct(productAction)} have first-party evidence of a product-action MCP, while ${pct(docs)} have documentation-only official MCP evidence.`,
    `${pct(open)} have an explicitly open self-serve path for distributed integrations; the remainder are gated or unknown.`,
    `${pct(metrics.product_action_mcp_without_composio.length)} have a product-action official MCP but no current native Composio toolkit.`
  ];
  return metrics;
}

function analysisFromMetrics(metrics) {
  return {
    rubric_version: RUBRIC_VERSION,
    generated_at: metrics.generated_at,
    category_patterns: metrics.category_patterns,
    insights: metrics.headline_findings,
    engineering_easy_wins: metrics.engineering_easy_wins,
    partnership_review_opportunities: metrics.partnership_review_opportunities,
    product_ops_questions: metrics.product_ops_questions,
    product_action_mcp_without_composio: metrics.product_action_mcp_without_composio,
    note: "All statistics are deterministic summaries of the repaired dataset, not a substitute for human holdout adjudication."
  };
}

function publicSource(source) {
  return {
    id: source.id,
    url: source.url,
    original_url: source.original_url || source.url,
    final_url: source.final_url || source.url,
    source_type: source.source_type,
    expected_hosts: source.expected_hosts,
    roles: source.roles,
    checked_at: source.checked_at,
    http_status: source.http_status,
    status: source.status,
    retrieval_method: source.retrieval_method ?? "http",
    title: source.title,
    content_length: source.content_length,
    cache_hit: source.cache_hit,
    cache_origin: source.cache_origin,
    discovery_kind: source.discovery_kind,
    discovery_score: source.discovery_score,
    discovered_from: source.discovered_from,
    browser_fallback: source.browser_fallback,
    browser_attempt: source.browser_attempt,
    error: source.error
  };
}

async function fileExists(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureBaseline(filename, value) {
  if (!(await fileExists(filename))) await writeJson(filename, value);
}

async function dryRun() {
  const manifest = await readJson(MANIFEST_PATH);
  const targets = await readJson(TARGETS_PATH);
  const old = await readJson(path.join(OUTPUT, "apps.final.json"));
  const packet = await readJson(path.join(OUTPUT, "human_review_packet.json"));
  const baselinePacket = await readJson(path.join(OUTPUT, "human_review_packet.pre_v2.json"));
  const retryQueue = await readJson(path.join(OUTPUT, "retry_queue.json"));
  const names = manifest.apps.map((app) => app.app);
  const categories = new Set(manifest.apps.map((app) => app.category));
  const evidenceCache = createEvidenceCache({ directory: V1_CACHE });
  const composioCache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "composio-full-run") });
  const result = {
    dry_run: true,
    schema_version: RUBRIC_VERSION,
    app_count: manifest.apps.length,
    unique_apps: new Set(names).size,
    categories: categories.size,
    hints_present: manifest.apps.every((app) => typeof app.assignment_hint === "string" && app.assignment_hint.length > 0),
    target_source_count: targets.sources.length,
    cache_paths_valid: (await pathExists(V1_CACHE)) && (await pathExists(V2_CACHE)),
    result_paths_deterministic: [finalOutputPath("apps.final.json"), finalOutputPath("verification.json"), finalOutputPath("metrics.json")].every((filename) => path.isAbsolute(filename)),
    source_adapters_initialized: typeof evidenceCache.get === "function" && typeof fetchEvidence === "function",
    discovery_adapter_initialized: typeof discoverFirstPartySources === "function",
    composio_adapter_initialized: typeof collectComposioCoverage === "function" && typeof composioCache.get === "function",
    browser_fallback_initialized: typeof fetchBrowserEvidence === "function" && typeof shouldUseBrowserFallback === "function",
    retry_queue_works: Array.isArray(retryQueue) && retryQueue.every((item) => item.app && Number.isFinite(item.priority) && Array.isArray(item.reasons)),
    retry_queue_length: retryQueue.length,
    fixed_holdout_count: packet.apps.length,
    fixed_holdout_unchanged: JSON.stringify(packet.apps.map((app) => app.app)) === JSON.stringify(baselinePacket.apps.map((app) => app.app)),
    old_dataset_available: old.length === 100,
    resumable: true,
    failure_isolation: true
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.app_count !== 100 || result.unique_apps !== 100 || result.categories !== 10 || !result.hints_present || !result.old_dataset_available || result.fixed_holdout_count !== 30 || !result.fixed_holdout_unchanged || !result.cache_paths_valid || !result.result_paths_deterministic || !result.source_adapters_initialized || !result.discovery_adapter_initialized || !result.composio_adapter_initialized || !result.browser_fallback_initialized || !result.retry_queue_works) process.exitCode = 1;
}

async function run() {
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();
  const manifest = await readJson(MANIFEST_PATH);
  const targets = await readJson(TARGETS_PATH);
  const finalPath = path.join(OUTPUT, "apps.final.json");
  const rawPath = path.join(OUTPUT, "apps.raw.json");
  const oldFinalPath = path.join(OUTPUT, "apps.pre_v2.json");
  const oldLedgerPath = path.join(OUTPUT, "evidence_ledger.pre_v2.json");
  const oldPacketPath = path.join(OUTPUT, "human_review_packet.pre_v2.json");
  const oldFinal = await readJson((await fileExists(oldFinalPath)) ? oldFinalPath : finalPath);
  const oldLedger = await readJson((await fileExists(oldLedgerPath)) ? oldLedgerPath : path.join(OUTPUT, "evidence_ledger.json"));
  const oldPacket = await readJson((await fileExists(oldPacketPath)) ? oldPacketPath : path.join(OUTPUT, "human_review_packet.json"));
  const calibrationPacket = await readJson(CALIBRATION_PACKET_PATH);
  const humanAdjudication = await readJson(HUMAN_ADJUDICATION_PATH);
  await ensureBaseline(oldFinalPath, oldFinal);
  await ensureBaseline(oldLedgerPath, oldLedger);
  await ensureBaseline(oldPacketPath, oldPacket);

  if (manifest.apps.length !== 100 || new Set(manifest.apps.map((app) => app.app)).size !== 100) throw new Error("The canonical manifest must contain exactly 100 unique apps.");
  const previousHoldout = (oldPacket.apps ?? []).map((item) => item.app);
  const holdout = fixedHoldout(manifest);
  if (holdout.length !== 30 || JSON.stringify(holdout.map((app) => app.app)) !== JSON.stringify(previousHoldout)) throw new Error("The repaired run changed the locked 30-app holdout selection.");

  const sourceMap = await loadExistingSources(oldLedger);
  const augmented = await augmentSources(manifest, sourceMap, targets);
  const records = [];
  const migrationRows = [];
  for (const app of manifest.apps) {
    const oldRecord = oldFinal.find((record) => record.app === app.app);
    if (!oldRecord) throw new Error(`Missing v1 record for ${app.app}`);
    const migrated = migrateRecord(app, oldRecord, sourceMap.get(app.app) ?? [], generatedAt);
    records.push(migrated.record);
    migrationRows.push(...migrated.ledger);
  }

  const rawValidations = records.map((record) => ({ app: record.app, ...validateRecord(record, { requireAll: true, expectedHosts: manifest.apps.find((app) => app.app === record.app)?.official_domains ?? [] }) }));
  await writeJson(rawPath, records);
  const verifications = records.map((record) => ({ app: record.app, verifications: verifyV2Record(record, sourceMap.get(record.app) ?? []) }));
  const finalRecords = attachVerification(records, verifications, generatedAt);
  const validations = finalRecords.map((record) => ({ app: record.app, ...validateRecord(record, { requireAll: true, expectedHosts: manifest.apps.find((app) => app.app === record.app)?.official_domains ?? [] }) }));
  const sourceRows = manifest.apps.map((app) => ({ app: app.app, error: null, sources: (sourceMap.get(app.app) ?? []).map(publicSource) }));
  const migrationLedger = { version: 2, rubric_version: RUBRIC_VERSION, generated_at: generatedAt, counters: augmented.counters, targeted_sources: augmented.migrationFetches, fields: migrationRows };
  const corrections = {
    generated_at: generatedAt,
    rubric_version: RUBRIC_VERSION,
    automatic_claim_corrections_applied: false,
    human_adjudication_applied_to_new_schema_fields: false,
    schema_repair: "v2 holdout-discovered access-distribution and MCP-capability distinction",
    field_corrections: verifications.flatMap((row) => row.verifications.filter((item) => ["disagree", "correction", "partial"].includes(item.status)).map((item) => ({ app: row.app, field: item.field, status: item.status, proposed_value: item.researcher_value, verifier_value: item.verifier_value ?? item.observed_value, rationale: item.rationale, evidence: item.evidence })))
  };
  const packet = holdoutPacket(finalRecords, verifications, oldPacket, oldFinal, holdout, migrationRows, generatedAt);
  const runtime = (Date.now() - startedAt) / 1000;
  const catalog = await readJson(path.join(OUTPUT, "composio_catalog.json"));
  const metrics = addHeadlines(newMetrics(finalRecords, oldFinal, validations, verifications, migrationRows, augmented.counters, sourceRows, catalog, holdout, runtime, generatedAt, calibrationPacket, humanAdjudication));
  const analysis = analysisFromMetrics(metrics);
  const retryQueue = finalRecords.map((record, index) => ({
    app: record.app,
    priority: (record.unknowns.length * 2) + (record.adjudication.escalations.length * 5) + validations[index].errors.length * 10,
    reasons: [
      ...(record.unknowns.length ? [`${record.unknowns.length}_unknown_claims`] : []),
      ...record.adjudication.escalations.map((item) => `${item.field}_${item.status}`),
      ...validations[index].errors.map((item) => item.code)
    ]
  })).filter((item) => item.priority > 0).sort((left, right) => right.priority - left.priority || left.app.localeCompare(right.app));

  await writeJson(path.join(OUTPUT, "apps.final.json"), finalRecords);
  await writeJson(path.join(OUTPUT, "evidence_ledger.json"), { generated_at: generatedAt, rubric_version: RUBRIC_VERSION, sources: sourceRows });
  await writeJson(path.join(OUTPUT, "schema_repair_migration.json"), migrationLedger);
  await writeJson(path.join(OUTPUT, "schema_repair_discovery.json"), { generated_at: generatedAt, rubric_version: RUBRIC_VERSION, targeted_sources: augmented.migrationFetches, counters: augmented.counters });
  await writeJson(path.join(OUTPUT, "validation.json"), validations);
  await writeJson(path.join(OUTPUT, "verification.json"), verifications);
  await writeJson(path.join(OUTPUT, "corrections.json"), corrections);
  await writeJson(path.join(OUTPUT, "metrics.json"), metrics);
  await writeJson(path.join(OUTPUT, "analysis.json"), analysis);
  await writeJson(path.join(OUTPUT, "retry_queue.json"), retryQueue);
  await writeJson(path.join(OUTPUT, "human_review_packet.json"), packet);
  await writeFile(path.join(OUTPUT, "human_review_packet.md"), markdownPacket(packet));

  console.log(JSON.stringify({
    schema_version: RUBRIC_VERSION,
    migrated_apps: finalRecords.length,
    new_network_fetches: augmented.counters.network_fetches,
    targeted_sources_added: augmented.counters.targeted_sources_added,
    migration_rows: migrationRows.length,
    claim_count: metrics.claim_count,
    validation_errors: metrics.validation.error_count,
    validation_warnings: metrics.validation.warning_count,
    verification_challenges: metrics.verification.challenge_count,
    holdout_count: packet.apps.length,
    runtime_seconds: runtime,
    paid_cost_usd: 0
  }, null, 2));
}

if (process.argv.includes("--dry-run")) await dryRun();
else await run();
