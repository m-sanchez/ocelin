// @ts-check
/** editor.open on Windows routes through cmd.exe, so this exercises the real
 * launcher end to end: a fake code.cmd on PATH records the arguments it was
 * actually given, and an injected path must arrive as one inert argument with
 * no second command run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAction } from "../server/lib/actions.mjs";

const skip =
  process.platform === "win32"
    ? false
    : "Windows-only: exercises the real cmd.exe editor launcher";

/** Poll for a file to appear (the detached launcher writes it asynchronously). */
async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function fakeEditor(binDir, argsOut) {
  fs.writeFileSync(
    path.join(binDir, "code.cmd"),
    `@echo off\r\n> "${argsOut}" echo %*\r\n`,
  );
}

test("editor.open passes an injected path to cmd.exe as one inert argument", { skip }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "editor-win-inject-"));
  const binDir = path.join(work, "bin");
  const repo = path.join(work, "repo");
  fs.mkdirSync(binDir);
  fs.mkdirSync(repo);
  const argsOut = path.join(work, "code-args.txt");
  fakeEditor(binDir, argsOut);

  const prevPath = process.env.PATH;
  const prevPathExt = process.env.PATHEXT;
  const prevCwd = process.cwd();
  process.env.PATH = binDir + path.delimiter + (prevPath || "");
  if (!/(^|;)\.CMD(;|$)/i.test(prevPathExt || ""))
    process.env.PATHEXT = `${prevPathExt || ""};.CMD`;
  // `>marker` in an injected command would write relative to the cwd, so point
  // the cwd at the temp dir where its appearance is detectable and contained.
  process.chdir(work);

  try {
    // Space-free on purpose: a path with a space is auto-quoted by libuv, which
    // would mask the bug. `cd>injected` writes a file iff an unquoted `&` lets
    // cmd start a second command.
    const res = await runAction(
      "editor.open",
      { worktreePath: repo, file: "x&cd>injected&z.ts", line: 1 },
      {
        ctx: { checkoutRoot: repo },
        hub: { broadcast() {} },
        resolveWorktree: async () => ({ cwd: repo, worktree: null }),
      },
    );
    assert.equal(res.ok, true, "a clean (if hostile) path launches");

    const wrote = await waitForFile(argsOut);
    assert.ok(wrote, "the fake editor must have been invoked");
    const recorded = fs.readFileSync(argsOut, "utf8");
    // The whole path reached the editor as one argument, metacharacters and all.
    assert.match(recorded, /cd>injected/, "the path arrives verbatim as data");
    assert.match(recorded, /z\.ts:1/, "the file:line is intact");
    assert.ok(
      !fs.existsSync(path.join(work, "injected")),
      "the injected `& cd>injected &` must not have run",
    );
  } finally {
    process.chdir(prevCwd);
    process.env.PATH = prevPath;
    if (prevPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = prevPathExt;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("editor.open preserves spaces and parentheses in a Windows path", { skip }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "editor-win-spaces-"));
  const binDir = path.join(work, "bin");
  const repo = path.join(work, "repo");
  fs.mkdirSync(binDir);
  fs.mkdirSync(repo);
  const argsOut = path.join(work, "code-args.txt");
  fakeEditor(binDir, argsOut);

  const prevPath = process.env.PATH;
  const prevPathExt = process.env.PATHEXT;
  process.env.PATH = binDir + path.delimiter + (prevPath || "");
  if (!/(^|;)\.CMD(;|$)/i.test(prevPathExt || ""))
    process.env.PATHEXT = `${prevPathExt || ""};.CMD`;

  try {
    const res = await runAction(
      "editor.open",
      { worktreePath: repo, file: "Program Files (x86)/file (1).ts", line: 7 },
      {
        ctx: { checkoutRoot: repo },
        hub: { broadcast() {} },
        resolveWorktree: async () => ({ cwd: repo, worktree: null }),
      },
    );
    assert.equal(res.ok, true);

    const wrote = await waitForFile(argsOut);
    assert.ok(wrote, "the fake editor must have been invoked");
    const recorded = fs.readFileSync(argsOut, "utf8");
    assert.match(recorded, /Program Files \(x86\)/, "spaces and parens survive");
    assert.match(recorded, /file \(1\)\.ts:7/, "the file:line is intact");
  } finally {
    process.env.PATH = prevPath;
    if (prevPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = prevPathExt;
    fs.rmSync(work, { recursive: true, force: true });
  }
});
