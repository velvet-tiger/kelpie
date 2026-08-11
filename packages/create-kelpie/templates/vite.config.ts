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
export default defineConfig(({ mode, command }) => {
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

  const shared = {
    root: fileURLToPath(new URL('./web', import.meta.url)),
    envDir: projectRoot,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
    },
  }

  // A production build writes static files and proxies nothing, so it needs no
  // API port. Demanding one for every invocation breaks any build that runs
  // without a `.env` beside it, which is exactly what a container build is: the
  // image leaves `.env` out because it holds `SECRET_ENCRYPTION_KEY`, and the
  // build then dies over a variable it was never going to read.
  if (command !== 'serve') {
    return shared
  }

  const apiPort = environment.API_PORT

  if (apiPort === undefined || apiPort.length === 0) {
    throw new Error('API_PORT is not set. It belongs in .env, with the same value as PORT.')
  }

  const apiOrigin = `http://localhost:${apiPort}`

  return {
    ...shared,
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
