# recode

A local-first agentic coding app for macOS. Runs real coding tasks against a model on
your own machine, with a transcript you can read: streaming text, native reasoning,
tool cards, diffs, and permission prompts.

Built because the good agentic desktop apps assume a cloud model, and the good local
models assume a terminal.

> **Status:** early. The interface shell and design system are in place; the agent loop
> lands next. Not yet usable for real work.

## Requirements

- macOS
- Node 24+
- [pnpm](https://pnpm.io) 11+
- [Ollama](https://ollama.com) running locally, with at least one tool-capable model

## Run it

```sh
pnpm install

# pnpm 11 blocks dependency postinstall scripts by default; Electron needs its binary.
# If `pnpm dev` reports "Electron uninstall", run:
node node_modules/electron/install.js

pnpm dev
```

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
