import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function cacheKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

export function createEvidenceCache({
  directory = ".cache/evidence",
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  return {
    directory,
    fetchImpl,
    now,
    async get(url, loader) {
      const filename = path.join(directory, `${cacheKey(url)}.json`);
      try {
        const cached = JSON.parse(await readFile(filename, "utf8"));
        return { ...cached, cache_hit: true };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      const fresh = await loader();
      await mkdir(directory, { recursive: true });
      await writeFile(filename, JSON.stringify(fresh, null, 2));
      return { ...fresh, cache_hit: false };
    }
  };
}
