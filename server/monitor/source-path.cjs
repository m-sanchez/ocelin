const { isAbsolute } = require("node:path");
function sourceKind(root) {
  if (typeof root !== "string" || /[\x00-\x1f]/.test(root)) return null;
  if (
    /^\\\\(?:wsl\.localhost|wsl\$)\\[a-zA-Z0-9_.-]+\\[^\0]+$/i.test(root) &&
    !root.split(/[\\/]/).includes("..")
  )
    return "wsl";
  return isAbsolute(root) && !/^[/\\]{2}/.test(root) ? "local" : null;
}
module.exports = { sourceKind };
