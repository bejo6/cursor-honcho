const PATTERNS = [
  /hch-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
  /sk-[A-Za-z0-9]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text, extra = []) {
  let out = String(text ?? "");
  for (const pattern of [...PATTERNS, ...extra]) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function cap(text, max) {
  const value = String(text ?? "");
  if (!max || value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated]`;
}
