import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchTranscript } from "../server/library/search.mjs";
import { SessionLibrary } from "../server/library/catalog.mjs";

test("full transcript search finds later Unicode responses and tool results without indexing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ocelin-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  await writeFile(
    file,
    [
      { type: "session_meta", payload: { secret: "private-credential" } },
      { type: "user", message: { content: "first request" } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "España later answer" }] },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "needle-in-result" }],
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  assert.equal(
    (await searchTranscript({ file, root }, ["españa", "needle-in-result"]))
      .matched,
    true,
  );
  assert.equal(
    (await searchTranscript({ file, root }, ["private-credential"])).matched,
    false,
  );
  assert.equal(
    (await searchTranscript({ file, root }, ["missing"], { maxBytes: 10 }))
      .partial,
    true,
  );
  await assert.rejects(
    searchTranscript({ file, root: join(root, "elsewhere") }, ["first"]),
  );
});

test("library full text is opt-in and invalidates matches when transcripts change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ocelin-search-library-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const file = join(source, "session.jsonl");
  const rows = [
    {
      type: "user",
      sessionId: "session",
      cwd: root,
      timestamp: new Date().toISOString(),
      message: { content: "original request" },
    },
    { type: "assistant", message: { content: "later answer zebra" } },
  ];
  await writeFile(file, rows.map(JSON.stringify).join("\n"));
  const library = new SessionLibrary({
    dataDir: join(root, "data"),
    sources: [{ provider: "claude", root: source }],
    desktopRoot: null,
    codexLogRoot: null,
    client: { stop() {} },
  });
  assert.equal((await library.query({ search: "zebra" })).total, 0);
  assert.equal(
    (await library.query({ search: "zebra", fullText: true })).total,
    1,
  );
  library.scannedAt = Date.now() - 61000;
  const generation = library.generation;
  await library.query({
    search: "zebra",
    fullText: true,
    continueSearch: true,
  });
  assert.equal(library.generation, generation);
  rows[1].message.content = "replacement answer";
  await writeFile(file, rows.map(JSON.stringify).join("\n"));
  assert.equal(
    (await library.query({ search: "zebra", fullText: true, refresh: true }))
      .total,
    0,
  );
});
