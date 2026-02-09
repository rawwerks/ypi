/**
 * Pi RLM Extension
 * 
 * Registers an "rlm" provider that routes completions through
 * a Python bridge running the RLM library.
 */

import type { ExtensionContext, Provider, StreamSimpleOptions } from "@mariozechner/pi-ai";

// Bridge configuration
const BRIDGE_URL = process.env.RLM_BRIDGE_URL || "http://localhost:8765";

interface RlmBridgeRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  rlmConfig?: {
    backend?: string;
    maxRecursionDepth?: number;
    environment?: "local" | "docker";
  };
}

interface RlmBridgeResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  metadata?: {
    recursionDepth: number;
    totalCalls: number;
  };
}

/**
 * Converts Pi messages to a format suitable for RLM bridge
 */
function messagesToBridgeFormat(messages: StreamSimpleOptions["messages"]): RlmBridgeRequest["messages"] {
  return messages.map(msg => {
    // Handle different message content formats
    let content: string;
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text from content blocks
      content = msg.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map(block => block.text)
        .join("\n");
    } else {
      content = String(msg.content);
    }
    
    return {
      role: msg.role,
      content
    };
  });
}

/**
 * RLM Provider implementation
 */
const rlmProvider: Provider = {
  name: "rlm",
  displayName: "RLM (Recursive LM)",
  
  models: [
    {
      id: "rlm-default",
      name: "RLM Default",
      contextLength: 128000, // Effectively unlimited via RLM
      supportsTools: false, // Phase 1: no tools yet
      supportsStreaming: false, // Phase 1: no streaming yet
    }
  ],

  async *streamSimple(options: StreamSimpleOptions) {
    const { messages, model, signal } = options;
    
    // Emit start event
    yield { type: "start" as const };
    
    try {
      // Convert messages to bridge format
      const bridgeMessages = messagesToBridgeFormat(messages);
      
      // Call the Python bridge
      const response = await fetch(`${BRIDGE_URL}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: bridgeMessages,
          model: model || "rlm-default",
          rlmConfig: {
            backend: "openai",
            maxRecursionDepth: 10,
            environment: "local"
          }
        } satisfies RlmBridgeRequest),
        signal
      });

      if (!response.ok) {
        const error = await response.text();
        yield { 
          type: "error" as const, 
          error: new Error(`RLM bridge error: ${response.status} - ${error}`)
        };
        return;
      }

      const result: RlmBridgeResponse = await response.json();
      
      // Phase 1: Emit text as a single block (no streaming)
      yield { type: "text_start" as const, contentIndex: 0 };
      yield { type: "text_delta" as const, delta: result.text, contentIndex: 0 };
      yield { type: "text_end" as const, contentIndex: 0 };
      
      // Emit done event
      yield { 
        type: "done" as const, 
        reason: "stop",
        usage: result.usage
      };
      
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        yield { type: "error" as const, error: new Error("Request aborted"), reason: "aborted" };
      } else {
        yield { 
          type: "error" as const, 
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
  }
};

/**
 * Extension entry point
 */
export function activate(context: ExtensionContext) {
  // Register the RLM provider
  context.registerProvider(rlmProvider);
  
  // Register /rlm command for toggling
  context.registerCommand({
    name: "rlm",
    description: "Toggle or configure RLM mode",
    execute: async (args) => {
      const subcommand = args[0];
      
      if (subcommand === "status") {
        const bridgeHealth = await checkBridgeHealth();
        return `RLM Bridge: ${bridgeHealth ? "✓ Connected" : "✗ Not available"}\nBridge URL: ${BRIDGE_URL}`;
      }
      
      if (subcommand === "on") {
        // Switch to RLM model
        await context.setModel("rlm-default");
        return "Switched to RLM provider. All completions now go through RLM.";
      }
      
      if (subcommand === "off") {
        // Could switch back to default, but we don't know what it was
        return "Use /model to switch to a different provider.";
      }
      
      return "Usage: /rlm [status|on|off]";
    }
  });
  
  console.log("Pi RLM Extension activated");
}

async function checkBridgeHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${BRIDGE_URL}/health`, { 
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function deactivate() {
  console.log("Pi RLM Extension deactivated");
}
