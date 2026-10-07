// Reporte en Excel: una hoja de resumen por vuelta y otra con el detalle
// parada por parada.
//
// Una vuelta es una pasada completa por la ruta. Las anteriores vienen de
// route_runs (se archivan al restablecer); la actual se arma con lo que el
// panel ya tiene en pantalla.
//
// Las horas y las duraciones van como fecha y duración de verdad, no como
// texto: así la hoja las puede ordenar, restar y promediar. Una duración en
// Excel es una fracción de día; el formato [h]:mm es el que no "da la vuelta"
// al pasar de 24 horas.

import { fmtDur } from './geo'
import type { Point, RouteRun, RunStop, Team, Visit } from './supabase'
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

/** Una vuelta para el reporte: archivada o la que está en curso (sin reset_at). */
export type Run = Omit<RouteRun, 'id' | 'team_id' | 'reset_at'> & { reset_at: string | null }

/**
 * La vuelta actual de cada ruta, con la misma forma que una archivada. Las
 * visitas a paradas que ya no están en la ruta no cuentan.
 */
export function liveRuns(
  teams: Team[],
  stops: ReportStop[],
  visits: Visit[],
  points: Point[],
): Run[] {
  return teams.map((t) => ({
    route_name: t.name,
    driver_name: t.driver_name,
    phone: t.phone,
    started_at: t.route_started_at,
    finished_at: t.route_finished_at,
    reset_at: null,
    stops: stops
      .filter((s) => s.team_id === t.id)
      .sort((a, b) => a.seq - b.seq)
      .map((s): RunStop => {
        const v = visits.find((x) => x.team_id === t.id && x.point_id === s.point_id)
        return {
          seq: s.seq,
          name: points.find((p) => p.id === s.point_id)?.name ?? null,
          arrived_at: v?.arrived_at ?? null,
          left_at: v?.left_at ?? null,
        }
      }),
  }))
}

/**
 * Por ruta y, dentro de cada ruta, del día más viejo al más nuevo: así los
 * lunes de una misma ruta quedan juntos. La vuelta sin arrancar va al final.
 */
export function sortRuns(runs: Run[]): Run[] {
  const key = (r: Run) => r.started_at ?? r.reset_at ?? '9999'
  return [...runs].sort(
    (a, b) => a.route_name.localeCompare(b.route_name) || key(a).localeCompare(key(b)),
  )
}

const runState = (r: Run): string =>
  r.finished_at
    ? 'Completada'
    : r.reset_at
      ? 'Incompleta'
      : r.started_at
        ? 'En ruta'
        : 'Sin empezar'

/**
 * Una vuelta restablecida sin completar no tiene fin: su tiempo queda vacío
 * en vez de seguir creciendo hasta hoy.
 */
const runMs = (r: Run, now: number): number | null =>
  r.reset_at && !r.finished_at
    ? null
    : routeMs({ route_started_at: r.started_at, route_finished_at: r.finished_at }, now)

/** Hoja 1: una línea por vuelta, que es lo que se mira de un vistazo. */
export function summarySheet(runs: Run[], now: number): Row[] {
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
    ...runs.map((r): Row => [
      r.route_name,
      r.driver_name ?? null,
      r.phone ?? null,
      runState(r),
      num(r.stops.length),
      num(r.stops.filter((s) => s.arrived_at).length),
      at(r.started_at),
      at(r.finished_at),
      dur(runMs(r, now)),
    ]),
  ]
}

/**
 * Hoja 2: una línea por parada, en el orden de la ruta. Las paradas sin visitar
 * salen igual, con las horas vacías: el hueco es justo lo que se quiere ver.
 * "Inicio de la vuelta" dice a qué día pertenece cada parada.
 *
 * Las dos duraciones son dato medido, no estimación:
 * - "Tiempo en parada" solo existe si el chofer cerró la estancia; si se fue
 *   sin cerrarla, nadie registró a qué hora salió y la celda va vacía.
 * - "Hasta la siguiente" es llegada contra llegada, así que incluye la
 *   estancia y el traslado. Vacío si la siguiente parada no se visitó.
 */
export function detailSheet(runs: Run[]): Row[] {
  const rows: Row[] = []

  for (const r of runs) {
    const ordered = [...r.stops].sort((a, b) => a.seq - b.seq)
    ordered.forEach((s, i) => {
      const next = ordered[i + 1]
      rows.push([
        r.route_name,
        at(r.started_at),
        num(s.seq),
        s.name,
        at(s.arrived_at),
        at(s.left_at),
        dur(s.arrived_at && s.left_at ? span(s.arrived_at, s.left_at) : null),
        dur(s.arrived_at && next?.arrived_at ? span(s.arrived_at, next.arrived_at) : null),
      ])
    })
  }

  return [
    head([
      'Ruta',
      'Inicio de la vuelta',
      '#',
      'Parada',
      'Llegada',
      'Salida',
      'Tiempo en parada',
      'Hasta la siguiente',
    ]),
    ...rows,
  ]
}

/**
 * Arma y descarga el reporte: las vueltas archivadas más la actual de cada
 * ruta.
 */
export async function downloadReport(runs: Run[], now: number): Promise<void> {
  const sorted = sortRuns(runs)
  await writeXlsx(
    [
      {
        name: 'Resumen',
        rows: summarySheet(sorted, now),
        widths: [18, 16, 14, 12, 9, 10, 17, 17, 15],
      },
      {
        name: 'Detalle',
        rows: detailSheet(sorted),
        widths: [18, 17, 5, 24, 17, 17, 17, 19],
      },
    ],
    stampName('mapdash-reporte', now),
  )
}
