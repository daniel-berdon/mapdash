// Geometría para tracking y navegación.
// Convención: SIEMPRE [lng, lat] (orden GeoJSON), igual que MapLibre y ORS.
// Mezclar los dos órdenes es el bug clásico de estos proyectos.

export type LngLat = [number, number]

const EARTH_R = 6371000

/** Distancia haversine en metros. */
export function distM(a: LngLat, b: LngLat): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const lat1 = (a[1] * Math.PI) / 180
  const lat2 = (b[1] * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(h))
}

// A escala de ciudad, proyectar a un plano local es exacto de sobra y mucho
// más barato que hacer haversine dentro de un bucle por cada vértice.
function toPlane(p: LngLat, lat0: number): [number, number] {
  return [
    ((p[0] * Math.PI) / 180) * EARTH_R * Math.cos((lat0 * Math.PI) / 180),
    ((p[1] * Math.PI) / 180) * EARTH_R,
  ]
}

export interface Projection {
  /** Distancia perpendicular a la ruta, en metros. */
  distM: number
  /** Índice del vértice donde cae — es lo que indexan los way_points de ORS. */
  index: number
  /** Punto exacto sobre la línea. */
  point: LngLat
}

/**
 * Proyecta una posición sobre la polilínea de la ruta.
 * Con esto se sabe si el chofer sigue la ruta y en qué maniobra va.
 */
export function projectOnLine(p: LngLat, line: LngLat[]): Projection | null {
  if (line.length === 0) return null
  if (line.length === 1) return { distM: distM(p, line[0]), index: 0, point: line[0] }

  const lat0 = p[1]
  const [px, py] = toPlane(p, lat0)
  let best: Projection = { distM: Infinity, index: 0, point: line[0] }

  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toPlane(line[i], lat0)
    const [bx, by] = toPlane(line[i + 1], lat0)
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    // t recortado a [0,1] para que la proyección caiga dentro del segmento
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best.distM) {
      best = {
        distM: d,
        // se redondea al vértice más cercano: los way_points de ORS son enteros
        index: t < 0.5 ? i : i + 1,
        point: [
          line[i][0] + t * (line[i + 1][0] - line[i][0]),
          line[i][1] + t * (line[i + 1][1] - line[i][1]),
        ],
      }
    }
  }
  return best
}

export interface Step {
  instruction: string
  distance: number
  duration: number
  /** [índice inicial, índice final] dentro de la geometría de la ruta. */
  way_points: [number, number]
}

/**
 * Maniobra vigente: la primera cuyo tramo aún no se ha terminado de recorrer.
 * Devuelve -1 si ya se pasaron todas.
 */
export function currentStepIndex(steps: Step[], vertexIndex: number): number {
  return steps.findIndex((s) => vertexIndex < s.way_points[1])
}

/** Metros que faltan, siguiendo la ruta, desde una posición hasta un vértice. */
export function metersAlong(line: LngLat[], from: LngLat, fromIndex: number, toIndex: number): number {
  if (toIndex <= fromIndex) return distM(from, line[Math.min(toIndex, line.length - 1)])
  let total = distM(from, line[fromIndex])
  for (let i = fromIndex; i < toIndex && i < line.length - 1; i++) {
    total += distM(line[i], line[i + 1])
  }
  return total
}

/**
 * Parte la polilínea en tramos entre waypoints (p. ej. paradas).
 * Cada waypoint se ancla al vértice más cercano, avanzando siempre hacia adelante
 * para no rebobinar si dos paradas quedan cerca del mismo tramo.
 */
export function splitLegs(line: LngLat[], via: LngLat[]): LngLat[][] {
  if (line.length < 2 || via.length === 0) return line.length >= 2 ? [line] : []

  let prev = 0
  const cuts: number[] = [0]
  for (const p of via) {
    let best = prev
    let bestD = Infinity
    for (let i = prev; i < line.length; i++) {
      const d = distM(p, line[i])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    cuts.push(best)
    prev = best
  }

  const legs: LngLat[][] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]
    const b = cuts[i + 1]
    if (b > a) legs.push(line.slice(a, b + 1))
  }
  return legs
}

// ---------------------------------------------------------------------------
// Envío de posiciones
// ---------------------------------------------------------------------------

export interface Fix {
  lng: number
  lat: number
  accuracy?: number
  heading?: number
  speed?: number
  at: number
}

/**
 * watchPosition dispara muchas veces por segundo cuando el GPS está bueno.
 * Solo vale la pena mandar si pasó tiempo o si de verdad se movió.
 */
export function shouldSend(prev: Fix | null, next: Fix, minMs = 3000, minM = 10): boolean {
  if (!prev) return true
  if (next.at - prev.at >= minMs) return true
  return distM([prev.lng, prev.lat], [next.lng, next.lat]) >= minM
}

const BUFFER_KEY = 'mapdash:pending'
const BUFFER_MAX = 300 // ~25 min a 1 cada 5 s; de sobra para un túnel

/** Guarda una posición que no se pudo enviar (sin señal). */
export function bufferFix(fix: Fix, storage: Storage = localStorage): void {
  const pending = readBuffer(storage)
  pending.push(fix)
  // se descartan las más viejas: al organizador le importa dónde está la van
  // ahora, no dónde estuvo hace media hora
  storage.setItem(BUFFER_KEY, JSON.stringify(pending.slice(-BUFFER_MAX)))
}

export function readBuffer(storage: Storage = localStorage): Fix[] {
  try {
    const raw = storage.getItem(BUFFER_KEY)
    return raw ? (JSON.parse(raw) as Fix[]) : []
  } catch {
    return [] // JSON corrupto no debe tumbar el tracking
  }
}

export function clearBuffer(storage: Storage = localStorage): void {
  storage.removeItem(BUFFER_KEY)
}

/** Formatea metros para la banda de instrucciones. */
export function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  return `${(m / 1000).toFixed(1)} km`
}

export function fmtDur(s: number): string {
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

/**
 * Antigüedad de un dato, en la unidad que toque. Un equipo que no reporta
 * desde ayer decía "2089 min": ilegible. Se omite la unidad menor cuando es
 * cero, para no leer "2 d 0 h".
 */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}
