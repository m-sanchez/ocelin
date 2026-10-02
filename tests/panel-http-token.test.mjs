// @ts-check
/**
 * Live HTTP contract for the per-launch panel token: privileged routes refuse a
 * missing or wrong bearer, accept the right one, and the secret never reaches the
 * served HTML or the panel log. Boots the real server on a free port with an
 * isolated runtime dir.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_ID, CODEX_OTHER_ID, writeCodexRollout } from "./helpers/codex-fixture.mjs";

const PANEL = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKOUT = PANEL;
const ENTRY = join(PANEL, "server", "start.mjs");

/** An ephemeral port the OS just handed back, so the boot cannot collide. */
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
let token = "";
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
  runtime = mkdtempSync(join(tmpdir(), "panel-token-"));
  const codexHome = join(runtime, "codex");
  writeCodexRollout(codexHome, CHECKOUT);
  writeCodexRollout(codexHome, join(runtime, "unrelated"), undefined, CODEX_OTHER_ID);
  child = spawn(process.execPath, [ENTRY], {
    cwd: PANEL,
    env: {
      ...process.env,
      PANEL_SERVICE_PORT: String(port),
      PANEL_CHECKOUT_ROOT: CHECKOUT,
      PANEL_REPO_ROOT: CHECKOUT,
      PANEL_RUNTIME_DIR: runtime,
      PANEL_CHECKOUT_ID: "token-test",
      PANEL_NONCE: "test-nonce",
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const up = await waitFor(async () => {
    const r = await fetch(`${origin()}/health`);
    return r.ok;
  });
  assert.ok(up, "panel did not become healthy");
  token = readFileSync(join(runtime, "panel.token"), "utf8").trim();
  assert.match(token, /^[0-9a-f]{48}$/, "a per-launch token must be written");
});

after(() => {
  child?.kill();
  rmSync(runtime, { recursive: true, force: true });
});

/** POST helper; `tok` of null omits the header entirely. */
const post = (path, tok, body = {}) =>
  fetch(`${origin()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: origin(),
      ...(tok === null ? {} : { "x-panel-token": tok }),
    },
    body: JSON.stringify(body),
  });

const get = (path, tok) =>
  fetch(`${origin()}${path}`, {
    headers: tok === null ? {} : { "x-panel-token": tok },
  });

test("privileged POST routes refuse a missing or wrong token", async () => {
  for (const path of [
    "/api/actions/config.read",
    "/api/jobs",
    "/api/jobs/abc/cancel",
    "/v1/metrics",
  ]) {
    assert.equal((await post(path, null)).status, 401, `${path} without token`);
    assert.equal(
      (await post(path, "not-the-token")).status,
      401,
      `${path} with a wrong token`,
    );
  }
});

test("sensitive reads refuse a missing token", async () => {
  for (const path of [
    "/api/session-feed?session=00000000-0000-0000-0000-000000000000",
    "/api/session-tasks?session=00000000-0000-0000-0000-000000000000",
    "/api/trace?session=00000000-0000-0000-0000-000000000000",
    "/api/display-preferences",
  ]) {
    assert.equal((await get(path, null)).status, 401, path);
  }
});

test("workspace display writes require authorization, same origin and allowlisted booleans", async () => {
  assert.equal((await post("/api/display-preferences", null, { metrics: true })).status, 401);
  const foreign = await fetch(`${origin()}/api/display-preferences`, { method: "POST", headers: { "x-panel-token": token, origin: "https://example.invalid" }, body: JSON.stringify({ metrics: true }) });
  assert.equal(foreign.status, 403);
  assert.equal((await post("/api/display-preferences", token, { command: "anything" })).status, 400);
  assert.equal((await post("/api/display-preferences", token, { metrics: true })).status, 200);
  assert.equal((await (await get("/api/display-preferences", token)).json()).metrics, true);
});

test("/api/trace validates the session id and returns the trace shape", async () => {
  assert.equal((await get("/api/trace?session=..bad..", token)).status, 400);
  const r = await get(
    "/api/trace?session=00000000-0000-0000-0000-000000000000",
    token,
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.missing, true);
  assert.deepEqual(body.turns, []);
  assert.equal(typeof body.sessionLive, "boolean");
  // No `turns` param means the adapter default, never a clamp of Number(null)=0.
  assert.equal(body.caps.maxTurns, 20);
});

test("Codex feeds and traces require the token and enforce checkout scope", async () => {
  for (const route of ["session-feed", "trace"]) {
    const path = `/api/${route}?provider=codex&session=${CODEX_ID}`;
    assert.equal((await get(path, null)).status, 401);
    assert.equal((await get(path, "wrong")).status, 401);
    assert.equal((await get(path.replace("provider=codex", "provider=other"), token)).status, 400);
    assert.equal((await get(path + "&worktree=" + encodeURIComponent(runtime), token)).status, 400);
    const result = await (await get(path, token)).json();
    assert.equal(result.provider, "codex");
    assert.equal(result.session, CODEX_ID);
    if (route === "session-feed") assert.ok(result.events.some((e) => e.kind === "tool"));
    else {
      assert.equal(result.turns.length, 1);
      assert.equal(result.sessionLive, false);
    }
    const other = await (await get(path.replace(CODEX_ID, CODEX_OTHER_ID), token)).json();
    assert.equal(other.missing, true);
  }
  const snapshot = await (await get("/api/snapshot", token)).json();
  assert.ok(snapshot.sessions.agents.some((a) => a.provider === "codex" && a.latestSessionId === CODEX_ID));
  assert.ok(!snapshot.sessions.agents.some((a) => a.latestSessionId === CODEX_OTHER_ID));
});

test("the right token is accepted", async () => {
  const r = await post("/api/actions/config.read", token);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(typeof body, "object");
});

test("liveness stays open so the lifecycle scripts keep working", async () => {
  assert.equal((await get("/health", null)).status, 200);
});

test("the token never reaches the HTML, an API body or the log", async () => {
  const html = await (await get("/", null)).text();
  assert.ok(html.length > 0, "index.html must still be served");
  assert.ok(!html.includes(token), "token must not be embedded in the HTML");

  const health = await (await get("/health", null)).text();
  assert.ok(!health.includes(token), "token must not appear in an API body");

  const logPath = join(runtime, "panel.log");
  if (existsSync(logPath)) {
    assert.ok(
      !readFileSync(logPath, "utf8").includes(token),
      "token must not be logged",
    );
  }
});

test("/api/snapshot answers 304 to a matching If-None-Match", async () => {
  // A section may legitimately move between two builds (a transcript mtime
  // tick); an unchanged pair must 304, so retry the pair a few times.
  let got304 = false;
  for (let i = 0; i < 3 && !got304; i++) {
    const first = await get("/api/snapshot", token);
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.match(etag || "", /^"[0-9a-f]{8}"$/);
    const body = await first.json();
    assert.equal(`"${body.sections.version}"`, etag);
    const second = await fetch(`${origin()}/api/snapshot`, {
      headers: { "x-panel-token": token, "if-none-match": etag },
    });
    if (second.status === 304) got304 = true;
    else assert.equal(second.status, 200);
  }
  assert.ok(got304, "an idle snapshot pair must revalidate as unchanged");
});

test("the review inbox routes join the token gate, and no write route exists", async () => {
  for (const path of ["/api/review-inbox", "/api/review-inbox/thread?id=rt_" + "a".repeat(24)])
    assert.equal((await get(path, null)).status, 401, `${path} must require the bearer`);

  const assist = await post("/api/actions/reviewInbox.assist", null, {
    id: "rt_" + "a".repeat(24),
    kind: "explain",
  });
  assert.equal(assist.status, 401, "the assist action joins the 401 loop");

  // The Workbench has no forge-write action, so its name is not routable.
  const reply = await post("/api/actions/reviewInbox.reply", token, {
    id: "rt_" + "a".repeat(24),
    body: "posted from the panel",
  });
  assert.equal(reply.status, 404, "a write action must not exist to be called");

  // A malformed id is rejected before anything reads it.
  const bad = await get("/api/review-inbox/thread?id=../../etc/passwd", token);
  assert.equal(bad.status, 400);
});

test("CI routes join the token gate, and job output is never served blind", async () => {
  for (const path of ["/api/ci", "/api/ci/log?job=123"])
    assert.equal(
      (await get(path, null)).status,
      401,
      `${path} must require the bearer`,
    );

  // A job id that is not part of the CI read for this commit is refused: the
  // route is not a generic proxy to the provider's log storage.
  const unknown = await get("/api/ci/log?job=999999", token);
  assert.equal(unknown.status, 404);

  const malformed = await get("/api/ci/log?job=../../secrets", token);
  assert.equal(malformed.status, 400);
});

test("a foreign Host header is refused as misdirected (anti-rebinding)", async () => {
  // fetch() forbids overriding Host, so send the request raw over a socket.
  const status = await new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/snapshot",
        method: "GET",
        headers: { host: "evil.example", "x-panel-token": token },
      },
      (res) => {
        res.resume();
        resolvePromise(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 421, "an unexpected Host must fail closed");
});

test("source-serving reads now require the token, matching the sensitive reads", async () => {
  for (const path of [
    "/api/diff?file=README.md",
    "/api/working-tree",
    "/api/reviews",
    "/api/review-pack/preview",
    "/api/logs",
    "/api/snapshot",
  ]) {
    assert.equal((await get(path, null)).status, 401, `${path} without token`);
    // and the right token is accepted (not 401), whatever the body turns out to be
    assert.notEqual((await get(path, token)).status, 401, `${path} with token`);
  }
});

test("a path-traversal request cannot escape the static root", async () => {
  for (const attempt of [
    "/../package.json",
    "/..%2f..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
  ]) {
    const r = await get(attempt, token);
    assert.ok(
      r.status === 403 || r.status === 404,
      `${attempt} -> ${r.status}`,
    );
    if (r.ok) {
      const body = await r.text();
      assert.ok(
        !body.includes('"name": "clawdeck-panel"'),
        "must not leak package.json",
      );
    }
  }
});

test("a cross-origin mutation is refused before the token is even checked", async () => {
  const r = await fetch(`${origin()}/api/actions/config.read`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://evil.example",
      "x-panel-token": token,
    },
    body: "{}",
  });
  assert.equal(r.status, 403, "same-origin is required for writes");
});
