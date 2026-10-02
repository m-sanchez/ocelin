import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(process.argv[2] || "../.ocelin-smoke");
const dashboardOnly = process.argv.includes("--dashboard-only");
const dataDir = join(root, "data"),
  launchDir = join(root, "widget-launch"),
  codex = join(root, "codex"),
  claude = join(root, "claude");
const projects = [
  join(root, "Ocelin sample project"),
  join(root, "Proyecto español"),
];
for (const dir of [dataDir, launchDir, codex, claude, ...projects])
  await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString();
await writeFile(
  join(codex, "rollout.jsonl"),
  [
    {
      type: "session_meta",
      timestamp: stamp,
      payload: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: projects[0] },
    },
    {
      type: "event_msg",
      timestamp: stamp,
      payload: { type: "task_started", turn_id: "turn-1" },
    },
    {
      type: "event_msg",
      timestamp: stamp,
      payload: {
        type: "user_message",
        message: "Check the native conversation preview",
      },
    },
    ...Array.from({ length: 6 }, (_, i) => [
      {
        type: "response_item",
        timestamp: stamp,
        payload: {
          type: "function_call",
          call_id: `diagnostic-${i}`,
          name: "Bash",
          arguments: JSON.stringify({ command: "fixture-check" }),
        },
      },
      {
        type: "response_item",
        timestamp: stamp,
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
for (const [id, cwd, stop] of [
  ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", projects[0], false],
  ["cccccccc-cccc-cccc-cccc-cccccccccccc", projects[1], true],
]) {
  const rows = [
    {
      type: "user",
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: {
        content: [{ type: "text", text: "Review the Windows integration" }],
      },
    },
  ];
  if (stop)
    rows.push({
      type: "assistant",
      sessionId: id,
      cwd,
      timestamp: stamp,
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
await writeFile(
  join(dataDir, "preferences.json"),
  JSON.stringify({
    sources: [
      { provider: "codex", root: codex },
      { provider: "claude", root: claude },
    ],
    tray: !dashboardOnly,
    dashboard: true,
    bar: !dashboardOnly,
    quiet: true,
    motion: "none",
    theme: "dark",
  }),
);
console.log(dataDir);
await writeFile(
  join(dataDir, "subscriptions.json"),
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
