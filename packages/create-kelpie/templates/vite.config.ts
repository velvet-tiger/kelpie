import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const projectRoot = fileURLToPath(new URL('./', import.meta.url))

/**
 * The dev server proxies the API rather than pointing the browser at a second
 * origin, so the UI runs against same-origin `/v1` in development exactly as it
 * does in production.
 */
export default defineConfig(({ mode }) => {
  // `loadEnv` rather than `process.env`, because `npm run dev:web` runs `vite`
  // directly and nothing has read `.env` into the environment by then. Reading
  // `process.env.WEB_PORT` here means the port in `.env` is silently ignored and
  // Vite takes 5173, or the next free one, while README and .env both say
  // otherwise.
  //
  // `API_PORT`, not `PORT`. Every process manager sets `PORT` to the port it
  // wants the process it is launching to listen on, and a prefix that matched it
  // would let that value win over `.env`. Vite would then proxy to itself: the
  // page loads and every `/v1` call times out against the dev server it came
  // from.
  const environment = loadEnv(mode, projectRoot, ['API_', 'WEB_'])
  const apiPort = environment.API_PORT

  if (apiPort === undefined || apiPort.length === 0) {
    throw new Error('API_PORT is not set. It belongs in .env, with the same value as PORT.')
  }

  const apiOrigin = `http://localhost:${apiPort}`

  return {
    root: fileURLToPath(new URL('./web', import.meta.url)),
    envDir: projectRoot,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      port: Number(environment.WEB_PORT ?? 5173),
      // Refuse rather than quietly taking the next port. A launcher that was
      // told 5173 and got 5174 proxies nothing, and the README hands out an
      // address that answers nothing.
      strictPort: true,
      proxy: {
        '/v1': { target: apiOrigin, changeOrigin: false },
        '/healthz': { target: apiOrigin, changeOrigin: false },
        // The MCP page shows the endpoint at the origin the browser reached the
        // app on, which in development is this dev server. Without the proxy
        // that address is right in production and dead here, so anyone copying
        // it out of the page would be debugging the wrong thing.
        '/mcp': { target: apiOrigin, changeOrigin: false },
      },
    },
  }
})
