import { createEvidenceCache } from "./cache.mjs";

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function pageTitle(html, fallback) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 180) : fallback;
}

function classifyStatus(status) {
  if (status >= 200 && status < 400) return "live";
  if ([401, 403, 429, 451, 503].includes(status)) return "blocked";
  return "inaccessible";
}

export function excerpt(text, pattern, radius = 140) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
  const globalFlags = [...new Set(`${regex.flags}g`)].join("");
  const globalRegex = new RegExp(regex.source, globalFlags);
  const matches = [...text.matchAll(globalRegex)];
  const match = matches.find((item) => item.index > 400) ?? matches[0];
  if (!match) return text.slice(0, Math.min(radius * 2, text.length));
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export async function fetchEvidence(url, {
  cache = createEvidenceCache(),
  now = cache.now,
  maxContentLength = 250000
} = {}) {
  return cache.get(url, async () => {
    try {
      const response = await cache.fetchImpl(url, {
        redirect: "follow",
        headers: {
          "user-agent": "agent-buildability-audit/0.1 (research evidence collector)",
          accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5"
        },
        signal: AbortSignal.timeout(20000)
      });
      const body = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const contentText = contentType.includes("html") ? htmlToText(body) : body.replace(/\s+/g, " ").trim();
      return {
        url,
        final_url: response.url || url,
        retrieval_method: "http",
        checked_at: now(),
        http_status: response.status,
        status: classifyStatus(response.status),
        content_type: contentType,
        title: contentType.includes("html") ? pageTitle(body, url) : url,
        content_text: contentText.slice(0, maxContentLength),
        content_length: contentText.length,
        error: null
      };
    } catch (error) {
      return {
        url,
        final_url: url,
        retrieval_method: "http",
        checked_at: now(),
        http_status: null,
        status: "inaccessible",
        content_type: null,
        title: url,
        content_text: "",
        content_length: 0,
        error: `${error.name}: ${error.message}`
      };
    }
  });
}
