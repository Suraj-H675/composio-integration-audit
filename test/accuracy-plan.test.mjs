import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("accuracy methodology is preregistered before final outcomes", async () => {
  const plan = JSON.parse(await readFile(new URL("../config/accuracy_plan.json", import.meta.url), "utf8"));
  assert.equal(plan.status, "pre_registered");
  assert.ok(plan.sample_size >= 20);
  assert.equal(plan.sampling.fixed_before_outcomes, true);
  assert.equal(plan.sampling.stratified_categories, 10);
  assert.ok(plan.fields.length >= 10);
  assert.deepEqual(plan.labels, ["correct", "partial", "wrong", "unverifiable"]);
});
