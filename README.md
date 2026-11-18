# recode

A local-first agentic coding app for macOS. Runs real coding tasks against a model on
your own machine, with a transcript you can read: streaming text, native reasoning,
tool cards, diffs, and permission prompts.

Built because the good agentic desktop apps assume a cloud model, and the good local
models assume a terminal.

> **Status:** early but usable. The agent loop, seven tools, permissions, sessions,
> context compaction, project instructions with a trust gate, both provider adapters,
> crash recovery, keyboard shortcuts, and diagnostics export are in place. Distribution
> is source-only.

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

## Composer

Two commands are handled locally instead of being sent to the model:

- `/clear` starts a new session in the same project and leaves the previous one in the
  sidebar, so the old transcript is still there to reopen.
- `/compact` summarizes earlier turns now. The **Compact** button next to the context
  meter does the same thing.

Typing a command prefix shows a hint row above the composer; click a hint or press Enter
to run it. Any other text beginning with `/`, such as an absolute path, is a normal
message.

## Sessions and crashes

Sessions are append-only JSONL under `~/Library/Application Support/recode/sessions`. If
the app stops mid-turn, the session still loads: a tool call whose result never arrived is
dropped so the conversation stays valid, and the composer shows that the last turn did not
finish. Nothing runs automatically. The next message continues from the stored history.

## Project instructions

If the project root contains `AGENTS.md` or `CLAUDE.md`, both are loaded in that order and
appended to the system prompt for every message in the session. They are context, not
authority: they cannot change permissions, and the system prompt tells the model to treat
instructions to reveal secrets or bypass a rule as untrusted.

- Each file is capped at 8 KB and the pair at 12 KB. A truncated file says so in the
  prompt and in the review dialog.
- Symlinks and binary files are skipped and reported, not followed. A repository should
  not be able to pull another file into the prompt by linking to it.
- Instructions stay off until you review the exact content and press **Trust this
  project**. The trust record stores a SHA-256 fingerprint of what you read, so editing
  either file invalidates it and the composer blocks again.
- Sends are blocked in both the renderer and main while instructions are untrusted, and
  main re-reads the files before a trust click so a change between display and click
  cannot be trusted unseen.

Trust lives in `~/Library/Application Support/recode/trust.json` (mode `0600`), separate
from settings. It is keyed by resolved directory and holds the reviewed fingerprint plus
the time it was granted.

## Diagnostics

Settings → **Export diagnostics** writes a JSON support bundle. There is no telemetry;
nothing is sent anywhere, and the file is only created when you ask for it. It contains
app and machine versions, endpoint configuration with credentials and query strings
removed, per-session message counts, and the most recent run lifecycle events. It does not
contain your prompts, tool output, or API keys; error messages may mention endpoints and
short provider responses. Project paths are shortened before they are written.

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
