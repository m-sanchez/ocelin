import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseTrace } from "../server/core/trace-diagnostics.mjs";

const now = Date.now();
const startTs = new Date(now - 600000).toISOString();
const span = (id, summary = "same command", extra = {}) => ({
  id,
  tool: "Bash",
  summary,
  startTs,
  durMs: 20,
  ok: true,
  ...extra,
});
const trace = (spans, extra = {}) => ({
  turns: [{ index: 0, startTs, durMs: 600000, open: true, spans, ...extra }],
});

test("diagnostics explain repeated calls and failures with stable evidence", () => {
  const input = trace(
    Array.from({ length: 6 }, (_, i) =>
      span(String(i), "same command", { ok: false, errorSignature: "same" }),
    ),
  );
  const result = diagnoseTrace(input, { now, sessionLive: true });
  assert.deepEqual(
    new Set(result.findings.map((f) => f.type)),
    new Set([
      "long_running",
      "no_activity",
      "repeated_tool",
      "repeated_error",
      "possible_loop",
    ]),
  );
  assert.equal(result.errors[0].count, 6);
  assert.equal(
    result.findings.find((f) => f.type === "repeated_error").evidence.length,
    6,
  );
  assert.deepEqual(result, diagnoseTrace(input, { now, sessionLive: true }));
});

test("human waits, completed sessions and changing arguments avoid false alarms", () => {
  const wait = span("wait", "", { wait: true, running: true, durMs: 600000 });
  assert.equal(
    diagnoseTrace(trace([wait]), { now, sessionLive: true }).findings.length,
    0,
  );
  assert.equal(
    diagnoseTrace(trace([], { durMs: null }), { now, sessionLive: false })
      .findings.length,
    0,
  );
  const calls = Array.from({ length: 8 }, (_, i) =>
    span(String(i), `read file-${i}`),
  );
  assert.equal(
    diagnoseTrace(trace(calls, { durMs: 1000, open: false }), { now }).findings
      .length,
    0,
  );
});

test("loop evidence stays within one turn and requires three cycles", () => {
  const calls = [
    span("a", "a"),
    span("b", "b"),
    span("c", "a"),
    span("d", "b"),
  ];
  assert.equal(
    diagnoseTrace(trace(calls)).findings.some(
      (f) => f.type === "possible_loop",
    ),
    false,
  );
  calls.push(span("e", "a"), span("f", "b"));
  assert.equal(
    diagnoseTrace(trace(calls)).findings.some(
      (f) => f.type === "possible_loop",
    ),
    true,
  );
  assert.equal(diagnoseTrace({ ...trace([]), truncated: true }).partial, true);
});
