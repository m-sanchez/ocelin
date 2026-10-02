import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { accountKey } from "./identity.mjs";

export async function codexProfileIdentity(home) {
  try {
    const file = join(home, "auth.json");
    if ((await stat(file)).size > 128 * 1024) return null;
    const auth = JSON.parse(await readFile(file, "utf8"));
    const tokens = auth.tokens;
    if (auth.auth_mode !== "chatgpt" || !tokens?.id_token) return null;
    const claims = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8"),
    );
    const details = claims["https://api.openai.com/auth"];
    if (
      !details ||
      details.chatgpt_account_id !== tokens.account_id ||
      typeof claims.email !== "string"
    )
      return null;
    const key = accountKey("codex", tokens.account_id, details.chatgpt_user_id);
    if (!key) return null;
    return {
      key,
      email: claims.email,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(tokens))
        .digest("hex"),
    };
  } catch {
    return null;
  }
}
