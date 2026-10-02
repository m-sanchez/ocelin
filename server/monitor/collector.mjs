import {
  readdir,
  readFile,
  writeFile,
  rename,
  mkdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { IncrementalReader } from "./reader.mjs";
import { recordEvents } from "./records.mjs";
import {
  recordIdentity,
  mergeIdentity,
  claudeDesktopIdentity,
} from "./identity.mjs";
import { CodexDesktopIdentity } from "./desktop-identity.mjs";
import sourcePaths from "./source-path.cjs";
import {
  reduceSession,
  presentSession,
  sortSessions,
  sessionKey,
  safeId,
  validEvent,
  localPath,
  pathKey,
} from "./model.mjs";

export function defaultSources() {
  return [
    {
      provider: "codex",
      root: join(
        process.env.CODEX_HOME || join(homedir(), ".codex"),
        "sessions",
      ),
    },
    {
      provider: "claude",
      root: join(
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        "projects",
      ),
    },
  ];
}

export async function atomicJson(file, value) {
  await mkdir(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
}

async function filesUnder(root, extension, limit, depth = 5) {
  const files = [];
  async function walk(dir, level) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const item of entries) {
      if (files.length >= limit) break;
      if (item.isSymbolicLink()) continue;
      const file = join(dir, item.name);
      if (item.isDirectory() && level > 0)
        await walk(file, level - 1).catch(() => {});
      if (item.isFile() && item.name.endsWith(extension)) files.push(file);
    }
  }
  await walk(root, depth);
  return files;
}

export class SessionMonitor {
  constructor({
    dataDir,
    sources = defaultSources(),
    now = Date.now,
    limit = 2000,
    desktopRoot,
    codexLogRoot,
  } = {}) {
    this.dataDir = dataDir;
    this.sources = sources;
    this.now = now;
    this.limit = limit;
    this.desktopRoot =
      desktopRoot !== undefined
        ? desktopRoot
        : process.env.APPDATA
          ? join(process.env.APPDATA, "Claude", "claude-code-sessions")
          : null;
    this.codexIdentity = new CodexDesktopIdentity(codexLogRoot);
    this.sessions = new Map();
    this.files = new Map();
    this.acknowledgements = {};
    this.notified = {};
    this.diagnostics = [];
    this.discoveryAt = 0;
    this.lastHookAt = {};
    this.bytesRead = 0;
    this.bootAt = now();
    this.ticking = false;
  }
  async load() {
    try {
      const saved = JSON.parse(
        await readFile(join(this.dataDir, "monitor.json"), "utf8"),
      );
      if (saved.version !== 1) return;
      for (const s of saved.sessions || [])
        if (safeId(s.sessionId)) this.sessions.set(s.key, s);
      this.acknowledgements = saved.acknowledgements || {};
      this.notified = saved.notified || {};
      this.lastHookAt = saved.lastHookAt || {};
      this.savedFiles = saved.files || {};
    } catch {}
  }
  setSources(sources) {
    this.sources = sources;
    const allowed = new Set(
      sources.map((s) => `${s.provider}:${pathKey(s.root)}`),
    );
    for (const [key, session] of this.sessions) {
      if (
        session.sourceRoots?.length &&
        !session.sourceRoots.some((root) =>
          allowed.has(`${session.provider}:${pathKey(root)}`),
        )
      )
        this.sessions.delete(key);
    }
  }
  async discover() {
    const diagnostics = [];
    const seen = new Set();
    for (const source of this.sources) {
      try {
        if (!sourcePaths.sourceKind(source.root)) continue;
        const candidates = await filesUnder(
          source.root,
          ".jsonl",
          this.limit * 10,
        );
        const ranked = [];
        for (let i = 0; i < candidates.length; i += 32) {
          const batch = await Promise.all(
            candidates.slice(i, i + 32).map(async (file) => ({
              file,
              mtime: (await stat(file).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
            })),
          );
          ranked.push(...batch);
        }
        const paths = ranked
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, this.limit)
          .map((s) => s.file);
        for (const file of paths) {
          seen.add(file);
          if (!this.files.has(file)) {
            const saved = this.savedFiles?.[file];
            const id = basename(file, ".jsonl");
            const subagent =
              source.provider === "claude" && id.startsWith("agent-");
            this.files.set(file, {
              provider: source.provider,
              sourceRoot: source.root,
              sourceKind:
                source.kind === "mirror"
                  ? "mirror"
                  : sourcePaths.sourceKind(source.root),
              reader: new IncrementalReader(
                saved?.context?.identity ? saved.reader : undefined,
              ),
              context: saved?.context?.identity
                ? saved.context
                : {
                    sessionId:
                      source.provider === "claude" && safeId(id) ? id : null,
                    subagent,
                    parentId: subagent
                      ? basename(join(file, "..", ".."))
                      : null,
                  },
              checkedAt: 0,
            });
          }
        }
        diagnostics.push({
          ...source,
          status: "available",
          files: paths.length,
          capped: candidates.length > this.limit,
        });
      } catch (error) {
        diagnostics.push({
          ...source,
          status: error.code === "ENOENT" ? "unavailable" : "unreadable",
          files: 0,
        });
      }
    }
    for (const file of this.files.keys())
      if (!seen.has(file)) this.files.delete(file);
    this.diagnostics = diagnostics;
    this.discoveryAt = this.now();
  }
  async desktopAliases() {
    try {
      for (const file of await filesUnder(
        this.desktopRoot,
        ".json",
        this.limit,
        3,
      )) {
        if (!basename(file).startsWith("local_")) continue;
        try {
          if ((await stat(file)).size > 128 * 1024) continue;
          const meta = JSON.parse(await readFile(file, "utf8"));
          if (!safeId(meta.cliSessionId)) continue;
          const key = sessionKey("claude", meta.cliSessionId);
          const existing = this.sessions.get(key);
          if (existing)
            this.sessions.set(key, {
              ...existing,
              ...(typeof meta.title === "string"
                ? { displayTitle: meta.title.slice(0, 160) }
                : {}),
              desktopId: safeId(meta.sessionId) ? meta.sessionId : null,
              host: "Claude Desktop",
              identity: mergeIdentity(
                existing.identity,
                claudeDesktopIdentity(this.desktopRoot, file, meta),
              ),
            });
        } catch {}
      }
    } catch {}
  }
  async codexTitles() {
    for (const source of this.sources.filter((s) => s.provider === "codex")) {
      try {
        const file = join(source.root, "..", "session_index.jsonl");
        if ((await stat(file)).size > 4 * 1024 * 1024) continue;
        for (const line of (await readFile(file, "utf8")).split("\n")) {
          try {
            const entry = JSON.parse(line),
              key = sessionKey("codex", entry.id),
              session = this.sessions.get(key);
            if (session && typeof entry.thread_name === "string")
              this.sessions.set(key, {
                ...session,
                displayTitle: entry.thread_name.slice(0, 160),
              });
          } catch {}
        }
      } catch {}
    }
  }
  apply(event) {
    const key = sessionKey(event.provider, event.sessionId);
    const next = reduceSession(this.sessions.get(key), event);
    if (next) this.sessions.set(key, next);
  }
  async drainHooks() {
    const spool = join(this.dataDir, "events");
    let files;
    try {
      files = (await readdir(spool))
        .filter((f) => /^[0-9a-f-]+\.json$/.test(f))
        .slice(0, 4000);
    } catch {
      return;
    }
    const batch = [];
    for (const name of files) {
      const file = join(spool, name);
      try {
        if ((await stat(file)).size <= 4096) {
          const event = JSON.parse(await readFile(file, "utf8"));
          if (validEvent(event)) batch.push({ event, file });
          else await unlink(file);
        } else await unlink(file);
      } catch {
        await unlink(file).catch(() => {});
      }
    }
    batch.sort(
      (a, b) => a.event.ts - b.event.ts || a.event.id.localeCompare(b.event.id),
    );
    for (const { event } of batch) {
      this.apply(event);
      if (["codex", "claude"].includes(event.provider))
        this.lastHookAt[event.provider] = event.ts;
    }
    return batch.map((b) => b.file);
  }
  async tick({ force = false } = {}) {
    if (this.ticking) return this.snapshot();
    this.ticking = true;
    const started = performance.now();
    try {
      const discover =
        force || this.now() - this.discoveryAt > 30000 || !this.discoveryAt;
      if (discover) await this.discover();
      for (const [file, entry] of this.files) {
        const s = this.sessions.get(
          sessionKey(entry.provider, entry.context.sessionId),
        );
        if (
          !force &&
          s &&
          this.now() - s.lastTs > 60 * 60 * 1000 &&
          this.now() - entry.checkedAt < 30000
        )
          continue;
        try {
          const read = await entry.reader.read(file, (record, offset) => {
            entry.context.offset = offset;
            const recordId =
              entry.provider === "codex"
                ? record.type === "session_meta"
                  ? record.payload?.id
                  : null
                : record.sessionId;
            if (
              !entry.context.subagent &&
              safeId(recordId) &&
              recordId !== entry.context.sessionId
            )
              entry.context.identity = null;
            entry.context.identity = mergeIdentity(
              entry.context.identity,
              recordIdentity(entry.provider, record),
            );
            for (const event of recordEvents(
              entry.provider,
              record,
              entry.context,
            )) {
              entry.context.lastTs = Math.max(
                entry.context.lastTs || 0,
                event.ts,
              );
              this.apply(event);
            }
          });
          this.bytesRead += read.bytes;
          const key = sessionKey(entry.provider, entry.context.sessionId);
          const session = this.sessions.get(key);
          if (session)
            this.sessions.set(key, {
              ...session,
              readOnlySource:
                session.readOnlySource || entry.sourceKind !== "local",
              sourceKind: entry.sourceKind,
              identity: mergeIdentity(session.identity, entry.context.identity),
              transcript:
                !session.transcript || entry.context.lastTs >= session.lastTs
                  ? file
                  : session.transcript,
              sourceRoots: [
                ...new Set([...(session.sourceRoots || []), entry.sourceRoot]),
              ],
            });
          entry.checkedAt = this.now();
        } catch {
          entry.error = "Transcript unavailable";
        }
      }
      const drained = await this.drainHooks();
      if (discover) {
        await this.codexTitles();
        if (this.desktopRoot) await this.desktopAliases();
        const identities = [...this.sessions.values()].some(
          (s) => s.provider === "codex",
        )
          ? await this.codexIdentity.read()
          : [];
        for (const [id, identity] of identities) {
          const session = this.sessions.get(sessionKey("codex", id));
          if (session)
            session.identity = mergeIdentity(session.identity, identity);
        }
      }
      const cutoff = this.now() - 30 * 24 * 60 * 60 * 1000;
      for (const [key, s] of this.sessions)
        if (s.lastTs < cutoff) {
          this.sessions.delete(key);
          delete this.acknowledgements[key];
          delete this.notified[key];
        }
      await this.save();
      for (const file of drained || []) await unlink(file).catch(() => {});
      this.lastTickMs = Math.round(performance.now() - started);
      return this.snapshot();
    } finally {
      this.ticking = false;
    }
  }
  snapshot() {
    const sessions = sortSessions(
      [...this.sessions.values()].map((s) =>
        presentSession(s, this.acknowledgements, this.now()),
      ),
    );
    return {
      sessions,
      diagnostics: this.diagnostics.map((s) => ({
        ...s,
        lastHookAt: this.lastHookAt[s.provider] || null,
      })),
      sampledAt: this.now(),
      metrics: {
        files: this.files.size,
        bytesRead: this.bytesRead,
        lastTickMs: this.lastTickMs || 0,
      },
      counts: {
        running: sessions.filter((s) => s.execution === "running" && !s.stale)
          .length,
        attention: sessions.filter(
          (s) => (s.attention || s.execution === "error") && !s.stale,
        ).length,
        unseen: sessions.filter((s) => s.unseen && !s.stale).length,
      },
    };
  }
  async acknowledge(key) {
    const s = this.snapshot().sessions.find((s) => s.key === key);
    if (!s) throw new Error("Unknown session");
    this.acknowledgements[key] = s.signal;
    await this.save();
  }
  async notifications({
    quiet = false,
    completions = false,
    mutedProviders = [],
    mutedProjects = [],
  } = {}) {
    const result = [];
    for (const s of this.snapshot().sessions) {
      if (
        !s.signal ||
        s.lastTs < this.bootAt ||
        this.notified[s.key] === s.signal ||
        !s.unseen
      )
        continue;
      this.notified[s.key] = s.signal;
      if (
        !quiet &&
        !mutedProviders.includes(s.provider) &&
        !mutedProjects.includes(s.cwd) &&
        (s.attention ||
          s.execution === "error" ||
          (completions && s.result?.kind === "complete"))
      )
        result.push(s);
    }
    await this.save();
    return result;
  }
  async save() {
    const value = {
      version: 1,
      sessions: [...this.sessions.values()],
      acknowledgements: this.acknowledgements,
      notified: this.notified,
      lastHookAt: this.lastHookAt,
      files: Object.fromEntries(
        [...this.files].map(([file, e]) => [
          file,
          { reader: e.reader.checkpoint(), context: e.context },
        ]),
      ),
    };
    const serialized = JSON.stringify(value);
    if (serialized === this.lastSaved) return;
    await atomicJson(join(this.dataDir, "monitor.json"), value);
    this.lastSaved = serialized;
  }
  target(key) {
    const s = this.sessions.get(key);
    if (s?.readOnlySource)
      throw new Error(
        "Open this conversation on its source host. Imported and WSL sources are read-only.",
      );
    if (!s || !localPath(s.cwd))
      throw new Error("This session has no local project path");
    return { ...s };
  }
}
