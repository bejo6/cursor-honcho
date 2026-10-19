import { createHmac } from "node:crypto";

function b64url(text) {
  return Buffer.from(text).toString("base64url");
}

/** HS256 workspace token. The self-hosted API rejects the raw config value and accepts this signature. */
export function signWorkspaceJwt(secret, workspace) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ w: workspace }));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function bearerToken(apiKey, workspace) {
  const key = String(apiKey || "").trim();
  if (key.split(".").length === 3) return key;
  return signWorkspaceJwt(key, workspace);
}
