import fs from "node:fs";
import path from "node:path";
import type { Usage } from "./models.js";

// Reader for Claude Code transcript JSONL (~/.claude/projects/<proj>/<session>.jsonl).
// Relevant shape, verified against Claude Code 2.1.x:
//   {type:"assistant", message:{id, model, content:[...], usage:{input_tokens,
//     output_tokens, cache_read_input_tokens, cache_creation_input_tokens}}}
// One API response is split into one entry per content block, each repeating the same
// usage, so usage must be de-duplicated by message.id. Subagent runs are written to
// <session>/subagents/agent-<id>.jsonl.

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export interface TranscriptTail {
  lastAssistantText?: string;
  lastAssistantModel?: string;
}

/** Read the last assistant text and model from the end of a transcript, cheaply. */
export function readTail(file: string | undefined, maxBytes = 256 * 1024): TranscriptTail {
  if (!file) return {};
  let buf: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      buf = b.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  const lines = buf.split("\n");
  const out: TranscriptTail = {};
  for (let i = lines.length - 1; i >= 0 && (!out.lastAssistantText || !out.lastAssistantModel); i--) {
    const e = parse(lines[i]!);
    if (!e || e.type !== "assistant" || e.isSidechain) continue;
    const model = e.message?.model;
    if (!out.lastAssistantModel && model && model !== "<synthetic>") out.lastAssistantModel = model;
    if (!out.lastAssistantText) {
      const text = textOf(e.message?.content);
      if (text) out.lastAssistantText = text;
    }
  }
  return out;
}

/**
 * Sum token usage per model for everything appended since `offsets`, across the main
 * transcript and its subagent transcripts. Returns new offsets to persist.
 */
export function usageSince(
  file: string,
  offsets: Record<string, number> = {},
): { byModel: Record<string, Usage>; offsets: Record<string, number> } {
  const files = [file, ...subagentFiles(file)];
  const byModel: Record<string, Usage> = {};
  const seen = new Set<string>();
  const nextOffsets: Record<string, number> = { ...offsets };
  for (const f of files) {
    let size: number;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    const start = offsets[f] ?? 0;
    if (size <= start) continue;
    const fd = fs.openSync(f, "r");
    let chunk: string;
    try {
      const b = Buffer.alloc(size - start);
      fs.readSync(fd, b, 0, b.length, start);
      chunk = b.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // Only consume complete lines; a partially written last line is read next time.
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) continue;
    nextOffsets[f] = start + Buffer.byteLength(chunk.slice(0, lastNl + 1));
    for (const line of chunk.slice(0, lastNl).split("\n")) {
      const e = parse(line);
      const u = e?.message?.usage;
      const model = e?.message?.model;
      if (!e || e.type !== "assistant" || !u || !model || model === "<synthetic>") continue;
      const id = e.message?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const acc = (byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      acc.input += u.input_tokens ?? 0;
      acc.output += u.output_tokens ?? 0;
      acc.cacheRead += u.cache_read_input_tokens ?? 0;
      acc.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
  }
  return { byModel, offsets: nextOffsets };
}

function subagentFiles(file: string): string[] {
  const dir = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** User prompts and the usage of the turn each one triggered, for `jev audit`. */
export interface TranscriptTurn {
  prompt: string;
  model?: string;
  usage: Usage;
  previousAssistant?: string;
}

export function readTurns(file: string): TranscriptTurn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const turns: TranscriptTurn[] = [];
  const seen = new Set<string>();
  let current: TranscriptTurn | undefined;
  let lastAssistantText: string | undefined;
  for (const line of raw.split("\n")) {
    const e = parse(line);
    if (!e || e.isSidechain) continue;
    if (e.type === "user") {
      const content = e.message?.content;
      const isToolResult =
        Array.isArray(content) && content.some((c) => (c as { type?: string })?.type === "tool_result");
      const text = textOf(content);
      if (isToolResult || !text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
      current = {
        prompt: text,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        previousAssistant: lastAssistantText,
      };
      turns.push(current);
    } else if (e.type === "assistant" && current) {
      const text = textOf(e.message?.content);
      if (text) lastAssistantText = text;
      const u = e.message?.usage;
      const id = e.message?.id;
      if (!u || (id && seen.has(id))) continue;
      if (id) seen.add(id);
      current.model ??= e.message?.model;
      current.usage.input += u.input_tokens ?? 0;
      current.usage.output += u.output_tokens ?? 0;
      current.usage.cacheRead += u.cache_read_input_tokens ?? 0;
      current.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
  }
  return turns;
}

function parse(line: string): TranscriptEntry | undefined {
  if (!line || line[0] !== "{") return undefined;
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((c) => (c as { type?: string })?.type === "text")
    .map((c) => (c as { text?: string }).text ?? "");
  const joined = parts.join("\n").trim();
  return joined || undefined;
}
