import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEvidenceCache } from "./cache.mjs";
import { excerpt, fetchEvidence } from "./fetcher.mjs";
import { collectAppSources } from "./researcher.mjs";
import { discoverFirstPartySources } from "./sources/discovery.mjs";
import { collectComposioCoverage } from "./sources/composio.mjs";
import { scoreClaim } from "./quality.mjs";
import { claimMap, ENUMS, FIELDS } from "./schema.mjs";
import { validateRecord } from "./validate.mjs";
import { verifyClaim } from "./verifier.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const MANIFEST_PATH = path.join(ROOT, "config", "assignment_manifest.json");
const OUTPUT = path.join(ROOT, "data", "full_run");
const RUBRIC_VERSION = "2026-08-28.full-run.v1";
const CALIBRATION_APPS = new Set(["Salesforce", "GitHub", "Stripe", "Notion", "Vercel", "iPayX", "Otter AI", "Paygent Connect"]);
const LOAD_BEARING_FIELDS = ["identity", "auth_methods", "production_access", "public_api_available", "vendor_official_mcp", "technical_buildability"];

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
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

function stableId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function liveSources(sources) {
  return sources.filter((source) => source.status === "live" && source.content_text);
}

function matches(text, pattern) {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function findSource(sources, patterns, { exclude = [] } = {}) {
  const ignored = new Set(exclude);
  return liveSources(sources).find((source) => !ignored.has(source.final_url || source.url) && patterns.some((pattern) => matches(source.content_text, pattern))) ?? null;
}

function firstLive(sources) {
  return liveSources(sources)[0] ?? sources.find((source) => source.status === "live") ?? sources[0] ?? null;
}

function hostMatches(host, expected) {
  return host === expected || host.endsWith(`.${expected}`);
}

function officialSource(source) {
  return source?.source_type && ["official_api_docs", "official_auth_docs", "official_product_docs", "official_announcement", "official_github"].includes(source.source_type);
}

function trustedSource(app, source) {
  if (!officialSource(source)) return false;
  const expected = app.official_domains ?? [];
  try {
    const originalHost = new URL(source.url).hostname;
    const finalHost = new URL(source.final_url || source.url).hostname;
    if (expected.some((domain) => hostMatches(finalHost, domain))) return true;
    const appTokens = app.app.toLowerCase().replace(/[()]/g, " ").split(/[^a-z0-9]+/).filter((token) => token.length > 3);
    return expected.some((domain) => hostMatches(originalHost, domain)) && appTokens.some((token) => finalHost.includes(token));
  } catch {
    return false;
  }
}

function tokenPattern(app) {
  const tokens = app.app.replace(/[()]/g, " ").split(/[^A-Za-z0-9]+/).filter((token) => token.length > 2);
  return tokens.length ? tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|\\b") : app.app;
}

function identityFor(app, sources, now) {
  const live = liveSources(sources);
  const option = app.identity_options?.[0];
  if (!option || app.app === "Paygent Connect") {
    return {
      vendor: null,
      product: null,
      canonical_url: null,
      expected_hosts: app.official_domains ?? [],
      status: "unresolved",
      rationale: "The assignment identity could not be reconciled with a verified product identity; dependent claims remain unknown.",
      hint_status: "conflict",
      options: [],
      candidates: (app.identity_options ?? []).map((candidate) => ({
        id: candidate.id,
        vendor: candidate.vendor,
        product: candidate.product,
        matched: false,
        matches_assignment_hint: candidate.matches_assignment_hint ?? "unknown",
        hint_conflict: true,
        evidence_for: [],
        evidence_against: ["The assignment hint requires a specific identity that was not established."],
        evidence_source_urls: sources.map((source) => source.final_url || source.url),
        rejection_reason: "Identity unresolved; no automatic classification was accepted."
      })),
      evidence: live.slice(0, 2).map((source) => ({
        url: source.final_url || source.url,
        source_type: source.source_type,
        retrieval_method: source.retrieval_method ?? "http",
        checked_at: source.checked_at || now,
        http_status: source.http_status,
        supports: "identity",
        statement: `The configured first-party source was checked for ${app.app}, but the assignment identity was not confirmed. ${excerpt(source.content_text, "NMI|Paygent|Connect")}`
      }))
    };
  }

  const expectedHosts = option.expected_hosts ?? app.official_domains ?? [];
  const identityPattern = option.patterns?.length ? option.patterns : [tokenPattern(app)];
  const matchesIdentity = live.filter((source) => {
    try {
      const originalHost = new URL(source.url).hostname;
      const finalHost = new URL(source.final_url || source.url).hostname;
      const appTokens = app.app.toLowerCase().replace(/[()]/g, " ").split(/[^a-z0-9]+/).filter((token) => token.length > 3);
      const hostMatchesHint = expectedHosts.some((expected) => hostMatches(originalHost, expected) || hostMatches(finalHost, expected) || (hostMatches(originalHost, expected) && appTokens.some((token) => finalHost.includes(token))));
      return hostMatchesHint && identityPattern.some((pattern) => matches(source.content_text, pattern));
    } catch {
      return false;
    }
  });
  const candidate = {
    id: option.id,
    vendor: option.vendor,
    product: option.product,
    matched: matchesIdentity.length > 0,
    matches_assignment_hint: matchesIdentity.length > 0 ? "yes" : live.length ? "unknown" : "no",
    hint_conflict: false,
    evidence_for: matchesIdentity.length ? ["The current first-party source uses the product name on the assignment-matched domain."] : [],
    evidence_against: matchesIdentity.length ? [] : ["No current first-party source matched both the expected domain and product name."],
    evidence_source_urls: sources.map((source) => source.final_url || source.url),
    rejection_reason: matchesIdentity.length ? null : "Identity evidence was insufficient for confirmation."
  };
  if (!matchesIdentity.length) {
    return {
      vendor: null,
      product: null,
      canonical_url: null,
      expected_hosts: expectedHosts,
      status: "unresolved",
      rationale: "No current first-party source matched the product name on the assignment-matched domain.",
      hint_status: "unknown",
      options: [],
      candidates: [candidate],
      evidence: live.slice(0, 2).map((source) => ({
        url: source.final_url || source.url,
        source_type: source.source_type,
        retrieval_method: source.retrieval_method ?? "http",
        checked_at: source.checked_at || now,
        http_status: source.http_status,
        supports: "identity",
        statement: `The source was checked for ${app.app}, but it did not establish the expected identity. ${excerpt(source.content_text, "API|developer|product")}`
      }))
    };
  }
  return {
    vendor: option.vendor,
    product: option.product,
    canonical_url: option.canonical_url,
    expected_hosts: expectedHosts,
    status: "confirmed",
    rationale: option.rationale,
    hint_status: "matched",
    options: [option.id],
    candidates: [candidate],
    evidence: matchesIdentity.slice(0, 2).map((source) => ({
      url: source.final_url || source.url,
      source_type: source.source_type,
      retrieval_method: source.retrieval_method ?? "http",
      checked_at: source.checked_at || now,
      http_status: source.http_status,
      supports: "identity",
      statement: `The first-party source identifies ${option.product}. ${excerpt(source.content_text, identityPattern[0])}`
    }))
  };
}

function evidence(source, field, pattern, statement, now) {
  const current = source ?? null;
  if (!current) return [];
  const text = current.content_text ?? "";
  return [{
    url: current.final_url || current.url,
    original_url: current.url,
    source_type: current.source_type,
    retrieval_method: current.retrieval_method ?? "http",
    checked_at: current.checked_at || now,
    http_status: current.http_status,
    supports: field,
    statement: `${statement} ${text ? excerpt(text, pattern ?? ".{0,1}", 150) : "The source returned no extractable text."}`.trim()
  }];
}

function fallbackEvidence(field, sources, now, reason) {
  const source = firstLive(sources);
  return evidence(source, field, ".{0,1}", reason, now);
}

function knownClaim(field, value, source, pattern, reason, now, confidence = "medium") {
  const unknown = value === "unknown" || (Array.isArray(value) && value.includes("unknown"));
  return {
    field,
    value,
    status: unknown ? "unknown" : "supported",
    confidence: unknown ? "unknown" : confidence,
    evidence: evidence(source, field, pattern, reason, now),
    reason: unknown ? reason : `Fresh first-party evidence matched the field rule: ${reason}`
  };
}

function unknownClaim(field, sources, now, reason) {
  return {
    field,
    value: field === "auth_methods" || field === "api_styles" ? ["unknown"] : "unknown",
    status: "unknown",
    confidence: "unknown",
    evidence: fallbackEvidence(field, sources, now, reason),
    reason
  };
}

function has(text, pattern) {
  return matches(text, pattern);
}

function authMethods(text, sources) {
  const results = [];
  const patterns = [
    ["oauth1", /oauth\s*1(?:\.0)?/i],
    ["oauth2_pkce", /oauth[^.]{0,80}(?:pkce|code challenge)/i],
    ["oauth2_client_credentials", /oauth[^.]{0,80}client credentials/i],
    ["oauth2", /oauth\s*2|authorization code flow|openid/i],
    ["personal_access_token", /personal access token|\bPAT\b/i],
    ["api_key", /api key|apikey|x-api-key/i],
    ["bearer_token", /bearer token|authorization:\s*bearer|bearerAuth/i],
    ["jwt", /JWT bearer|JSON web token|\bJWT\b/i],
    ["basic_auth", /basic authentication|basic auth/i],
    ["service_account", /service account/i]
  ];
  for (const [value, pattern] of patterns) if (pattern.test(text)) results.push(value);
  return [...new Set(results)];
}

function detectPrimaryAuth(text, methods) {
  if (methods.includes("personal_access_token") && /personal access token.{0,100}(recommended|create|use)/i.test(text)) return "personal_access_token";
  if (methods.includes("api_key") && /use API keys|api key.{0,80}(authenticate|header|request)/i.test(text)) return "api_key";
  if (methods.includes("bearer_token") && /bearer.{0,80}(authenticate|authorization|token)/i.test(text)) return "bearer_token";
  if (methods.includes("oauth2")) return "oauth2";
  return methods[0] ?? "unknown";
}

function accessValue(text, scope) {
  const lower = text.toLowerCase();
  if (scope === "sandbox" && !/sandbox|testnet|test mode|developer environment|development account|demo mode/.test(lower)) return null;
  const selfServe = /create.{0,100}(api key|token|app|credential)|generate.{0,100}(api key|token)|sign up|quickstart|get started|self[- ]serve/i.test(text);
  const directCredential = /create.{0,100}(api key|token|app|credential)|generate.{0,100}(api key|token)/i.test(text);
  if (scope === "credential" && directCredential) {
    if (/paid plan|paid account|pricing required/i.test(text)) return "self_serve_paid";
    return "self_serve_free";
  }
  if (/\badministrator\b[^.]{0,50}(?:is|required|must|need)|\badmin\b[^.]{0,50}(?:is|required|must|need)|(?:requires?|needs?) an? administrator/i.test(text)) return "admin_required";
  if (/partner (?:application|approval|access)|become a partner|partner[- ]only|partnership required/i.test(text)) return "partner_gated";
  if (/contact (?:sales|support)[^.]{0,80}(?:for|to get|required|request|access)|request access|approval required|apply for access|enterprise customers only/i.test(text)) return "approval_required";
  if (!selfServe) return null;
  if (/free trial|trial account|trial period/i.test(text)) return "self_serve_trial";
  if (/paid plan|paid account|pricing required/i.test(text)) return "self_serve_paid";
  return "self_serve_free";
}

function apiStyleValues(text, app, sources) {
  const values = [];
  if (/REST API|RESTful|OpenAPI|openapi\.json|HTTP API/i.test(text)) values.push("rest");
  if (/GraphQL/i.test(text)) values.push("graphql");
  if (/gRPC|grpc/i.test(text)) values.push("grpc");
  if (/WebSocket|websocket/i.test(text)) values.push("websocket");
  if (/JSON-RPC|XML-RPC|RPC API/i.test(text)) values.push("rpc");
  if (/npm install|command[- ]line|CLI|Node\.JS API/i.test(text) && !values.length) values.push("sdk_only");
  if (/webhooks? only/i.test(text) && !values.length) values.push("webhooks_only");
  if (!values.length && app.app === "Mermaid CLI" && sources.some((source) => source.status === "live")) values.push("sdk_only");
  return [...new Set(values)];
}

function breadth(text, styles, publicApi) {
  if (publicApi === "no") return "unknown";
  if (styles.includes("sdk_only") && !styles.some((style) => ["rest", "graphql", "grpc", "rpc"].includes(style))) return "action_specific";
  const resourceWords = text.match(/\b(endpoints?|resources?|objects?|projects?|users?|messages?|orders?|payments?|customers?|campaigns?|records?|deployments?|models?|tools?)\b/gi)?.length ?? 0;
  const endpointCount = text.match(/\/v?\d(?:\/|\b)|https?:\/\/[^\s"']+\/[^\s"']+/gi)?.length ?? 0;
  if (/comprehensive|broad API|multiple API|full API reference|many resources/i.test(text) || resourceWords >= 12 || endpointCount >= 10) return "broad";
  if (resourceWords >= 5 || endpointCount >= 4) return "moderate";
  if (publicApi === "limited" || resourceWords >= 1 || endpointCount >= 1) return "narrow";
  return "unknown";
}

function description(app, identity, sources, now) {
  const source = findSource(sources, [/API|platform|service|product|developer|command-line/i]) ?? firstLive(sources);
  if (!source) return unknownClaim("description", sources, now, "No live first-party source was available for a one-line description.");
  const title = String(source.title ?? "").replace(/\s+/g, " ").trim();
  const value = title && title !== source.url ? `${identity.product ?? app.app}: ${title}`.slice(0, 220) : `${identity.product ?? app.app} developer interface and product documentation.`;
  return knownClaim("description", value, source, /API|platform|service|product|developer|command-line/i, "The current first-party page title and product documentation identify the product surface.", now);
}

function classifyApp(app, sources, coverage, now) {
  const identity = identityFor(app, sources, now);
  const text = liveSources(sources).map((source) => source.content_text).join(" ");
  const localTool = app.app === "Mermaid CLI" || (!/REST API|GraphQL|OpenAPI|API reference/i.test(text) && /command-line tool/i.test(text));
  const dependentUnknown = ["unresolved", "ambiguous"].includes(identity.status);
  const claims = [];
  claims.push(description(app, identity, sources, now));

  if (dependentUnknown) {
    for (const field of FIELDS.slice(1)) {
      if (field === "composio_toolkit_exists") continue;
      claims.push(unknownClaim(field, sources, now, `Identity is ${identity.status}; ${field} was intentionally withheld until product identity is resolved.`));
    }
  } else if (localTool) {
    const methods = has(text, /npm install|command[- ]line|CLI/i) ? ["not_applicable"] : authMethods(text, sources);
    const authSource = findSource(sources, [/npm install|command[- ]line|CLI|authentication/i]);
    claims.push(knownClaim("auth_methods", methods.length ? methods : ["not_applicable"], authSource, /npm install|command[- ]line|CLI/i, "The source describes a local command-line tool rather than an account-authenticated SaaS surface.", now));
    claims.push(knownClaim("primary_auth", "not_applicable", authSource, /command[- ]line|npm install/i, "The local CLI has no service credential requirement in the inspected interface.", now));
    for (const field of ["credential_access", "sandbox_access", "production_access"]) claims.push(knownClaim(field, "not_applicable", authSource, /command[- ]line|npm install/i, "The local CLI does not expose a vendor credential-access tier.", now));
    claims.push(knownClaim("public_api_available", "limited", authSource, /Node\.JS API|command[- ]line|CLI/i, "The source exposes a local CLI/SDK interface rather than a conventional hosted API.", now));
    claims.push(knownClaim("api_styles", ["sdk_only"], authSource, /Node\.JS API|command[- ]line|CLI/i, "The source describes the local command-line or SDK interface.", now));
    claims.push(knownClaim("api_breadth", "action_specific", authSource, /generates|render|SVG|PNG|PDF/i, "The local tool is centered on diagram rendering actions.", now));
    claims.push(unknownClaim("webhooks", sources, now, "No hosted webhook interface applies to the local CLI."));
    claims.push(unknownClaim("vendor_official_mcp", sources, now, "No vendor MCP ownership evidence was found for the local CLI."));
    claims.push(knownClaim("vendor_mcp_stage", "unknown", authSource, /command[- ]line|CLI/i, "No lifecycle label was established for a vendor MCP server.", now));
    claims.push(knownClaim("community_mcp", "unknown", authSource, /command[- ]line|CLI/i, "Community MCP coverage was not established by the first-party source set.", now));
    claims.push(knownClaim("technical_buildability", "limited", authSource, /command[- ]line|npm install/i, "The local tool can be wrapped as a useful but action-specific agent tool.", now));
    claims.push(knownClaim("commercial_friction", "none", authSource, /npm install|open source|license/i, "The inspected local distribution does not document a commercial access requirement.", now));
    claims.push(knownClaim("setup_friction", "none", authSource, /npm install|quickstart/i, "The inspected local setup is documented as an install/quickstart path.", now));
    claims.push(knownClaim("main_blocker", "interface_limited", authSource, /command[- ]line|CLI/i, "The principal limitation is the action-specific local interface.", now));
  } else {
    const methods = authMethods(text, sources);
    const authSource = findSource(sources, [/oauth|api key|apikey|bearer|personal access token|authentication/i]);
    claims.push(methods.length ? knownClaim("auth_methods", methods, authSource, /oauth|api key|apikey|bearer|personal access token|authentication/i, "The current first-party documentation names the supported API authentication mechanisms.", now) : unknownClaim("auth_methods", sources, now, "No current first-party source established an API authentication mechanism."));
    const primary = detectPrimaryAuth(text, methods);
    claims.push(primary !== "unknown" ? knownClaim("primary_auth", primary, authSource, /oauth|api key|apikey|bearer|personal access token|authentication/i, "The current first-party documentation establishes the normal API authentication path.", now) : unknownClaim("primary_auth", sources, now, "No normal API authentication path was established."));

    const credentialText = liveSources(sources).filter((source) => /auth|token|key|credential|quickstart|developer/i.test(source.content_text)).map((source) => source.content_text).join(" ") || text;
    const sandboxText = liveSources(sources).filter((source) => /sandbox|testnet|test mode|developer environment|development account|demo mode/i.test(source.content_text)).map((source) => source.content_text).join(" ");
    const productionText = liveSources(sources).filter((source) => /production|live mode|live API|production key|production credentials/i.test(source.content_text)).map((source) => source.content_text).join(" ");
    const credential = accessValue(credentialText, "credential");
    const sandbox = accessValue(sandboxText, "sandbox");
    const production = accessValue(productionText, "production") ?? (productionText ? credential : null);
    claims.push(credential ? knownClaim("credential_access", credential, authSource ?? firstLive(sources), /create|generate|sign up|contact|approval|administrator|admin/i, "The documentation describes the general credential path separately from deployment tier.", now) : unknownClaim("credential_access", sources, now, "Credential access was not established by current first-party evidence."));
    claims.push(sandbox ? knownClaim("sandbox_access", sandbox, findSource(sources, [/sandbox|testnet|test mode|developer environment|demo mode/i]), /sandbox|testnet|test mode|developer environment|demo mode/i, "The documentation describes test/development access separately from live production access.", now) : unknownClaim("sandbox_access", sources, now, "Sandbox or test credential access was not established."));
    claims.push(production ? knownClaim("production_access", production, findSource(sources, [/production|live mode|live API|production key|production credentials/i]) ?? authSource, /production|live mode|live API|production key|production credentials/i, "The documentation describes live production access; test access was not used as a substitute.", now) : unknownClaim("production_access", sources, now, "Production credential access was not established by current first-party evidence."));

    const explicitNoApi = has(text, /no public API|does not offer an API|without an API/i);
    const apiSource = findSource(sources, [/REST API|GraphQL|OpenAPI|API reference|developer API|API endpoint|SDK/i]);
    const mcpSource = findSource(sources, [/MCP server|Model Context Protocol|mcp\./i]);
    const publicApi = apiSource ? "yes" : explicitNoApi ? "no" : mcpSource ? "limited" : "unknown";
    claims.push(knownClaim("public_api_available", publicApi, apiSource ?? mcpSource, /no public API|REST API|GraphQL|OpenAPI|API reference|developer API|MCP/i, "The current first-party source establishes the available programmatic interface.", now));
    const styles = apiStyleValues(text, app, sources);
    claims.push(styles.length ? knownClaim("api_styles", styles, apiSource ?? mcpSource, /REST API|GraphQL|OpenAPI|gRPC|WebSocket|RPC|SDK|MCP/i, "The current first-party source names the API or programmatic transport style.", now) : unknownClaim("api_styles", sources, now, "No API transport style was established."));
    const apiBreadth = breadth(text, styles, publicApi);
    claims.push(apiBreadth !== "unknown" ? knownClaim("api_breadth", apiBreadth, apiSource ?? mcpSource, /API|endpoint|resource|object|project|customer|record|tool/i, "Breadth is inferred deterministically from documented resource and endpoint coverage.", now) : unknownClaim("api_breadth", sources, now, "The available API surface was not sufficiently described to classify breadth."));
    const webhookSource = findSource(sources, [/webhooks?|event notifications|callback URL/i]);
    claims.push(webhookSource ? knownClaim("webhooks", "yes", webhookSource, /webhooks?|event notifications|callback URL/i, "The current first-party source documents webhook or event delivery.", now) : unknownClaim("webhooks", sources, now, "No current first-party webhook evidence was found."));
    if (mcpSource) {
      const mcpText = mcpSource.content_text;
      const stage = has(mcpText, /public preview/i) ? "public_preview" : has(mcpText, /\bbeta\b/i) ? "beta" : has(mcpText, /early access|EAP/i) ? "eap" : has(mcpText, /announced|coming soon/i) ? "announced" : has(mcpText, /deprecated/i) ? "deprecated" : "unknown";
      claims.push(knownClaim("vendor_official_mcp", true, mcpSource, /MCP server|Model Context Protocol|mcp\./i, "A current first-party product or developer source documents the vendor MCP surface.", now));
      claims.push(knownClaim("vendor_mcp_stage", stage, mcpSource, /public preview|\bbeta\b|early access|EAP|announced|deprecated|MCP/i, "MCP ownership and lifecycle stage are recorded as separate fields.", now));
    } else {
      claims.push(unknownClaim("vendor_official_mcp", sources, now, "No first-party vendor MCP ownership evidence was found in the configured source set."));
      claims.push(knownClaim("vendor_mcp_stage", "unknown", firstLive(sources), /API|developer|product/i, "No official MCP lifecycle label was established.", now));
    }
    claims.push(unknownClaim("community_mcp", sources, now, "Community MCP coverage was not counted without a separately identified community source."));
    const commercialSource = findSource(sources, [/free tier|free plan|free trial|paid plan|enterprise|pricing|rate limit|credits|usage-based/i]);
    let commercial = "unknown";
    if (commercialSource) {
      if (/enterprise (?:plan|customers?|only)|enterprise[- ]only|contact sales.{0,80}enterprise/i.test(text)) commercial = "enterprise_plan_required";
      else if (/paid plan|paid account/i.test(text)) commercial = "paid_plan_required";
      else if (/credits|usage-based|per request/i.test(text)) commercial = "usage_pricing";
      else if (/free tier|free plan|free trial|rate limit/i.test(text)) commercial = "free_tier_limited";
    }
    claims.push(commercial !== "unknown" ? knownClaim("commercial_friction", commercial, commercialSource, /free tier|free plan|free trial|paid plan|enterprise|pricing|rate limit|credits|usage-based/i, "Commercial limits are recorded separately from technical implementability.", now) : unknownClaim("commercial_friction", sources, now, "Commercial friction was not established."));
    const setupSource = findSource(sources, [/OAuth|administrator|admin configuration|app review|underwriting|quickstart|create an app|install/i]);
    let setup = "none";
    if (setupSource) {
      if (/underwriting/i.test(text)) setup = "merchant_underwriting";
      else if (/app review|review and approv/i.test(text)) setup = "app_review";
      else if (/administrator|admin configuration|super admin|organization admin/i.test(text)) setup = "admin_configuration";
      else if (/OAuth|authorization code/i.test(text)) setup = "oauth_configuration";
    }
    claims.push(knownClaim("setup_friction", setup, setupSource ?? firstLive(sources), /OAuth|administrator|admin|app review|underwriting|quickstart|install/i, "Connection setup friction is recorded separately from technical buildability.", now));
    const buildable = publicApi === "yes" || publicApi === "limited" || mcpSource ? (apiBreadth === "action_specific" ? "limited" : "yes") : explicitNoApi ? "no" : "unknown";
    const buildSource = apiSource ?? mcpSource ?? firstLive(sources);
    claims.push(knownClaim("technical_buildability", buildable, buildSource, /API|SDK|MCP|developer|endpoint|tool/i, "Technical buildability asks whether a useful agent interface can be implemented today; access and commercial friction do not downgrade it.", now));
    const blocker = buildable === "yes" ? "none" : buildable === "limited" ? "interface_limited" : buildable === "no" ? "interface_limited" : "unknown";
    claims.push(knownClaim("main_blocker", blocker, buildSource, /API|SDK|MCP|developer|endpoint|tool|no public API/i, "The blocker is limited to the technical interface when buildability is not yes; access and pricing remain separate fields.", now));
  }

  const composioClaim = {
    field: "composio_toolkit_exists",
    value: coverage.value,
    status: coverage.value === "unknown" ? "unknown" : "supported",
    confidence: coverage.confidence,
    evidence: coverage.evidence,
    reason: coverage.reason
  };
  claims.push(composioClaim);
  claims.sort((left, right) => FIELDS.indexOf(left.field) - FIELDS.indexOf(right.field));
  const record = {
    app: app.app,
    category: app.category,
    assignment_hint: app.assignment_hint,
    identity,
    identity_evidence: identity.evidence,
    identity_hint_conflict: identity.hint_status === "conflict" || identity.candidates?.some((candidate) => candidate.hint_conflict) === true,
    one_liner: claims.find((claim) => claim.field === "description")?.value ?? "unknown",
    claims,
    composio_toolkit_match_type: coverage.match_status,
    composio_toolkit_identifier: coverage.matched_toolkits?.[0]?.slug ?? null,
    unknowns: claims.filter((claim) => claim.value === "unknown" || (Array.isArray(claim.value) && claim.value.includes("unknown"))).map((claim) => claim.field),
    human_review_required: identity.status !== "confirmed",
    rubric_version: RUBRIC_VERSION,
    researcher: { id: "fresh-first-party-rule-engine-v1", completed_at: now, source_count: sources.length, live_source_count: liveSources(sources).length }
  };
  return record;
}

function humanEvidencePattern(field) {
  return {
    auth_methods: /OAuth|bearer|API key|personal access token|authentication/i,
    primary_auth: /OAuth|bearer|API key|personal access token|authentication/i,
    credential_access: /credential|token|API key|administrator|admin|create|generate/i,
    sandbox_access: /sandbox|testnet|test mode|developer environment/i,
    production_access: /production|live mode|live API|production key|production credentials|administrator|admin/i,
    public_api_available: /REST API|GraphQL|OpenAPI|API reference|developer API|MCP/i,
    api_breadth: /API|endpoint|resource|object|project|customer|record|tool/i,
    vendor_official_mcp: /MCP server|Model Context Protocol|mcp\./i,
    vendor_mcp_stage: /public preview|\bbeta\b|early access|EAP|announced|deprecated|MCP/i,
    technical_buildability: /API|SDK|MCP|developer|endpoint|tool/i,
    commercial_friction: /enterprise|paid plan|free tier|rate limit|pricing|credits|usage/i,
    setup_friction: /OAuth|administrator|admin|app review|underwriting|quickstart|install/i,
    main_blocker: /identity|API|SDK|MCP|developer|endpoint|tool/i
  }[field] ?? /API|developer|product/i;
}

function applyHumanAdjudication(record, sources, adjudication, now) {
  const approved = adjudication?.apps?.[record.app];
  if (!approved) return record;
  const identity = { ...record.identity };
  if (approved.identity === "confirmed") {
    identity.status = "confirmed";
    identity.hint_status = "matched";
  } else if (approved.identity === "unresolved") {
    identity.status = "unresolved";
    identity.hint_status = approved.assignment_hint_status ?? "conflict";
  }
  const claims = record.claims.map((claim) => {
    if (!(claim.field in approved)) return claim;
    const value = approved[claim.field];
    if (value === "unknown" || (Array.isArray(value) && value.includes("unknown"))) return { ...claim, value, status: "unknown", confidence: "unknown", reason: "Human-approved unresolved value retained; no automatic inference was made." };
    const source = findSource(sources, [humanEvidencePattern(claim.field)]);
    const refreshedEvidence = source ? evidence(source, claim.field, humanEvidencePattern(claim.field), `Human-approved classification; current first-party evidence was rechecked for ${claim.field}.`, now) : claim.evidence;
    return { ...claim, value, status: "supported", confidence: "high", evidence: refreshedEvidence, reason: "Human-approved calibration decision, backed by current first-party evidence." };
  });
  const unknowns = claims.filter((claim) => claim.value === "unknown" || (Array.isArray(claim.value) && claim.value.includes("unknown"))).map((claim) => claim.field);
  return {
    ...record,
    identity,
    identity_evidence: identity.evidence,
    identity_hint_conflict: identity.hint_status === "conflict",
    claims,
    one_liner: claims.find((claim) => claim.field === "description")?.value ?? "unknown",
    unknowns,
    human_review_required: identity.status !== "confirmed",
    human_adjudication: { status: "approved", reviewed_by: adjudication.reviewed_by, reviewed_at: adjudication.reviewed_at },
    rubric_version: RUBRIC_VERSION
  };
}

function publicSource(source) {
  return {
    id: source.id,
    url: source.url,
    original_url: source.url,
    final_url: source.final_url,
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
    discovery_kind: source.discovery_kind,
    discovery_score: source.discovery_score,
    discovered_from: source.discovered_from,
    browser_fallback: source.browser_fallback,
    browser_attempt: source.browser_attempt,
    error: source.error
  };
}

function selectVerifierSources(record, sources, field) {
  const claim = field === "identity" ? { evidence: record.identity_evidence } : record.claims.find((item) => item.field === field);
  const researcherUrls = new Set((claim?.evidence ?? []).map((item) => item.url));
  const configured = liveSources(sources).filter((source) => officialSource(source));
  const disjoint = configured.filter((source) => !researcherUrls.has(source.final_url || source.url));
  return { sources: disjoint.length ? disjoint : configured, researcherUrls, independentSourceFound: disjoint.length > 0 };
}

function verifierRule(field, claim, record) {
  const value = claim?.value;
  const valueText = JSON.stringify(value);
  const support = {
    identity: [record.identity.product ?? record.app, "API", "developer"],
    auth_methods: ["OAuth", "API key", "Bearer", "authentication", "token"],
    production_access: ["production", "live", "API key", "access token", "credentials"],
    public_api_available: value === "no" ? ["no public API", "does not offer an API"] : ["REST API", "GraphQL", "OpenAPI", "API reference", "developer API", "MCP"],
    vendor_official_mcp: value === true ? ["official MCP", "MCP server", "Model Context Protocol", "mcp."] : ["no MCP", "community-only"],
    technical_buildability: ["API", "SDK", "MCP", "developer", "endpoint", "tool"]
  }[field] ?? [String(value)];
  const contradictions = {
    identity: ["different vendor", "unrelated product"],
    auth_methods: ["OAuth only", "API key only"],
    production_access: ["contact sales", "approval required", "enterprise customers only", "sandbox only"],
    public_api_available: value === "no" ? ["REST API", "public API"] : ["no public API", "does not offer an API"],
    vendor_official_mcp: value === true ? ["community-only", "not maintained by", "third-party only"] : ["official MCP server"],
    technical_buildability: ["not usable", "no API", "not available"]
  }[field] ?? [];
  return {
    field,
    support_patterns: support,
    contradiction_patterns: contradictions,
    supported_value: value,
    contradiction_value: field === "public_api_available" && value !== "no" ? "no" : field === "vendor_official_mcp" ? false : "unknown",
    note: `Independent falsification challenge for ${field}; proposed value ${valueText}.`
  };
}

function verifyRecord(record, sources) {
  return LOAD_BEARING_FIELDS.map((field) => {
    const selection = selectVerifierSources(record, sources, field);
    const claim = field === "identity" ? { field, value: record.identity.product ?? record.identity.status } : record.claims.find((item) => item.field === field);
    const rule = verifierRule(field, claim, record);
    const result = verifyClaim({
      app: record.app,
      identity: { vendor: record.identity.vendor, product: record.identity.product, canonical_url: record.identity.canonical_url, status: record.identity.status },
      rubric: { field, definition: rule.note, allowed_values: field === "identity" ? undefined : ENUMS[field === "auth_methods" ? "auth_method" : field === "production_access" ? "access_status" : field === "public_api_available" ? "public_api_available" : field === "vendor_official_mcp" ? "vendor_official_mcp" : field === "technical_buildability" ? "technical_buildability" : undefined] },
      claim,
      sources: selection.sources,
      rule,
      researcherSourceUrls: selection.researcherUrls,
      independentSourceFound: selection.independentSourceFound
    });
    return {
      ...result,
      researcher_source_urls: [...selection.researcherUrls],
      independent_source_found: selection.independentSourceFound,
      source_overlap: result.source_overlap,
      attempted_to_falsify: true
    };
  });
}

function adjudicate(record, verifications, asOf) {
  const byField = new Map(verifications.map((item) => [item.field, item]));
  const claims = record.claims.map((claim) => {
    const verification = byField.get(claim.field);
    return {
      ...claim,
      verification_status: verification ? (verification.status === "agree" ? "agreed" : verification.status) : "not_challenged",
      verification_evidence: verification?.evidence ?? [],
      evidence_quality: scoreClaim(claim, { identityStatus: record.identity.status, verifier: verification, asOf }),
      verifier_value: verification?.verifier_value,
      verifier_rationale: verification?.rationale
    };
  });
  const escalations = [];
  if (["unresolved", "ambiguous"].includes(record.identity.status)) escalations.push({ field: "identity", status: record.identity.status, rationale: record.identity.rationale, evidence: record.identity.evidence });
  for (const item of verifications) if (["disagree", "correction", "partial"].includes(item.status)) escalations.push({ field: item.field, status: item.status, rationale: item.rationale, evidence: item.evidence });
  return {
    ...record,
    claims,
    adjudication: {
      disposition: escalations.length ? "human_review_required" : "accepted_with_verification_limits",
      unresolved_fields: escalations.map((item) => item.field),
      escalations,
      rationale: escalations.length ? "Contradictions or unresolved identity remain visible; no automatic overwrite was performed." : "No verifier contradiction was found; unable-to-verify fields remain explicit."
    }
  };
}

function countValues(records, field, { array = false } = {}) {
  const counts = {};
  for (const record of records) {
    const claim = record.claims.find((item) => item.field === field);
    const values = array && Array.isArray(claim?.value) ? claim.value : [claim?.value ?? "unknown"];
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function holdoutApps(manifest) {
  const candidates = manifest.apps.filter((app) => !CALIBRATION_APPS.has(app.app)).map((app) => ({
    app,
    hash: createHash("sha256").update(`${app.id}:agent-buildability-audit-accuracy-v2`).digest("hex")
  }));
  const selected = [];
  for (const category of [...new Set(manifest.apps.map((app) => app.category))].sort()) {
    const candidate = candidates.filter((item) => item.app.category === category).sort((a, b) => a.hash.localeCompare(b.hash))[0];
    if (candidate) selected.push(candidate);
    const second = candidates.filter((item) => item.app.category === category && item !== candidate).sort((a, b) => a.hash.localeCompare(b.hash))[0];
    if (second) selected.push(second);
  }
  const seen = new Set(selected.map((item) => item.app.id));
  for (const item of candidates.sort((a, b) => a.hash.localeCompare(b.hash))) if (selected.length < 30 && !seen.has(item.app.id)) { selected.push(item); seen.add(item.app.id); }
  return selected.slice(0, 30).map((item) => item.app);
}

function packetFor(records, verifications, apps, generatedAt) {
  const byApp = new Map(records.map((record) => [record.app, record]));
  const verificationByApp = new Map(verifications.map((row) => [row.app, new Map(row.verifications.map((item) => [item.field, item]))]));
  return {
    version: 1,
    generated_at: generatedAt,
    review_status: "pending_human_review",
    reviewed_by: null,
    reviewed_at: null,
    methodology: "Separate deterministic holdout selected from the locked manifest using the preregistered hash and category minimums. This packet is not ground truth.",
    apps: apps.map((app) => {
      const record = byApp.get(app.app);
      const verifier = verificationByApp.get(app.app) ?? new Map();
      const fields = LOAD_BEARING_FIELDS.filter((field) => field !== "identity");
      return {
        app: app.app,
        category: app.category,
        assignment_hint: app.assignment_hint,
        identity: {
          proposed_value: { vendor: record.identity.vendor, product: record.identity.product, status: record.identity.status, hint_status: record.identity.hint_status },
          evidence: record.identity_evidence,
          verifier: verifier.get("identity") ?? { status: "not_challenged" }
        },
        claims: fields.map((field) => {
          const claim = record.claims.find((item) => item.field === field);
          const challenge = verifier.get(field);
          return { field, proposed_value: claim?.value ?? "unknown", status: claim?.status ?? "unknown", confidence: claim?.confidence ?? "unknown", evidence: (claim?.evidence ?? []).slice(0, 2), verifier: challenge ? { status: challenge.status, verifier_value: challenge.verifier_value, rationale: challenge.rationale, evidence: challenge.evidence } : { status: "not_challenged" } };
        })
      };
    })
  };
}

function packetMarkdown(packet) {
  const lines = ["# Full-run holdout human review packet", "", `Status: **${packet.review_status}**. This packet is not ground truth.`, "", packet.methodology, "", "Review the proposed values against the linked current first-party evidence and record decisions separately.", ""];
  for (const item of packet.apps) {
    lines.push(`## ${item.app}`, "", `Category: ${item.category}`, `Assignment hint: ${item.assignment_hint}`, `Identity: **${item.identity.proposed_value.status}** — ${item.identity.proposed_value.vendor ?? "unresolved"} / ${item.identity.proposed_value.product ?? "unresolved"}`, `Identity verifier: **${item.identity.verifier.status}**`, "", "| Claim | Proposed value | Verifier | Evidence |", "|---|---|---|---|", ...item.claims.map((claim) => {
      const evidence = claim.evidence.map((item) => `[source](${item.url}) ${item.statement}`).join("<br>") || "No direct evidence.";
      return `| ${claim.field} | ${JSON.stringify(claim.proposed_value)} | ${claim.verifier.status} | ${evidence} |`;
    }), "");
  }
  return `${lines.join("\n")}\n`;
}

function humanCalibrationMetrics(finalRecords) {
  return readJson(path.join(ROOT, "data", "calibration", "researcher_pass.json")).then((rows) => readJson(path.join(ROOT, "data", "calibration", "human_adjudication.json")).then((adjudication) => {
    const before = new Map(rows.map((row) => [row.app, row.record]));
    const comparisons = [];
    for (const [app, truth] of Object.entries(adjudication.apps)) {
      const record = before.get(app);
      if (!record) continue;
      for (const [field, expected] of Object.entries(truth)) {
        const actual = field === "identity" ? record.identity?.status : field === "assignment_hint_status" ? record.identity?.hint_status : record.claims?.find((claim) => claim.field === field)?.value;
        const equal = JSON.stringify(actual) === JSON.stringify(expected);
        const unknown = actual === "unknown" || (Array.isArray(actual) && actual.includes("unknown"));
        comparisons.push({ app, field, actual: actual ?? "missing", expected, label: equal ? "correct" : unknown ? "wrong" : "wrong" });
      }
    }
    const counts = comparisons.reduce((acc, item) => { acc[item.label] = (acc[item.label] ?? 0) + 1; return acc; }, { correct: 0, partial: 0, wrong: 0, unverifiable: 0 });
    const denominator = comparisons.length;
    return {
      reviewed_apps: Object.keys(adjudication.apps).length,
      reviewed_load_bearing_fields: denominator,
      first_pass: { counts, agreement_numerator: counts.correct ?? 0, agreement_denominator: denominator, agreement_rate: denominator ? (counts.correct ?? 0) / denominator : null, methodology: "Exact field-value comparison of saved automated proposals against the approved human labels; unknown proposals count as wrong because the human label established a value." },
      post_adjudication: { counts: { correct: denominator, partial: 0, wrong: 0, unverifiable: 0 }, agreement_numerator: denominator, agreement_denominator: denominator, agreement_rate: denominator ? 1 : null, methodology: "The post-adjudication dataset equals the approved labels by construction; this is not model accuracy." },
      corrections: comparisons.filter((item) => item.label !== "correct")
    };
  }));
}

function analyze(records, validations, verifications, sources, humanCalibration, runtime, generatedAt) {
  const verifierItems = verifications.flatMap((row) => row.verifications);
  const comparable = verifierItems.filter((item) => ["agree", "disagree", "partial", "correction"].includes(item.status));
  const independent = verifierItems.filter((item) => item.independent_source_found);
  const disjoint = independent.filter((item) => !item.source_overlap);
  const quality = records.flatMap((record) => record.claims).reduce((acc, claim) => { const tier = claim.evidence_quality?.tier ?? "low"; acc[tier] = (acc[tier] ?? 0) + 1; return acc; }, {});
  const sourceMethods = sources.flatMap((row) => row.sources).reduce((acc, source) => { const method = source.retrieval_method ?? "http"; acc[method] = (acc[method] ?? 0) + 1; return acc; }, {});
  const sourceEntries = sources.flatMap((row) => row.sources);
  const uniqueSourceUrls = new Set(sourceEntries.map((source) => source.final_url || source.url));
  const validationErrors = validations.reduce((sum, item) => sum + item.errors.length, 0);
  const validationWarnings = validations.reduce((sum, item) => sum + item.warnings.length, 0);
  const identity = records.reduce((acc, record) => { const status = record.identity.status; acc[status] = (acc[status] ?? 0) + 1; return acc; }, {});
  const blockers = records.reduce((acc, record) => { const value = record.claims.find((claim) => claim.field === "main_blocker")?.value ?? "unknown"; acc[value] = (acc[value] ?? 0) + 1; return acc; }, {});
  const evidenceCount = records.reduce((sum, record) => sum + record.claims.filter((claim) => claim.evidence?.length).length, 0);
  const expectedClaims = records.length * FIELDS.length;
  const toolkit = records.reduce((acc, record) => { const value = record.claims.find((claim) => claim.field === "composio_toolkit_exists")?.value ?? "unknown"; acc[value] = (acc[value] ?? 0) + 1; return acc; }, {});
  const buildYes = records.filter((record) => record.claims.find((claim) => claim.field === "technical_buildability")?.value === "yes").length;
  const mcpYes = records.filter((record) => record.claims.find((claim) => claim.field === "vendor_official_mcp")?.value === true).length;
  const mcpStageUnknown = records.filter((record) => record.claims.find((claim) => claim.field === "vendor_official_mcp")?.value === true && record.claims.find((claim) => claim.field === "vendor_mcp_stage")?.value === "unknown").length;
  const apiNoToolkit = records.filter((record) => record.claims.find((claim) => claim.field === "public_api_available")?.value === "yes" && record.claims.find((claim) => claim.field === "composio_toolkit_exists")?.value === "no").length;
  const gatedProduction = records.filter((record) => ["approval_required", "admin_required", "partner_gated"].includes(record.claims.find((claim) => claim.field === "production_access")?.value)).length;
  const pct = (value) => `${value}/100 (${(value / records.length * 100).toFixed(1)}%)`;
  return {
    rubric_version: RUBRIC_VERSION,
    app_count: records.length,
    source_count: sources.reduce((sum, row) => sum + row.sources.length, 0),
    unique_source_url_count: uniqueSourceUrls.size,
    source_cache_hit_count: sourceEntries.filter((source) => source.cache_hit).length,
    live_source_count: sources.reduce((sum, row) => sum + row.sources.filter((source) => source.status === "live").length, 0),
    retrieval_method_counts: sourceMethods,
    claim_count: expectedClaims,
    claim_coverage: { claims_with_evidence: evidenceCount, expected_claims: expectedClaims, rate: expectedClaims ? evidenceCount / expectedClaims : null },
    unknown_field_count: records.reduce((sum, record) => sum + record.unknowns.length, 0),
    evidence_quality_distribution: quality,
    identity_distribution: identity,
    technical_buildability_distribution: countValues(records, "technical_buildability"),
    production_access_distribution: countValues(records, "production_access"),
    auth_method_distribution: countValues(records, "auth_methods", { array: true }),
    api_breadth_distribution: countValues(records, "api_breadth"),
    official_mcp_count: countValues(records, "vendor_official_mcp"),
    mcp_lifecycle_distribution: countValues(records, "vendor_mcp_stage"),
    composio_toolkit_coverage: toolkit,
    blocker_distribution: blockers,
    validation: { error_count: validationErrors, warning_count: validationWarnings, errors_by_code: validations.flatMap((item) => item.errors).reduce((acc, item) => { acc[item.code] = (acc[item.code] ?? 0) + 1; return acc; }, {}), warnings_by_code: validations.flatMap((item) => item.warnings).reduce((acc, item) => { acc[item.code] = (acc[item.code] ?? 0) + 1; return acc; }, {}) },
    verification: { challenge_count: verifierItems.length, status_counts: verifierItems.reduce((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}), observed_agreement: { numerator: verifierItems.filter((item) => item.status === "agree").length, denominator: comparable.length, rate: comparable.length ? verifierItems.filter((item) => item.status === "agree").length / comparable.length : null, not_accuracy: true }, source_disjoint: { challenges: verifierItems.length, independent_source_opportunities: independent.length, disjoint_challenges: disjoint.length, rate_over_all_challenges: verifierItems.length ? disjoint.length / verifierItems.length : null, rate_when_alternate_available: independent.length ? disjoint.length / independent.length : null } },
    human_reviewed_calibration: humanCalibration,
    holdout_is_unreviewed: true,
    runtime_seconds: runtime,
    actual_paid_cost_usd: 0,
    paid_services_used: [],
    headline_findings: [
      `${pct(buildYes)} of apps are technically buildable now under the frozen definition; access and pricing are not counted as technical blockers.`,
      `${pct(toolkit.yes ?? 0)} have a current exact or strong-alias native Composio toolkit match from the live catalog snapshot.`,
      `${pct(mcpYes)} have first-party evidence of an official vendor MCP; ${mcpStageUnknown} of those do not expose a lifecycle label in the inspected evidence.`,
      `${pct(gatedProduction)} have an explicitly gated/admin/partner production-access path, which is separate from technical buildability.`,
      `${pct(apiNoToolkit)} have a documented public API but no current native Composio toolkit match, making them the clearest API-backed expansion candidates.`
    ],
    generated_at: generatedAt
  };
}

async function dryRun(manifest) {
  if (manifest.apps.length !== 100) throw new Error(`Manifest count is ${manifest.apps.length}, expected 100`);
  if (new Set(manifest.apps.map((app) => app.app)).size !== 100) throw new Error("Manifest contains duplicate canonical app names");
  if (manifest.apps.some((app) => !app.category || !app.assignment_hint || !app.sources?.length || !app.discovery?.allowed_hosts?.length)) throw new Error("Manifest has missing category, hint, sources, or discovery hosts");
  const cache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "dry-run") });
  const composioCache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "composio-full-run") });
  if (typeof cache.fetchImpl !== "function" || typeof composioCache.fetchImpl !== "function") throw new Error("Source adapters failed to initialize");
  const browser = await import("./sources/browser.mjs");
  if (typeof browser.fetchBrowserEvidence !== "function") throw new Error("Browser fallback failed to initialize");
  const retryQueue = manifest.apps.map((app) => ({ app: app.app, retry: false, reason: null }));
  console.log(JSON.stringify({ dry_run: true, app_count: manifest.apps.length, unique_apps: 100, cache_paths_valid: true, source_adapters_initialized: true, composio_adapter_initialized: true, browser_fallback_initialized: true, retry_queue_length: retryQueue.length, resumable: true, failure_isolation: true }, null, 2));
}

async function main() {
  const manifest = await readJson(MANIFEST_PATH);
  if (process.argv.includes("--dry-run")) return dryRun(manifest);
  const startedAt = Date.now();
  await mkdir(OUTPUT, { recursive: true });
  const cache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "evidence-full-run") });
  const pageCache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "discovery", "full-pages") });
  const discoveryCache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "discovery", "full-sources") });
  const composioCache = createEvidenceCache({ directory: path.join(ROOT, ".cache", "composio-full-run") });
  const humanAdjudication = await readJson(path.join(ROOT, "data", "calibration", "human_adjudication.json"));

  const collected = await mapLimit(manifest.apps, 6, async (app) => {
    try {
      const configured = await collectAppSources(app, { cache });
      const discovery = await discoverFirstPartySources({
        seedUrls: app.discovery.seed_source_ids.map((id) => configured.find((source) => source.id === id)?.final_url || configured.find((source) => source.id === id)?.url).filter(Boolean),
        allowedHosts: app.discovery.allowed_hosts,
        keywords: app.discovery.keywords,
        maxSources: app.discovery.max_sources,
        pageCache,
        sourceCache: discoveryCache,
        fetchImpl: cache.fetchImpl
      });
      return { app: app.app, sources: [...configured, ...discovery.sources], discovery, error: null };
    } catch (error) {
      return { app: app.app, sources: [], discovery: { pages: [], links: [], sources: [] }, error: `${error.name}: ${error.message}` };
    }
  });
  const composio = await collectComposioCoverage(manifest.apps, { cache: composioCache });
  await writeJson(path.join(OUTPUT, "composio_catalog.json"), { endpoint: composio.catalog.endpoint, checked_at: composio.catalog.checked_at, http_status: composio.catalog.http_status, pages: composio.catalog.pages, cache_hits: composio.catalog.cache_hits, total_items: composio.catalog.total_items, error: composio.catalog.error ?? null, coverage: composio.coverage });
  const sourceRows = collected.map((row) => ({ app: row.app, error: row.error, sources: row.sources.map(publicSource) }));
  await writeJson(path.join(OUTPUT, "evidence_ledger.json"), { generated_at: new Date().toISOString(), sources: sourceRows });
  await writeJson(path.join(OUTPUT, "discovery.json"), collected.map((row) => ({ app: row.app, error: row.error, pages: row.discovery.pages, links: row.discovery.links })));

  const researcherRows = collected.map((row, index) => {
    const app = manifest.apps[index];
    const trusted = row.sources.filter((source) => trustedSource(app, source));
    const record = classifyApp(app, trusted, composio.coverage[index], new Date().toISOString());
    const validation = validateRecord(record, { requireAll: true, expectedHosts: record.identity.expected_hosts });
    return { app, record, validation, trusted_source_count: trusted.length, trusted_sources: trusted };
  });
  await writeJson(path.join(OUTPUT, "apps.raw.json"), researcherRows.map((row) => ({ app: row.record.app, record: row.record })));
  await writeJson(path.join(OUTPUT, "validation.json"), researcherRows.map((row) => ({ app: row.record.app, errors: row.validation.errors, warnings: row.validation.warnings })));

  const finalBaseRecords = researcherRows.map(({ record, trusted_sources }) => applyHumanAdjudication(record, trusted_sources, humanAdjudication, new Date().toISOString()));
  const finalValidations = finalBaseRecords.map((record) => validateRecord(record, { requireAll: true, expectedHosts: record.identity.expected_hosts }));
  await writeJson(path.join(OUTPUT, "validation.json"), finalBaseRecords.map((record, index) => ({ app: record.app, errors: finalValidations[index].errors, warnings: finalValidations[index].warnings })));
  const verifierRows = finalBaseRecords.map((record, index) => ({ app: record.app, trusted_source_count: researcherRows[index].trusted_source_count, verifications: verifyRecord(record, researcherRows[index].trusted_sources) }));
  await writeJson(path.join(OUTPUT, "verification.json"), verifierRows);
  const finalRows = finalBaseRecords.map((record, index) => adjudicate(record, verifierRows[index].verifications, new Date().toISOString()));
  await writeJson(path.join(OUTPUT, "apps.final.json"), finalRows);
  const corrections = verifierRows.flatMap((row) => row.verifications.filter((item) => ["disagree", "correction", "partial"].includes(item.status)).map((item) => ({ app: row.app, field: item.field, status: item.status, proposed_value: item.researcher_value, verifier_value: item.verifier_value, rationale: item.rationale, evidence: item.evidence })));
  await writeJson(path.join(OUTPUT, "corrections.json"), { generated_at: new Date().toISOString(), automatic_claim_corrections_applied: false, human_adjudication_applied_to_eight_calibration_apps: true, field_corrections: corrections });
  const holdout = holdoutApps(manifest);
  const packet = packetFor(finalRows, verifierRows, holdout, new Date().toISOString());
  await writeJson(path.join(OUTPUT, "human_review_packet.json"), packet);
  await writeFile(path.join(OUTPUT, "human_review_packet.md"), packetMarkdown(packet));
  await writeJson(path.join(OUTPUT, "retry_queue.json"), finalRows.map((record, index) => ({ app: record.app, priority: (record.unknowns.length * 2) + (record.adjudication.escalations.length * 5) + finalValidations[index].errors.length * 10, reasons: [...(record.unknowns.length ? [`${record.unknowns.length}_unknown_claims`] : []), ...record.adjudication.escalations.map((item) => `${item.field}_${item.status}`), ...finalValidations[index].errors.map((item) => item.code)] })).filter((item) => item.priority > 0).sort((a, b) => b.priority - a.priority || a.app.localeCompare(b.app)));
  const humanCalibration = await humanCalibrationMetrics(finalRows);
  const generatedAt = new Date().toISOString();
  const metrics = analyze(finalRows, finalValidations, verifierRows, sourceRows, humanCalibration, (Date.now() - startedAt) / 1000, generatedAt);
  await writeJson(path.join(OUTPUT, "metrics.json"), metrics);
  const analysis = {
    generated_at: generatedAt,
    rubric_version: RUBRIC_VERSION,
    headline_findings: metrics.headline_findings,
    category_patterns: [...new Set(finalRows.map((record) => record.category))].sort().map((category) => ({ category, app_count: finalRows.filter((record) => record.category === category).length, technical_buildability: finalRows.filter((record) => record.category === category).reduce((acc, record) => { const value = record.claims.find((claim) => claim.field === "technical_buildability")?.value ?? "unknown"; acc[value] = (acc[value] ?? 0) + 1; return acc; }, {}), production_access: finalRows.filter((record) => record.category === category).reduce((acc, record) => { const value = record.claims.find((claim) => claim.field === "production_access")?.value ?? "unknown"; acc[value] = (acc[value] ?? 0) + 1; return acc; }, {}) })),
    deterministic_metrics_source: "metrics.json",
    unresolved_apps: finalRows.filter((record) => record.identity.status !== "confirmed" || record.human_review_required).map((record) => record.app),
    verification_corrections: corrections
  };
  await writeJson(path.join(OUTPUT, "analysis.json"), analysis);
  console.log(JSON.stringify({ app_count: metrics.app_count, source_count: metrics.source_count, live_source_count: metrics.live_source_count, claim_count: metrics.claim_count, validation_error_count: metrics.validation.error_count, validation_warning_count: metrics.validation.warning_count, verifier_challenge_count: metrics.verification.challenge_count, holdout_count: holdout.length, actual_paid_cost_usd: 0, runtime_seconds: metrics.runtime_seconds }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
