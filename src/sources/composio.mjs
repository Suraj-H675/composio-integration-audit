import { createEvidenceCache } from "../cache.mjs";

export const COMPOSIO_TOOLKITS_ENDPOINT = "https://backend.composio.dev/api/v3.1/toolkits";

const MATCH_STATUSES = ["exact_match", "strong_alias_match", "no_match", "ambiguous"];

export function normalizeToolkitLabel(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeToolkit(item, matchKind = null) {
  return {
    slug: item.slug ?? null,
    name: item.name ?? null,
    type: item.type ?? null,
    version: item.meta?.version ?? item.version ?? null,
    tools_count: item.meta?.tools_count ?? null,
    triggers_count: item.meta?.triggers_count ?? null,
    description: item.meta?.description ?? null,
    app_url: item.meta?.app_url ?? null,
    auth_schemes: item.auth_schemes ?? [],
    is_deprecated: item.is_deprecated ?? null,
    deprecated: item.deprecated ?? null,
    ...(matchKind ? { match_kind: matchKind } : {})
  };
}

function itemLabels(item) {
  return [item.slug, item.name].map(normalizeToolkitLabel).filter(Boolean);
}

function appNames(app) {
  const config = app.composio ?? {};
  return new Set([...(config.canonical_names ?? [app.app])].map(normalizeToolkitLabel).filter(Boolean));
}

function appAliases(app) {
  return new Set((app.composio?.strong_aliases ?? app.composio_aliases ?? []).map(normalizeToolkitLabel).filter(Boolean));
}

function nearMatch(item, names, aliases) {
  const terms = new Set([...names, ...aliases].flatMap((value) => value.split(" ").filter((term) => term.length > 2)));
  const labels = itemLabels(item);
  const overlap = [...terms].filter((term) => labels.some((label) => label.split(" ").includes(term)));
  return overlap.length ? { ...normalizeToolkit(item, "near_match"), overlap_terms: overlap } : null;
}

export function matchToolkit(app, catalogItems) {
  const names = appNames(app);
  const aliases = appAliases(app);
  const exact = [];
  const strongAliases = [];
  const nearMatches = [];

  for (const item of catalogItems ?? []) {
    const labels = itemLabels(item);
    if (labels.some((label) => names.has(label))) exact.push(normalizeToolkit(item, "exact_match"));
    else if (labels.some((label) => aliases.has(label))) strongAliases.push(normalizeToolkit(item, "strong_alias_match"));
    else {
      const near = nearMatch(item, names, aliases);
      if (near) nearMatches.push(near);
    }
  }

  let match_status = "no_match";
  let matches = [];
  if (exact.length === 1) {
    match_status = "exact_match";
    matches = exact;
  } else if (exact.length > 1) {
    match_status = "ambiguous";
    matches = exact;
  } else if (strongAliases.length === 1) {
    match_status = "strong_alias_match";
    matches = strongAliases;
  } else if (strongAliases.length > 1) {
    match_status = "ambiguous";
    matches = strongAliases;
  }

  return {
    match_status,
    value: match_status === "ambiguous" ? "unknown" : match_status === "no_match" ? "no" : "yes",
    confidence: match_status === "ambiguous" ? "low" : "high",
    matched_toolkits: matches,
    near_matches: nearMatches.slice(0, 8),
    ...(MATCH_STATUSES.includes(match_status) ? {} : { match_status: "ambiguous" })
  };
}

async function fetchCatalogPage(url, { apiKey, cache, fetchImpl, now }) {
  return cache.get(url, async () => {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`Composio catalog request failed with HTTP ${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("Composio catalog returned invalid JSON");
    }
    return {
      endpoint: COMPOSIO_TOOLKITS_ENDPOINT,
      request_url: url,
      checked_at: now(),
      http_status: response.status,
      items: body.items ?? [],
      next_cursor: body.next_cursor ?? null,
      total_items: body.total_items ?? null,
      total_pages: body.total_pages ?? null
    };
  });
}

export async function fetchComposioCatalog({
  apiKey = process.env.COMPOSIO_API_KEY,
  cache = createEvidenceCache({ directory: ".cache/composio" }),
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString()
} = {}) {
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is required for catalog coverage");
  const items = [];
  const seen = new Set();
  let url = new URL(COMPOSIO_TOOLKITS_ENDPOINT);
  url.searchParams.set("limit", "1000");
  url.searchParams.set("sort_by", "alphabetically");
  url.searchParams.set("include_deprecated", "false");
  url.searchParams.set("type", "native");
  let pageCount = 0;
  let cacheHits = 0;
  let firstPage = null;

  while (url) {
    const page = await fetchCatalogPage(url.toString(), { apiKey, cache, fetchImpl, now });
    pageCount += 1;
    if (page.cache_hit) cacheHits += 1;
    firstPage ??= page;
    for (const item of page.items) {
      if (!item.slug || seen.has(item.slug)) continue;
      seen.add(item.slug);
      items.push(item);
    }
    url = page.next_cursor
      ? new URL(`${COMPOSIO_TOOLKITS_ENDPOINT}?limit=1000&sort_by=alphabetically&include_deprecated=false&type=native&cursor=${encodeURIComponent(page.next_cursor)}`)
      : null;
  }

  return {
    endpoint: COMPOSIO_TOOLKITS_ENDPOINT,
    checked_at: firstPage?.checked_at ?? now(),
    http_status: firstPage?.http_status ?? null,
    total_items: firstPage?.total_items ?? items.length,
    pages: pageCount,
    cache_hits: cacheHits,
    items
  };
}

export function lookupComposioCoverage(app, catalog) {
  const match = matchToolkit(app, catalog.items ?? []);
  const labels = match.matched_toolkits.map((item) => `${item.slug} (${item.name})`).join(", ");
  let statement;
  if (match.match_status === "no_match") {
    statement = `Composio's current native toolkit catalog returned no exact or configured strong-alias match for ${app.app}; adjacent products were not counted.`;
  } else if (match.match_status === "ambiguous") {
    statement = `Composio's current native toolkit catalog returned multiple plausible matches for ${app.app}; coverage remains unknown until identity is adjudicated.`;
  } else {
    const label = match.match_status.replaceAll("_", " ");
    const article = label.startsWith("exact") ? "an" : "a";
    statement = `Composio's current native toolkit catalog returned ${article} ${label} for ${app.app}: ${labels}.`;
  }
  return {
    ...match,
    evidence: [{
      url: catalog.endpoint,
      source_type: "composio_catalog",
      retrieval_method: "http",
      checked_at: catalog.checked_at,
      http_status: catalog.http_status,
      supports: "composio_toolkit_exists",
      statement
    }],
    reason: `Catalog match status: ${match.match_status}.`
  };
}

export async function collectComposioCoverage(apps, options = {}) {
  try {
    const catalog = await fetchComposioCatalog(options);
    return {
      catalog,
      coverage: apps.map((app) => ({ app: app.app, ...lookupComposioCoverage(app, catalog) }))
    };
  } catch (error) {
    const checked_at = (options.now ?? (() => new Date().toISOString()))();
    return {
      catalog: {
        endpoint: COMPOSIO_TOOLKITS_ENDPOINT,
        checked_at,
        http_status: null,
        pages: 0,
        cache_hits: 0,
        items: [],
        error: error.message
      },
      coverage: apps.map((app) => ({
        app: app.app,
        match_status: "unavailable",
        value: "unknown",
        confidence: "unknown",
        matched_toolkits: [],
        near_matches: [],
        evidence: [{
          url: COMPOSIO_TOOLKITS_ENDPOINT,
          source_type: "composio_catalog",
          retrieval_method: "http",
          checked_at,
          http_status: null,
          supports: "composio_toolkit_exists",
          statement: `Composio catalog could not be checked: ${error.message}.`
        }],
        reason: "Catalog unavailable; no toolkit existence conclusion was made."
      }))
    };
  }
}
