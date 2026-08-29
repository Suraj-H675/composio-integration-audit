function claimIsUnknown(claim) {
  return claim?.value === "unknown" || (Array.isArray(claim?.value) && claim.value.includes("unknown"));
}

export function scoreRecord(record, validation = { errors: [], warnings: [] }) {
  const reasons = [];
  let score = 0;
  if (record.identity?.status === "unresolved") {
    score += 8;
    reasons.push("identity_unresolved");
  } else if (record.identity?.status === "ambiguous") {
    score += 6;
    reasons.push("identity_ambiguous");
  }

  const unknownCount = (record.claims ?? []).filter(claimIsUnknown).length;
  if (unknownCount) {
    score += unknownCount;
    reasons.push(`${unknownCount}_unknown_claims`);
  }
  if (validation.errors?.length) {
    score += validation.errors.length * 5;
    reasons.push(`${validation.errors.length}_validation_errors`);
  }
  if (validation.warnings?.length) {
    score += validation.warnings.length * 2;
    reasons.push(`${validation.warnings.length}_validation_warnings`);
  }
  return { app: record.app, priority_score: score, reasons };
}

export function rankRecords(records) {
  return records
    .map(({ record, validation }) => scoreRecord(record, validation))
    .sort((left, right) => right.priority_score - left.priority_score || left.app.localeCompare(right.app));
}
