/**
 * auto-title — Periodically summarizes the session into a short status label.
 *
 * When you have 8 ypi windows open and can't remember which is which,
 * this extension fixes that. It watches for activity and periodically
 * forks the conversation to a cheap `pi -p` call that returns a 1-line
 * summary. That summary is shown in the status bar via setStatus().
 *
 * Triggers re-summarization when EITHER:
 *   - 5 user messages since last summary, OR
 *   - 5 minutes elapsed since last summary (only if new activity)
 *
 * The summary call is fire-and-forget — runs in the background,
 * updates the status when it completes. Never blocks the main session.
 * Stale sessions (no new turns) don't re-summarize on the timer.
 *
 * Usage:
 *   ln -s "$(pwd)/contrib/extensions/auto-title.ts" ~/.pi/agent/extensions/auto-title.ts
 *
 * Environment:
 *   AUTO_TITLE_DISABLE=1          Disable the extension
 *   AUTO_TITLE_INTERVAL=300       Seconds between time-based re-summarizations (default: 300)
 *   AUTO_TITLE_TURNS=5            Turns between turn-based re-summarizations (default: 5)
 *   AUTO_TITLE_INITIAL_TURNS=2    Turns before first summarization (default: 2)
 *   AUTO_TITLE_MODEL              Model for summary calls (default: claude-sonnet-4-20250514)
 *   AUTO_TITLE_PROVIDER           Provider for summary calls (default: pi's default)
 *   AUTO_TITLE_DEBUG              Path to debug log file (default: none)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "child_process";

interface TitleState {
  turnsSinceUpdate: number;
  totalTurns: number;
  lastUpdateTime: number;
  currentTitle: string | undefined;
  pendingUpdate: boolean;
  sessionFile: string | undefined;
  timer: ReturnType<typeof setInterval> | undefined;
}

const STATUS_KEY = "auto-title";
const SUMMARY_PROMPT = 'Write a 5-10 word title describing what this session is working on. Reply with ONLY the title. No quotes, no punctuation, no explanation.';

export default function autoTitle(pi: ExtensionAPI) {
  if (process.env.AUTO_TITLE_DISABLE === "1") return;

  const intervalSecs = parseInt(process.env.AUTO_TITLE_INTERVAL || "300", 10);
  const turnsThreshold = parseInt(process.env.AUTO_TITLE_TURNS || "5", 10);
  const initialTurns = parseInt(process.env.AUTO_TITLE_INITIAL_TURNS || "2", 10);
  const model = process.env.AUTO_TITLE_MODEL || "claude-sonnet-4-20250514";
  const provider = process.env.AUTO_TITLE_PROVIDER;
  const debugFile = process.env.AUTO_TITLE_DEBUG;

  const state: TitleState = {
    turnsSinceUpdate: 0,
    totalTurns: 0,
    lastUpdateTime: 0,
    currentTitle: undefined,
    pendingUpdate: false,
    sessionFile: undefined,
    timer: undefined,
  };

  function debug(msg: string) {
    if (!debugFile) return;
    const fs = require("fs");
    fs.appendFileSync(debugFile, `[${new Date().toISOString()}] [auto-title] ${msg}\n`);
  }

  function setTitle(title: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) {
    state.currentTitle = title;
    ctx.ui.setStatus(STATUS_KEY, title);
    debug(`status set: '${title}'`);
  }

  function requestSummary(ctx: any) {
    if (!state.sessionFile || state.pendingUpdate) return;

    state.pendingUpdate = true;

    const args = ["-p", "--no-extensions", "--no-session", "--session", state.sessionFile];
    if (model) args.push("--model", model);
    if (provider) args.push("--provider", provider);
    args.push(SUMMARY_PROMPT);

    debug(`spawning summary: pi ${args.join(" ")}`);

    const child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Close stdin immediately — pi -p reads args, not stdin
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });

    // Kill if it takes too long
    const killTimer = setTimeout(() => { child.kill(); }, 30000);
    if (killTimer.unref) killTimer.unref();

    child.on("close", (code: number | null) => {
      clearTimeout(killTimer);
      state.pendingUpdate = false;
      debug(`pi exited code=${code} stdout='${stdout.trim()}'`);

      if (code !== 0 || !stdout.trim()) return;
      // Clean up the response — take first line, strip quotes/periods
      let title = stdout.trim().split("\n")[0]
        .replace(/^["']|["']$/g, "")
        .replace(/\.+$/, "")
        .trim()
        .toLowerCase();
      // Sanity check — should be short
      if (title.length > 60) title = title.slice(0, 57) + "...";
      if (title.length < 3) return;

      state.lastUpdateTime = Date.now();
      state.turnsSinceUpdate = 0;
      setTitle(title, ctx);
    });
    // Don't keep the process alive waiting for this
    child.unref();
  }

  function startTimer(ctx: any) {
    stopTimer();
    state.timer = setInterval(() => {
      // Only re-summarize on timer if there's been new activity
      if (state.turnsSinceUpdate > 0 && !state.pendingUpdate) {
        requestSummary(ctx);
      }
    }, intervalSecs * 1000);
    // Don't let the timer keep the process alive
    if (state.timer && typeof state.timer === "object" && "unref" in state.timer) {
      (state.timer as any).unref();
    }
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  }

  function resetState(ctx: any) {
    state.turnsSinceUpdate = 0;
    state.totalTurns = 0;
    state.lastUpdateTime = Date.now();
    state.currentTitle = undefined;
    state.pendingUpdate = false;
    state.sessionFile = ctx.sessionManager.getSessionFile();
    ctx.ui.setStatus(STATUS_KEY, undefined); // clear until first summary
    startTimer(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    resetState(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    resetState(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopTimer();
  });

  pi.on("turn_end", async (_event, ctx) => {
    state.totalTurns++;
    state.turnsSinceUpdate++;

    // Update session file reference (may change after compaction/fork)
    state.sessionFile = ctx.sessionManager.getSessionFile();

    // First title: trigger after initialTurns
    if (!state.currentTitle && state.totalTurns >= initialTurns) {
      requestSummary(ctx);
      return;
    }

    // Subsequent: trigger after turnsThreshold turns
    if (state.currentTitle && state.turnsSinceUpdate >= turnsThreshold) {
      requestSummary(ctx);
    }
  });
}
