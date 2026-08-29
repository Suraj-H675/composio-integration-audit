import { createHash } from "node:crypto";
import { createEvidenceCache } from "../cache.mjs";
import { fetchEvidence } from "../fetcher.mjs";

function hostAllowed(hostname, allowedHosts) {
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function discoveryScore(url, keywords) {
  const haystack = `${url.pathname} ${url.search}`.toLowerCase();
  return keywords.reduce((score, keyword) => score + (haystack.includes(String(keyword).toLowerCase()) ? 3 : 0), 0);
}

export function extractFirstPartyLinks(html, baseUrl, allowedHosts = [], keywords = []) {
  const links = [];
  const seen = new Set();
  const pattern = /<(a|link|script)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    let url;
    try {
      url = new URL(match[2], baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || !hostAllowed(url.hostname, allowedHosts)) continue;
    url.hash = "";
    if (/\.(?:css|png|jpe?g|gif|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url.pathname)) continue;
    const kind = match[1].toLowerCase() === "script" ? "script" : "link";
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    const score = discoveryScore(url, keywords) + (kind === "script" ? 1 : 0);
    if (kind !== "script" && score === 0) continue;
    seen.add(normalized);
    links.push({ url: normalized, kind, score });
  }
  return links.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
}

function discoveryId(url) {
  return `discovery-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

async function fetchDiscoveryPage(url, { cache, fetchImpl, now, allowedHosts, keywords }) {
  return cache.get(url, async () => {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        headers: { "user-agent": "agent-buildability-audit/0.1 (first-party discovery)", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(20000)
      });
      const body = await response.text();
      return {
        url,
        final_url: response.url || url,
        checked_at: now(),
        http_status: response.status,
        status: response.ok ? "live" : "inaccessible",
        links: response.ok ? extractFirstPartyLinks(body, response.url || url, allowedHosts, keywords) : [],
        error: null
      };
    } catch (error) {
      return { url, final_url: url, checked_at: now(), http_status: null, status: "inaccessible", links: [], error: `${error.name}: ${error.message}` };
    }
  });
}

export async function discoverFirstPartySources({
  seedUrls = [],
  allowedHosts = [],
  keywords = ["api", "docs", "developer", "mcp", "connect"],
  maxSources = 8,
  pageCache = createEvidenceCache({ directory: ".cache/discovery/pages" }),
  sourceCache = createEvidenceCache({ directory: ".cache/discovery/sources" }),
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  sourceType = "official_product_docs"
} = {}) {
  const pages = [];
  const links = [];
  const seenLinks = new Set();
  for (const seedUrl of seedUrls) {
    const page = await fetchDiscoveryPage(seedUrl, { cache: pageCache, fetchImpl, now, allowedHosts, keywords });
    pages.push({ ...page, cache_hit: page.cache_hit ?? false });
    for (const link of page.links ?? []) {
      if (seenLinks.has(link.url)) continue;
      seenLinks.add(link.url);
      links.push({ ...link, discovered_from: seedUrl });
    }
  }

  const selected = links
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
    .slice(0, maxSources);
  const sources = [];
  for (const link of selected) {
    const result = await fetchEvidence(link.url, { cache: sourceCache, now, fetchImpl, maxContentLength: 1000000 });
    sources.push({
      ...result,
      id: discoveryId(link.url),
      source_type: sourceType,
      expected_hosts: allowedHosts,
      roles: ["discovered", "verify"],
      discovery_kind: link.kind,
      discovery_score: link.score,
      discovered_from: link.discovered_from
    });
  }
  return { pages, links: selected, sources };
}
