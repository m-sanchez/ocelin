import { relative, sep } from "node:path";

const id = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const clients = new Set(["cli", "desktop", "ide", "exec", "app-server"]);
const sources = new Set(["transcript", "desktop-record", "desktop-log"]);
export const accountKey = (provider, account, user = null) =>
  ["codex", "claude"].includes(provider) && id(account) && (!user || id(user))
    ? `${provider}:${account}${user ? `:${user}` : ""}`
    : null;

export function accountIdentity(provider, account, user, source, observedAt) {
  const key = accountKey(provider, account, user);
  return key && sources.has(source)
    ? {
        key,
        label: `Account ${account.slice(0, 8)}${user ? `/${user.replace(/^user-/, "").slice(0, 6)}` : ""}`,
        source,
        observedAt: Number.isFinite(observedAt) ? observedAt : null,
      }
    : null;
}

export function mergeIdentity(...values) {
  const knownClients = new Set(),
    accounts = new Map();
  for (const value of values) {
    for (const client of value?.clients || [])
      if (clients.has(client)) knownClients.add(client);
    for (const account of value?.accounts || []) {
      if (
        !account ||
        !/^(codex|claude):[a-zA-Z0-9_-]{1,128}(?::[a-zA-Z0-9_-]{1,128})?$/.test(
          account.key,
        ) ||
        !sources.has(account.source)
      )
        continue;
      const previous = accounts.get(account.key);
      if (!previous || (account.observedAt || 0) > (previous.observedAt || 0))
        accounts.set(account.key, {
          key: account.key,
          label:
            typeof account.label === "string"
              ? account.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)
              : "Account unknown",
          source: account.source,
          observedAt: Number.isFinite(account.observedAt)
            ? account.observedAt
            : null,
        });
    }
  }
  return {
    clients: [...knownClients].sort(),
    accounts: [...accounts.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, 32),
  };
}

export function recordIdentity(provider, record) {
  let client;
  const accounts = [];
  if (provider === "codex" && record.type === "session_meta") {
    const p = record.payload || {};
    const origin = String(p.originator || "").toLowerCase();
    if (origin === "codex desktop") client = "desktop";
    else if (
      ["codex_cli_rs", "codex-cli"].includes(origin) ||
      p.source === "cli"
    )
      client = "cli";
    else if (p.source === "vscode") client = "ide";
    else if (p.source === "exec") client = "exec";
    else if (p.source === "appServer") client = "app-server";
  } else if (provider === "claude") {
    if (record.entrypoint === "claude-desktop") client = "desktop";
    else if (record.entrypoint === "cli") client = "cli";
    if (record.type === "bridge-session") {
      const account = accountIdentity(
        provider,
        record.ownerAccountUuid,
        null,
        "transcript",
        Date.parse(record.timestamp),
      );
      if (account) accounts.push(account);
    }
  }
  return { clients: client ? [client] : [], accounts };
}

export function claudeDesktopIdentity(root, file, meta) {
  const parts = relative(root, file).split(sep);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const account =
    parts.length === 3 && uuid.test(parts[0]) && uuid.test(parts[1])
      ? accountIdentity(
          "claude",
          parts[0],
          null,
          "desktop-record",
          Date.parse(meta.lastActivityAt || meta.createdAt),
        )
      : null;
  return { clients: ["desktop"], accounts: account ? [account] : [] };
}

export function observedAccounts(sessions) {
  const accounts = new Map();
  for (const session of sessions) {
    for (const account of session.identity?.accounts || []) {
      const previous = accounts.get(account.key);
      accounts.set(account.key, {
        ...account,
        provider: session.provider,
        clients: [
          ...new Set([
            ...(previous?.clients || []),
            ...(session.identity.clients || []),
          ]),
        ].sort(),
      });
    }
  }
  return [...accounts.values()].sort((a, b) => a.key.localeCompare(b.key));
}
