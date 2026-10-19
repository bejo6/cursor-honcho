import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";

function paths() {
  const dir = stateDir();
  return {
    dir,
    queue: join(dir, "queue.jsonl"),
    seen: join(dir, "seen.json"),
    lock: join(dir, "queue.lock"),
    log: join(dir, "hook.log"),
  };
}

function ensure() {
  mkdirSync(paths().dir, { recursive: true });
}

export function messageId(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function readSeen() {
  const { seen } = paths();
  if (!existsSync(seen)) return [];
  try {
    const parsed = JSON.parse(readFileSync(seen, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSeen(ids) {
  ensure();
  writeFileSync(paths().seen, JSON.stringify(ids.slice(-300)));
}

export function enqueue(item) {
  ensure();
  const seen = readSeen();
  if (seen.includes(item.id)) return false;
  const pending = readQueue();
  if (pending.some((row) => row.id === item.id)) return false;
  appendFileSync(paths().queue, `${JSON.stringify(item)}\n`);
  writeSeen([...seen, item.id]);
  return true;
}

export function readQueue() {
  const { queue } = paths();
  if (!existsSync(queue)) return [];
  return readFileSync(queue, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function replaceQueue(items) {
  ensure();
  const { queue } = paths();
  const next = `${queue}.next`;
  writeFileSync(next, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
  renameSync(next, queue);
}

export function withLock(fn) {
  ensure();
  const { lock } = paths();
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    return false;
  }
  try {
    fn();
    return true;
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // another flush owns the next attempt
    }
  }
}

export function logLine(enabled, message) {
  if (!enabled) return;
  try {
    ensure();
    appendFileSync(paths().log, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must not break a hook
  }
}
