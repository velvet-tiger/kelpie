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
  const environment = loadEnv(mode, repositoryRoot, '')
  const apiPort = environment.PORT

  if (apiPort === undefined || apiPort.length === 0) {
    throw new Error('PORT is not set. Copy .env.example to .env at the repository root.')
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
      proxy: {
        '/v1': { target: apiOrigin, changeOrigin: false },
        '/healthz': { target: apiOrigin, changeOrigin: false },
      },
    },
  }
})
