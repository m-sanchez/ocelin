// @ts-check
/**
 * Session trace: reconstruct a session's recent turns into waterfall data —
 * per turn: start/end, deduped token usage, and tool-call spans with real
 * durations paired via tool_use.id ↔ tool_result.tool_use_id.
 *
 * Read-only and bounded: the transcript is read BACKWARD in chunks under a
 * hard byte budget, stopping once one extra turn boundary beyond the request
 * is seen, so the oldest emitted turn always includes its own start. A turn
 * whose beginning was cut off by the budget is dropped, never mis-assembled.
 *
 * "Running" is a live-state assertion, not an inference: an unpaired span is
 * running only when the caller says the session is live (`sessionLive`); a
 * dead session's unfinished tail renders incomplete with unknown duration.
 */
import {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { summarizeTool } from "./session-feed.mjs";
import { normalizeCodexRecords, parseJsonLines } from "./codex-transcript.mjs";
import { createHash } from "node:crypto";
import { diagnoseTrace } from "../core/trace-diagnostics.mjs";

const CHUNK_BYTES = 512 * 1024;
const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TURNS = 20;
const MAX_SPANS_PER_TURN = 80;
const MAX_SUBAGENT_META = 40;
const SUBAGENT_META_MAX_BYTES = 4096;
const WAIT_TOOLS = new Set([
  "ExitPlanMode",
  "AskUserQuestion",
  "request_user_input",
  "request_user_input_async",
]);
const TASK_TOOLS = new Set(["Task", "Agent", "spawn_agent"]);
const END_TURN_NEEDLE = '"stop_reason":"end_turn"';

/**
 * Read the transcript tail backward until roughly `wantBoundaries` end_turn
 * markers, the byte budget, or the file start. Returns the text plus whether
 * the read reached the start of the file.
 */
function readTail(fd, size, maxTailBytes, wantBoundaries) {
  let offset = size;
  let text = "";
  let boundaries = 0;
  while (offset > 0 && size - offset < maxTailBytes) {
    const len = Math.min(CHUNK_BYTES, offset, maxTailBytes - (size - offset));
    if (len <= 0) break;
    offset -= len;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const chunk = buf.toString("utf8");
    text = chunk + text;
    // Cheap pre-parse count; exact segmentation happens at parse time.
    let at = -1;
    while ((at = chunk.indexOf(END_TURN_NEEDLE, at + 1)) !== -1) boundaries++;
    if (boundaries > wantBoundaries) break;
  }
  return { text, atStart: offset === 0 };
}

function parseTs(o) {
  const t = Date.parse(o.timestamp || "");
  return Number.isFinite(t) ? t : null;
}

/** A user record that starts a turn: textual content, not a tool_result relay. */
function isPromptRecord(o) {
  if (o.type !== "user" || o.isMeta) return false;
  const c = o.message?.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c))
    return c.some((b) => b?.type === "text" && String(b.text || "").trim());
  return false;
}

/** toolUseId → { agentType, description } from the session's sidecar metas. */
function readSubagentMeta(transcriptPath) {
  const map = new Map();
  const sid = basename(transcriptPath).replace(/\.jsonl$/, "");
  const dir = join(dirname(transcriptPath), sid, "subagents");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".meta.json"));
  } catch {
    return map;
  }
  for (const name of names.slice(0, MAX_SUBAGENT_META)) {
    try {
      const full = join(dir, name);
      if (statSync(full).size > SUBAGENT_META_MAX_BYTES) continue;
      const meta = JSON.parse(readFileSync(full, "utf8"));
      if (meta?.toolUseId)
        map.set(meta.toolUseId, {
          agentType: meta.agentType || "agent",
          description: meta.description || "",
        });
    } catch {
      /* skip unreadable meta */
    }
  }
  return map;
}

/**
 * @param {string} transcriptPath
 * @param {{ maxTurns?: number, maxTailBytes?: number, now?: number, sessionLive?: boolean, provider?: string }} [opts]
 * @returns {{ session: string, missing?: boolean, model: string|null, turns: Array<object>, truncated: boolean, caps: { maxTurns: number, tailBytes: number } }}
 */
export function getSessionTrace(transcriptPath, opts = {}) {
  const maxTurns = Math.max(
    1,
    Math.min(50, opts.maxTurns ?? DEFAULT_MAX_TURNS),
  );
  const maxTailBytes = opts.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const now = opts.now ?? Date.now();
  const sessionLive = opts.sessionLive === true;
  const session = basename(transcriptPath).replace(/\.jsonl$/, "");
  const caps = { maxTurns, tailBytes: maxTailBytes };

  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return {
      session,
      missing: true,
      model: null,
      turns: [],
      truncated: false,
      caps,
    };
  }
  let text;
  let atStart;
  try {
    const size = fstatSync(fd).size;
    ({ text, atStart } = readTail(
      fd,
      size,
      Math.min(maxTailBytes, size),
      maxTurns,
    ));
  } finally {
    closeSync(fd);
  }

  const lines = text.split(/\r?\n/);
  if (!atStart) lines.shift(); // partial first record when tailing mid-file
  const parsed = parseJsonLines(lines.join("\n"));
  const normalized =
    opts.provider === "codex" ? normalizeCodexRecords(parsed) : parsed;

  // Parse: keep only timestamped user/assistant records, preserving sequence.
  const records = [];
  for (let seq = 0; seq < normalized.length; seq++) {
    const o = normalized[seq];
    if (o.type !== "user" && o.type !== "assistant") continue;
    const ts = parseTs(o);
    if (ts == null) continue;
    records.push({ o, ts, seq });
  }
  // ms timestamps are not monotonic; sequence breaks ties deterministically.
  records.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  // Drop anything before the first complete turn start we actually read.
  let truncated = !atStart;
  let firstPrompt = records.findIndex((r) => isPromptRecord(r.o));
  if (firstPrompt === -1 && !atStart) {
    return { session, model: null, turns: [], truncated: true, caps };
  }
  const usable = firstPrompt === -1 ? records : records.slice(firstPrompt);
  if (firstPrompt > 0 && !atStart) truncated = true;

  const agents =
    opts.provider === "codex" ? new Map() : readSubagentMeta(transcriptPath);
  const toolById = new Map();
  const turns = [];
  let current = null;
  let model = null;
  let lastEndTs = null;

  const closeTurn = (endTs, open) => {
    if (!current) return;
    current.endTs = endTs != null ? new Date(endTs).toISOString() : null;
    current.open = open;
    if (endTs != null) current.durMs = endTs - current._startMs;
    else if (open && sessionLive) current.durMs = now - current._startMs;
    else current.durMs = null;
    if (current._spanCount > MAX_SPANS_PER_TURN)
      current.spansDropped = current._spanCount - MAX_SPANS_PER_TURN;
    current.usage = current._usage;
    current.lastActivityAt = new Date(
      current._lastTs ?? current._startMs,
    ).toISOString();
    delete current._startMs;
    delete current._usage;
    delete current._usageSeen;
    delete current._spanCount;
    turns.push(current);
    current = null;
  };

  for (const { o, ts } of usable) {
    if (isPromptRecord(o)) {
      if (current) closeTurn(current._lastTs ?? ts, false); // interrupted turn
      current = {
        index: turns.length,
        startTs: new Date(ts).toISOString(),
        endTs: null,
        open: false,
        durMs: null,
        model: null,
        gapBeforeMs:
          lastEndTs != null && ts - lastEndTs > 0 ? ts - lastEndTs : null,
        usage: null,
        spans: [],
        _startMs: ts,
        _usage: null,
        _usageSeen: new Set(),
        _spanCount: 0,
      };
    }
    if (!current) continue; // stray records before a prompt at file start
    current._lastTs = ts;

    if (o.type === "assistant") {
      const msg = o.message || {};
      if (msg.model) {
        current.model = msg.model;
        model = msg.model;
      }
      // Usage repeats identically across the records of one request; count once.
      const usageKey = o.requestId ?? msg.id;
      if (msg.usage && usageKey && !current._usageSeen.has(usageKey)) {
        current._usageSeen.add(usageKey);
        const u = msg.usage;
        const acc = current._usage || {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          requests: 0,
        };
        acc.input += u.input_tokens || 0;
        acc.output += u.output_tokens || 0;
        acc.cacheRead += u.cache_read_input_tokens || 0;
        acc.cacheCreate += u.cache_creation_input_tokens || 0;
        acc.requests += 1;
        current._usage = acc;
      }
      const blocks = msg.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type !== "tool_use") continue;
          current._spanCount++;
          if (current.spans.length >= MAX_SPANS_PER_TURN) continue;
          const span = {
            id: b.id || `${current.index}:${current.spans.length}`,
            tool: b.name || "tool",
            summary: summarizeTool(b.name, b.input),
            startTs: new Date(ts).toISOString(),
            _startMs: ts,
            durMs: null,
            running: false,
            incomplete: false,
            ok: null,
            isTask: TASK_TOOLS.has(b.name),
            wait: WAIT_TOOLS.has(b.name),
            agent: agents.get(b.id) || null,
          };
          if (b.id) toolById.set(b.id, span);
          current.spans.push(span);
        }
      }
      if (msg.stop_reason === "end_turn") {
        lastEndTs = ts;
        closeTurn(ts, false);
      }
    } else if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type !== "tool_result") continue;
        const span = toolById.get(b.tool_use_id);
        if (!span) continue;
        span.durMs = Math.max(0, ts - span._startMs);
        span.ok = !b.is_error;
        span.endTs = new Date(ts).toISOString();
        if (b.is_error)
          span.errorSignature = createHash("sha256")
            .update(JSON.stringify(b.content ?? ""))
            .digest("hex")
            .slice(0, 20);
      }
    }
  }
  if (current) {
    lastEndTs = null;
    closeTurn(null, true);
  }

  // Resolve unpaired spans + strip internals.
  const openIndex =
    turns.length && turns[turns.length - 1].open ? turns.length - 1 : -1;
  for (let i = 0; i < turns.length; i++) {
    for (const span of turns[i].spans) {
      if (span.durMs == null && span.ok == null) {
        if (i === openIndex && sessionLive) {
          span.running = true;
          span.durMs = Math.max(0, now - span._startMs);
        } else {
          span.incomplete = true;
        }
      }
      delete span._startMs;
    }
    delete turns[i]._lastTs;
  }

  const kept = turns.slice(-maxTurns);
  if (kept.length < turns.length) truncated = true;
  kept.forEach((t, i) => (t.index = i));
  const trace = { session, model, turns: kept, truncated, caps };
  return { ...trace, diagnostics: diagnoseTrace(trace, { now, sessionLive }) };
}
