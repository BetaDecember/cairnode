# recode

A local-first agentic coding app for macOS. Runs real coding tasks against a model on
your own machine, with a transcript you can read: streaming text, native reasoning,
tool cards, diffs, and permission prompts.

Built because the good agentic desktop apps assume a cloud model, and the good local
models assume a terminal.

> **Status:** early but usable. The agent loop, seven tools, permissions, sessions,
> context compaction, both provider adapters, and crash recovery are in place.
> Keyboard shortcuts and packaging are next.

## Requirements

- macOS
- Node 24+
- [pnpm](https://pnpm.io) 11+
- [Ollama](https://ollama.com) running locally with a tool-capable model, or an
  OpenAI-compatible endpoint such as LM Studio, llama.cpp, vLLM, or OpenRouter

## Run it

```sh
pnpm install

# pnpm 11 blocks dependency postinstall scripts by default; Electron needs its binary.
# If `pnpm dev` reports "Electron uninstall", run:
node node_modules/electron/install.js

pnpm dev
```

## Models and providers

The model picker groups models by provider.

- **Ollama** — the native API at `http://127.0.0.1:11434` by default. Models are
  discovered and probed for tool support.
- **OpenAI-compatible** — enable it in Settings (gear, top right), set the base URL
  **including** `/v1`, and list the model ids to offer. An API key is optional; when set,
  it is encrypted with the OS keychain and never reaches the renderer.

Each provider has its own context window. For Ollama that number is sent as `num_ctx` on
every run. Chat Completions has no portable context setting, so for OpenAI-compatible
endpoints the value is the budget the context meter and compaction use — set it to match
the server's actual window.

## Sessions and crashes

Sessions are append-only JSONL under `~/Library/Application Support/recode/sessions`. If
the app stops mid-turn, the session still loads: a tool call whose result never arrived is
dropped so the conversation stays valid, and the composer shows that the last turn did not
finish. Nothing runs automatically. The next message continues from the stored history.

## Keyboard

| Shortcut | Action |
|---|---|
| `Enter` or `⌘⏎` | Send |
| `Shift+Enter` | New line |
| `Esc` | Stop the current run |
| `⌘N` | New session |
| `⌘K` | Model picker |

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Electron + Vite with HMR |
| `pnpm build` | Production build into `out/` |
| `pnpm typecheck` | Type-check main, preload, and renderer |
| `pnpm test` | Core tests, plain `node --test`, no Electron |

## Layout

```
src/
├─ main/       window, IPC handlers, filesystem scoping, child processes
├─ preload/    typed, context-isolated bridge
├─ renderer/   React + Tailwind
└─ core/       agent loop — imports nothing from Electron
```

`src/core` is the rule that keeps this testable. It must stay free of Electron, DOM, and
Node-only APIs that cannot run under `node --test`, and it must use only erasable
TypeScript syntax (no enums, no namespaces, no parameter properties) so Node can run the
sources directly.

The renderer never touches the filesystem or the network. Every IPC payload is validated
with Zod in the main process.

## Design notes

- Palette, spacing, and type are defined as CSS custom properties in
  `src/renderer/src/styles.css` and exposed to Tailwind through `@theme inline`.
- Theme is driven by `data-theme` on `<html>`, not the OS setting.
- `?theme=dark&view=gallery` renders the component gallery — the surface used for visual
  checks.
- Icons are original inline SVG. No icon package, no borrowed artwork.

## Not affiliated

This is an independent implementation. It is not affiliated with, endorsed by, or
derived from Anthropic's products, and it contains no Anthropic code, prompts, assets, or
fonts. "Claude Code" is mentioned only to describe the interaction model this project
aims for.

Bring your own model weights and API keys. Respect provider terms of service.

## License

MIT — see [LICENSE](LICENSE).
