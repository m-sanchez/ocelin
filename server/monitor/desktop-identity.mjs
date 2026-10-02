import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { accountIdentity, mergeIdentity } from "./identity.mjs";

export const defaultCodexLogRoot = () =>
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Codex", "Logs")
    : null;

export function codexLogIdentity(line) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\S+ info \[(?:desktop-notifications|notifications-service)\] /.test(
      line,
    )
  )
    return null;
  const match = line.match(/notificationId=turn-(\[.*?\])/);
  if (!match) return null;
  try {
    const [accountId, userId, host, sessionId] = JSON.parse(
      match[1].replaceAll('\\"', '"'),
    );
    if (host !== "local" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId || ""))
      return null;
    const account = accountIdentity(
      "codex",
      accountId,
      userId,
      "desktop-log",
      Date.parse(line.split(" ")[0]),
    );
    return account
      ? { sessionId, identity: { clients: ["desktop"], accounts: [account] } }
      : null;
  } catch {
    return null;
  }
}

export class CodexDesktopIdentity {
  constructor(root = defaultCodexLogRoot()) {
    this.root = root;
    this.files = new Map();
    this.sessions = new Map();
  }
  async read() {
    if (!this.root) return this.sessions;
    const files = [];
    const walk = async (dir, depth) => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const e of entries) {
        if (files.length >= 64) break;
        const file = join(dir, e.name);
        if (e.isDirectory() && depth > 0 && /^\d{2,4}$/.test(e.name))
          await walk(file, depth - 1).catch(() => {});
        else if (e.isFile() && /^codex-desktop-.+\.log$/.test(e.name))
          files.push(file);
      }
    };
    await walk(this.root, 3).catch(() => {});
    for (const file of files) {
      let handle;
      try {
        const info = await stat(file),
          previous = this.files.get(file);
        const fileId = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
        if (
          previous?.fileId === fileId &&
          previous.size === info.size &&
          previous.mtime === info.mtimeMs
        )
          continue;
        const offset =
          previous?.fileId === fileId && info.size > previous.size
            ? previous.offset
            : 0;
        const start = Math.max(offset, info.size - 2 * 1024 * 1024);
        handle = await open(file, "r");
        const buffer = Buffer.alloc(info.size - start);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          start,
        );
        const last = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (last < 0) continue;
        const first = start > offset ? buffer.indexOf(10) + 1 : 0;
        for (const line of buffer.toString("utf8", first, last).split("\n")) {
          const entry = codexLogIdentity(line);
          if (entry)
            this.sessions.set(
              entry.sessionId,
              mergeIdentity(this.sessions.get(entry.sessionId), entry.identity),
            );
        }
        this.files.set(file, {
          fileId,
          offset: start + last + 1,
          size: info.size,
          mtime: info.mtimeMs,
        });
      } catch {
      } finally {
        await handle?.close();
      }
    }
    for (const file of this.files.keys())
      if (!files.includes(file)) this.files.delete(file);
    return this.sessions;
  }
}
