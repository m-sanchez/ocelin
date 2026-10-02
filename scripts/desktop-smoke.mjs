import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(root, ".ocelin-smoke", `v060-${Date.now()}`);
const data = join(target, "data"),
  codex = join(target, "codex"),
  claude = join(target, "claude");
const checkout = join(target, "Proyecto español");
const launchDir = join(target, "widget-launch");
await Promise.all(
  [data, codex, claude, checkout, launchDir].map((p) =>
    mkdir(p, { recursive: true }),
  ),
);
await writeFile(join(checkout, "README.md"), "# Ocelin integration fixture\n");
const timestamp = new Date().toISOString();
await writeFile(
  join(codex, "rollout.jsonl"),
  [
    {
      type: "session_meta",
      timestamp,
      payload: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: checkout },
    },
    {
      type: "event_msg",
      timestamp,
      payload: { type: "task_started", turn_id: "turn-1" },
    },
    {
      type: "event_msg",
      timestamp,
      payload: {
        type: "user_message",
        message: "Check the native conversation preview",
      },
    },
    ...Array.from({ length: 6 }, (_, i) => [
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call",
          call_id: `diagnostic-${i}`,
          name: "Bash",
          arguments: JSON.stringify({ command: "fixture-check" }),
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call_output",
          call_id: `diagnostic-${i}`,
          output: JSON.stringify({
            exit_code: 1,
            output: "Fixture check failed",
          }),
        },
      },
    ]).flat(),
  ]
    .map(JSON.stringify)
    .join("\n") + "\n",
);
for (const [id, complete] of [
  ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", false],
  ["cccccccc-cccc-cccc-cccc-cccccccccccc", true],
]) {
  const rows = [
    {
      type: "user",
      timestamp,
      sessionId: id,
      cwd: checkout,
      message: {
        content: [{ type: "text", text: "Review the Windows integration" }],
      },
    },
  ];
  if (complete)
    rows.push({
      type: "assistant",
      timestamp,
      sessionId: id,
      cwd: checkout,
      message: {
        content: [{ type: "text", text: "The fixture is complete." }],
        stop_reason: "end_turn",
      },
    });
  await writeFile(
    join(claude, `${id}.jsonl`),
    rows.map(JSON.stringify).join("\n") + "\n",
  );
}
const binary = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
await writeFile(
  join(data, "subscriptions.json"),
  JSON.stringify({
    schemaVersion: 1,
    providers: {
      codex: {
        provider: "codex",
        status: "ready",
        sampledAt: Date.now(),
        plan: "pro",
        profileId: "codex-default",
        profileLabel: "Default",
        accountLabel: "personal@example.test",
        source: "Codex sign-in",
        windows: [
          {
            id: "codex:primary",
            label: "Weekly",
            remainingPercent: 18,
            resetsAt: Date.now() + 7200000,
            minutes: 10080,
            extra: false,
          },
        ],
      },
      claude: {
        provider: "claude",
        status: "ready",
        sampledAt: Date.now(),
        plan: "max",
        profileId: "claude-default",
        profileLabel: "Default",
        accountLabel: "claude@example.test",
        source: "Claude Code sign-in",
        windows: [
          {
            id: "five_hour",
            label: "5-hour window",
            remainingPercent: 72,
            resetsAt: Date.now() + 3600000,
            minutes: 300,
            extra: false,
          },
          {
            id: "seven_day",
            label: "Weekly",
            remainingPercent: 44,
            resetsAt: Date.now() + 86400000,
            minutes: 10080,
            extra: false,
          },
        ],
      },
    },
  }),
);
const packaged = binary && resolve(binary);
const exe =
  packaged ||
  join(root, "desktop", "node_modules", "electron", "dist", "electron.exe");
const args = [...(packaged ? [] : [join(root, "desktop")]), "--smoke-test"];
if (process.argv.includes("--panel-launch")) args.push("ocelin://panel");
const env = {
  ...process.env,
  OCELIN_DATA_DIR: data,
  OCELIN_MEMORY_SMOKE: process.argv.includes("--memory") ? "1" : "0",
  OCELIN_SOURCES: JSON.stringify([
    { provider: "codex", root: codex },
    { provider: "claude", root: claude },
  ]),
};
delete env.ELECTRON_RUN_AS_NODE;
const protocolRegistration = () => {
  if (process.platform !== "win32") return null;
  const result = spawnSync(
    join(process.env.SystemRoot, "System32", "reg.exe"),
    ["query", "HKCU\\Software\\Classes\\ocelin\\shell\\open\\command", "/ve"],
    { windowsHide: true, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout };
};
const registrationBefore = protocolRegistration();
const child = spawn(exe, args, {
  cwd: launchDir,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env,
});
let log = "";
child.stdout.on("data", (data) => {
  log = (log + data).slice(-16000);
});
child.stderr.on("data", (data) => {
  log = (log + data).slice(-16000);
});
const code = await new Promise((done, reject) => {
  child.on("error", reject);
  child.on("exit", done);
});
assert.deepEqual(
  protocolRegistration(),
  registrationBefore,
  "Smoke run must preserve the installed Ocelin protocol handler",
);
try {
  console.log(await readFile(join(data, "proof", "report.json"), "utf8"));
} catch {
  console.log(log);
  process.exitCode = 1;
}
console.log(`Artifacts: ${join(data, "proof")}`);
process.exitCode ||= code || 0;
