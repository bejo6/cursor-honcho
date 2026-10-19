import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export function sanitize(value) {
  return String(value || "session")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}

export function gitBranch(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Session id for one Cursor workspace. Pinned names in config.sessions win.
 * per-directory is stable across restarts. git-branch adds the branch.
 * chat-instance uses the conversation id.
 */
export function sessionName(config, cwd, conversationId) {
  const pinned = config.sessions?.[cwd];
  if (pinned) return sanitize(pinned);

  const dir = sanitize(basename(cwd || "workspace"));
  const peer = config.sessionPeerPrefix ? sanitize(config.peerName) : "";
  const prefix = peer ? `${peer}-` : "";

  if (config.sessionStrategy === "chat-instance") {
    return sanitize(`${prefix}chat-${conversationId || "session"}`);
  }
  if (config.sessionStrategy === "git-branch") {
    const branch = gitBranch(cwd);
    return sanitize(branch ? `${prefix}${dir}-${branch}` : `${prefix}${dir}`);
  }
  return sanitize(`${prefix}${dir}`);
}
