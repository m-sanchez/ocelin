import { resolve } from "node:path";
import { getSessionTrace } from "../server/adapters/session-trace.mjs";

const args = process.argv.slice(2);
const file = args[0];
const providerIndex = args.indexOf("--provider");
const provider = providerIndex < 0 ? "claude" : args[providerIndex + 1];
if (!file || file.startsWith("-") || !["claude", "codex"].includes(provider)) {
  console.error(
    "Usage: ocelin inspect <transcript.jsonl> [--provider claude|codex] [--json]",
  );
  process.exitCode = 1;
} else {
  const trace = getSessionTrace(resolve(file), { provider });
  if (trace.missing) {
    console.error("Transcript not found");
    process.exitCode = 1;
  } else if (args.includes("--json"))
    console.log(JSON.stringify(trace, null, 2));
  else {
    console.log(
      `${provider} · ${trace.turns.length} turns${trace.truncated ? " · partial history" : ""}`,
    );
    for (const finding of trace.diagnostics.findings)
      console.log(
        `[${finding.severity}] Turn ${finding.turn + 1}: ${finding.message}`,
      );
    for (const group of trace.diagnostics.errors)
      console.log(`${group.tool}: ${group.count} matching failures`);
    if (!trace.diagnostics.findings.length)
      console.log("No heuristic findings in the inspected history.");
  }
}
