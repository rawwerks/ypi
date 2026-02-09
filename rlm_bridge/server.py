#!/usr/bin/env python3
"""
RLM Bridge Server

A simple Flask server that wraps the RLM library and exposes it
as an HTTP API for the Pi extension to call.

Phase 1 MVP: Returns final text response (no streaming, no tool calls).
"""

import os
import json
import logging
from typing import Optional
from dataclasses import dataclass, asdict

from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# RLM configuration defaults
DEFAULT_BACKEND = os.getenv("RLM_BACKEND", "openai")
DEFAULT_MODEL = os.getenv("RLM_MODEL", "gpt-4o-mini")
DEFAULT_MAX_RECURSION = int(os.getenv("RLM_MAX_RECURSION", "10"))


@dataclass
class RlmConfig:
    """Configuration for RLM instance."""
    backend: str = DEFAULT_BACKEND
    model_name: str = DEFAULT_MODEL
    max_recursion_depth: int = DEFAULT_MAX_RECURSION
    environment: str = "local"  # "local" | "docker"


@dataclass 
class CompletionRequest:
    """Incoming completion request from Pi extension."""
    messages: list[dict]
    model: Optional[str] = None
    rlm_config: Optional[dict] = None


@dataclass
class CompletionResponse:
    """Response to send back to Pi extension."""
    text: str
    usage: Optional[dict] = None
    metadata: Optional[dict] = None


def messages_to_context(messages: list[dict]) -> tuple[str, str]:
    """
    Convert Pi-style messages into RLM context + query.
    
    RLM's model is: context lives in environment, query is the current turn.
    We treat all messages except the last as "context" and the last as "query".
    """
    if not messages:
        return "", ""
    
    # Build context from all messages except the last
    context_parts = []
    for msg in messages[:-1]:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        context_parts.append(f"[{role.upper()}]: {content}")
    
    context = "\n\n".join(context_parts)
    
    # Last message is the query
    last_msg = messages[-1]
    query = last_msg.get("content", "")
    
    return context, query


def run_rlm_completion(context: str, query: str, config: RlmConfig) -> CompletionResponse:
    """
    Run RLM completion with the given context and query.
    
    Phase 1: Simple wrapper around RLM library.
    """
    try:
        from rlm import RLM
        
        # Initialize RLM with config
        rlm = RLM(
            backend=config.backend,
            backend_kwargs={
                "model_name": config.model_name,
            },
            max_recursion_depth=config.max_recursion_depth,
            # Note: environment setting for sandbox would go here
        )
        
        # Build the full prompt
        # RLM handles context offloading internally
        if context:
            full_prompt = f"""Previous conversation context:
{context}

Current request:
{query}"""
        else:
            full_prompt = query
        
        # Run completion
        result = rlm.completion(full_prompt)
        
        return CompletionResponse(
            text=result.response,
            usage={
                "promptTokens": getattr(result, "prompt_tokens", 0),
                "completionTokens": getattr(result, "completion_tokens", 0),
            },
            metadata={
                "recursionDepth": getattr(result, "recursion_depth", 0),
                "totalCalls": getattr(result, "total_calls", 1),
            }
        )
        
    except ImportError:
        logger.error("RLM library not installed. Run: pip install rlms")
        # Fallback: return a mock response for testing
        return CompletionResponse(
            text=f"[RLM MOCK] Would process query: {query[:100]}...",
            metadata={"mock": True}
        )
    except Exception as e:
        logger.exception("RLM completion failed")
        raise


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    try:
        import rlm
        rlm_available = True
        rlm_version = getattr(rlm, "__version__", "unknown")
    except ImportError:
        rlm_available = False
        rlm_version = None
    
    return jsonify({
        "status": "ok",
        "rlm_available": rlm_available,
        "rlm_version": rlm_version,
        "default_backend": DEFAULT_BACKEND,
        "default_model": DEFAULT_MODEL,
    })


@app.route("/completion", methods=["POST"])
def completion():
    """
    Main completion endpoint.
    
    Accepts Pi-style messages and returns RLM completion.
    """
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({"error": "No JSON body provided"}), 400
        
        messages = data.get("messages", [])
        if not messages:
            return jsonify({"error": "No messages provided"}), 400
        
        # Parse config
        rlm_config_data = data.get("rlmConfig", {})
        config = RlmConfig(
            backend=rlm_config_data.get("backend", DEFAULT_BACKEND),
            model_name=rlm_config_data.get("modelName", DEFAULT_MODEL),
            max_recursion_depth=rlm_config_data.get("maxRecursionDepth", DEFAULT_MAX_RECURSION),
            environment=rlm_config_data.get("environment", "local"),
        )
        
        logger.info(f"Completion request: {len(messages)} messages, backend={config.backend}")
        
        # Convert messages to RLM format
        context, query = messages_to_context(messages)
        
        # Run completion
        response = run_rlm_completion(context, query, config)
        
        return jsonify(asdict(response))
        
    except Exception as e:
        logger.exception("Completion endpoint error")
        return jsonify({"error": str(e)}), 500


@app.route("/", methods=["GET"])
def index():
    """Root endpoint with usage info."""
    return jsonify({
        "name": "RLM Bridge Server",
        "version": "0.1.0",
        "endpoints": {
            "GET /health": "Health check",
            "POST /completion": "Run RLM completion",
        },
        "phase": "1 - MVP (final text, no streaming, no tools)"
    })


if __name__ == "__main__":
    port = int(os.getenv("RLM_BRIDGE_PORT", "8765"))
    debug = os.getenv("RLM_BRIDGE_DEBUG", "false").lower() == "true"
    
    logger.info(f"Starting RLM Bridge Server on port {port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
