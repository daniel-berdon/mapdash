// Búsqueda de direcciones con la API de geocoding de MapTiler.
//
// Se usa la misma key que las teselas: ya está en el bundle y se restringe por
// dominio. Sin key no hay buscador — el panel lo esconde en vez de mostrar un
// campo que siempre falla.

import type { LngLat } from './geo'

const KEY = import.meta.env.VITE_MAPTILER_KEY

export const geocodeOk = Boolean(KEY)

export interface Place {
  id: string
  name: string
  /** Qué encuadrar: las dos esquinas del bbox, o el punto si no lo trae. */
  coords: LngLat[]
}

interface Feature {
  id?: string
  text?: string
  place_name?: string
  place_name_es?: string
  center?: LngLat
  bbox?: [number, number, number, number]
}

/** Traduce la respuesta de MapTiler. Separado para poder probarlo sin red. */
export function toPlaces(json: { features?: Feature[] }): Place[] {
  return (json.features ?? [])
    .filter((f) => f.center || f.bbox)
    .map((f, i) => ({
      id: f.id ?? String(i),
      name: f.place_name_es ?? f.place_name ?? f.text ?? 'Sin nombre',
      coords: f.bbox
        ? [
            [f.bbox[0], f.bbox[1]],
            [f.bbox[2], f.bbox[3]],
          ]
        : [f.center!],
    }))
}

/**
 * Hasta 5 resultados para lo que se escriba: ciudad, calle con número, o un
 * lugar por su nombre. `near` sesga la búsqueda a esa zona — con las paradas ya
 * puestas, "Reforma" devuelve la de la ciudad del evento y no la de otro país.
 */
export async function searchPlaces(q: string, near?: LngLat): Promise<Place[]> {
  const url = new URL(`https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json`)
  url.searchParams.set('key', KEY)
  url.searchParams.set('language', 'es')
  url.searchParams.set('limit', '5')
  if (near) url.searchParams.set('proximity', `${near[0]},${near[1]}`)

  const res = await fetch(url)
  if (!res.ok) throw new Error(`geocoding ${res.status}`)
  return toPlaces(await res.json())
}
