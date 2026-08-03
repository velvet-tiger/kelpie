import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The dev server proxies the API rather than pointing the browser at a second
 * origin, so the UI runs against same-origin `/v1` in development exactly as it
 * does in production.
 */
export default defineConfig(({ mode }) => {
  // `API_PORT`, not `PORT`. Every process manager sets `PORT` to the port it
  // wants the process it is launching to listen on, and `loadEnv` with an empty
  // prefix copies the whole environment over the `.env` file. Reading `PORT`
  // here meant that launching Vite under anything that assigns a port made the
  // proxy target Vite itself: the page loads and every `/v1` call times out
  // against the dev server it came from.
  const environment = loadEnv(mode, repositoryRoot, 'API_')
  const apiPort = environment.API_PORT

  if (apiPort === undefined || apiPort.length === 0) {
    throw new Error('API_PORT is not set. Copy .env.example to .env at the repository root.')
  }

  const apiOrigin = `http://localhost:${apiPort}`

  return {
    root: fileURLToPath(new URL('./web', import.meta.url)),
    envDir: repositoryRoot,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      // Honour an assigned port, and refuse rather than silently taking the next
      // one: a launcher that told us 5173 and got 5174 proxies nothing.
      port: Number(process.env.PORT ?? 5173),
      strictPort: true,
      proxy: {
        '/v1': { target: apiOrigin, changeOrigin: false },
        '/healthz': { target: apiOrigin, changeOrigin: false },
      },
    },
  }
})
