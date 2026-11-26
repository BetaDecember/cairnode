import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/**
 * The dev server needs a WebSocket for HMR. The packaged renderer never talks
 * to the network directly, so the strict policy stays in `index.html` and the
 * dev-only source is injected here.
 */
function devCsp(): Plugin {
  return {
    name: 'cairnode-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "connect-src 'self'",
        "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': resolve('src/core'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    // Fixed so the Playwright web server can wait on a known URL.
    server: { port: 5183, strictPort: true },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@core': resolve('src/core'),
      },
    },
    plugins: [devCsp(), react(), tailwindcss()],
  },
})
