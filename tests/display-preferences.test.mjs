import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  readDisplay,
  saveDisplay,
} from "../server/core/display-preferences.mjs";
const { Preferences } = createRequire(import.meta.url)(
  "../desktop/lib/preferences.cjs",
);

test("desktop starts simple and keeps individual display choices across reopening", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ocelin-display-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefs = new Preferences(root);
  assert.equal(prefs.value.showSummary, true);
  assert.equal(prefs.value.showAllowances, false);
  assert.equal(prefs.value.showMemory, false);
  prefs.update({
    showAllowances: true,
    showMemory: "true",
    showSessionDetails: true,
  });
  const restored = new Preferences(root).value;
  assert.equal(restored.showAllowances, true);
  assert.equal(restored.showSessionDetails, true);
  assert.equal(restored.showMemory, false);
  assert.equal(restored.quiet, false);
});

test("workspace choices persist independently and reject unsupported settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ocelin-workspace-display-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "display.json");
  assert.equal(readDisplay(file).metrics, false);
  saveDisplay(file, { metrics: true });
  saveDisplay(file, { activity: true });
  assert.equal(readDisplay(file).metrics, true);
  assert.equal(readDisplay(file).activity, true);
  assert.throws(() => saveDisplay(file, { command: "anything" }));
  assert.throws(() => saveDisplay(file, { health: "true" }));
  assert.equal(readDisplay(file).health, false);
});
