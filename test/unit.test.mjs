import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { bearerToken } from "../src/jwt.mjs";
import {
  assembleByPriority,
  filterRepresentation,
  renderMemory,
  renderSessionStart,
} from "../src/injection.mjs";
import { hookCommand, mergeHooks } from "../src/cli.mjs";
import { enqueue, messageId, readQueue, replaceQueue } from "../src/queue.mjs";
import { cap, redact } from "../src/redact.mjs";
import { sanitize, sessionName } from "../src/session-name.mjs";

test("sanitize keeps a stable session token", () => {
  assert.equal(sanitize("My Project!"), "my-project");
});

test("session name uses the peer and directory", () => {
  const config = {
    peerName: "alice",
    sessionPeerPrefix: true,
    sessionStrategy: "per-directory",
    sessions: {},
  };
  assert.equal(sessionName(config, "/work/honcho", "conv"), "alice-honcho");
});

test("pinned session wins", () => {
  const config = {
    peerName: "alice",
    sessionPeerPrefix: true,
    sessionStrategy: "per-directory",
    sessions: { "/work/honcho": "pinned" },
  };
  assert.equal(sessionName(config, "/work/honcho", "conv"), "pinned");
});

test("redact hides keys and caps length", () => {
  assert.match(redact("token Bearer abcdefghijklmnop"), /\[REDACTED\]/);
  assert.equal(cap("abcdef", 3), "abc\n…[truncated]");
});

test("cursor host overrides workspace and ai peer", () => {
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    peerName: "alice",
    apiKey: "test-key",
    workspace: "shared",
    hosts: { cursor: { workspace: "cursor-ws", aiPeer: "cursor-ai" } },
  }));
  const config = loadConfig({ HONCHO_CONFIG_PATH: path });
  assert.equal(config.peerName, "alice");
  assert.equal(config.workspace, "cursor-ws");
  assert.equal(config.aiPeer, "cursor-ai");
  assert.equal(config.baseUrl, "https://api.honcho.dev");
  assert.equal(config.observationMode, "directional");
  assert.deepEqual(config.perTurn, ["userContext", "dialectic"]);
  assert.equal(config.cadence.ttlSeconds, 300);
  assert.equal(config.cadence.dialectic, 5);
});

test("missing hosts.cursor is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    peerName: "alice",
    apiKey: "test-key",
    workspace: "other-ws",
    hosts: { dsh: { workspace: "other-ws", aiPeer: "dsh" } },
  }));
  assert.equal(loadConfig({ HONCHO_CONFIG_PATH: path }), null);
});

test("raw api key is signed into a workspace jwt", () => {
  const token = bearerToken("secret", "demo-ws");
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  assert.equal(token.split(".").length, 3);
  assert.deepEqual(payload, { w: "demo-ws" });
  assert.equal(bearerToken("aaa.bbb.ccc", "demo-ws"), "aaa.bbb.ccc");
});

test("injection names the peers and skips an empty card", () => {
  const config = {
    peerName: "alice",
    aiPeer: "cursor-ai",
    workspace: "cursor-ws",
    perTurn: [],
    contextTokens: 1500,
    maxRenderedConclusions: 4,
  };
  const text = renderSessionStart(["directives", "peerCard", "summary"], {
    summary: "building cursor-honcho",
    peerCard: [],
  }, config);
  assert.match(text, /alice/);
  assert.match(text, /cursor-ai/);
  assert.match(text, /building cursor-honcho/);
  assert.doesNotMatch(text, /Profile:/);
});

test("per-turn userContext contributes card and representation", () => {
  const config = {
    peerName: "alice",
    aiPeer: "cursor-ai",
    workspace: "cursor-ws",
    sessionStart: ["directives"],
    perTurn: ["userContext", "dialectic"],
    contextTokens: 1500,
    maxRenderedConclusions: 4,
  };
  const text = renderMemory(
    config,
    {
      peerCard: ["likes concise diffs"],
      peerRepresentation: "**Pattern** [high]: prefers small PRs\nType: habit\nSources:\n- a",
    },
    "Works best with short feedback loops.",
  );
  assert.match(text, /likes concise diffs/);
  assert.match(text, /prefers small PRs/);
  assert.match(text, /short feedback loops/);
  assert.doesNotMatch(text, /Sources:/);
});

test("filterRepresentation drops medium patterns and provenance", () => {
  const filtered = filterRepresentation(
    "**Pattern** [high]: keep\n**Pattern** [medium]: drop\n- bullet\nType: x\nSources:\n- a\nPremises:\n- b\n[2024-01-01] after",
  );
  assert.match(filtered, /keep/);
  assert.doesNotMatch(filtered, /drop/);
  assert.doesNotMatch(filtered, /Sources:/);
  assert.match(filtered, /after/);
});

test("assembleByPriority keeps whole parts under budget", () => {
  const out = assembleByPriority(
    {
      "peer-card": "card",
      "session-summary": "summary that is too long for the remaining budget",
      representation: "repr",
    },
    20,
  );
  assert.equal(out, "card\n\nrepr");
});

test("queue dedupes one message id", () => {
  const dir = mkdtempSync(join(tmpdir(), "honcho-q-"));
  process.env.HONCHO_STATE_DIR = dir;
  const id = messageId(["a", "b"]);
  assert.equal(enqueue({ id, content: "one" }), true);
  assert.equal(enqueue({ id, content: "one" }), false);
  assert.equal(readQueue().length, 1);
  replaceQueue([]);
  assert.equal(readQueue().length, 0);
  delete process.env.HONCHO_STATE_DIR;
});

test("plugin hooks.json uses the script wrapper", () => {
  const raw = readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.hooks.sessionStart[0].command, "node ./scripts/honcho.mjs sessionStart");
  assert.equal(parsed.hooks.beforeSubmitPrompt[0].command.includes("beforeSubmitPrompt"), true);
  assert.equal(parsed.hooks.beforeSubmitPrompt[0].timeout, 12);
});

test("install merge keeps unrelated hooks", () => {
  const merged = mergeHooks({
    version: 1,
    hooks: { beforeShellExecution: [{ command: "echo hi" }] },
  });
  assert.equal(merged.hooks.beforeShellExecution.length, 1);
  assert.equal(merged.hooks.sessionStart.length, 1);
  assert.equal(merged.hooks.sessionStart[0].command, hookCommand("sessionStart"));
  assert.equal(merged.hooks.beforeSubmitPrompt[0].timeout, 12);
  assert.equal(hookCommand("sessionStart", "linux"), "./hooks/cursor-honcho.sh sessionStart");
  assert.equal(hookCommand("sessionStart", "win32"), "./hooks/cursor-honcho.cmd sessionStart");
  assert.equal(hookCommand("stop", "darwin"), "./hooks/cursor-honcho.sh stop");
  const again = mergeHooks(merged);
  assert.equal(again.hooks.sessionStart.length, 1);
});
