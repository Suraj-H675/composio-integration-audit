import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidenceCache } from "../src/cache.mjs";
import { fetchBrowserEvidence, shouldUseBrowserFallback } from "../src/sources/browser.mjs";

test("browser fallback is reserved for blocked or incomplete HTTP evidence", () => {
  assert.equal(shouldUseBrowserFallback({ status: "live", content_type: "text/html", content_text: "A complete page with enough content ".repeat(20) }), false);
  assert.equal(shouldUseBrowserFallback({ status: "blocked", content_text: "" }), true);
  assert.equal(shouldUseBrowserFallback({ status: "live", content_type: "text/html", content_text: "Loading..." }), true);
});

test("browser adapter records rendered text and retrieval method", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-audit-browser-"));
  const cache = createEvidenceCache({ directory, fetchImpl: async () => new Response("") });
  const fakePlaywright = {
    chromium: {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => ({ status: () => 200, headers: () => ({ "content-type": "text/html" }) }),
          waitForLoadState: async () => {},
          locator: () => ({ innerText: async () => "Rendered API documentation with current credentials and webhook details." }),
          title: async () => "Rendered docs",
          url: () => "https://example.com/docs"
        }),
        close: async () => {}
      })
    }
  };
  try {
    const result = await fetchBrowserEvidence("https://example.com/docs", { cache, playwrightModule: fakePlaywright, reason: "HTTP shell" });
    assert.equal(result.status, "live");
    assert.equal(result.retrieval_method, "browser");
    assert.match(result.content_text, /Rendered API documentation/);
    assert.equal(result.fallback_reason, "HTTP shell");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
