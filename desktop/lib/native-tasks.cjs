const {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} = require("node:fs");
const { join } = require("node:path");
const { execFile } = require("node:child_process");
const { activationUri } = require("./session-links.cjs");

function nativeSnapshot(state, enabled, now = Date.now()) {
  const fresh =
    !state.error && state.sampledAt && now - state.sampledAt < 15000;
  const entries = fresh
    ? state.sessions.filter(
        (s) =>
          !s.readOnlySource &&
          !s.stale &&
          (s.attention || s.execution === "running" || s.execution === "error"),
      )
    : [];
  const groups = (state.resources?.groups || []).filter(
    (g) => g.provider !== "ocelin",
  );
  const memory =
    state.resources?.status === "ready" &&
    now - state.resources.sampledAt < 35000 &&
    groups.length &&
    groups.every((g) => Number.isFinite(g.memoryBytes) && !g.unavailable)
      ? `${(groups.reduce((n, g) => n + g.memoryBytes, 0) / 1024 ** 3).toFixed(1)} GB apps + tools`
      : "Measuring app memory";
  const summary = fresh
    ? `${state.counts.running} running · ${state.counts.attention} need you · ${memory}`
    : "Waiting for fresh activity";
  return {
    sampledAt: now,
    enabled,
    tasks: enabled
      ? [
          {
            key: "summary",
            title: "Ocelin",
            subtitle: summary,
            text: fresh
              ? "Open your local Codex and Claude sessions"
              : "Ocelin is reconnecting",
            uri: "ocelin://dashboard",
            state: state.counts.attention ? 2 : 0,
          },
          ...entries.slice(0, 12).map((s) => ({
            key: s.key,
            title: s.displayTitle || s.title,
            subtitle: `${s.provider === "codex" ? "Codex" : "Claude"} · ${s.title}`,
            text: `${s.label}${s.evidence === "hook" ? "" : " · observed from transcript"}`,
            uri: activationUri(s),
            state: s.attention ? 2 : s.execution === "error" ? 4 : 0,
          })),
        ]
      : [],
  };
}
function nativeConnection(status) {
  if (!status.supported || status.error)
    return {
      status: "unavailable",
      message: status.error || "Windows App Tasks is unavailable",
    };
  if (status.readbackError || !Number.isInteger(status.matchingTasks))
    return {
      status: "unverified",
      message: "Windows API reachable; task storage is unverified",
    };
  if (status.matchingTasks < status.tasks)
    return {
      status: "unverified",
      message: `Windows retained ${status.matchingTasks} of ${status.tasks} tasks; taskbar display is unverified`,
    };
  return {
    status: "connected",
    message: `${status.matchingTasks} tasks stored by Windows${status.hiddenTasks ? ` · ${status.hiddenTasks} hidden` : ""}; taskbar display is unverified`,
  };
}
class NativeTasks {
  constructor(dir, script, onChange = () => {}) {
    Object.assign(this, { dir, script, onChange });
    this.value = { status: "off", message: "Native taskbar tasks are off" };
    this.launching = false;
    this.lastLaunch = 0;
  }
  publish(state, enabled) {
    try {
      if (
        enabled &&
        this.dir.toLowerCase() !==
          join(process.env.LOCALAPPDATA || "", "Ocelin").toLowerCase()
      ) {
        this.value = {
          status: "unavailable",
          message:
            "Native Windows tasks use the installed Ocelin profile; isolated profiles cannot publish.",
        };
        return;
      }
      if (!enabled && !this.enabled) return;
      if (enabled && !this.enabled) {
        this.lastLaunch = 0;
        this.bridgeDir = null;
      }
      this.enabled = enabled;
      mkdirSync(this.dir, { recursive: true });
      for (const dir of new Set([this.dir, this.bridgeDir].filter(Boolean))) {
        const file = join(dir, "native-tasks.json");
        writeFileSync(
          `${file}.tmp`,
          JSON.stringify(nativeSnapshot(state, enabled)),
          { mode: 0o600 },
        );
        renameSync(`${file}.tmp`, file);
      }
      if (!enabled) {
        this.value = { status: "off", message: "Native taskbar tasks are off" };
        return;
      }
      let status;
      try {
        if (this.bridgeDir)
          status = JSON.parse(
            readFileSync(join(this.bridgeDir, "native-status.json"), "utf8"),
          );
      } catch {}
      if (status && Date.now() - status.sampledAt < 25000) {
        this.value = {
          ...status,
          ...nativeConnection(status),
        };
        if (status.supported) return;
      }
      if (!this.launching && Date.now() - this.lastLaunch > 60000) this.start();
    } catch (e) {
      this.value = { status: "unavailable", message: e.message };
    }
  }
  start() {
    this.launching = true;
    this.lastLaunch = Date.now();
    this.value = {
      status: "connecting",
      message: "Connecting to Windows App Tasks…",
    };
    execFile(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-File", this.script],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 },
      (error, stdout) => {
        this.launching = false;
        if (error)
          this.value = {
            status: "unavailable",
            message:
              "Install the Ocelin App Tasks package to connect native Windows tasks.",
          };
        else {
          try {
            this.bridgeDir = JSON.parse(stdout).directory;
          } catch {}
        }
        this.onChange();
      },
    );
  }
}
module.exports = { NativeTasks, nativeSnapshot, nativeConnection };
