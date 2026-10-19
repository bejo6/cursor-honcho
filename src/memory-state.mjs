import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";

function memoryDir() {
  return join(stateDir(), "memory");
}

function statePath(conversationId) {
  const key = createHash("sha256")
    .update(String(conversationId || "unknown"))
    .digest("hex")
    .slice(0, 24);
  return join(memoryDir(), `${key}.json`);
}

function emptyState(conversationId, sessionName) {
  return {
    conversationId: conversationId || "",
    sessionName: sessionName || "",
    turnCount: 0,
    lastFetchAt: 0,
    lastError: null,
    context: null,
    dialecticText: null,
    dialecticStartedAt: 0,
    refreshingUntil: 0,
  };
}

export function loadMemoryState(conversationId, sessionName) {
  const path = statePath(conversationId);
  if (!existsSync(path)) return emptyState(conversationId, sessionName);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...emptyState(conversationId, sessionName),
      ...parsed,
      conversationId: conversationId || parsed.conversationId || "",
      sessionName: sessionName || parsed.sessionName || "",
    };
  } catch {
    return emptyState(conversationId, sessionName);
  }
}

export function saveMemoryState(state) {
  mkdirSync(memoryDir(), { recursive: true });
  const path = statePath(state.conversationId);
  const next = `${path}.next`;
  writeFileSync(next, JSON.stringify(state, null, 2));
  renameSync(next, path);
}

export function conversationKey(input) {
  return input.conversation_id || input.session_id || "";
}
