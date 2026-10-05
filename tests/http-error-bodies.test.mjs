// @ts-check
/**
 * Error responses from the real server must carry a stable, generic message and
 * never a stack trace or an absolute filesystem path. Boots the server on a free
 * port and drives a failing static read (a missing .html) through the handler.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PANEL, "server", "start.mjs");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {any} */ (s.address());
      s.close(() => resolvePort(port));
    });
  });
}

let child = null;
let runtime = "";
let port = 0;
const origin = () => `http://127.0.0.1:${port}`;

async function waitFor(fn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  port = await freePort();
  runtime = mkdtempSync(join(tmpdir(), "panel-errbody-"));
  child = spawn(process.execPath, [ENTRY], {
    cwd: PANEL,
    env: {
      ...process.env,
      PANEL_SERVICE_PORT: String(port),
      PANEL_CHECKOUT_ROOT: PANEL,
      PANEL_REPO_ROOT: PANEL,
      PANEL_RUNTIME_DIR: runtime,
      PANEL_CHECKOUT_ID: "errbody-test",
      PANEL_NONCE: "test-nonce",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const up = await waitFor(async () => (await fetch(`${origin()}/health`)).ok);
  assert.ok(up, "panel did not become healthy");
});

after(() => {
  child?.kill();
  rmSync(runtime, { recursive: true, force: true });
});

test("a missing static file 404s with no stack trace or path in the body", async () => {
  const res = await fetch(`${origin()}/does-not-exist.html`);
  assert.equal(res.status, 404);
  const body = await res.json();
  const text = JSON.stringify(body);
  assert.ok(!/\n?\s+at\s/.test(text), "no stack frame lines");
  assert.ok(!text.includes("ENOENT"), "no raw fs error code");
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), "no Windows absolute path");
  assert.ok(!text.includes("/ui/") && !text.includes("\\ui\\"), "no server path");
  assert.equal(body.error, "Not found", "a stable, generic message is returned");
});
