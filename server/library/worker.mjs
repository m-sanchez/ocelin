import { parentPort } from "node:worker_threads";
import { SessionLibrary } from "./catalog.mjs";

const port = process.parentPort || parentPort;
const library = new SessionLibrary({
  dataDir: process.env.OCELIN_DATA_DIR,
  ...(process.env.OCELIN_SMOKE_TEST === "1"
    ? { desktopRoot: null, codexLogRoot: null }
    : {}),
  profiles: process.env.OCELIN_ACCOUNT_PROFILES
    ? JSON.parse(process.env.OCELIN_ACCOUNT_PROFILES)
    : [],
  ...(process.env.OCELIN_SOURCES
    ? { sources: JSON.parse(process.env.OCELIN_SOURCES) }
    : {}),
});
await library.load();
let queue = Promise.resolve();
port.on("message", (raw) => {
  const message = raw.data || raw;
  if (message.type === "snapshot") {
    library.setLive(message.sessions);
    return;
  }
  if (message.type === "stop") {
    library.stop();
    process.exit(0);
  }
  queue = queue.then(async () => {
    const { id, type, args } = message;
    try {
      let value;
      if (type === "query") value = await library.query(args);
      else if (type === "preview")
        value = await library.preview(args.key, args.hint);
      else if (type === "target") value = await library.target(args.key);
      else if (type === "plan") value = await library.plan(args);
      else if (type === "apply") value = await library.apply(args.id);
      else if (type === "doctor") value = await library.doctor(args);
      else throw new Error("Unknown library action");
      port.postMessage({ type: "reply", id, value });
    } catch (error) {
      port.postMessage({ type: "reply", id, error: error.message });
    }
  });
});
