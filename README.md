# pi-rlm-extension

A Pi (badlogic/pi-mono) extension that swaps the LLM provider with an RLM-backed provider. Instead of `llm.completion(...)`, every agent turn goes through `rlm.completion(...)`.

## Architecture

```
┌─────────────────┐    HTTP/SSE    ┌──────────────────┐
│  Pi Extension   │◄──────────────►│  Python Bridge   │
│  (TypeScript)   │                │  (RLM library)   │
└─────────────────┘                └──────────────────┘
        │                                   │
        ▼                                   ▼
  Pi Agent Loop                      rlm.completion()
  (tools, streaming)                 (recursive context)
```

## Phase 1 MVP (Current)

Proves the provider swap works:
- Pi extension registers an `rlm` provider
- Python bridge wraps the RLM library
- Returns final text (no streaming, no tool calls yet)

## Setup

### Python Bridge

```bash
cd rlm_bridge
pip install -r requirements.txt
python server.py
```

### Pi Extension

```bash
# From pi-mono or your pi project
pi ext install ./path/to/pi-rlm-extension
```

## Usage

```bash
# Start the bridge
cd rlm_bridge && python server.py

# In Pi, switch to RLM provider
/model rlm-default
```

## Roadmap

- [x] Phase 1: MVP with final text response
- [ ] Phase 2: Tool calling support (OpenAI-compatible)
- [ ] Phase 3: Real streaming (text_delta events)
- [ ] Phase 4: Full RLM integration for coding workloads

## References

- [Pi Mono](https://github.com/badlogic/pi-mono)
- [RLM (rlms)](https://github.com/SuperAGI/recursive-lm) - pip install rlms
