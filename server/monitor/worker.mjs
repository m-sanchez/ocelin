import { SessionMonitor } from "./collector.mjs";
import { parentPort } from "node:worker_threads";
import { SubscriptionMonitor } from "./subscriptions.mjs";
import profilesModule from "./profiles.cjs";
import { observedAccounts } from "./identity.mjs";
import allowanceModule from "./allowance.cjs";
const { accountProfiles, sessionProfiles } = profilesModule;
let profiles = accountProfiles(
  process.env.OCELIN_ACCOUNT_PROFILES
    ? JSON.parse(process.env.OCELIN_ACCOUNT_PROFILES)
    : [],
);
const accountLabels = new Map();
const sessionSnapshot = () => {
  const snapshot = monitor.snapshot();
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((s) => ({
      ...s,
      identity: s.identity
        ? {
            ...s.identity,
            accounts: s.identity.accounts.map((a) => ({
              ...a,
              label: accountLabels.get(a.key) || a.label,
            })),
          }
        : undefined,
      profiles: sessionProfiles(s, profiles),
    })),
  };
};

const port = process.parentPort || parentPort;

const monitor = new SessionMonitor({
  dataDir: process.env.OCELIN_DATA_DIR,
  ...(process.env.OCELIN_SMOKE_TEST === "1"
    ? { desktopRoot: null, codexLogRoot: null }
    : {}),
  sources: process.env.OCELIN_SOURCES
    ? JSON.parse(process.env.OCELIN_SOURCES)
    : undefined,
});
await monitor.load();
port.postMessage({
  type: "snapshot",
  snapshot: sessionSnapshot(),
});
let preferences = {};
let chain = Promise.resolve();
const send = (value) => port.postMessage(value);
const subscriptions = new SubscriptionMonitor({
  dataDir: process.env.OCELIN_DATA_DIR,
  fixture: process.env.OCELIN_SMOKE_TEST === "1",
  profiles: profiles.filter((p) => !p.builtin),
  onUpdate: () => {
    for (const reading of [
      subscriptions.value.codex,
      subscriptions.value.claude,
      ...(subscriptions.value.profiles || []),
    ])
      if (reading.accountKey && reading.accountLabel)
        accountLabels.set(reading.accountKey, reading.accountLabel);
    send({
      type: "snapshot",
      snapshot: { ...sessionSnapshot(), subscriptions: subscriptionSnapshot() },
    });
  },
});
const subscriptionSnapshot = () => {
  const value = {
    ...subscriptions.value,
    observedAccounts: observedAccounts(sessionSnapshot().sessions),
  };
  return {
    ...value,
    totals: allowanceModule.allowanceTotals(value),
    totalsAt: allowanceModule.allowanceSampledAt(value),
  };
};
const enqueue = (fn) => {
  chain = chain
    .then(fn)
    .catch((error) => send({ type: "error", message: error.message }));
};
async function refresh(force = false) {
  await monitor.tick({ force });
  send({
    type: "snapshot",
    snapshot: {
      ...sessionSnapshot(),
      subscriptions: subscriptionSnapshot(),
    },
  });
  for (const session of await monitor.notifications(preferences))
    send({ type: "notification", session });
}
port.on("message", (raw) => {
  const data = raw.data || raw;
  return enqueue(async () => {
    try {
      let value;
      if (data.type === "preferences") {
        preferences = data.value;
        return;
      }
      if (data.type === "acknowledge") {
        await monitor.acknowledge(data.key);
        value = { ...sessionSnapshot(), subscriptions: subscriptionSnapshot() };
        send({ type: "snapshot", snapshot: value });
      } else if (data.type === "target") value = monitor.target(data.key);
      else if (data.type === "refresh") {
        await refresh(true);
        value = true;
      } else if (data.type === "sources") {
        monitor.setSources(data.value);
        await refresh(true);
        value = true;
      } else if (data.type === "profiles") {
        profiles = accountProfiles(data.profiles);
        subscriptions.setProfiles(data.profiles);
        monitor.setSources(data.sources);
        await refresh(true);
        value = true;
      } else if (data.type === "stop") {
        subscriptions.stop();
        await monitor.save();
        process.exit(0);
      } else throw new Error("Unknown monitor request");
      send({ type: "reply", id: data.id, value });
    } catch (error) {
      send({ type: "reply", id: data.id, error: error.message });
    }
  });
});
async function cycle(force = false) {
  enqueue(() => refresh(force));
  await chain;
  setTimeout(cycle, 3000);
}
void cycle(true);
subscriptions.start();
