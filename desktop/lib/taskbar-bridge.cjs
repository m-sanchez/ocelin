const { writeFileSync, renameSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const allowanceFile = join(__dirname, "../../server/monitor/allowance.cjs");
const { remainingAllowance } = require(
  require("node:fs").existsSync(allowanceFile)
    ? allowanceFile
    : join(process.resourcesPath, "core/server/monitor/allowance.cjs"),
);

function widgetSetupArguments(installed, bundled, destination) {
  const version = (value) =>
    typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)
      ? value.split(".").map(Number)
      : null;
  const current = version(installed?.version);
  const target = version(bundled.version);
  if (installed?.id === bundled.id && current && target) {
    const difference = current.findIndex((part, i) => part !== target[i]);
    if (difference === -1 || current[difference] > target[difference])
      return ["--settings"];
  }
  return ["--install-widget", destination];
}

function taskbarSummary(state, enabled, now = Date.now()) {
  const ready = enabled && !state.error;
  const fresh =
    state.resources?.status === "ready" &&
    now >= state.resources.sampledAt &&
    now - state.resources.sampledAt < 35000;
  const groups = (state.resources?.groups || []).filter(
    (g) => g.provider !== "ocelin",
  );
  const complete =
    groups.length > 0 &&
    groups.every((g) => Number.isFinite(g.memoryBytes) && !g.unavailable);
  const allowanceScope = state.preferences?.taskbarAllowance || "lowest";
  const allowance = Object.fromEntries(
    ["codex", "claude"].map((provider) => [
      provider,
      ready
        ? remainingAllowance(state.subscriptions, provider, allowanceScope, now)
        : { remainingPercent: null, incomplete: true },
    ]),
  );
  const running = ready ? state.counts.running : null;
  const attention = ready ? state.counts.attention : null;
  const memoryBytes =
    ready && fresh && complete
      ? groups.reduce((n, g) => n + g.memoryBytes, 0)
      : null;
  const providerCount = (provider) =>
    (state.sessions || []).filter(
      (s) => s.provider === provider && s.execution === "running" && !s.stale,
    ).length;
  const taskbarDetail = state.preferences?.taskbarDetail || "allowance";
  const percentage = (provider) =>
    allowance[provider].remainingPercent == null
      ? "—"
      : `${Math.round(allowance[provider].remainingPercent * 10) / 10}%${allowance[provider].accountCount > 1 ? " avg" : ""}${allowance[provider].incomplete ? "*" : ""}`;
  const detail =
    taskbarDetail === "memory"
      ? memoryBytes == null
        ? "RAM unavailable"
        : `${(memoryBytes / 1024 ** 3).toFixed(1)} GB RAM`
      : taskbarDetail === "sessions"
        ? `Codex ${providerCount("codex")} · Claude ${providerCount("claude")}`
        : `Codex ${percentage("codex")} · Claude ${percentage("claude")}`;
  return {
    schemaVersion: 1,
    theme: state.taskbarTheme === "light" ? "light" : "dark",
    motion:
      !["none", "reduced"].includes(state.preferences?.motion) &&
      !state.reducedMotion,
    sampledAt: now,
    status: !enabled ? "disabled" : ready ? "ready" : "unavailable",
    running,
    attention,
    memoryBytes,
    allowance,
    allowanceScope,
    taskbarDetail,
    headline: ready
      ? `${running} running${attention ? ` · ${attention} need you` : ""}`
      : "Ocelin offline",
    detail: ready ? detail : "Open Ocelin to connect",
  };
}
class TaskbarBridge {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "taskbar-summary.json");
  }
  publish(state, enabled) {
    if (!enabled && !this.wasEnabled) return;
    this.wasEnabled = enabled;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        `${this.file}.tmp`,
        JSON.stringify(taskbarSummary(state, enabled)),
        { mode: 0o600 },
      );
      renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }
}
module.exports = {
  TaskbarBridge,
  taskbarSummary,
  widgetSetupArguments,
  remainingAllowance,
};
