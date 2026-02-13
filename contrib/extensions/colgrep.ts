/**
 * ColGREP Extension for Pi
 *
 * Adds semantic code search via colgrep to all Pi/ypi sessions.
 * - On session start: kicks off `colgrep init -y` in the background to pre-warm the index
 * - On before_agent_start: injects colgrep usage instructions into the system prompt
 *
 * Requirements:
 *   - colgrep binary on PATH
 *
 * Install globally:
 *   Place at ~/.pi/agent/extensions/colgrep.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const COLGREP_INSTRUCTIONS = `
## Semantic Code Search (colgrep)

This environment has \`colgrep\` installed — a semantic code search CLI powered by ColBERT embeddings.

**Use \`colgrep\` as your PRIMARY search tool** instead of grep for finding code by meaning.

### Quick Reference

\`\`\`bash
# Semantic search (find code by intent)
colgrep "database connection pooling" -k 10
colgrep "error handling in API layer" --include="*.ts"
colgrep "authentication middleware" ./src

# Regex pre-filter + semantic ranking (hybrid)
colgrep -e "async fn" "error handling" --include="*.rs"
colgrep -e "TODO" "security concerns"

# Pattern-only search
colgrep -e "TODO|FIXME|HACK"

# Output options
colgrep -l "query"              # files only
colgrep -n 10 "query"           # more context lines
colgrep --json "query"          # JSON output for scripting
colgrep -c "query" -k 5         # full function content
\`\`\`

### When to Use What

| Task                            | Tool                                    |
|---------------------------------|-----------------------------------------|
| Find code by intent/description | \`colgrep "query" -k 10\`              |
| Explore/understand a system     | \`colgrep "query" -k 25\`              |
| Pattern + semantic ranking      | \`colgrep -e "pattern" "query"\`        |
| Search specific file types      | \`colgrep --include="*.ext" "query"\`   |
| Exact string/regex match only   | \`grep\` / built-in Grep tool           |
| Find files by name              | \`find\` / built-in Glob tool           |

### Key Rules

1. **Default to colgrep** for any code search task
2. **Increase \`-k\`** when exploring (20-30 results)
3. **Use \`-e\`** for hybrid text+semantic filtering
4. The index auto-updates on each search — no manual rebuild needed
`;

const LOG_FILE = path.join(os.tmpdir(), "colgrep-extension.log");

function log(msg: string) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

export default function colgrepExtension(pi: ExtensionAPI) {
  let colgrepAvailable = false;
  let colgrepPath = "";

  pi.on("session_start", async (_event, ctx) => {
    // Check if colgrep is on PATH
    try {
      colgrepPath = execSync("which colgrep", { stdio: "pipe" }).toString().trim();
      colgrepAvailable = true;
      log(`Found colgrep at: ${colgrepPath}`);
    } catch (e) {
      colgrepAvailable = false;
      log(`colgrep not found on PATH: ${e}`);
      return;
    }

    // Kick off background index build/update via shell to avoid spawn issues
    try {
      const logFile = path.join(os.tmpdir(), "colgrep-init.log");
      const child = spawn("sh", ["-c", `"${colgrepPath}" init -y > "${logFile}" 2>&1`], {
        cwd: ctx.cwd,
        stdio: "ignore",
        detached: true,
        env: { ...process.env, PATH: `${path.dirname(colgrepPath)}:${process.env.PATH}` },
      });
      child.unref();
      log(`Spawned colgrep init (pid ${child.pid}) in ${ctx.cwd}`);
      ctx.ui.notify("colgrep: indexing in background…", "info");
    } catch (e) {
      log(`Failed to spawn colgrep init: ${e}`);
      ctx.ui.notify("colgrep: failed to start background indexing", "warning");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!colgrepAvailable) return;

    return {
      systemPrompt: event.systemPrompt + COLGREP_INSTRUCTIONS,
    };
  });
}
