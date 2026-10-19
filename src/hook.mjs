import {
  captureTurn,
  flushPending,
  handleBeforeSubmit,
  handleSessionStart,
  runBackgroundJob,
} from "./memory.mjs";
import { loadConfig } from "./config.mjs";
import { logLine } from "./queue.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const event = process.argv[2] || "";

if (event === "flush") {
  flushPending()
    .catch((error) => {
      const config = loadConfig();
      logLine(config?.logging !== false, `flush error: ${error}`);
    })
    .finally(() => process.exit(0));
} else if (event === "bg") {
  const jobPath = process.argv[3];
  runBackgroundJob(jobPath)
    .catch((error) => {
      const config = loadConfig();
      logLine(config?.logging !== false, `bg error: ${error}`);
    })
    .finally(() => process.exit(0));
} else {
  const input = await readStdin();
  try {
    if (event === "sessionStart") {
      const additional = await handleSessionStart(input);
      write(additional ? { additional_context: additional } : {});
    } else if (event === "beforeSubmitPrompt") {
      const result = await handleBeforeSubmit(input);
      write(result);
    } else if (event === "afterAgentResponse") {
      captureTurn(input, "assistant", input.text);
      write({});
    } else if (event === "stop" || event === "preCompact" || event === "sessionEnd") {
      await flushPending();
      write({});
    } else {
      write({});
    }
  } catch (error) {
    const config = loadConfig();
    logLine(config?.logging !== false, `${event} error: ${error}`);
    write(event === "beforeSubmitPrompt" ? { continue: true } : {});
  }
}
