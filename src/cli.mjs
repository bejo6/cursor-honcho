import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { readQueue } from "./queue.mjs";
import { sessionName } from "./session-name.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "src", "hook.mjs");
const MARKER = "cursor-honcho";
const COPY_PATHS = [
  ".cursor-plugin",
  "rules",
  "skills",
  "commands",
  "hooks",
  "scripts",
  "src",
  "package.json",
  "package-lock.json",
  "README.md",
];

const EVENTS = [
  ["sessionStart", 20],
  ["beforeSubmitPrompt", 12],
  ["afterAgentResponse", 8],
  ["stop", 20],
  ["preCompact", 20],
  ["sessionEnd", 20],
];

function cursorHome() {
  return join(homedir(), ".cursor");
}

function hooksPath() {
  return join(cursorHome(), "hooks.json");
}

function systemNode() {
  if (process.platform === "win32" && process.env.ProgramFiles) {
    const candidate = join(process.env.ProgramFiles, "nodejs", "node.exe");
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

export function hookCommand(event, platform = process.platform) {
  const file = platform === "win32" ? "cursor-honcho.cmd" : "cursor-honcho.sh";
  return `./hooks/${file} ${event}`;
}

function commandFor(event) {
  return hookCommand(event);
}

function isOurs(entry) {
  return typeof entry?.command === "string" && entry.command.includes(MARKER);
}

export function mergeHooks(existing) {
  const hooks = { ...(existing?.hooks ?? {}) };
  for (const [event] of EVENTS) {
    hooks[event] = (hooks[event] ?? []).filter((entry) => !isOurs(entry));
  }
  for (const [event, timeout] of EVENTS) {
    hooks[event].push({ command: commandFor(event), timeout });
  }
  return { version: 1, ...existing, hooks };
}

function localPluginDir() {
  return join(cursorHome(), "plugins", "local", "cursor-honcho");
}

function stripUserHooks() {
  const path = hooksPath();
  if (!existsSync(path)) return;
  const existing = JSON.parse(readFileSync(path, "utf8"));
  const hooks = { ...(existing.hooks ?? {}) };
  for (const [event] of EVENTS) {
    hooks[event] = (hooks[event] ?? []).filter((entry) => !isOurs(entry));
    if (hooks[event].length === 0) delete hooks[event];
  }
  writeFileSync(path, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
}

function installPlugin() {
  const dest = localPluginDir();
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const rel of COPY_PATHS) {
    const from = join(ROOT, rel);
    if (!existsSync(from)) continue;
    cpSync(from, join(dest, rel), { recursive: true });
  }
  const npm = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: dest,
    shell: true,
    stdio: "inherit",
  });
  if (npm.status !== 0) process.exit(npm.status ?? 1);

  stripUserHooks();
  for (const name of ["cursor-honcho.cmd", "cursor-honcho.sh"]) {
    const wrapper = join(cursorHome(), "hooks", name);
    if (existsSync(wrapper)) rmSync(wrapper);
  }

  process.stdout.write(`Installed local plugin at ${dest}\n`);
  process.stdout.write("Reload Cursor (Developer: Reload Window), then open Customize and confirm cursor-honcho.\n");
  process.stdout.write("User-level hooks.json entries for this plugin were removed so turns are not captured twice.\n");
}

function installHooks() {
  const dir = join(cursorHome(), "hooks");
  mkdirSync(dir, { recursive: true });
  const node = systemNode();
  const wrapper = join(dir, process.platform === "win32" ? "cursor-honcho.cmd" : "cursor-honcho.sh");
  const body = process.platform === "win32"
    ? `@echo off\r\n"${node}" "${HOOK}" %*\r\n`
    : `#!/bin/sh\nexec "${node}" "${HOOK}" "$@"\n`;
  writeFileSync(wrapper, body);
  if (process.platform !== "win32") chmodSync(wrapper, 0o755);

  const path = hooksPath();
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, hooks: {} };
  writeFileSync(path, `${JSON.stringify(mergeHooks(existing), null, 2)}\n`);
  process.stdout.write(`Installed user hooks in ${path}\n`);
  process.stdout.write("Use this only when local plugins are disabled. Do not run it together with the plugin install.\n");
}

function uninstall() {
  stripUserHooks();
  for (const name of ["cursor-honcho.cmd", "cursor-honcho.sh"]) {
    const wrapper = join(cursorHome(), "hooks", name);
    if (existsSync(wrapper)) rmSync(wrapper);
  }
  rmSync(localPluginDir(), { recursive: true, force: true });
  process.stdout.write("Removed the local cursor-honcho plugin and its user hooks.\n");
}

function status() {
  const config = loadConfig();
  if (!config) {
    process.stdout.write("No API key. Set HONCHO_API_KEY or apiKey in ~/.honcho/config.json\n");
    process.exit(1);
  }
  const cwd = process.cwd();
  const name = sessionName(config, cwd, "status");
  process.stdout.write(
    [
      `peer: ${config.peerName}`,
      `aiPeer: ${config.aiPeer}`,
      `workspace: ${config.workspace}`,
      `baseUrl: ${config.baseUrl}`,
      `session: ${name}`,
      `strategy: ${config.sessionStrategy}`,
      `enabled: ${config.enabled}`,
      `saveMessages: ${config.saveMessages}`,
      `perTurn: ${config.perTurn.join(",")}`,
      `ttlSeconds: ${config.cadence.ttlSeconds}`,
      `dialecticEvery: ${config.cadence.dialectic}`,
      `queue: ${readQueue().length}`,
      `node: ${process.execPath}`,
    ].join("\n") + "\n",
  );
  const node = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (node.status !== 0) process.stdout.write("node failed to start\n");
}

const verb = process.argv[2];
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (verb === "install") installPlugin();
  else if (verb === "install-hooks") installHooks();
  else if (verb === "uninstall") uninstall();
  else if (verb === "status") status();
  else {
    process.stderr.write("Usage: node src/cli.mjs install|install-hooks|uninstall|status\n");
    process.exit(1);
  }
}
