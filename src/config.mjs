import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SESSION_START = ["directives", "summary", "peerCard"];
export const DEFAULT_PER_TURN = ["userContext", "dialectic"];
export const DEFAULT_DIALECTIC = {
  template:
    "In two or three sentences, what should I know about this user to work with them well? " +
    "Durable preferences, current projects, working style. Third person, factual, no questions.",
  reasoning: "low",
  maxChars: 600,
};
/** First Cursor turn may wait this long for memory before proceeding without it. */
export const FIRST_TURN_BUDGET_MS = 5_000;
export const REFRESH_BUDGET_MS = 8_000;
export const DIALECTIC_BUDGET_MS = 12_000;

/** Shared Honcho config: ~/.honcho/config.json (override with HONCHO_CONFIG_PATH). */
export function configPath() {
  return process.env.HONCHO_CONFIG_PATH || join(homedir(), ".honcho", "config.json");
}

export function stateDir() {
  return process.env.HONCHO_STATE_DIR || join(homedir(), ".honcho", "cursor");
}

function fail(message) {
  console.error(`[cursor-honcho] ${message}`);
  return null;
}

function asStringArray(value, fallback) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback;
}

/**
 * Cursor settings come only from hosts.cursor in ~/.honcho/config.json.
 * Root fields supply the shared key, peer name, and API URL.
 * A missing cursor block does not fall back to another host or the root workspace.
 */
export function loadConfig(env = process.env) {
  const path = env.HONCHO_CONFIG_PATH || configPath();
  if (!existsSync(path)) return fail(`config file is required: ${path}`);

  let file;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`cannot read ${path}: ${error}`);
  }

  const host = file.hosts?.cursor;
  if (!host || typeof host !== "object") {
    return fail(`hosts.cursor is required in ${path}`);
  }
  if (!host.workspace || !host.aiPeer) {
    return fail(`hosts.cursor.workspace and hosts.cursor.aiPeer are required in ${path}`);
  }

  const apiKey = String(host.apiKey || file.apiKey || file.auth?.apiKey || "").trim();
  if (!apiKey) return fail(`apiKey is required in ${path}`);

  const peerName = String(file.peerName || "").trim();
  if (!peerName) return fail(`peerName is required in ${path}`);

  const baseUrl = String(host.baseUrl || file.baseUrl || file.endpoint?.baseUrl || "https://api.honcho.dev")
    .trim()
    .replace(/\/$/, "");
  const injection = host.injection ?? {};
  const capture = host.capture ?? {};
  const cadence = injection.cadence ?? {};
  const dialectic = injection.dialectic ?? {};

  return {
    apiKey,
    peerName,
    workspace: String(host.workspace),
    aiPeer: String(host.aiPeer),
    baseUrl,
    enabled: host.enabled !== false && file.enabled !== false,
    saveMessages: capture.saveMessages !== false && host.saveMessages !== false,
    logging: host.logging !== false && file.logging !== false,
    observationMode: host.observationMode || "directional",
    sessionStrategy: host.sessionStrategy || "per-directory",
    sessionPeerPrefix: host.sessionPeerPrefix !== false,
    sessions: host.sessions ?? {},
    sessionStart: asStringArray(injection.sessionStart, DEFAULT_SESSION_START),
    perTurn: asStringArray(injection.perTurn, DEFAULT_PER_TURN),
    contextTokens: Number(injection.contextTokens) || 1500,
    searchTopK: Number(injection.searchTopK) || 10,
    searchMaxDistance: Number(injection.searchMaxDistance) || 0.6,
    maxConclusions: Number(injection.maxConclusions) || 15,
    maxRenderedConclusions: Number(injection.maxRenderedConclusions) || 4,
    cadence: {
      dialectic: Math.max(1, Number(cadence.dialectic) || 5),
      ttlSeconds: Math.max(1, Number(cadence.ttlSeconds) || 300),
    },
    dialectic: {
      template: String(dialectic.template || DEFAULT_DIALECTIC.template),
      reasoning: String(dialectic.reasoning || DEFAULT_DIALECTIC.reasoning),
      maxChars: Number(dialectic.maxChars) || DEFAULT_DIALECTIC.maxChars,
    },
    maxMessageChars: Number(host.maxMessageChars || 12000) || 12000,
  };
}
