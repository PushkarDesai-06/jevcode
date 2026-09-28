// Strip secrets before any text leaves the machine for classification.
// Conservative: it's fine to redact a false positive, since Jev only needs the shape of the ask.
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, "[REDACTED_URL_CREDENTIALS]@"],
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|pwd|auth)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
    "$1[REDACTED]",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Keep the head and tail of long text: the ask is usually at one end, pasted logs in the middle. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 20);
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars]…\n${text.slice(text.length - tail)}`;
}
