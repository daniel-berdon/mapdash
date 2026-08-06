// Proxy a OpenRouteService.
//
// Existe por una sola razón: ORS no permite restringir la key por dominio, así
// que si la metemos en el bundle cualquiera puede gastarse la cuota. La key vive
// aquí, en el servidor. En Vercel esto es una función serverless; en `npm run
// dev` lo sirve el plugin de vite.config.ts llamando al mismo `handle()`.

const ORS = 'https://api.openrouteservice.org'

export type LngLat = [number, number]

export interface RouteResult {
  geometry: { type: 'LineString'; coordinates: LngLat[] }
  steps: { instruction: string; distance: number; duration: number; way_points: [number, number] }[]
  distance_m: number
  duration_s: number
}

async function ors(path: string, body: unknown, key: string): Promise<any> {
  const res = await fetch(`${ORS}${path}`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: any = await res.json()
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.error ?? res.statusText
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return json
}

/**
 * ORS traduce mal al español: con perfil driving-car sigue diciendo "Camina".
 * Se reescribe a lenguaje de conducción antes de guardarlo o narrarlo.
 */
function driveWording(text: string): string {
  return text
    .replace(/\bCamina\b/gi, 'Conduce')
    .replace(/\bCamine\b/gi, 'Conduce')
    .replace(/\bCaminar\b/gi, 'Conducir')
    .replace(/\ba pie\b/gi, 'en auto')
    .replace(/\bpeatonal\b/gi, 'vehicular')
}

/** Ruta por calles + maniobras en español entre una lista de coordenadas. */
async function directions(coordinates: LngLat[], key: string): Promise<RouteResult> {
  const json = await ors(
    '/v2/directions/driving-car/geojson',
    { coordinates, instructions: true, language: 'es', units: 'm' },
    key,
  )
  const feature = json.features?.[0]
  if (!feature) throw new Error('ORS no devolvió ruta')

  // Con varias paradas ORS parte la ruta en segmentos; los way_points de cada
  // step ya son índices sobre la geometría completa, así que basta aplanarlos.
  const steps = (feature.properties.segments ?? []).flatMap((s: any) => s.steps ?? [])

  return {
    geometry: feature.geometry,
    steps: steps.map((s: any) => ({
      instruction: driveWording(String(s.instruction ?? '')),
      distance: s.distance,
      duration: s.duration,
      way_points: s.way_points,
    })),
    distance_m: feature.properties.summary?.distance ?? 0,
    duration_s: feature.properties.summary?.duration ?? 0,
  }
}

/**
 * Orden óptimo de las paradas (TSP, motor VROOM).
 * `stops` son las paradas intermedias; start/end son fijos si se dan.
 * Devuelve los índices de `stops` en el orden en que conviene visitarlas.
 */
async function optimize(
  stops: LngLat[],
  key: string,
  start?: LngLat,
  end?: LngLat,
): Promise<number[]> {
  const vehicle: Record<string, unknown> = { id: 1, profile: 'driving-car' }
  if (start) vehicle.start = start
  if (end) vehicle.end = end

  const json = await ors(
    '/optimization',
    {
      jobs: stops.map((location, i) => ({ id: i + 1, location })),
      vehicles: [vehicle],
    },
    key,
  )
  const steps = json.routes?.[0]?.steps ?? []
  return steps.filter((s: any) => s.type === 'job').map((s: any) => s.job - 1)
}

export async function handle(body: any): Promise<unknown> {
  const key = process.env.ORS_API_KEY
  if (!key) throw new Error('Falta ORS_API_KEY en el entorno del servidor')

  if (body?.mode === 'optimize') {
    if (!Array.isArray(body.stops) || body.stops.length < 2) {
      throw new Error('optimize necesita al menos 2 paradas')
    }
    return { order: await optimize(body.stops, key, body.start, body.end) }
  }

  if (!Array.isArray(body?.coordinates) || body.coordinates.length < 2) {
    throw new Error('directions necesita al menos 2 coordenadas')
  }
  return directions(body.coordinates, key)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  try {
    res.status(200).json(await handle(req.body))
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
}
