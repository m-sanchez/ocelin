import {
  readdir,
  readFile,
  stat,
  realpath,
  open,
  mkdir,
  appendFile,
} from "node:fs/promises";
import { join, basename, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { defaultSources, atomicJson } from "../monitor/collector.mjs";
import { safeId, sessionKey, localPath, pathKey } from "../monitor/model.mjs";
import {
  parseJsonLines,
  normalizeCodexRecords,
} from "../adapters/codex-transcript.mjs";
import { getSessionFeed } from "../adapters/session-feed.mjs";
import { CodexClient } from "./codex-client.mjs";
import { searchTranscript } from "./search.mjs";
import { getSessionTrace } from "../adapters/session-trace.mjs";
import { diagnoseTrace } from "../core/trace-diagnostics.mjs";
import sourcePaths from "../monitor/source-path.cjs";
import {
  recordIdentity,
  mergeIdentity,
  claudeDesktopIdentity,
} from "../monitor/identity.mjs";
import { CodexDesktopIdentity } from "../monitor/desktop-identity.mjs";
import profilesModule from "../monitor/profiles.cjs";
const { accountProfiles, sessionProfiles } = profilesModule;

const text = (value) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x08\x0b-\x1f]/g, "").slice(0, 600)
    : "";
const content = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((b) => b.type === "text" || b.type === "input_text")
          .map((b) => b.text || "")
          .join("\n")
      : "";
const within = (root, file) => {
  const r = relative(root, file);
  return r && !r.startsWith("..") && !isAbsolute(r);
};
const nativePath = (value) =>
  typeof value === "string" &&
  value.startsWith("\\\\?\\") &&
  /^[a-z]:\\/i.test(value.slice(4))
    ? value.slice(4)
    : value;
export async function walk(root, suffix, limit = 100000, depth = 6) {
  const files = [];
  async function visit(dir, level) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= limit) break;
      if (item.isSymbolicLink()) continue;
      const file = join(dir, item.name);
      if (item.isDirectory() && level > 0)
        await visit(file, level - 1).catch(() => {});
      if (item.isFile() && item.name.endsWith(suffix)) files.push(file);
    }
  }
  await visit(root, depth);
  return files;
}
async function head(file, size) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseJsonLines(buffer.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}
function metadata(records, provider, file) {
  const meta = records.find((r) => r.type === "session_meta")?.payload;
  const row =
    records.find((r) => r.sessionId && r.cwd) ||
    records.find((r) => r.sessionId);
  const id =
    provider === "codex"
      ? meta?.id ||
        basename(file).match(
          /([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl$/i,
        )?.[1]
      : row?.sessionId || basename(file, ".jsonl");
  if (!safeId(id) || basename(file).startsWith("agent-")) return null;
  const normalized =
    provider === "codex" ? normalizeCodexRecords(records) : records;
  const prompt = normalized.find(
    (r) =>
      r.type === "user" &&
      !r.omitFromFeed &&
      (provider === "codex" || !r.isMeta) &&
      content(r.message?.content),
  );
  const request = text(content(prompt?.message?.content));
  const cwd = provider === "codex" ? meta?.cwd : row?.cwd;
  return {
    key: sessionKey(provider, id),
    provider,
    sessionId: id,
    cwd: localPath(cwd) ? cwd : "",
    title: localPath(cwd) ? basename(cwd) : "Workspace unavailable",
    displayTitle:
      request.split("\n")[0].slice(0, 140) || `Session ${id.slice(0, 8)}`,
    request,
    historyMode: meta?.history_mode || "legacy",
    identity: mergeIdentity(
      ...records.map((record) => recordIdentity(provider, record)),
    ),
    parentId:
      meta?.parent_thread_id ||
      meta?.source?.subagent?.thread_spawn?.parent_thread_id ||
      null,
  };
}

export class SessionLibrary {
  constructor({
    dataDir,
    sources = defaultSources(),
    desktopRoot = process.env.APPDATA
      ? join(process.env.APPDATA, "Claude", "claude-code-sessions")
      : null,
    now = Date.now,
    client = new CodexClient(),
    profiles = [],
    codexLogRoot,
  } = {}) {
    Object.assign(this, { dataDir, sources, desktopRoot, now, client });
    this.profiles = accountProfiles(profiles);
    this.codexIdentity = new CodexDesktopIdentity(codexLogRoot);
    this.entries = new Map();
    this.hidden = {};
    this.plans = new Map();
    this.live = new Map();
    this.generation = 0;
    this.scannedAt = 0;
  }
  async load() {
    try {
      const file = join(this.dataDir, "library-index.json");
      if ((await stat(file)).size <= 64 * 1024 * 1024) {
        const cache = JSON.parse(await readFile(file, "utf8"));
        if (cache.version === 1 && Array.isArray(cache.entries))
          this.byFile = new Map(
            cache.entries
              .slice(0, 100000)
              .filter(
                (e) =>
                  e &&
                  ["codex", "claude"].includes(e.provider) &&
                  safeId(e.sessionId) &&
                  e.key === sessionKey(e.provider, e.sessionId) &&
                  sourcePaths.sourceKind(e.file) &&
                  typeof e.displayTitle === "string" &&
                  typeof e.request === "string" &&
                  typeof e.cwd === "string" &&
                  Number.isFinite(e.mtime) &&
                  Number.isFinite(e.bytes),
              )
              .map((e) => [e.file, e]),
          );
      }
    } catch {}
    try {
      this.hidden = JSON.parse(
        await readFile(join(this.dataDir, "library-hidden.json"), "utf8"),
      );
    } catch {}
    if (
      !this.hidden ||
      Array.isArray(this.hidden) ||
      typeof this.hidden !== "object"
    )
      this.hidden = {};
  }
  setLive(sessions) {
    this.live = new Map(sessions.map((s) => [s.key, s]));
  }
  async refresh(force = false) {
    if (this.scanning) return this.scanning;
    if (!force && this.scannedAt && this.now() - this.scannedAt < 60000) return;
    this.scanning = this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }
  async scan() {
    const next = new Map(),
      diagnostics = [];
    const sources = this.sources.flatMap((s) =>
      s.provider === "codex" && basename(s.root) === "sessions"
        ? [
            s,
            {
              ...s,
              root: join(s.root, "..", "archived_sessions"),
              archived: true,
            },
          ]
        : [s],
    );
    const workspaces = new Map();
    const nativeEntries = new Map();
    const nativeHome =
      this.client.env?.CODEX_HOME ||
      process.env.CODEX_HOME ||
      join(homedir(), ".codex");
    if (
      this.client.executable &&
      this.sources.some(
        (s) =>
          s.provider === "codex" &&
          pathKey(s.root) === pathKey(join(nativeHome, "sessions")),
      )
    ) {
      try {
        for (const archived of [false, true]) {
          let cursor;
          const seen = new Set();
          do {
            const page = await this.client.call("thread/list", {
              archived,
              limit: 200,
              useStateDbOnly: true,
              sourceKinds: [
                "cli",
                "vscode",
                "exec",
                "appServer",
                "subAgent",
                "subAgentReview",
                "subAgentCompact",
                "subAgentThreadSpawn",
                "subAgentOther",
                "unknown",
              ],
              ...(cursor ? { cursor } : {}),
            });
            for (const thread of page.data || []) {
              const candidate = nativePath(thread.path);
              if (!safeId(thread.id) || !localPath(candidate)) continue;
              const file = await realpath(candidate).catch(() => null);
              if (!file) continue;
              nativeEntries.set(pathKey(file), {
                key: sessionKey("codex", thread.id),
                provider: "codex",
                sessionId: thread.id,
                cwd: localPath(thread.cwd) ? thread.cwd : "",
                title: basename(thread.cwd || "") || "Workspace unavailable",
                displayTitle:
                  text(thread.name || thread.preview)
                    .split("\n")[0]
                    .slice(0, 160) || `Session ${thread.id.slice(0, 8)}`,
                request: text(thread.preview),
                historyMode: thread.historyMode || "legacy",
                parentId: thread.parentThreadId || null,
                nativeUpdatedAt: Number.isFinite(thread.updatedAt)
                  ? thread.updatedAt * 1000
                  : 0,
              });
            }
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) break;
            seen.add(cursor);
          } while (cursor && nativeEntries.size < 100000);
        }
      } catch {
        diagnostics.push({
          provider: "codex",
          status: "Native index unavailable; reading local transcripts",
        });
      }
    }
    for (const source of sources) {
      try {
        const root = await realpath(source.root);
        if (!sourcePaths.sourceKind(root)) continue;
        const files = await walk(root, ".jsonl");
        diagnostics.push({
          provider: source.provider,
          files: files.length,
          archived: Boolean(source.archived),
          capped: files.length === 100000,
        });
        for (let n = 0; n < files.length; n += 24) {
          await Promise.all(
            files.slice(n, n + 24).map(async (file) => {
              try {
                const info = await stat(file);
                const cached = this.byFile?.get(file);
                const entry = nativeEntries.has(pathKey(file))
                  ? { ...nativeEntries.get(pathKey(file)) }
                  : cached &&
                      cached.mtime === info.mtimeMs &&
                      cached.bytes === info.size
                    ? { ...cached }
                    : metadata(
                        await head(file, info.size),
                        source.provider,
                        file,
                      );
                if (!entry) return;
                if (!entry.identity) {
                  entry.identity =
                    cached?.identity &&
                    cached.mtime === info.mtimeMs &&
                    cached.bytes === info.size
                      ? cached.identity
                      : mergeIdentity(
                          ...(await head(file, info.size)).map((record) =>
                            recordIdentity(source.provider, record),
                          ),
                        );
                }
                if (entry.cwd && !workspaces.has(entry.cwd))
                  workspaces.set(
                    entry.cwd,
                    stat(entry.cwd)
                      .then((s) => s.isDirectory())
                      .catch(() => false),
                  );
                Object.assign(entry, {
                  sourceKind:
                    source.kind === "mirror"
                      ? "mirror"
                      : sourcePaths.sourceKind(root),
                  readOnlySource:
                    source.kind === "mirror" ||
                    sourcePaths.sourceKind(root) !== "local",
                  file,
                  root,
                  mtime: info.mtimeMs,
                  lastTs: Math.max(info.mtimeMs, entry.nativeUpdatedAt || 0),
                  bytes: info.size,
                  nativeArchived: Boolean(source.archived),
                  workspaceExists:
                    !entry.readOnlySource &&
                    source.kind !== "mirror" &&
                    sourcePaths.sourceKind(root) === "local" &&
                    entry.cwd
                      ? await workspaces.get(entry.cwd)
                      : false,
                });
                const existing = next.get(entry.key);
                entry.readOnlySource ||= Boolean(existing?.readOnlySource);
                entry.identity = mergeIdentity(
                  cached?.key === entry.key ? cached.identity : null,
                  existing?.identity,
                  entry.identity,
                );
                if (!existing || entry.mtime > existing.mtime)
                  next.set(entry.key, entry);
                else {
                  existing.identity = entry.identity;
                  existing.readOnlySource ||= entry.readOnlySource;
                }
              } catch {}
            }),
          );
        }
      } catch (e) {
        if (!source.archived)
          diagnostics.push({
            provider: source.provider,
            status: e.code === "ENOENT" ? "missing" : "unreadable",
            files: 0,
          });
      }
    }
    for (const source of this.sources.filter((s) => s.provider === "codex")) {
      try {
        const index = join(source.root, "..", "session_index.jsonl");
        if ((await stat(index)).size > 16 * 1024 * 1024) continue;
        for (const row of parseJsonLines(await readFile(index, "utf8"))) {
          const entry = next.get(sessionKey("codex", row.id));
          if (entry && typeof row.thread_name === "string")
            entry.displayTitle = text(row.thread_name).slice(0, 160);
        }
      } catch {}
    }
    if (this.desktopRoot) {
      try {
        for (const file of await walk(this.desktopRoot, ".json", 20000, 3)) {
          if (
            !basename(file).startsWith("local_") ||
            (await stat(file)).size > 131072
          )
            continue;
          try {
            const meta = JSON.parse(await readFile(file, "utf8"));
            const entry = next.get(sessionKey("claude", meta.cliSessionId));
            if (entry) {
              if (typeof meta.title === "string")
                entry.displayTitle = text(meta.title).slice(0, 160);
              entry.desktopId = safeId(meta.sessionId) ? meta.sessionId : null;
              entry.nativeArchived = meta.isArchived === true;
              entry.identity = mergeIdentity(
                entry.identity,
                claudeDesktopIdentity(this.desktopRoot, file, meta),
              );
            }
          } catch {}
        }
      } catch {}
    }
    const identities = [...next.values()].some((e) => e.provider === "codex")
      ? await this.codexIdentity.read()
      : [];
    for (const [id, identity] of identities) {
      const entry = next.get(sessionKey("codex", id));
      if (entry) entry.identity = mergeIdentity(entry.identity, identity);
    }
    this.entries = next;
    this.byFile = new Map([...next.values()].map((e) => [e.file, e]));
    this.diagnostics = diagnostics;
    this.scannedAt = this.now();
    this.generation++;
    await atomicJson(join(this.dataDir, "library-index.json"), {
      version: 1,
      entries: [...next.values()],
    });
  }
  public(entry) {
    const { file, root, mtime, request, ...value } = entry;
    const live = this.live.get(entry.key);
    return {
      ...value,
      identity: mergeIdentity(live?.identity, entry.identity),
      profiles: sessionProfiles(
        { ...entry, sourceRoots: [root] },
        this.profiles,
      ),
      ...(live
        ? {
            execution: live.execution,
            attention: live.attention,
            stale: live.stale,
            label: live.label,
            quality: live.quality,
          }
        : { execution: "unknown", stale: true, label: "Saved conversation" }),
      hidden: Boolean(this.hidden[entry.key]),
      archiveScope: entry.nativeArchived
        ? `${entry.provider === "codex" ? "Codex" : "Claude"} archive`
        : this.hidden[entry.key]
          ? "Hidden in Ocelin"
          : null,
    };
  }
  async query({
    search = "",
    provider = "all",
    view = "history",
    offset = 0,
    limit = 60,
    olderDays = 0,
    missingWorkspace = false,
    refresh = false,
    fullText = false,
    continueSearch = false,
  } = {}) {
    if (!continueSearch || !this.searchCache || refresh)
      await this.refresh(refresh);
    const terms = text(search)
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let records = [...this.entries.values()]
      .filter((e) => {
        if (provider !== "all" && e.provider !== provider) return false;
        if (
          (view === "archived") !==
          Boolean(e.nativeArchived || this.hidden[e.key])
        )
          return false;
        if (
          olderDays &&
          this.now() - e.lastTs <
            Math.min(36500, Math.max(0, olderDays)) * 86400000
        )
          return false;
        if (missingWorkspace && e.workspaceExists) return false;
        const haystack =
          `${e.displayTitle} ${e.request} ${e.cwd} ${e.sessionId} ${e.provider} ${JSON.stringify(mergeIdentity(this.live.get(e.key)?.identity, e.identity))}`.toLowerCase();
        return fullText || terms.every((t) => haystack.includes(t));
      })
      .sort((a, b) => b.lastTs - a.lastTs || a.key.localeCompare(b.key));
    let searchProgress;
    if (fullText && terms.length) {
      const key = JSON.stringify([
        this.generation,
        terms,
        provider,
        view,
        olderDays,
        missingWorkspace,
      ]);
      if (this.searchCache?.key !== key)
        this.searchCache = { key, position: 0, matches: [], partial: 0 };
      const cache = this.searchCache;
      if (!cache.position || continueSearch) {
        const deadline = Date.now() + 8000;
        while (cache.position < records.length && Date.now() < deadline) {
          const entry = records[cache.position++];
          const metadata =
            `${entry.displayTitle} ${entry.request} ${entry.cwd} ${entry.sessionId} ${entry.provider} ${JSON.stringify(entry.identity)}`.toLowerCase();
          const remaining = terms.filter((term) => !metadata.includes(term));
          try {
            const result = remaining.length
              ? await searchTranscript(entry, remaining, { deadline })
              : { matched: true };
            if (result.matched) cache.matches.push(entry);
            else if (result.partial) cache.partial++;
          } catch {
            cache.partial++;
          }
        }
      }
      searchProgress = {
        scanned: cache.position,
        total: records.length,
        partial: cache.partial,
        more: cache.position < records.length,
      };
      records = cache.matches;
    }
    const start = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    const count = Number.isSafeInteger(limit)
      ? Math.min(100, Math.max(1, limit))
      : 60;
    return {
      entries: records.slice(start, start + count).map((e) => this.public(e)),
      total: records.length,
      next: start + count < records.length ? start + count : null,
      generation: this.generation,
      indexed: this.entries.size,
      diagnostics: this.diagnostics,
      searchProgress,
      searchScope: fullText
        ? "Conversation messages and tool results, plus titles, projects, accounts and IDs"
        : "Titles, first requests, projects, accounts and IDs",
    };
  }
  async resolve(key, hint) {
    if (typeof key !== "string" || !/^(codex|claude):[\w-]{1,128}$/.test(key))
      throw new Error("Invalid session key");
    if (hint?.key === key && localPath(hint.transcript)) {
      const file = await realpath(hint.transcript);
      for (const source of this.sources.filter(
        (s) => s.provider === hint.provider,
      )) {
        const root = await realpath(source.root).catch(() => null);
        if (!root || !within(root, file)) continue;
        const info = await stat(file);
        const entry = metadata(
          await head(file, info.size),
          source.provider,
          file,
        );
        if (!entry || entry.key !== key)
          throw new Error(
            "Conversation identity changed. Refresh the library.",
          );
        const known = this.entries.get(key) || this.byFile?.get(file);
        return {
          ...entry,
          readOnlySource:
            source.kind === "mirror" ||
            sourcePaths.sourceKind(root) !== "local",
          sourceKind:
            source.kind === "mirror" ? "mirror" : sourcePaths.sourceKind(root),
          displayTitle: text(hint.displayTitle) || entry.displayTitle,
          file,
          root,
          mtime: info.mtimeMs,
          lastTs: hint.lastTs || info.mtimeMs,
          bytes: info.size,
          nativeArchived: Boolean(known?.nativeArchived),
          workspaceExists: entry.cwd
            ? await stat(entry.cwd)
                .then((s) => s.isDirectory())
                .catch(() => false)
            : false,
        };
      }
      throw new Error("Transcript is outside its configured source folder");
    }
    await this.refresh();
    const entry = this.entries.get(key);
    if (!entry)
      throw new Error(
        "Conversation is no longer in the session library. Refresh and try again.",
      );
    const actual = await realpath(entry.file);
    if (!within(entry.root, actual) || pathKey(actual) !== pathKey(entry.file))
      throw new Error("Transcript moved outside its source folder");
    return entry;
  }
  async preview(key, hint) {
    const entry = await this.resolve(key, hint);
    const feed = getSessionFeed(entry.file, {
      provider: entry.provider,
      limit: 80,
    });
    const events = feed.events.filter((e) =>
      ["user", "assistant", "tool", "result"].includes(e.kind),
    );
    const result = {
      ...this.public(entry),
      request:
        [...events].reverse().find((e) => e.kind === "user")?.text ||
        entry.request,
      response:
        [...events].reverse().find((e) => e.kind === "assistant")?.text || "",
      activity: events.filter((e) => e.kind === "tool").slice(-3),
      events: events.slice(-30),
      model: feed.model,
      branch: feed.branch,
      bounded: true,
    };
    const live = this.live.get(key);
    const trace = getSessionTrace(entry.file, {
      provider: entry.provider,
      sessionLive: live?.execution === "running" && !live.stale,
      now: this.now(),
    });
    result.diagnostics = diagnoseTrace(trace, {
      now: this.now(),
      sessionLive: live?.execution === "running" && !live.stale,
      waiting: Boolean(live?.attention),
    });
    if (
      entry.provider === "codex" &&
      !entry.readOnlySource &&
      this.client.executable
    ) {
      try {
        const read = await this.client.call("thread/read", {
          threadId: entry.sessionId,
          includeTurns: false,
        });
        const nativeFile = read.thread?.path
          ? await realpath(nativePath(read.thread.path)).catch(() => null)
          : null;
        if (!nativeFile || pathKey(nativeFile) !== pathKey(entry.file))
          throw new Error("Native conversation belongs to another Codex home");
        const native = await this.client.call("thread/turns/list", {
          threadId: entry.sessionId,
          limit: 2,
          itemsView: "summary",
          sortDirection: "desc",
        });
        const items = (native.data || []).flatMap((t) => t.items || []);
        const request = items.find((i) => i.type === "userMessage");
        const response = items.find((i) => i.type === "agentMessage" && i.text);
        if (request) result.request = text(content(request.content));
        if (response) result.response = text(response.text);
        result.previewSource = "Codex native history";
      } catch {
        if (entry.historyMode === "paginated")
          result.previewWarning =
            "Codex native history is unavailable. This preview only includes text from the local transcript.";
      }
    }
    return result;
  }
  async target(key) {
    return this.public(await this.resolve(key));
  }
  busy(entry) {
    const live = this.live.get(entry.key);
    return (
      this.now() - entry.mtime < 5 * 60000 ||
      (live && !live.stale && (live.execution === "running" || live.attention))
    );
  }
  async completed(entry) {
    if (entry.historyMode === "paginated") {
      const response = await this.client.call("thread/turns/list", {
        threadId: entry.sessionId,
        limit: 1,
        itemsView: "summary",
        sortDirection: "desc",
      });
      return ["completed", "interrupted", "failed"].includes(
        response.data?.[0]?.status,
      );
    }
    const handle = await open(entry.file, "r");
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 300000));
      await handle.read(buffer, 0, buffer.length, size - buffer.length);
      const raw = buffer.toString("utf8");
      const rows = parseJsonLines(
        size > buffer.length ? raw.slice(raw.indexOf("\n") + 1) : raw,
      );
      for (const row of rows.reverse()) {
        const p = row.payload;
        if (
          row.type === "event_msg" &&
          ["task_complete", "task_completed", "turn_aborted"].includes(p?.type)
        )
          return true;
        if (
          row.type === "response_item" &&
          p?.type === "message" &&
          p.role === "assistant" &&
          ["final", "final_answer"].includes(p.phase)
        )
          return true;
        if (
          (row.type === "event_msg" &&
            ["task_started", "user_message"].includes(p?.type)) ||
          (row.type === "response_item" &&
            [
              "function_call",
              "custom_tool_call",
              "function_call_output",
              "custom_tool_call_output",
            ].includes(p?.type))
        )
          return false;
      }
      return false;
    } finally {
      await handle.close();
    }
  }
  async nativeScope(entries, operation) {
    const selected = new Set(entries.map((e) => e.key));
    const descendants = new Map();
    for (const entry of entries) {
      const read = await this.client.call("thread/read", {
        threadId: entry.sessionId,
        includeTurns: false,
      });
      if (
        ["active", "running", "inProgress"].includes(read.thread?.status?.type)
      )
        throw new Error("Codex reports this conversation is active.");
      const nativeFile = read.thread?.path
        ? await realpath(nativePath(read.thread.path)).catch(() => null)
        : null;
      if (!nativeFile || pathKey(nativeFile) !== pathKey(entry.file))
        throw new Error(
          "This conversation belongs to a different Codex home. No changes made.",
        );
      if (operation !== "archive") continue;
      let cursor;
      const cursors = new Set();
      do {
        const result = await this.client.call("thread/list", {
          ancestorThreadId: entry.sessionId,
          archived: false,
          limit: 100,
          useStateDbOnly: true,
          sourceKinds: [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
          ],
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(result.data))
          throw new Error(
            "Codex cannot verify child-task scope on this version.",
          );
        if (
          result.data.some(
            (child) =>
              child.id !== entry.sessionId &&
              !selected.has(sessionKey("codex", child.id)),
          )
        )
          throw new Error(
            "Codex also archives child tasks. Select every child explicitly before continuing.",
          );
        descendants.set(entry.key, [
          ...(descendants.get(entry.key) || []),
          ...result.data.map((child) => sessionKey("codex", child.id)),
        ]);
        cursor = result.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("Codex returned an invalid history cursor.");
        cursors.add(cursor);
      } while (cursor);
    }
    const ordered = [],
      visited = new Set(),
      visiting = new Set();
    const visit = (key) => {
      if (visited.has(key)) return;
      if (visiting.has(key))
        throw new Error("Codex returned a cyclic child-task relationship.");
      visiting.add(key);
      for (const child of descendants.get(key) || [])
        if (child !== key) visit(child);
      visiting.delete(key);
      visited.add(key);
      ordered.push(key);
    };
    for (const entry of entries) visit(entry.key);
    return ordered;
  }
  doctorCandidates(olderDays) {
    if (![30, 90, 180].includes(olderDays))
      throw new Error("Choose 30, 90 or 180 days.");
    return [...this.entries.values()].filter(
      (e) =>
        !this.hidden[e.key] &&
        !e.nativeArchived &&
        !this.busy(e) &&
        this.now() - e.lastTs >= olderDays * 86400000,
    );
  }
  async doctor({ operation = "report", olderDays = 30 } = {}) {
    if (!["report", "tidy", "undo"].includes(operation))
      throw new Error("Unknown Doctor action.");
    await this.refresh(true);
    let undo = null;
    const undoFile = join(this.dataDir, "doctor-undo.json");
    try {
      undo = JSON.parse(await readFile(undoFile, "utf8"));
    } catch {}
    let changed = 0,
      skipped = 0;
    if (operation === "tidy") {
      const entries = this.doctorCandidates(olderDays),
        at = this.now(),
        keys = [];
      for (const entry of entries) {
        const info = await stat(entry.file).catch(() => null);
        if (
          !info ||
          info.mtimeMs !== entry.mtime ||
          info.size !== entry.bytes ||
          this.busy(entry)
        ) {
          skipped++;
          continue;
        }
        keys.push(entry.key);
      }
      if (keys.length) {
        undo = { at, keys };
        await atomicJson(undoFile, undo);
        for (const key of keys) this.hidden[key] = at;
        await atomicJson(
          join(this.dataDir, "library-hidden.json"),
          this.hidden,
        );
        changed = keys.length;
      }
    } else if (
      operation === "undo" &&
      Array.isArray(undo?.keys) &&
      Number.isFinite(undo.at)
    ) {
      for (const key of undo.keys)
        if (this.hidden[key] === undo.at) {
          delete this.hidden[key];
          changed++;
        }
      await atomicJson(join(this.dataDir, "library-hidden.json"), this.hidden);
      await atomicJson(undoFile, null);
      undo = null;
    }
    const candidates = this.doctorCandidates(olderDays);
    return {
      indexed: this.entries.size,
      candidates: candidates.length,
      missingWorkspaces: candidates.filter((e) => !e.workspaceExists).length,
      olderDays,
      changed,
      skipped,
      canUndo: Boolean(undo?.keys?.some((key) => this.hidden[key] === undo.at)),
      hiddenKeys: Object.keys(this.hidden),
      diagnostics: this.diagnostics,
    };
  }
  async plan({ keys, operation }) {
    if (
      !Array.isArray(keys) ||
      !keys.length ||
      keys.length > 100 ||
      new Set(keys).size !== keys.length ||
      !["hide", "unhide", "archive", "unarchive"].includes(operation)
    )
      throw new Error("Choose 1–100 sessions and a supported action");
    const entries = await Promise.all(keys.map((key) => this.resolve(key)));
    const native = ["archive", "unarchive"].includes(operation);
    if (native && !this.client.executable)
      throw new Error("The Codex CLI is required for native archive actions.");
    const selected = new Set(keys);
    if (native)
      for (const entry of entries) {
        if (entry.readOnlySource)
          throw new Error(
            "Manage archives on the original host. This source is read-only.",
          );
        if (entry.provider !== "codex")
          throw new Error(
            "Claude has no supported native archive API. Hide it in Ocelin or open Claude to manage it.",
          );
        if (this.busy(entry))
          throw new Error(
            "A selected conversation is active or recently changed. Wait for it to finish before archiving.",
          );
        if (operation === "archive" && !(await this.completed(entry)))
          throw new Error(
            "A selected conversation has no confirmed completion. Open it in Codex and finish or interrupt it first.",
          );
        if (entry.nativeArchived !== (operation === "unarchive"))
          throw new Error("Archive state changed. Refresh this selection.");
        if (operation === "archive") {
          const descendants = [...this.entries.values()].filter(
            (e) => e.parentId === entry.sessionId && !e.nativeArchived,
          );
          if (descendants.some((e) => !selected.has(e.key)))
            throw new Error(
              "Codex also archives child tasks. Select its child tasks explicitly before continuing.",
            );
        }
      }
    if (native) await this.nativeScope(entries, operation);
    const id = randomBytes(20).toString("hex");
    const plan = {
      id,
      operation,
      created: this.now(),
      entries: entries.map((e) => ({
        key: e.key,
        file: e.file,
        mtime: e.mtime,
        bytes: e.bytes,
      })),
    };
    this.plans.clear();
    this.plans.set(id, plan);
    return {
      id,
      operation,
      entries: entries.map((e) => this.public(e)),
      count: entries.length,
      scope: native ? "Codex native history" : "Ocelin only",
      reversible: true,
      note: native
        ? "Uses Codex’s archive API. Originals are retained. Restore from Archived. Active conversations cannot be selected."
        : "Changes visibility in Ocelin. Original conversations and files stay in their owning apps.",
      diskBytesFreed: 0,
    };
  }
  async apply(id) {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (!plan || this.now() - plan.created > 60000)
      throw new Error("Preview expired. Review the selection again.");
    for (const selected of plan.entries) {
      const entry = await this.resolve(selected.key);
      const current = await stat(entry.file);
      if (
        entry.file !== selected.file ||
        current.mtimeMs !== selected.mtime ||
        current.size !== selected.bytes
      )
        throw new Error(
          "A conversation changed after the preview. Review again.",
        );
      if (["archive", "unarchive"].includes(plan.operation) && this.busy(entry))
        throw new Error("A selected conversation is now active.");
    }
    const native = ["archive", "unarchive"].includes(plan.operation);
    if (native) {
      const order = await this.nativeScope(
        plan.entries.map((s) => this.entries.get(s.key)),
        plan.operation,
      );
      plan.entries.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    const results = [];
    for (const selected of plan.entries) {
      const entry = this.entries.get(selected.key);
      try {
        if (plan.operation === "hide") this.hidden[entry.key] = this.now();
        else if (plan.operation === "unhide") delete this.hidden[entry.key];
        else {
          const before = await stat(entry.file);
          if (
            before.mtimeMs !== selected.mtime ||
            before.size !== selected.bytes ||
            (plan.operation === "archive" && !(await this.completed(entry)))
          )
            throw new Error("The conversation changed. Review a new preview.");
          await this.client.call(
            plan.operation === "archive"
              ? "thread/archive"
              : "thread/unarchive",
            { threadId: entry.sessionId },
          );
        }
        results.push({ key: entry.key, ok: true });
      } catch (error) {
        results.push({
          key: entry.key,
          ok: false,
          uncertain: native,
          error:
            error.message +
            (native
              ? " No further sessions were changed; refresh to check the native state."
              : ""),
        });
        if (native) break;
      }
    }
    await atomicJson(join(this.dataDir, "library-hidden.json"), this.hidden);
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(
      join(this.dataDir, "library-actions.jsonl"),
      JSON.stringify({ ts: this.now(), operation: plan.operation, results }) +
        "\n",
      { mode: 0o600 },
    );
    await this.refresh(true);
    return { results, hiddenKeys: Object.keys(this.hidden) };
  }
  stop() {
    this.client.stop();
  }
}
