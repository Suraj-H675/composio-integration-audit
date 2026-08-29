import presentationData from "../../../data/presentation.json";
import lock from "../../../data/final/DATASET_LOCK.json";
import { PRESENTATION_FIELDS } from "../../../src/presentation_logic.mjs";

function isUnknown(value: unknown) {
  return value === "unknown" || (Array.isArray(value) && value.length === 1 && value[0] === "unknown");
}

export async function GET() {
  const apps = presentationData.apps;
  const names = apps.map((record) => record.app);
  const requiredFields = apps.every((record) => {
    const fields = new Set((record.claims ?? []).map((claim) => claim.field));
    return PRESENTATION_FIELDS.every((field) => fields.has(field));
  });
  const evidenceLinksPresent = apps.every((record) => (record.claims ?? []).every((claim) => isUnknown(claim.value) || (claim.evidence ?? []).every((evidence) => /^https?:\/\//.test(evidence.url))));
  const sourceHashMatchesLock = presentationData.integrity?.sourceAppsSha256 === lock.artifact_hashes?.["apps.json"];
  const ledgerHashMatchesLock = presentationData.integrity?.sourceLedgerSha256 === lock.artifact_hashes?.["evidence_ledger.json"];
  const checks = [
    { label: "Frozen dataset status", ok: presentationData.dataset.status === "frozen" && lock.dataset_status === "frozen", detail: presentationData.dataset.status },
    { label: "Dataset version", ok: presentationData.dataset.id === "2026-08-28.final.v2" && lock.dataset_id === "2026-08-28.final.v2", detail: presentationData.dataset.id },
    { label: "App count", ok: apps.length === 100 && presentationData.dataset.appCount === 100, detail: `${apps.length} / 100` },
    { label: "Unique app names", ok: new Set(names).size === 100, detail: `${new Set(names).size} unique` },
    { label: "Required claims", ok: requiredFields, detail: requiredFields ? "all presentation fields present" : "missing claims detected" },
    { label: "apps.json SHA-256", ok: sourceHashMatchesLock, detail: presentationData.integrity?.sourceAppsSha256 ?? "missing source hash" },
    { label: "Evidence ledger SHA-256", ok: ledgerHashMatchesLock, detail: ledgerHashMatchesLock ? "matches presentation build" : "ledger hash mismatch" },
    { label: "Evidence links", ok: evidenceLinksPresent, detail: evidenceLinksPresent ? "all linked evidence uses HTTP(S) URLs" : "invalid evidence link" }
  ];
  return Response.json({ ok: checks.every((check) => check.ok), datasetId: lock.dataset_id, checks });
}
