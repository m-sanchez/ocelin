#!/usr/bin/env node
// @ts-check
/**
 * `clawdeck <command>` dispatcher. Each command execs the matching script with
 * the remaining argv, so `clawdeck run --checkout <dir>` equals
 * `node scripts/panel-run.mjs --checkout <dir>`.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = {
  run: "panel-run.mjs",
  full: "panel-full.mjs",
  stop: "panel-stop.mjs",
  status: "panel-status.mjs",
  init: "init.mjs",
  inspect: "inspect.mjs",
  "self-test": "self-test.mjs",
};

const [command, ...rest] = process.argv.slice(2);
const script = SCRIPTS[command ?? ""];
if (!script) {
  console.log("Ocelin: a local dashboard for Codex and Claude Code.");
  console.log("\nUsage: ocelin <command> [options] (clawdeck also works)\n");
  console.log("Commands:");
  console.log("  run        Start the panel (opens the dashboard)");
  console.log("  full       Start the panel and keep it in the foreground");
  console.log("  status     Show the panel's process/port state");
  console.log("  stop       Stop the panel for this checkout");
  console.log("  init       Install hooks + commands into a project");
  console.log(
    "  inspect    Inspect a transcript and explain diagnostic findings",
  );
  console.log("  self-test  Verify this install can boot");
  console.log("\nCommon options: --checkout <dir> (which project to observe)");
  process.exit(command ? 1 : 0);
}

const result = spawnSync(
  process.execPath,
  [resolve(join(here, script)), ...rest],
  { stdio: "inherit", windowsHide: true },
);
process.exit(result.status ?? 1);
