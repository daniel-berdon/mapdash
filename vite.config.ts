import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { handle } from './api/route.js'

// En producción /api/route lo sirve Vercel. En dev lo sirve esto, llamando al
// mismo handler, para que la key de ORS tampoco esté en el cliente localmente.
function orsDevApi(): Plugin {
  return {
    name: 'ors-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/route', (req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json')
          try {
            res.end(JSON.stringify(await handle(JSON.parse(raw || '{}'))))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: (e as Error).message }))
          }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // ORS_API_KEY no lleva prefijo VITE_ (no debe llegar al cliente), así que
  // Vite no la carga sola: se pasa a process.env solo para el handler de dev.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return {
    plugins: [react(), orsDevApi()],
    // El worker de MapLibre es un módulo ES (lo instancia con
    // `{type:'module'}`), así que hay que emitirlo como tal. Ver el comentario
    // en components/Map.tsx.
    worker: { format: 'es' },
    // Túneles HTTPS (cloudflared / localtunnel) para probar el GPS en el celular.
    server: {
      host: true,
      allowedHosts: true,
    },
  }
})
