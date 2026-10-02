import { readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { CodexClient } from "../library/codex-client.mjs";
import profilesModule from "./profiles.cjs";
import { accountKey } from "./identity.mjs";
import { codexProfileIdentity } from "./credential-identity.mjs";
import allowanceModule from "./allowance.cjs";
const { accountProfiles } = profilesModule;

export const SUBSCRIPTION_INTERVAL = 120000;
export const SUBSCRIPTION_TTL = 300000;
export const subscriptionDirectory = () =>
  process.env.OCELIN_DATA_DIR ||
  join(
    process.env.LOCALAPPDATA || join(homedir(), ".local", "share"),
    "Ocelin",
  );
const percent = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100
    ? value
    : null;
const safeText = (value) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)
    : null;
const reset = (value) => {
  const time =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(time) && time > 0 && time < 8.64e15 ? time : null;
};
const empty = (provider, message = "Checking subscription…") => ({
  provider,
  status: "unavailable",
  message,
  sampledAt: null,
  windows: [],
  plan: null,
});
export const emptySubscriptions = () => ({
  codex: empty("codex"),
  claude: empty("claude"),
});
const window = (id, label, used, resetsAt, minutes) => ({
  id,
  label,
  remainingPercent:
    percent(used) == null ? null : Math.round((100 - used) * 10) / 10,
  resetsAt: reset(resetsAt),
  minutes,
});
const duration = (minutes) =>
  minutes === 300
    ? "5-hour window"
    : minutes === 10080
      ? "Weekly"
      : minutes > 0
        ? `${minutes} min`
        : "Allowance";

export function codexSubscription(result, account, now = Date.now()) {
  const buckets =
    result?.rateLimitsByLimitId &&
    typeof result.rateLimitsByLimitId === "object"
      ? result.rateLimitsByLimitId
      : result?.rateLimits
        ? { [result.rateLimits.limitId || "codex"]: result.rateLimits }
        : {};
  const windows = [];
  for (const [id, bucket] of Object.entries(buckets).slice(0, 12)) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const key of ["primary", "secondary"]) {
      const value = bucket[key];
      if (!value || typeof value !== "object") continue;
      const minutes = Number.isFinite(value.windowDurationMins)
        ? value.windowDurationMins
        : null;
      const label = `${id === "codex" ? "" : `${safeText(bucket.limitName) || safeText(id)} · `}${duration(minutes)}`;
      windows.push({
        ...window(
          `${id}:${key}`,
          label,
          value.usedPercent,
          value.resetsAt,
          minutes,
        ),
        extra: id !== "codex",
      });
    }
  }
  return {
    provider: "codex",
    status: windows.length ? "ready" : "unavailable",
    message: windows.length
      ? null
      : "Codex did not report subscription limits.",
    sampledAt: now,
    plan: safeText(account?.planType || result?.rateLimits?.planType),
    source: "Codex sign-in",
    windows,
  };
}

export function claudeSubscription(result, plan, now = Date.now()) {
  const labels = {
    five_hour: "5-hour window",
    seven_day: "Weekly",
    seven_day_opus: "Opus · weekly",
    seven_day_sonnet: "Sonnet · weekly",
    seven_day_oauth_apps: "Connected apps · weekly",
    seven_day_cowork: "Cowork · weekly",
  };
  const windows = [];
  for (const [key, value] of Object.entries(result || {})) {
    if (
      !/^(five_hour|seven_day(?:_[a-z0-9_]+)?)$/.test(key) ||
      !value ||
      typeof value !== "object" ||
      !("utilization" in value)
    )
      continue;
    windows.push({
      ...window(
        key,
        labels[key] ||
          `${key.replace(/^seven_day_/, "").replaceAll("_", " ")} · weekly`,
        value.utilization,
        value.resets_at,
        key === "five_hour" ? 300 : 10080,
      ),
      extra: !["five_hour", "seven_day"].includes(key),
    });
    if (windows.length === 12) break;
  }
  return {
    provider: "claude",
    status: windows.length ? "ready" : "unavailable",
    message: windows.length
      ? null
      : "Claude did not report subscription limits.",
    sampledAt: now,
    plan: safeText(plan),
    source: "Claude Code sign-in",
    windows,
  };
}

async function boundedJson(file) {
  if ((await stat(file)).size > 128 * 1024) throw new Error("File too large");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readSubscriptionSnapshot(
  directory = subscriptionDirectory(),
) {
  try {
    const value = await boundedJson(join(directory, "subscriptions.json"));
    if (![1, 2].includes(value.schemaVersion)) return emptySubscriptions();
    const clean = (provider, saved) => {
      if (!saved || !Array.isArray(saved.windows)) return empty(provider);
      return {
        provider,
        profileId: safeText(saved.profileId),
        profileLabel: safeText(saved.profileLabel),
        accountLabel: safeText(saved.accountLabel),
        accountKey:
          typeof saved.accountKey === "string" &&
          /^(codex|claude):[a-zA-Z0-9_-]{1,128}(?::[a-zA-Z0-9_-]{1,128})?$/.test(
            saved.accountKey,
          )
            ? saved.accountKey
            : null,
        status: saved.status === "ready" ? "ready" : "unavailable",
        message: safeText(saved.message),
        plan: safeText(saved.plan),
        source: safeText(saved.source),
        sampledAt: Number.isFinite(saved.sampledAt) ? saved.sampledAt : null,
        windows: saved.windows
          .slice(0, 12)
          .filter((w) => w && typeof w === "object")
          .map((w) => ({
            id: safeText(w.id),
            label: safeText(w.label),
            remainingPercent: percent(w.remainingPercent),
            resetsAt:
              Number.isFinite(w.resetsAt) &&
              w.resetsAt > 0 &&
              w.resetsAt < 8.64e15
                ? w.resetsAt
                : null,
            minutes: Number.isFinite(w.minutes) ? w.minutes : null,
            extra: w.extra === true,
          })),
      };
    };
    const result = {
      ...Object.fromEntries(
        ["codex", "claude"].map((provider) => [
          provider,
          clean(provider, value.providers?.[provider]),
        ]),
      ),
      profiles: (Array.isArray(value.profiles) ? value.profiles : [])
        .slice(0, 8)
        .filter((p) => ["codex", "claude"].includes(p?.provider))
        .map((p) => clean(p.provider, p)),
    };
    return {
      ...result,
      totals: allowanceModule.allowanceTotals(result),
      totalsAt: allowanceModule.allowanceSampledAt(result),
    };
  } catch {
    return emptySubscriptions();
  }
}

export class SubscriptionMonitor {
  constructor({
    dataDir = subscriptionDirectory(),
    env = process.env,
    now = Date.now,
    fetcher = fetch,
    client = new CodexClient({ env, timeout: 45000 }),
    onUpdate = () => {},
    fixture = false,
    profiles = [],
    clientFactory = (profileEnv) =>
      new CodexClient({ env: profileEnv, timeout: 45000 }),
  } = {}) {
    Object.assign(this, {
      dataDir,
      env,
      now,
      fetcher,
      client,
      onUpdate,
      fixture,
      clientFactory,
    });
    this.profiles = accountProfiles(profiles, env);
    this.clients = new Set([client]);
    this.generation = 0;
    this.value = emptySubscriptions();
  }
  async codex(client = this.client, home, env = this.env) {
    try {
      const localIdentity = !env.CODEX_ACCESS_TOKEN;
      const identity =
        localIdentity && home ? await codexProfileIdentity(home) : null;
      const before = await client.call("account/read", {
        refreshToken: false,
      });
      if (
        !before?.account ||
        !["chatgpt", "chatgptAuthTokens"].includes(before.account.type)
      )
        return empty("codex", "Sign in to a ChatGPT subscription in Codex.");
      const result = await client.call("account/rateLimits/read", {});
      const after = await client.call("account/read", {
        refreshToken: false,
      });
      if (JSON.stringify(before.account) !== JSON.stringify(after.account))
        return empty("codex", "Account changed. Checking again shortly.");
      const current = identity ? await codexProfileIdentity(home) : null;
      if (identity && current?.fingerprint !== identity.fingerprint)
        return empty("codex", "Account changed. Checking again shortly.");
      return {
        ...codexSubscription(result, after.account, this.now()),
        accountLabel: safeText(after.account.email),
        accountKey:
          after.account.type === "chatgpt" &&
          identity?.email === after.account.email
            ? identity.key
            : null,
      };
    } catch {
      return empty(
        "codex",
        "Cannot read Codex allowance. Open Codex and check its sign-in.",
      );
    } finally {
      client.stop();
    }
  }
  async claude(home, identify = false) {
    try {
      const file = join(
        home || this.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        ".credentials.json",
      );
      const credentials = (await boundedJson(file)).claudeAiOauth;
      if (
        !credentials?.accessToken ||
        !credentials.scopes?.includes("user:profile")
      )
        return empty(
          "claude",
          "Sign in to Claude Code with your subscription to read allowance.",
        );
      if (credentials.expiresAt && credentials.expiresAt <= this.now())
        return empty(
          "claude",
          "Claude sign-in expired. Open Claude Code to refresh it.",
        );
      const response = await this.fetcher(
        "https://api.anthropic.com/api/oauth/usage",
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "Ocelin/0.6.4",
          },
        },
      );
      if (!response.ok)
        return empty(
          "claude",
          response.status === 429
            ? "Claude usage is temporarily rate-limited. Retrying shortly."
            : "Claude usage unavailable. Check your Claude Code sign-in.",
        );
      const body = await response.text();
      if (body.length > 128 * 1024) throw new Error("Response too large");
      let accountLabel = null;
      let identityKey = null;
      if (identify) {
        try {
          const profile = await this.fetcher(
            "https://api.anthropic.com/api/oauth/profile",
            {
              method: "GET",
              redirect: "error",
              signal: AbortSignal.timeout(15000),
              headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "Ocelin/0.6.4",
              },
            },
          );
          if (profile.ok) {
            const text = await profile.text();
            if (text.length <= 128 * 1024) {
              const account = JSON.parse(text).account;
              accountLabel = safeText(account?.email);
              identityKey = accountKey("claude", account?.uuid);
            }
          }
        } catch {}
      }
      const current = (await boundedJson(file)).claudeAiOauth;
      if (current?.accessToken !== credentials.accessToken)
        return empty("claude", "Account changed. Checking again shortly.");
      return {
        ...claudeSubscription(
          JSON.parse(body),
          credentials.subscriptionType,
          this.now(),
        ),
        accountLabel,
        accountKey: identityKey,
      };
    } catch {
      return empty(
        "claude",
        "Cannot read Claude allowance. Check your connection and Claude Code sign-in.",
      );
    }
  }
  async readProfile(profile) {
    let result;
    if (profile.provider === "claude")
      result = await this.claude(profile.home, true);
    else if (profile.builtin)
      result = await this.codex(this.client, profile.home);
    else {
      const env = { ...this.env, CODEX_HOME: profile.home };
      for (const key of [
        "CODEX_ACCESS_TOKEN",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
      ])
        delete env[key];
      const client = this.clientFactory(env);
      this.clients.add(client);
      try {
        result = await this.codex(client, profile.home, env);
      } finally {
        this.clients.delete(client);
      }
    }
    return { ...result, profileId: profile.id, profileLabel: profile.label };
  }
  setProfiles(profiles) {
    this.generation++;
    this.profiles = accountProfiles(profiles, this.env);
    for (const client of this.clients) client.stop();
    this.value = {
      ...emptySubscriptions(),
      profiles: this.profiles
        .filter((p) => !p.builtin)
        .map((p) => ({
          ...empty(p.provider),
          profileId: p.id,
          profileLabel: p.label,
        })),
    };
    this.onUpdate(this.value);
    if (!this.pending) void this.refresh();
  }
  async refresh() {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = (async () => {
      if (this.fixture)
        this.value = await readSubscriptionSnapshot(this.dataDir);
      else {
        const profiles = [...this.profiles];
        this.value.profiles ||= [];
        for (let i = 0; i < profiles.length; i += 2) {
          if (this.stopped || generation !== this.generation) return;
          await Promise.all(
            profiles.slice(i, i + 2).map(async (profile) => {
              const value = await this.readProfile(profile);
              if (!this.stopped && generation === this.generation) {
                if (profile.builtin) this.value[profile.provider] = value;
                else
                  this.value.profiles = [
                    ...this.value.profiles.filter(
                      (p) => p.profileId !== profile.id,
                    ),
                    value,
                  ].sort(
                    (a, b) =>
                      profiles.findIndex((p) => p.id === a.profileId) -
                      profiles.findIndex((p) => p.id === b.profileId),
                  );
                this.onUpdate(this.value);
              }
            }),
          );
        }
        if (this.stopped || generation !== this.generation) return;
        await mkdir(this.dataDir, { recursive: true });
        const file = join(this.dataDir, "subscriptions.json");
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(
          temp,
          JSON.stringify({
            schemaVersion: 2,
            providers: { codex: this.value.codex, claude: this.value.claude },
            profiles: this.value.profiles,
          }),
          { mode: 0o600 },
        );
        if (this.stopped || generation !== this.generation) return;
        await rename(temp, file);
      }
      if (!this.stopped) this.onUpdate(this.value);
    })()
      .catch(() => {})
      .finally(() => {
        this.pending = null;
        if (!this.stopped && generation !== this.generation)
          void this.refresh();
      });
    return this.pending;
  }
  start() {
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), SUBSCRIPTION_INTERVAL);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const client of this.clients) client.stop();
  }
}
