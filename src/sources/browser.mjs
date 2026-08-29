import { createEvidenceCache } from "../cache.mjs";
import { htmlToText } from "../fetcher.mjs";

export function shouldUseBrowserFallback(result) {
  if (!result) return true;
  if (["blocked", "inaccessible", "browser_unavailable"].includes(result.status)) return true;
  if (!result.content_text || result.content_text.length < 240) return true;
  if (result.content_type?.includes("html") && /enable javascript|javascript required|loading\.\.\.|__next_f|webpackJsonp/i.test(result.content_text)) return true;
  return false;
}

function browserError(error) {
  return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
}

async function loadPlaywright(playwrightModule) {
  if (playwrightModule) return playwrightModule;
  try {
    return await import("playwright");
  } catch (error) {
    return { unavailable: browserError(error) };
  }
}

export async function fetchBrowserEvidence(url, {
  cache = createEvidenceCache(),
  now = cache.now,
  timeout = 20000,
  maxContentLength = 250000,
  reason = "HTTP evidence was incomplete or inaccessible.",
  playwrightModule = null
} = {}) {
  return cache.get(`browser:${url}`, async () => {
    const playwright = await loadPlaywright(playwrightModule);
    if (playwright.unavailable) {
      return {
        url,
        final_url: url,
        retrieval_method: "browser",
        checked_at: now(),
        http_status: null,
        status: "browser_unavailable",
        content_type: null,
        title: url,
        content_text: "",
        content_length: 0,
        fallback_reason: reason,
        error: playwright.unavailable
      };
    }

    let browser;
    try {
      const chromium = playwright.chromium ?? playwright.default?.chromium;
      if (!chromium) throw new Error("Playwright Chromium is unavailable.");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ userAgent: "agent-buildability-audit/0.1 (browser evidence verifier)" });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) }).catch(() => {});
      const bodyText = await page.locator("body").innerText({ timeout }).catch(async () => htmlToText(await page.content()));
      const contentText = bodyText.replace(/\s+/g, " ").trim();
      return {
        url,
        final_url: page.url() || url,
        retrieval_method: "browser",
        checked_at: now(),
        http_status: response?.status() ?? null,
        status: response && response.status() >= 200 && response.status() < 400 ? "live" : "inaccessible",
        content_type: response?.headers()?.["content-type"] ?? "text/html",
        title: await page.title().catch(() => url),
        content_text: contentText.slice(0, maxContentLength),
        content_length: contentText.length,
        fallback_reason: reason,
        error: null
      };
    } catch (error) {
      return {
        url,
        final_url: url,
        retrieval_method: "browser",
        checked_at: now(),
        http_status: null,
        status: "inaccessible",
        content_type: null,
        title: url,
        content_text: "",
        content_length: 0,
        fallback_reason: reason,
        error: browserError(error)
      };
    } finally {
      await browser?.close().catch(() => {});
    }
  });
}
