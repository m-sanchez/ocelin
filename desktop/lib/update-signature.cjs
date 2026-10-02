const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { join, normalize } = require("node:path");
function signatureMatches(value, publisher, file) {
  return (
    value?.valid === true &&
    typeof publisher === "string" &&
    publisher.startsWith("CN=") &&
    value.subject === publisher &&
    typeof value.path === "string" &&
    normalize(value.path).toLowerCase() === normalize(file).toLowerCase()
  );
}
async function verifyUpdateSignature(publisher, file) {
  try {
    const { stdout } = await promisify(execFile)(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(
          __dirname.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"),
          "verify-update.ps1",
        ),
        "-InstallerPath",
        file,
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 },
    );
    return signatureMatches(JSON.parse(stdout), publisher, file)
      ? null
      : "Installer signature does not match the trusted publisher";
  } catch {
    return "Installer signature verification failed";
  }
}
module.exports = { verifyUpdateSignature, signatureMatches };
