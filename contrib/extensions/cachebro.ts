/**
 * cachebro — File cache with diff tracking for AI coding agents.
 *
 * Intercepts Pi's built-in Read tool results. On first read, caches the
 * file content. On subsequent reads, returns "[unchanged]" or a compact
 * unified diff — saving thousands of tokens per session.
 *
 * Inspired by https://github.com/nichochar/cachebro (MCP server).
 * This is a pure Pi extension — no MCP, no database, no dependencies
 * beyond Node builtins. Works transparently with hashline and any other
 * extension that modifies read output.
 *
 * Design (Option B): reads files from disk independently rather than
 * inspecting event.content, so it's agnostic to other extensions'
 * output formatting.
 *
 * Usage:
 *   ln -s "$(pwd)/contrib/extensions/cachebro.ts" ~/.pi/agent/extensions/cachebro.ts
 *
 * Environment:
 *   CACHEBRO_DISABLE=1    Disable the extension
 *   CACHEBRO_DIFF_CMD     Custom diff command (default: diff -u)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TextContent } from "@mariozechner/pi-ai";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { tmpdir } from "os";

interface CacheEntry {
  /** SHA-256 of raw file content */
  hash: string;
  /** Raw file content (no hashline prefixes, no formatting) */
  content: string;
  /** Line count */
  lines: number;
}

/**
 * Estimate token count from character count.
 * ceil(chars * 0.75) — rough but directionally correct for code.
 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars * 0.75);
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute unified diff between two strings using the system diff command.
 * Returns empty string if files are identical.
 */
function computeDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  diffCmd?: string
): string {
  const tmp = tmpdir();
  const oldFile = join(tmp, `cachebro-old-${process.pid}.txt`);
  const newFile = join(tmp, `cachebro-new-${process.pid}.txt`);

  try {
    writeFileSync(oldFile, oldContent);
    writeFileSync(newFile, newContent);

    const cmd = diffCmd || "diff -u";
    const result = execSync(
      `${cmd} "${oldFile}" "${newFile}" | head -500`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result;
  } catch (err: any) {
    // diff exits 1 when files differ — that's normal
    if (err.stdout) {
      // Replace temp file paths with the actual file path
      const output = (err.stdout as string)
        .replace(/^--- .*$/m, `--- a/${filePath}`)
        .replace(/^\+\+\+ .*$/m, `+++ b/${filePath}`);
      return output;
    }
    return "";
  } finally {
    try { unlinkSync(oldFile); } catch {}
    try { unlinkSync(newFile); } catch {}
  }
}

/**
 * Check whether a range [offset, offset+limit) overlaps with changed lines.
 * Returns true if any changed line falls within the range.
 */
function rangeOverlapsChanges(
  oldContent: string,
  newContent: string,
  offset: number,
  limit: number
): boolean {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const start = offset - 1; // 1-indexed to 0-indexed
  const end = start + limit;

  // Quick check: if total line count changed and range extends to end, overlap
  if (oldLines.length !== newLines.length && end >= Math.min(oldLines.length, newLines.length)) {
    return true;
  }

  // Check each line in range
  for (let i = start; i < end && i < Math.max(oldLines.length, newLines.length); i++) {
    if (oldLines[i] !== newLines[i]) return true;
  }
  return false;
}

export default function cachebro(pi: ExtensionAPI) {
  if (process.env.CACHEBRO_DISABLE === "1") return;

  const cache = new Map<string, CacheEntry>();
  let tokensSaved = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const diffCmd = process.env.CACHEBRO_DIFF_CMD;

  function updateStatus(ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) {
    const files = cache.size;
    const saved = tokensSaved > 1000
      ? `~${(tokensSaved / 1000).toFixed(1)}k`
      : `~${tokensSaved}`;
    ctx.ui.setStatus(
      "cachebro",
      `📦 ${files} cached, ${saved} tokens saved`
    );
  }

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    // ── Invalidate on write/edit ──
    if (event.toolName === "write" || event.toolName === "edit") {
      const p = (event.input as Record<string, unknown>).path;
      if (typeof p === "string") {
        cache.delete(resolve(ctx.cwd, p));
      }
      return;
    }

    // ── Cache logic on read ──
    if (event.toolName !== "read") return;

    const input = event.input as { path: string; offset?: number; limit?: number };
    const abs = resolve(ctx.cwd, input.path);

    // Read from disk independently — don't inspect event.content
    let raw: string;
    try {
      raw = readFileSync(abs, "utf-8");
    } catch {
      // File unreadable (deleted, binary, permissions) — pass through
      return;
    }

    const hash = sha256(raw);
    const totalLines = raw.split("\n").length;
    const cached = cache.get(abs);

    if (!cached) {
      // First read — cache it, pass through whatever the read tool returned
      cache.set(abs, { hash, content: raw, lines: totalLines });
      cacheMisses++;
      updateStatus(ctx);
      return;
    }

    if (cached.hash === hash) {
      // ── UNCHANGED ──
      cacheHits++;
      const fullTokens = estimateTokens(raw.length);

      // Handle partial reads
      if (input.offset) {
        const limit = input.limit || totalLines;
        tokensSaved += estimateTokens(
          raw.split("\n").slice(input.offset - 1, input.offset - 1 + limit).join("\n").length
        );
        updateStatus(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `[cachebro: unchanged in lines ${input.offset}-${input.offset + limit - 1} of ${totalLines}, ~${fullTokens} tokens saved]`,
            },
          ] as TextContent[],
        };
      }

      tokensSaved += fullTokens;
      updateStatus(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `[cachebro: unchanged, ${totalLines} lines, ~${fullTokens} tokens saved]`,
          },
        ] as TextContent[],
      };
    }

    // ── CHANGED — return diff ──
    cacheMisses++;

    // For partial reads, check if the requested range was affected
    if (input.offset) {
      const limit = input.limit || totalLines;
      if (!rangeOverlapsChanges(cached.content, raw, input.offset, limit)) {
        const rangeTokens = estimateTokens(
          raw.split("\n").slice(input.offset - 1, input.offset - 1 + limit).join("\n").length
        );
        tokensSaved += rangeTokens;
        cache.set(abs, { hash, content: raw, lines: totalLines });
        updateStatus(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `[cachebro: unchanged in lines ${input.offset}-${input.offset + limit - 1}, ${totalLines} lines total (other lines changed)]`,
            },
          ] as TextContent[],
        };
      }
    }

    const diff = computeDiff(cached.content, raw, input.path, diffCmd);
    const diffTokens = estimateTokens(diff.length);
    const fullTokens = estimateTokens(raw.length);
    const saved = Math.max(0, fullTokens - diffTokens);
    tokensSaved += saved;

    // Update cache with new content
    cache.set(abs, { hash, content: raw, lines: totalLines });
    updateStatus(ctx);

    // Only return diff if it's actually shorter than the full file
    if (diff && diffTokens < fullTokens * 0.8) {
      return {
        content: [
          {
            type: "text" as const,
            text: `[cachebro: ${totalLines} lines, showing diff (~${saved} tokens saved)]\n${diff}`,
          },
        ] as TextContent[],
      };
    }

    // Diff is nearly as big as the file — pass through the original result
    return;
  });

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    cache.clear();
    tokensSaved = 0;
    cacheHits = 0;
    cacheMisses = 0;
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    cache.clear();
    tokensSaved = 0;
    cacheHits = 0;
    cacheMisses = 0;
    updateStatus(ctx);
  });
}
