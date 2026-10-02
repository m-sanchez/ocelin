import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

const contentText = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map(
            (block) =>
              block?.text ||
              (block?.type === "tool_result" ? contentText(block.content) : ""),
          )
          .join("\n")
      : "";

export function searchableText(record) {
  if (record.type === "response_item") {
    const p = record.payload || {};
    if (p.type === "message" && ["user", "assistant"].includes(p.role))
      return contentText(p.content);
    if (["function_call_output", "custom_tool_call_output"].includes(p.type))
      return contentText(p.output);
  }
  if (
    record.type === "event_msg" &&
    ["user_message", "agent_message"].includes(record.payload?.type)
  )
    return contentText(record.payload.message);
  if (["user", "assistant"].includes(record.type) && !record.isMeta)
    return contentText(record.message?.content);
  return "";
}

export async function searchTranscript(
  entry,
  terms,
  { maxBytes = 32 * 1024 * 1024, deadline = Infinity } = {},
) {
  const actual = await realpath(entry.file);
  const rel = relative(entry.root, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Transcript is outside its source folder");
  const handle = await open(actual, "r");
  const remaining = new Set(terms);
  let partial = false,
    bytes = 0,
    pending = "",
    dropping = false;
  const decoder = new StringDecoder("utf8");
  const inspect = (line) => {
    try {
      const text = searchableText(JSON.parse(line)).toLowerCase();
      for (const term of remaining)
        if (text.includes(term)) remaining.delete(term);
    } catch {
      partial = true;
    }
  };
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(65536);
    while (
      remaining.size &&
      bytes < size &&
      bytes < maxBytes &&
      Date.now() < deadline
    ) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes - bytes),
        bytes,
      );
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      pending += decoder.write(buffer.subarray(0, result.bytesRead));
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!dropping && line.trim()) inspect(line);
        dropping = false;
      }
      if (pending.length > 2 * 1024 * 1024) {
        pending = "";
        dropping = true;
        partial = true;
      }
    }
    if (bytes >= size && pending.trim() && !dropping)
      inspect(pending + decoder.end());
    return {
      matched: remaining.size === 0,
      partial: partial || (remaining.size > 0 && bytes < size),
      bytes,
    };
  } finally {
    await handle.close();
  }
}
