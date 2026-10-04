import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { firstReturnModel } from "../desktop/renderer/first-return.mjs";
const require = createRequire(import.meta.url);
const { Preferences } = require("../desktop/lib/preferences.cjs");
const session = (provider, patch = {}) => ({
  key: `${provider}:one`,
  provider,
  lastTs: 100,
  title: "Sample task",
  ...patch,
});
const state = (patch = {}) => ({
  sampledAt: 200,
  diagnostics: [
    { provider: "codex", status: "available" },
    { provider: "claude", status: "available" },
  ],
  connections: { codex: { nativeOpen: true }, claude: { nativeOpen: true } },
  sessions: [session("codex"), session("claude")],
  hiddenKeys: [],
  ...patch,
});
test("first return chooses a visible provider session without suggesting a hidden task or subagent", () => {
  const value = state({
    sessions: [
      session("codex"),
      session("codex", { key: "hidden", lastTs: 300 }),
      session("codex", { key: "child", parentId: "codex:one", lastTs: 400 }),
      session("codex", { key: "legacy-child", subagent: true, lastTs: 401 }),
      session("claude", { lastTs: 500 }),
    ],
    hiddenKeys: ["hidden"],
  });
  assert.equal(firstReturnModel(value, "codex").candidate.key, "codex:one");
  assert.equal(firstReturnModel(value, "claude").candidate.key, "claude:one");
  assert.equal(firstReturnModel(value, "codex").canOpen, true);
});
test("read-only and unavailable-provider sessions stay previewable without native opening", () => {
  for (const provider of ["codex", "claude"]) {
    const remote = firstReturnModel(
      state({ sessions: [session(provider, { readOnlySource: true })] }),
      provider,
    );
    assert.ok(remote.candidate);
    assert.equal(remote.canOpen, false);
    assert.match(remote.detail, /original computer/);
    const missing = firstReturnModel(state({ connections: {} }), provider);
    assert.ok(missing.candidate);
    assert.equal(missing.canOpen, false);
    assert.match(missing.detail, /desktop app/);
  }
});
test("discovery, empty history, and unavailable folders have distinct recovery guidance", () => {
  const scanning = firstReturnModel(
    state({ sampledAt: null, diagnostics: [], sessions: [] }),
    "codex",
  );
  assert.equal(scanning.scanning, true);
  assert.match(scanning.detail, /Looking/);
  const empty = firstReturnModel(state({ sessions: [] }), "claude");
  assert.equal(empty.canOpen, false);
  assert.match(empty.detail, /History/);
  const missing = firstReturnModel(
    state({
      sessions: [],
      diagnostics: [{ provider: "claude", status: "unreadable" }],
    }),
    "claude",
  );
  assert.match(missing.detail, /source folders and account profiles/);
});
test("new installs show first return once while existing preferences keep their established view", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-first-return-"));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fresh = new Preferences(dir);
  assert.equal(fresh.value.firstReturnDismissed, false);
  fresh.update({ firstReturnDismissed: true });
  assert.equal(new Preferences(dir).value.firstReturnDismissed, true);
  fresh.update({ firstReturnDismissed: false });
  assert.equal(new Preferences(dir).value.firstReturnDismissed, false);
  await writeFile(
    join(dir, "preferences.json"),
    JSON.stringify({ theme: "light" }),
  );
  assert.equal(new Preferences(dir).value.firstReturnDismissed, true);
});
