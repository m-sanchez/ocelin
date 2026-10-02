import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordIdentity,
  mergeIdentity,
  accountKey,
} from "../server/monitor/identity.mjs";
import {
  CodexDesktopIdentity,
  codexLogIdentity,
} from "../server/monitor/desktop-identity.mjs";
import { SessionMonitor } from "../server/monitor/collector.mjs";
import { SessionLibrary } from "../server/library/catalog.mjs";
import {
  SubscriptionMonitor,
  readSubscriptionSnapshot,
} from "../server/monitor/subscriptions.mjs";
import allowance from "../server/monitor/allowance.cjs";
import { groupSessions } from "../desktop/renderer/session-model.mjs";
import { sessionIdentityText } from "../ui/shared/session-identity.mjs";

const now = Date.now(),
  timestamp = new Date(now).toISOString();
const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
const org = "33333333-3333-3333-3333-333333333333";
const lines = (rows) => rows.map(JSON.stringify).join("\n") + "\n";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const notification = (
  account,
  session = "desktop-session",
  user = "user-one",
  host = "local",
) =>
  `${timestamp} info [desktop-notifications] show notification notificationId=turn-${JSON.stringify([account, user, host, session, "turn-one"]).replaceAll('"', '\\"')}\n`;

test("client metadata distinguishes Codex Desktop from the IDE and CLI", () => {
  for (const [payload, expected] of [
    [{ source: "vscode", originator: "Codex Desktop" }, "desktop"],
    [{ source: "vscode", originator: "codex_vscode" }, "ide"],
    [{ source: "cli", originator: "codex_cli_rs" }, "cli"],
    [{ source: "appServer" }, "app-server"],
  ])
    assert.deepEqual(
      recordIdentity("codex", { type: "session_meta", payload }).clients,
      [expected],
    );
  assert.deepEqual(
    recordIdentity("codex", {
      type: "event_msg",
      payload: { originator: "Codex Desktop" },
    }).clients,
    [],
  );
  assert.deepEqual(recordIdentity("claude", { entrypoint: "cli" }).clients, [
    "cli",
  ]);
  assert.deepEqual(
    recordIdentity("claude", { entrypoint: "claude-desktop" }).clients,
    ["desktop"],
  );
});

test("desktop log identity is local, bounded metadata and survives account switches", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "codex-desktop-fixture.log");
  const index = new CodexDesktopIdentity(dir);
  await writeFile(file, notification(first));
  let result = await index.read();
  assert.equal(
    result.get("desktop-session").accounts[0].key,
    accountKey("codex", first, "user-one"),
  );
  await appendFile(
    file,
    notification(second) +
      notification(first, "remote-session", "user-one", "remote"),
  );
  result = await index.read();
  assert.equal(result.get("desktop-session").accounts.length, 2);
  assert.equal(result.has("remote-session"), false);
  assert.equal((await index.read()).get("desktop-session").accounts.length, 2);
  assert.equal(
    codexLogIdentity(
      notification(first).replace("[desktop-notifications]", "[arbitrary]"),
    ),
    null,
  );
  assert.equal(codexLogIdentity(notification("invalid/identity")), null);
  assert.equal(codexLogIdentity("notificationId=turn-[malformed]"), null);
});

test("monitor identifies two desktop users on the first scan and preserves CLI and desktop provenance", async (t) => {
  const dir = await fixture(t),
    projects = join(dir, "projects"),
    desktop = join(dir, "desktop");
  await mkdir(projects);
  for (const [account, session] of [
    [first, "one"],
    [second, "two"],
  ]) {
    await mkdir(join(desktop, account, org), { recursive: true });
    await writeFile(
      join(desktop, account, org, `local_${session}.json`),
      JSON.stringify({
        cliSessionId: session,
        sessionId: `local_${session}`,
        title: session,
        lastActivityAt: timestamp,
      }),
    );
    await writeFile(
      join(projects, `${session}.jsonl`),
      lines([
        {
          type: "user",
          sessionId: session,
          cwd: dir,
          timestamp,
          entrypoint: "cli",
          message: { content: "PRIVATE CONTENT" },
        },
      ]),
    );
  }
  const options = {
    dataDir: join(dir, "data"),
    sources: [{ provider: "claude", root: projects }],
    desktopRoot: desktop,
    codexLogRoot: null,
  };
  const monitor = new SessionMonitor(options);
  const snapshot = await monitor.tick({ force: true });
  const a = snapshot.sessions.find((s) => s.sessionId === "one"),
    b = snapshot.sessions.find((s) => s.sessionId === "two");
  assert.deepEqual(a.identity.clients, ["cli", "desktop"]);
  assert.notEqual(a.identity.accounts[0].key, b.identity.accounts[0].key);
  assert.equal(a.identity.accounts[0].key, accountKey("claude", first));
  const restored = new SessionMonitor(options);
  await restored.load();
  assert.deepEqual(
    (await restored.tick()).sessions.map((s) => s.identity),
    snapshot.sessions.map((s) => s.identity),
  );
  assert.equal(restored.bytesRead, 0);
  const library = new SessionLibrary({ ...options, client: { stop() {} } });
  const history = await library.query();
  assert.deepEqual(
    history.entries.find((e) => e.sessionId === "one").identity,
    a.identity,
  );
  assert.equal(
    (await library.query({ search: first.slice(0, 8) })).entries.length,
    1,
  );
});

test("transcript account evidence and desktop observations are merged, never replaced by a current profile", () => {
  const identity = mergeIdentity(
    recordIdentity("claude", {
      type: "bridge-session",
      ownerAccountUuid: first,
      timestamp,
    }),
    recordIdentity("claude", {
      type: "bridge-session",
      ownerAccountUuid: second,
      timestamp,
    }),
  );
  assert.equal(identity.accounts.length, 2);
  assert.equal(
    sessionIdentityText({ identity: { clients: ["cli"], accounts: [] } }),
    "CLI · Account unknown",
  );
  const s = {
    key: "claude:one",
    sessionId: "one",
    title: "Project",
    lastTs: now,
    identity,
    provider: "claude",
  };
  assert.equal(
    groupSessions([s], { filter: "all", search: first.slice(0, 8) }).length,
    1,
  );
});

test("a rotated transcript cannot carry one session's account into another", async (t) => {
  const dir = await fixture(t),
    root = join(dir, "projects");
  await mkdir(root);
  const file = join(root, "one.jsonl");
  await writeFile(
    file,
    lines([
      { type: "bridge-session", ownerAccountUuid: first, timestamp },
      {
        type: "user",
        sessionId: "one",
        cwd: dir,
        timestamp,
        entrypoint: "cli",
      },
    ]),
  );
  const monitor = new SessionMonitor({
    dataDir: join(dir, "data"),
    sources: [{ provider: "claude", root }],
    desktopRoot: null,
    codexLogRoot: null,
  });
  await monitor.tick();
  await writeFile(
    file,
    lines([
      {
        type: "user",
        sessionId: "two",
        cwd: dir,
        timestamp,
        entrypoint: "cli",
      },
    ]),
  );
  const sessions = (await monitor.tick({ force: true })).sessions;
  assert.equal(
    sessions.find((s) => s.sessionId === "one").identity.accounts.length,
    1,
  );
  assert.equal(
    sessions.find((s) => s.sessionId === "two").identity.accounts.length,
    0,
  );
});

test("allowance averages distinct accounts once and separates incomplete and unknown identities", () => {
  const quota = (account, remaining, minutes = 10080) => ({
    provider: "codex",
    accountKey: account,
    status: "ready",
    sampledAt: now,
    windows: [{ remainingPercent: remaining, minutes }],
  });
  const subscriptions = {
    codex: quota("codex:one", 80),
    profiles: [quota("codex:two", 20), quota("codex:one", 80)],
  };
  assert.deepEqual(
    allowance.remainingAllowance(subscriptions, "codex", "weekly", now),
    {
      remainingPercent: 50,
      incomplete: false,
      accountCount: 2,
      availableCount: 2,
    },
  );
  subscriptions.profiles[0].windows.push({
    remainingPercent: 10,
    minutes: 300,
  });
  assert.equal(
    allowance.remainingAllowance(subscriptions, "codex", "lowest", now)
      .remainingPercent,
    45,
  );
  subscriptions.observedAccounts = [{ key: "codex:three", provider: "codex" }];
  assert.deepEqual(
    allowance.remainingAllowance(subscriptions, "codex", "weekly", now),
    {
      remainingPercent: 50,
      incomplete: true,
      accountCount: 3,
      availableCount: 2,
    },
  );
  subscriptions.profiles.push(quota(null, 100));
  assert.equal(
    allowance.remainingAllowance(subscriptions, "codex", "weekly", now)
      .remainingPercent,
    50,
  );
  assert.equal(
    allowance.remainingAllowance(subscriptions, "codex", "weekly", now + 300001)
      .remainingPercent,
    null,
  );
});

test("unchanged quota snapshots keep stable totals timestamps for HTTP revalidation", async (t) => {
  const dir = await fixture(t);
  await writeFile(
    join(dir, "subscriptions.json"),
    JSON.stringify({
      schemaVersion: 2,
      providers: {
        codex: {
          provider: "codex",
          status: "ready",
          sampledAt: now,
          accountKey: "codex:one",
          windows: [
            {
              id: "weekly",
              remainingPercent: 50,
              minutes: 10080,
              resetsAt: now + 3600000,
            },
          ],
        },
      },
    }),
  );
  const clock = t.mock.method(Date, "now", () => now + 1000);
  const first = await readSubscriptionSnapshot(dir);
  clock.mock.mockImplementation(() => now + 2000);
  assert.deepEqual(await readSubscriptionSnapshot(dir), first);
  assert.equal(first.totalsAt, now);
});

test("Codex quota identity matches its own credentials and discards a switch during sampling", async (t) => {
  const dir = await fixture(t),
    home = join(dir, "codex");
  await mkdir(home);
  const auth = (account) => ({
    auth_mode: "chatgpt",
    tokens: {
      account_id: account,
      access_token: "SECRET",
      id_token: `header.${Buffer.from(JSON.stringify({ email: "work@example.test", "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: "user-one" } })).toString("base64url")}.signature`,
    },
  });
  const file = join(home, "auth.json");
  await writeFile(file, JSON.stringify(auth(first)));
  let switched = false;
  const client = {
    async call(method) {
      if (method === "account/rateLimits/read") {
        if (switched) await writeFile(file, JSON.stringify(auth(second)));
        return {
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 10080 },
          },
        };
      }
      return { account: { type: "chatgpt", email: "work@example.test" } };
    },
    stop() {},
  };
  const monitor = new SubscriptionMonitor({
    dataDir: dir,
    client,
    env: { CODEX_HOME: home, OPENAI_API_KEY: "unused-api-key" },
  });
  const reading = await monitor.readProfile(monitor.profiles[0]);
  assert.equal(reading.accountKey, accountKey("codex", first, "user-one"));
  assert.equal(JSON.stringify(reading).includes("SECRET"), false);
  const external = await monitor.codex(client, home, {
    CODEX_ACCESS_TOKEN: "external-account",
  });
  assert.equal(external.accountKey, null);
  switched = true;
  assert.equal(
    (await monitor.readProfile(monitor.profiles[0])).status,
    "unavailable",
  );
  monitor.stop();
});
