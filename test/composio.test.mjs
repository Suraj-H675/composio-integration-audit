import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidenceCache } from "../src/cache.mjs";
import {
  fetchComposioCatalog,
  matchToolkit,
  lookupComposioCoverage
} from "../src/sources/composio.mjs";

const toolkit = (slug, name, description = "") => ({
  slug,
  name,
  type: "native",
  meta: { description, tools_count: 3, version: "20260813_00", app_url: `https://${slug}.example.com` },
  auth_schemes: ["oauth2"]
});

test("toolkit matching distinguishes exact, alias, ambiguous, and umbrella candidates", () => {
  assert.equal(matchToolkit({ app: "GitHub" }, [toolkit("github", "GitHub")]).match_status, "exact_match");
  assert.equal(matchToolkit({ app: "Otter AI", composio: { canonical_names: ["Otter meetings"], strong_aliases: ["otter.ai"] } }, [toolkit("otter", "Otter.ai")]).match_status, "strong_alias_match");
  assert.equal(matchToolkit({ app: "Paygent Connect", composio_aliases: ["paygent"] }, [toolkit("paygent", "Paygent"), toolkit("paygent_connect", "Paygent Connect")]).match_status, "exact_match");

  const mermaid = matchToolkit({ app: "Mermaid CLI" }, [toolkit("mermaid_chart_mcp", "Mermaid Chart MCP")]);
  assert.equal(mermaid.match_status, "no_match");
  assert.deepEqual(mermaid.matched_toolkits, []);
});

test("catalog lookup preserves toolkit identifiers and produces Composio evidence", () => {
  const result = lookupComposioCoverage({ app: "GitHub" }, {
    items: [toolkit("github", "GitHub")],
    endpoint: "https://backend.composio.dev/api/v3.1/toolkits",
    checked_at: "2026-08-27T00:00:00.000Z",
    http_status: 200,
    pages: 1
  });

  assert.equal(result.value, "yes");
  assert.equal(result.match_status, "exact_match");
  assert.equal(result.matched_toolkits[0].slug, "github");
  assert.equal(result.evidence[0].source_type, "composio_catalog");
  assert.match(result.evidence[0].statement, /github/i);
});

test("catalog requests are cached and never persist the API key", async () => {
  const secret = "test-secret-do-not-write";
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).pathname, "/api/v3.1/toolkits");
    assert.equal(options.headers["x-api-key"], secret);
    return new Response(JSON.stringify({ items: [toolkit("github", "GitHub")], next_cursor: null, total_items: 1, total_pages: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const directory = await mkdtemp(path.join(tmpdir(), "agent-audit-composio-"));
  const cache = createEvidenceCache({ directory, fetchImpl, now: () => "2026-08-27T00:00:00.000Z" });

  try {
    const first = await fetchComposioCatalog({ apiKey: secret, cache, fetchImpl });
    const second = await fetchComposioCatalog({ apiKey: secret, cache, fetchImpl });
    assert.equal(calls, 1);
    assert.equal(second.cache_hits, 1);
    const files = await readdir(directory);
    const cached = await readFile(path.join(directory, files[0]), "utf8");
    assert.equal(first.items[0].slug, "github");
    assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
    assert.doesNotMatch(cached, new RegExp(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
