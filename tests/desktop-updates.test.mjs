import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const { Updates } = require("../desktop/lib/updates.cjs");
const { sourceKind } = require("../server/monitor/source-path.cjs");
const { sessionLink } = require("../desktop/lib/session-links.cjs");
const { signatureMatches } = require("../desktop/lib/update-signature.cjs");

function updater(config) {
  const value = new EventEmitter();
  value.configOnDisk = { value: Promise.resolve(config) };
  value.checkForUpdates = async () => {
    value.checked = true;
    value.emit("update-available", { version: "1.0.0" });
  };
  value.downloadUpdate = async () =>
    value.emit("update-downloaded", { version: "1.0.0" });
  value.quitAndInstall = () => {
    value.installed = true;
  };
  return value;
}
const valid = {
  provider: "github",
  owner: "m-sanchez",
  repo: "ocelin",
  publisherName: "Fixture Publisher",
};

test("updates fail closed for unsigned builds and mismatched publishers or feeds", async () => {
  const unsigned = new Updates({ publisher: null });
  await assert.rejects(unsigned.check(), /signed/);
  for (const config of [
    { ...valid, publisherName: undefined },
    { ...valid, repo: "other" },
    { ...valid, publisherName: "Other" },
  ]) {
    const fake = updater(config);
    const updates = new Updates({
      updater: fake,
      publisher: "Fixture Publisher",
    });
    await assert.rejects(updates.check(), /publisher or feed/);
    assert.equal(fake.checked, undefined);
  }
});
test("manual update checks never download or install until requested", async () => {
  const fake = updater(valid);
  const updates = new Updates({
    updater: fake,
    publisher: "Fixture Publisher",
  });
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.throws(() => updates.install(), /No verified/);
  await updates.check();
  assert.equal(updates.value.status, "available");
  await updates.download();
  assert.equal(updates.value.status, "ready");
  updates.install();
  assert.equal(fake.installed, true);
});
test("WSL source allowance does not permit arbitrary network shares or native dispatch", () => {
  assert.equal(
    sourceKind("\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex\\sessions"),
    "wsl",
  );
  assert.equal(
    sourceKind("\\\\wsl$\\Ubuntu\\home\\user\\.claude\\projects"),
    "wsl",
  );
  assert.equal(sourceKind("\\\\server\\share\\sessions"), null);
  assert.equal(sourceKind("\\\\wsl.localhost\\Ubuntu\\..\\elsewhere"), null);
  assert.throws(
    () =>
      sessionLink({
        sessionId: "abc",
        provider: "codex",
        readOnlySource: true,
      }),
    /source host/,
  );
});
test("signature verification requires validity, the full subject and the exact installer path", () => {
  const file = "C:/updates/setup.exe",
    publisher = "CN=Fixture Publisher, O=Fixture";
  const signature = { valid: true, subject: publisher, path: file };
  assert.equal(signatureMatches(signature, publisher, file), true);
  assert.equal(
    signatureMatches({ ...signature, valid: false }, publisher, file),
    false,
  );
  assert.equal(signatureMatches(signature, "Fixture Publisher", file), false);
  assert.equal(
    signatureMatches(signature, publisher, "C:/updates/other.exe"),
    false,
  );
});
