import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchEvidence } from "../src/fetcher.mjs";
import { createEvidenceCache } from "../src/cache.mjs";

test("evidence cache prevents a second fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("<html><title>Docs</title><p>REST API documentation</p></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  };
  const directory = await mkdtemp(path.join(tmpdir(), "agent-audit-cache-"));
  const cache = createEvidenceCache({
    directory,
    fetchImpl,
    now: () => "2026-08-27T00:00:00.000Z"
  });

  try {
    const first = await fetchEvidence("https://docs.example.com/api", { cache });
    const second = await fetchEvidence("https://docs.example.com/api", { cache });

    assert.equal(calls, 1);
    assert.equal(first.http_status, 200);
    assert.equal(second.cache_hit, true);
    assert.equal(second.content_text, first.content_text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
