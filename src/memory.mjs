import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Honcho } from "@honcho-ai/sdk";
import {
  FIRST_TURN_BUDGET_MS,
  DIALECTIC_BUDGET_MS,
  REFRESH_BUDGET_MS,
  loadConfig,
  stateDir,
} from "./config.mjs";
import { directives, renderMemory } from "./injection.mjs";
import { bearerToken } from "./jwt.mjs";
import { conversationKey, loadMemoryState, saveMemoryState } from "./memory-state.mjs";
import { enqueue, logLine, messageId, readQueue, replaceQueue, withLock } from "./queue.mjs";
import { cap, redact } from "./redact.mjs";
import { sessionName } from "./session-name.mjs";

const HOOK_FILE = fileURLToPath(import.meta.url).replace(/memory\.mjs$/, "hook.mjs");
const TRIVIAL_PROMPT = /^(y|n|yes|no|ok|okay|sure|thanks|thank you|thx|\.|\,)$/i;

function client(config) {
  return new Honcho({
    apiKey: bearerToken(config.apiKey, config.workspace),
    baseURL: config.baseUrl,
    workspaceId: config.workspace,
    timeout: 15000,
  });
}

function workspaceCwd(input) {
  return input.workspace_roots?.[0] || process.env.CURSOR_PROJECT_DIR || process.cwd();
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureSession(config, name) {
  const honcho = client(config);
  const session = await honcho.session(name);
  const user = await honcho.peer(config.peerName);
  const ai = await honcho.peer(config.aiPeer);
  const observe = { observeMe: true, observeOthers: true };
  await session.addPeers([
    [config.peerName, observe],
    [config.aiPeer, observe],
  ]);
  return { honcho, session, user, ai };
}

/**
 * One session.context() call — summary + representation + peer card.
 * Matches dsh/Hermes: searchQuery from the current prompt, no limitToSession.
 */
export async function fetchContext(config, name, searchQuery) {
  const { session, user, ai } = await ensureSession(config, name);
  const directional = config.observationMode === "directional";
  const result = await session.context({
    summary: true,
    tokens: config.contextTokens,
    peerTarget: user,
    ...(directional ? { peerPerspective: ai } : {}),
    ...(searchQuery
      ? {
          representationOptions: {
            searchQuery: searchQuery.slice(0, 300),
            searchTopK: config.searchTopK,
            searchMaxDistance: config.searchMaxDistance,
            maxConclusions: config.maxConclusions,
          },
        }
      : {}),
  });
  return {
    summary: result.summary ? { content: result.summary.content } : null,
    peerRepresentation: result.peerRepresentation ?? null,
    peerCard: result.peerCard ?? null,
  };
}

export async function runDialectic(config, name, userQuery) {
  const { session, user, ai } = await ensureSession(config, name);
  const directional = config.observationMode === "directional";
  const peer = directional ? ai : user;
  const query = config.dialectic.template.replace(/%\{user_query\}/g, userQuery || "");
  const answer = await peer.chat(query, {
    ...(directional ? { target: user } : {}),
    session,
    reasoningLevel: config.dialectic.reasoning,
  });
  return (answer ?? "").trim().slice(0, config.dialectic.maxChars);
}

function wantsPerTurnRefresh(config) {
  return config.perTurn.includes("userContext");
}

function wantsDialectic(config) {
  return config.perTurn.includes("dialectic");
}

function isStale(state, config) {
  if (!state.lastFetchAt) return true;
  return Date.now() - state.lastFetchAt > config.cadence.ttlSeconds * 1000;
}

function shouldRunDialectic(state, config) {
  if (!wantsDialectic(config)) return false;
  const every = config.cadence.dialectic;
  return state.turnCount % every === 1 % every;
}

function isTrivial(prompt) {
  return TRIVIAL_PROMPT.test(String(prompt || "").trim());
}

function injectText(config, state) {
  const body = renderMemory(config, state.context, state.dialecticText);
  return body ? `[Honcho]\n${body}` : "";
}

/**
 * sessionStart: materialize peers and optionally warm the cache.
 * Primary inject is beforeSubmitPrompt (Hermes/dsh; also survives Agents Window).
 */
export async function handleSessionStart(input) {
  const config = loadConfig();
  if (!config || config.enabled === false) return "";
  const cwd = workspaceCwd(input);
  const conv = conversationKey(input);
  const name = sessionName(config, cwd, conv);
  logLine(config.logging, `sessionStart ${name}`);

  await withTimeout(ensureSession(config, name), 12000);
  const state = loadMemoryState(conv, name);
  state.sessionName = name;
  saveMemoryState(state);

  // Warm cache in the background so turn 1 may already have a snapshot.
  spawnBackground({
    kind: "refresh",
    conversationId: conv,
    cwd,
    sessionName: name,
    prompt: "",
    awaitDialectic: false,
  });

  // Cheap bootstrap only — full memory arrives on beforeSubmitPrompt.
  if (config.sessionStart.includes("directives")) {
    return `[Honcho]\n${directives(config)}`;
  }
  return "";
}

/**
 * beforeSubmitPrompt: capture the user turn, then inject memory like Hermes/dsh.
 * Turn 1 awaits a short budget; later turns use cache and refresh in the background when stale.
 */
export async function handleBeforeSubmit(input) {
  const config = loadConfig();
  const prompt = String(input.prompt || "");
  captureTurn(input, "user", prompt);

  if (!config || config.enabled === false) {
    return { continue: true };
  }

  const cwd = workspaceCwd(input);
  const conv = conversationKey(input);
  const name = sessionName(config, cwd, conv);
  const state = loadMemoryState(conv, name);
  state.sessionName = name;
  state.turnCount += 1;
  const first = state.turnCount === 1;
  const trivial = isTrivial(prompt);
  const stale = isStale(state, config);
  const refresh = wantsPerTurnRefresh(config);

  try {
    if (first && !trivial) {
      // Only turn 1 blocks — same trade as dsh/Hermes (~5s).
      await withTimeout(
        (async () => {
          state.context = await fetchContext(config, name, prompt);
          state.lastFetchAt = Date.now();
          state.lastError = null;
          if (shouldRunDialectic(state, config)) {
            state.dialecticText = await runDialectic(config, name, prompt);
            state.dialecticStartedAt = Date.now();
          }
        })(),
        FIRST_TURN_BUDGET_MS,
      );
    } else if (!trivial && refresh && stale) {
      // Later turns never block; warm the next turn's cache like dsh.
      spawnBackground({
        kind: "refresh",
        conversationId: conv,
        cwd,
        sessionName: name,
        prompt,
        awaitDialectic: false,
      });
      state.refreshingUntil = Date.now() + REFRESH_BUDGET_MS;
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    logLine(config.logging, `inject turn ${state.turnCount} failed: ${state.lastError}`);
  }

  // Dialectic cadence is turn-based (Hermes/dsh), not TTL-based.
  // Skip if turn 1 already produced an answer; cool down avoids overlapping jobs.
  const dialecticCooldown =
    Date.now() - (state.dialecticStartedAt || 0) < 60_000;
  if (
    !trivial &&
    shouldRunDialectic(state, config) &&
    !(first && state.dialecticText) &&
    !dialecticCooldown
  ) {
    spawnBackground({
      kind: "dialectic",
      conversationId: conv,
      cwd,
      sessionName: name,
      prompt,
      awaitDialectic: true,
    });
    state.dialecticStartedAt = Date.now();
  }

  saveMemoryState(state);
  const additional = injectText(config, state);
  if (additional) {
    logLine(
      config.logging,
      `inject turn ${state.turnCount} ${additional.length} chars` +
        (first ? " (first)" : stale && refresh ? " (stale-cache)" : ""),
    );
  }

  return additional
    ? { continue: true, additional_context: additional }
    : { continue: true };
}

function spawnBackground(job) {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `job-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    writeFileSync(jobPath, JSON.stringify(job));
    const child = spawn(process.execPath, [HOOK_FILE, "bg", jobPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    try {
      unlinkSync(jobPath);
    } catch {
      // ignore
    }
  }
}

/** Detached worker: refresh context and/or dialectic into the memory state file. */
export async function runBackgroundJob(jobPath) {
  const config = loadConfig();
  if (!config || config.enabled === false) return;
  let job;
  try {
    job = JSON.parse(readFileSync(jobPath, "utf8"));
  } catch (error) {
    logLine(config.logging, `bg job read failed: ${error}`);
    return;
  } finally {
    try {
      if (jobPath && existsSync(jobPath)) unlinkSync(jobPath);
    } catch {
      // ignore
    }
  }

  const state = loadMemoryState(job.conversationId, job.sessionName);
  state.sessionName = job.sessionName || state.sessionName;

  try {
    if (job.kind === "refresh" || job.kind === "both") {
      const context = await withTimeout(
        fetchContext(config, state.sessionName, job.prompt || ""),
        REFRESH_BUDGET_MS,
      );
      state.context = context;
      state.lastFetchAt = Date.now();
      state.lastError = null;
      state.refreshingUntil = 0;
      logLine(config.logging, `bg refresh ok ${state.sessionName}`);
    }
    if (job.kind === "dialectic" || (job.kind === "refresh" && job.awaitDialectic)) {
      const answer = await withTimeout(
        runDialectic(config, state.sessionName, job.prompt || ""),
        DIALECTIC_BUDGET_MS,
      );
      if (answer) state.dialecticText = answer;
      state.dialecticStartedAt = Date.now();
      logLine(config.logging, `bg dialectic ok ${state.sessionName} ${answer?.length || 0} chars`);
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    state.refreshingUntil = 0;
    logLine(config.logging, `bg ${job.kind} failed: ${state.lastError}`);
  }

  saveMemoryState(state);
}

export function captureTurn(input, role, content) {
  const config = loadConfig();
  if (!config || config.enabled === false || config.saveMessages === false) return;
  const text = cap(redact(content), config.maxMessageChars).trim();
  if (!text) return;
  const cwd = workspaceCwd(input);
  const name = sessionName(config, cwd, conversationKey(input));
  const id = messageId([
    name,
    role,
    input.conversation_id || "",
    input.generation_id || "",
    text,
  ]);
  const added = enqueue({
    id,
    sessionName: name,
    workspace: config.workspace,
    peerId: role === "assistant" ? config.aiPeer : config.peerName,
    content: text,
    createdAt: new Date().toISOString(),
  });
  if (added) logLine(config.logging, `queued ${role} ${name} ${text.length} chars`);
  spawnFlush();
}

export function spawnFlush() {
  const child = spawn(process.execPath, [HOOK_FILE, "flush"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function flushPending() {
  const config = loadConfig();
  if (!config || config.enabled === false) return 0;
  let uploaded = 0;

  let snapshot = [];
  const held = withLock(() => {
    snapshot = readQueue();
    if (snapshot.length) replaceQueue([]);
  });
  if (!held || snapshot.length === 0) return 0;

  const failed = [];
  const groups = new Map();
  for (const item of snapshot) {
    const key = `${item.workspace}\0${item.sessionName}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  for (const items of groups.values()) {
    try {
      const { session, user, ai } = await ensureSession(config, items[0].sessionName);
      const peers = { [config.peerName]: user, [config.aiPeer]: ai };
      const messages = items.map((item) => {
        const peer = peers[item.peerId] ?? user;
        return peer.message(item.content, {
          createdAt: item.createdAt,
          metadata: { source: "cursor-honcho", session: item.sessionName },
        });
      });
      await session.addMessages(messages);
      uploaded += messages.length;
      logLine(config.logging, `uploaded ${messages.length} to ${items[0].sessionName}`);
    } catch (error) {
      failed.push(...items);
      logLine(config.logging, `upload failed ${items[0].sessionName}: ${error}`);
    }
  }

  if (failed.length) {
    withLock(() => {
      const current = readQueue();
      replaceQueue([...failed, ...current]);
    });
  }
  return uploaded;
}
