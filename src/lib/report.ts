// Reporte de la jornada en Excel: una hoja de resumen por equipo y otra con el
// detalle parada por parada.
//
// Todo se deriva de lo que ya está en pantalla, sin consultar nada más: el
// panel tiene equipos, paradas, rutas y visitas cargados y al día por realtime.
//
// Las horas y las duraciones van como fecha y duración de verdad, no como
// texto: así la hoja las puede ordenar, restar y promediar. Una duración en
// Excel es una fracción de día; el formato [h]:mm es el que no "da la vuelta"
// al pasar de 24 horas.

import { fmtDur } from './geo'
import type { Point, Team, Visit } from './supabase'
import { head, stampName, writeXlsx, type Cell, type Row } from './xlsx'

export type { Row }

const MS_PER_DAY = 86_400_000

/**
 * Milisegundos que lleva (o llevó) la vuelta. null si el equipo todavía no
 * arranca. Mientras la ruta no se completa el número sigue creciendo: es el
 * tiempo transcurrido, no una estimación.
 */
export function routeMs(
  team: Pick<Team, 'route_started_at' | 'route_finished_at'>,
  now: number,
): number | null {
  if (!team.route_started_at) return null
  const start = new Date(team.route_started_at).getTime()
  const end = team.route_finished_at ? new Date(team.route_finished_at).getTime() : now
  // Un reloj de teléfono adelantado puede dejar el fin antes del inicio.
  return Math.max(0, end - start)
}

/** Tiempo de ruta ya formateado para el panel, o '—' si no ha empezado. */
export function fmtRoute(ms: number | null): string {
  return ms == null ? '—' : fmtDur(ms / 1000)
}

/** Milisegundos entre dos horas ISO. Nunca negativo: ver routeMs. */
const span = (from: string, to: string): number =>
  Math.max(0, new Date(to).getTime() - new Date(from).getTime())

/**
 * Excel guarda la hora sin zona horaria y la librería convierte en UTC, así que
 * se le resta el huso local: una llegada de las 08:25 tiene que leerse 08:25 en
 * la hoja, no 14:25. El desfase se toma de cada fecha y no una vez, porque un
 * cambio de horario de verano a media jornada mueve el de la tarde.
 */
const at = (iso: string | null): Cell => {
  if (!iso) return null
  const d = new Date(iso)
  return {
    value: new Date(d.getTime() - d.getTimezoneOffset() * 60_000),
    type: Date,
    format: 'dd/mm/yyyy hh:mm',
  }
}

const dur = (ms: number | null): Cell =>
  ms == null ? null : { value: ms / MS_PER_DAY, type: Number, format: '[h]:mm' }

const num = (n: number): Cell => ({ value: n, type: Number })

export interface ReportStop {
  team_id: string
  point_id: string
  seq: number
}

const teamState = (t: Team): string =>
  t.route_finished_at ? 'Completada' : t.route_started_at ? 'En ruta' : 'Sin empezar'

/** Hoja 1: una línea por ruta, que es lo que se mira de un vistazo. */
export function summarySheet(
  teams: Team[],
  stops: ReportStop[],
  visits: Visit[],
  now: number,
): Row[] {
  const rows = teams.map((t): Row => {
    const teamStops = stops.filter((s) => s.team_id === t.id)
    const done = teamStops.filter((s) =>
      visits.some((v) => v.team_id === t.id && v.point_id === s.point_id),
    ).length
    return [
      t.name,
      t.driver_name ?? null,
      t.phone ?? null,
      teamState(t),
      num(teamStops.length),
      num(done),
      at(t.route_started_at),
      at(t.route_finished_at),
      dur(routeMs(t, now)),
    ]
  })

  return [
    head([
      'Ruta',
      'Chofer',
      'Teléfono',
      'Estado',
      'Paradas',
      'Visitadas',
      'Inicio',
      'Fin',
      'Tiempo total',
    ]),
    ...rows,
  ]
}

/**
 * Hoja 2: una línea por parada, en el orden de la ruta. Las paradas sin visitar
 * salen igual, con las horas vacías: el hueco es justo lo que se quiere ver.
 *
 * Las dos duraciones son dato medido, no estimación:
 * - "Tiempo en parada" solo existe si el chofer cerró la estancia; si se fue
 *   sin cerrarla, nadie registró a qué hora salió y la celda va vacía.
 * - "Hasta la siguiente" es llegada contra llegada, así que incluye la
 *   estancia y el traslado. Vacío si la siguiente parada no se visitó.
 */
export function detailSheet(
  teams: Team[],
  stops: ReportStop[],
  visits: Visit[],
  points: Point[],
): Row[] {
  const rows: Row[] = []

  for (const t of teams) {
    const teamStops = stops.filter((s) => s.team_id === t.id).sort((a, b) => a.seq - b.seq)
    const visitOf = (pointId: string) =>
      visits.find((v) => v.team_id === t.id && v.point_id === pointId) ?? null

    teamStops.forEach((s, i) => {
      const v = visitOf(s.point_id)
      const next = teamStops[i + 1] ? visitOf(teamStops[i + 1].point_id) : null
      rows.push([
        t.name,
        num(s.seq),
        points.find((p) => p.id === s.point_id)?.name ?? null,
        at(v?.arrived_at ?? null),
        at(v?.left_at ?? null),
        dur(v?.left_at ? span(v.arrived_at, v.left_at) : null),
        dur(v && next ? span(v.arrived_at, next.arrived_at) : null),
      ])
    })
  }

  return [
    head(['Ruta', '#', 'Parada', 'Llegada', 'Salida', 'Tiempo en parada', 'Hasta la siguiente']),
    ...rows,
  ]
}

/**
 * Arma y descarga el reporte de la jornada.
 */
export async function downloadReport(
  teams: Team[],
  stops: ReportStop[],
  visits: Visit[],
  points: Point[],
  now: number,
): Promise<void> {
  await writeXlsx(
    [
      {
        name: 'Resumen',
        rows: summarySheet(teams, stops, visits, now),
        widths: [18, 16, 14, 12, 9, 10, 17, 17, 15],
      },
      {
        name: 'Detalle',
        rows: detailSheet(teams, stops, visits, points),
        widths: [18, 5, 24, 17, 17, 17, 19],
      },
    ],
    stampName('mapdash-reporte', now),
  )
}
