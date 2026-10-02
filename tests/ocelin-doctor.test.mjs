import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  utimes,
  symlink,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const {
  runtimeCaches,
  ProcessStops,
  stopSelection,
  terminateProcesses,
} = require("../desktop/lib/doctor.cjs");
const { taskbarSummary } = require("../desktop/lib/taskbar-bridge.cjs");
const now = Date.now();
const quota = (left, patch = {}) => ({
  provider: "codex",
  status: "ready",
  sampledAt: now,
  accountLabel: "PRIVATE",
  windows: [
    { remainingPercent: left, minutes: 10080, resetsAt: now + 86400000 },
  ],
  ...patch,
});

test("taskbar averages identified accounts without exporting identity", () => {
  const state = {
    counts: { running: 4, attention: 1 },
    subscriptions: {
      codex: quota(18, { accountKey: "codex:personal" }),
      claude: quota(72),
      profiles: [quota(9, { accountKey: "codex:work" })],
    },
  };
  const summary = taskbarSummary(state, true, now);
  assert.equal(summary.headline, "4 running · 1 need you");
  assert.equal(summary.detail, "Codex 13.5% avg · Claude 72%");
  assert.ok(!JSON.stringify(summary).includes("PRIVATE"));
  assert.equal(
    taskbarSummary(state, false, now).allowance.codex.remainingPercent,
    null,
  );
  assert.equal(
    taskbarSummary(state, true, now + 300001).detail,
    "Codex — · Claude —",
  );
  assert.equal(
    taskbarSummary(state, true, now - 1).allowance.codex.remainingPercent,
    null,
  );
  state.subscriptions.profiles[0].sampledAt = now - 300001;
  assert.equal(
    taskbarSummary(state, true, now).detail,
    "Codex 18% avg* · Claude 72%",
  );
  state.preferences = { taskbarAllowance: "five-hour" };
  assert.equal(
    taskbarSummary(state, true, now).allowance.codex.remainingPercent,
    null,
  );
  state.preferences = { taskbarDetail: "sessions" };
  state.sessions = [
    { provider: "codex", execution: "running" },
    { provider: "codex", execution: "running", stale: true },
  ];
  assert.equal(taskbarSummary(state, true, now).detail, "Codex 1 · Claude 0");
  state.preferences = { taskbarDetail: "memory" };
  assert.equal(taskbarSummary(state, true, now).detail, "RAM unavailable");
});

test("Doctor deletes only old allowlisted workspace caches inside its own directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "dashboard");
  const old = new Date(now - 9 * 86400000);
  for (const char of ["a", "b", "c", "d"]) {
    const folder = join(root, char.repeat(48));
    await mkdir(folder, { recursive: true });
    const file = join(folder, "panel.token");
    await writeFile(file, "fixture");
    if (char !== "b") await utimes(file, old, old);
    if (char === "c") await writeFile(join(folder, "project-work.txt"), "KEEP");
    await utimes(folder, old, old);
  }
  const active = join(root, "d".repeat(48));
  const outside = join(dir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "panel.token"), "KEEP");
  await symlink(
    outside,
    join(root, "e".repeat(48)),
    process.platform === "win32" ? "junction" : "dir",
  );
  const preview = await runtimeCaches(dir, active, now);
  assert.deepEqual(preview, { bytes: 7, count: 1 });
  assert.equal((await runtimeCaches(dir, active, now, true)).bytes, 7);
  await assert.rejects(stat(join(root, "a".repeat(48))));
  for (const char of ["b", "c", "d"])
    assert.equal(
      await readFile(join(root, char.repeat(48), "panel.token"), "utf8"),
      "fixture",
    );
  assert.equal(await readFile(join(outside, "panel.token"), "utf8"), "KEEP");
});

const processRow = {
  pid: 123,
  started: "638987654321012345",
  path: "C:\\Apps\\Codex.exe",
  name: "Codex.exe",
};
test("Doctor stopping uses single-use previews, rejects stale samples and skips changed PIDs", async () => {
  let tick = now,
    calls = [];
  const sample = {
    status: "ready",
    sampledAt: now,
    groups: [
      { provider: "codex", processCount: 1, processes: [{ ...processRow }] },
    ],
  };
  const stops = new ProcessStops({
    sample: () => sample,
    sessions: () => [{ provider: "codex", execution: "running" }],
    now: () => tick,
    stop: async (selection) => {
      calls.push(selection);
      return { stopped: selection.processes.length, skipped: 0 };
    },
  });
  assert.throws(() => stops.plan("ocelin"), /Only Codex/);
  const first = stops.plan("codex");
  assert.equal(first.running, 1);
  sample.groups[0].processes[0].started = "638987654321099999";
  assert.deepEqual(await stops.apply(first.id), { stopped: 0, skipped: 1 });
  assert.equal(calls.length, 0);
  await assert.rejects(stops.apply(first.id), /expired/);
  const second = stops.plan("codex");
  assert.equal((await stops.apply(second.id)).stopped, 1);
  assert.equal(calls.length, 1);
  const third = stops.plan("codex");
  tick += 60001;
  await assert.rejects(stops.apply(third.id), /expired/);
  assert.throws(() => stopSelection(sample, "codex", tick), /stale/);
});

test(
  "Windows stop helper validates creation time and ends only the selected fixture process",
  { skip: process.platform !== "win32", timeout: 45000 },
  async (t) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    t.after(() => child.kill());
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const ps = spawn(
      join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=[Diagnostics.Process]::GetProcessById(${child.pid}); @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().Ticks.ToString();path=$p.MainModule.FileName;name=[IO.Path]::GetFileName($p.MainModule.FileName)}|ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    ps.stdout.on("data", (c) => (output += c));
    assert.equal(await new Promise((resolve) => ps.once("exit", resolve)), 0);
    const row = JSON.parse(output);
    assert.deepEqual(
      await terminateProcesses({
        processes: [{ ...row, started: "638987654321000000" }],
      }),
      { stopped: 0, skipped: 1 },
    );
    assert.equal(child.exitCode, null);
    const result = await terminateProcesses({ processes: [row] });
    assert.deepEqual(result, { stopped: 1, skipped: 0 });
  },
);
