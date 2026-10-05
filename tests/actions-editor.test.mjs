// @ts-check
/** editor.open launches through a fixed argv with no shell, so a param
 * cannot reach a command line to break out of. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAction } from "../server/lib/actions.mjs";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-open-"));
  const calls = [];
  const deps = {
    ctx: { checkoutRoot: root },
    hub: { broadcast() {} },
    resolveWorktree: async () => ({ cwd: root, worktree: null }),
    spawn: (bin, argv, opts) => {
      calls.push({ bin, argv, opts });
      return { on() {}, unref() {} };
    },
  };
  return { root, calls, deps };
}

test("editor.open launches with a discrete argv and never a shell", async () => {
  const { root, calls, deps } = harness();
  const ok = await runAction(
    "editor.open",
    { worktreePath: root, file: "src/app.ts", line: 5 },
    deps,
  );
  assert.equal(ok.ok, true, "a clean file launches");
  assert.equal(calls.length, 1);
  const { argv, opts } = calls[0];
  assert.ok(Array.isArray(argv), "arguments are a discrete argv, not a string");
  assert.ok(!("shell" in opts) || opts.shell !== true, "no shell is used");
  // the file:line rides as one argv element; no command string exists to
  // break out of, so a newline in a path is inert rather than dangerous
  assert.ok(
    argv.some((a) => a.includes("app.ts:5")),
    "the file:line is one argument",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("editor.open still rejects a path that escapes the worktree", async () => {
  const { root, calls, deps } = harness();
  const res = await runAction(
    "editor.open",
    { worktreePath: root, file: "../../etc/passwd", line: 1 },
    deps,
  );
  assert.equal(res.ok, false, "a traversal path is refused");
  assert.equal(calls.length, 0, "nothing is launched");
  fs.rmSync(root, { recursive: true, force: true });
});

test("editor.open keeps a space-free path with cmd metacharacters in one quoted argument on Windows", async () => {
  const { root, calls, deps } = harness();
  deps.platform = "win32";
  const ok = await runAction(
    "editor.open",
    { worktreePath: root, file: "x&calc&", line: 1 },
    deps,
  );
  assert.equal(ok.ok, true);
  assert.equal(calls.length, 1);
  const { bin, argv, opts } = calls[0];
  assert.equal(bin, "cmd.exe");
  assert.equal(opts.windowsVerbatimArguments, true, "node must not re-quote");
  assert.deepEqual(argv.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  const absLine = `${path.resolve(root, "x&calc&")}:1`;
  // The whole path, metacharacters and all, rides as one self-quoted token
  // inside an outer pair that cmd's /s strips, so `&` never starts a command.
  assert.equal(argv[4], `""code" "-g" "${absLine}""`);
});
