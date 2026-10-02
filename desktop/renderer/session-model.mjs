import { sessionIdentityText } from "../../ui/shared/session-identity.mjs";

export const projectKey = (s) =>
  s.cwd
    ? s.cwd.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()
    : `unknown:${s.key}`;
export const isRunning = (s) => !s.stale && s.execution === "running";
export const needsAttention = (s) =>
  !s.stale && (s.attention || s.execution === "error");
export const isActive = (s) => isRunning(s) || needsAttention(s);
export const memory = (bytes) =>
  bytes == null
    ? "—"
    : bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.round(bytes / 1024 ** 2)} MB`;
export const tone = (s) =>
  s.stale
    ? "stale"
    : needsAttention(s)
      ? "attention"
      : isRunning(s)
        ? "running"
        : s.result?.kind === "complete"
          ? "complete"
          : "idle";
export const statusLabel = (s) =>
  s.stale && (s.execution === "running" || s.attention)
    ? "Status unknown"
    : s.label;

export function groupSessions(
  sessions,
  { search = "", filter = "active", now = Date.now(), historySince = 0 } = {},
) {
  const groups = new Map();
  const term = search.trim().toLowerCase();
  for (const s of sessions) {
    if (!isActive(s) && s.lastTs <= historySince) continue;
    if (
      term &&
      !`${s.title} ${s.displayTitle || ""} ${s.cwd} ${s.provider} ${s.sessionId} ${sessionIdentityText(s)} ${(s.profiles || []).map((p) => p.label).join(" ")}`
        .toLowerCase()
        .includes(term)
    )
      continue;
    if (filter === "active" && !isActive(s)) continue;
    if (filter === "running" && !isRunning(s)) continue;
    if (filter === "attention" && !needsAttention(s)) continue;
    if (filter === "recent" && !isActive(s) && now - s.lastTs > 86400000)
      continue;
    const key = projectKey(s);
    if (!groups.has(key))
      groups.set(key, {
        key,
        title: s.title,
        cwd: s.cwd,
        sessions: [],
        running: 0,
        attention: 0,
        latest: 0,
      });
    const g = groups.get(key);
    g.sessions.push(s);
    g.running += Number(isRunning(s));
    g.attention += Number(Boolean(needsAttention(s)));
    g.latest = Math.max(g.latest, s.lastTs);
  }
  const rank = (s) =>
    needsAttention(s) ? 0 : isRunning(s) ? 1 : s.stale ? 4 : s.unseen ? 2 : 3;
  for (const g of groups.values())
    g.sessions.sort(
      (a, b) =>
        rank(a) - rank(b) || b.lastTs - a.lastTs || a.key.localeCompare(b.key),
    );
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.attention > 0) - Number(a.attention > 0) ||
      Number(b.running > 0) - Number(a.running > 0) ||
      b.latest - a.latest ||
      a.key.localeCompare(b.key),
  );
}
