import test from "node:test";
import assert from "node:assert/strict";
import { extractFirstPartyLinks } from "../src/sources/discovery.mjs";

test("discovery keeps same-vendor links and ranks targeted documentation paths", () => {
  const html = `
    <a href="/docs/api">API docs</a>
    <a href="/pricing">Pricing</a>
    <script src="/assets/app.js"></script>
    <a href="https://external.test/docs/api">External</a>
    <a href="mailto:help@example.com">Email</a>
  `;
  const links = extractFirstPartyLinks(html, "https://example.com/", ["example.com"], ["api", "docs"]);
  assert.deepEqual(links.map((item) => item.url), [
    "https://example.com/docs/api",
    "https://example.com/assets/app.js"
  ]);
  assert.equal(links[0].kind, "link");
  assert.ok(links[0].score > links[1].score);
});
