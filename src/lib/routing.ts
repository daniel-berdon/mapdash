import type { LngLat, Step } from './geo'

export interface RouteResult {
  geometry: { type: 'LineString'; coordinates: LngLat[] }
  steps: Step[]
  distance_m: number
  duration_s: number
}

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? 'Error de routing')
  return json as T
}

/** Ruta por calles con maniobras en español. */
export function getRoute(coordinates: LngLat[]): Promise<RouteResult> {
  return post<RouteResult>({ mode: 'directions', coordinates })
}

/** Orden sugerido de las paradas (índices de `stops`). */
export function optimizeOrder(stops: LngLat[], start?: LngLat, end?: LngLat): Promise<number[]> {
  return post<{ order: number[] }>({ mode: 'optimize', stops, start, end }).then((r) => r.order)
}
