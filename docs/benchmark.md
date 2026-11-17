# Local Model Benchmarks

Measured 2026-11-17. These numbers drive the agent loop's design, so they are kept in the
repo rather than in local notes.

## Machine

| | |
|---|---|
| OS | macOS |
| CPU arch | **x86_64 (Intel)** |
| Accelerator | CPU inference (no usable GPU offload) |
| Ollama | 0.40.16 |

## Model

`qwen3.5:4b` — Q4_K_M, 4.2B parameters, 333M vision projector.

Capabilities reported by `ollama show`:

| Capability | Available |
|---|---|
| completion | yes |
| **tools** | **yes** |
| **thinking** | **yes** (default on) |
| vision | yes |
| max context | 262,144 |

The declared max context is far larger than is practical on this hardware. `num_ctx` must be
set explicitly per request; the practical ceiling is set by prefill time and memory, not by
the model.

## Throughput

| Measurement | Result |
|---|---|
| Model load (cold) | 14.2 s |
| **Generation** | **6.9 tok/s** |
| **Prompt prefill (cold)** | **31.1 tok/s** |
| Prompt prefill (warm prefix) | ~2,000 tok/s effective |

### The numbers that matter

| Situation | Wall clock |
|---|---|
| 3,623-token prompt, cold | **116.6 s** before the first token |
| 3,623-token prompt, same prefix again | **1.8 s** (3,619 of 3,623 tokens cached) |
| 300-token reply | ~43 s |
| 16k-token context, cold | ~8.5 min |

## Consequences for the architecture

### 1. Prompt caching is the core performance strategy

Ollama reuses the KV cache for an identical token prefix and reports it as
`prompt_eval_cached_count`. The measured speedup on a 3.6k prompt is **65×**.

That makes prefix stability a hard requirement, not an optimization:

- The system prompt must not change between turns.
- Tool definitions must be serialized in a fixed order, with no run-varying fields.
- No timestamps, file listings, or "current date" strings inside the cached prefix.
- Message history is **append-only**. Editing or reordering earlier messages invalidates
  everything after the first changed token.

### 2. Compaction is expensive and must be deliberate

Any compaction that rewrites history invalidates the entire cache, so the next turn pays a
full cold prefill — potentially minutes.

The design that fits:

- Keep an **immutable head**: system prompt + tool schemas + a summary of the distant past.
- Append the recent conversation after it.
- Compact rarely and in one pass, then hold the new head stable for as long as possible.
- Warn in the UI before an expensive rewrite. "Compacting — this will take about a minute"
  is honest and sets expectations.

This also means **tool-output truncation at insert time** matters more than summarizing
later: dropping a 4,000-token file dump before it ever enters the transcript costs nothing,
while removing it afterwards costs a cache invalidation.

### 3. Prefill time belongs in the UI

For local models the dominant wait is the prompt, not the reply. The context meter should
show **estimated prefill time**, not just a token count. That is a real differentiator: no
consumer coding app tells you that your next message will cost 90 seconds before it starts.

### 4. Tool calling is native, so the shim is a fallback

`qwen3.5:4b` emits well-formed `tool_calls` with object arguments:

```json
{
  "id": "call_jewd9zvy",
  "function": {
    "name": "Read",
    "arguments": { "path": "src/api/routes/health.ts" }
  }
}
```

Thinking arrives in a separate `message.thinking` field with `tool_calls` empty and
`content` empty when the model reasons before acting. The capability probe still matters for
other models, but for the reference model we start at rung 1 of the ladder.

### 5. Model choice

A 4B model at 6.9 tok/s is usable for short, well-scoped tasks and painful for multi-file
refactors. The practical recommendation for this hardware is to keep `num_ctx` at 8–16k and
prefer fewer, denser tool calls over exploratory round trips.

An Apple Silicon machine would change these numbers by roughly an order of magnitude. Re-run
this benchmark there before drawing any conclusions about the product's ceiling.
