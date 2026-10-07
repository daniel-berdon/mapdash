import { describe, expect, it } from 'vitest'
import {
  detailSheet,
  liveRuns,
  routeMs,
  sortRuns,
  summarySheet,
  type ReportStop,
  type Row,
  type Run,
} from './report'
import type { Point, Team, Visit } from './supabase'

const MIN = 60_000
const t0 = new Date('2026-08-07T12:00:00Z')
const at = (ms: number) => new Date(t0.getTime() + ms).toISOString()

const team = (over: Partial<Team> = {}): Team => ({
  id: 'e1',
  name: 'Equipo 1',
  driver_name: 'Ana',
  phone: '555',
  color: '#2563eb',
  token: 'abc',
  active: true,
  device_id: null,
  device_seen: null,
  lunch_after_seq: null,
  lunch_started_at: null,
  lunch_ended_at: null,
  route_started_at: null,
  route_finished_at: null,
  ...over,
})

const point = (id: string, name: string): Point => ({
  id,
  name,
  lat: 0,
  lng: 0,
  color: '#e11d48',
  icon: 'pin',
  radius_m: 50,
  dwell_min: 0,
})

const stop = (point_id: string, seq: number): ReportStop => ({ team_id: 'e1', point_id, seq })
const visit = (point_id: string, arrived_at: string): Visit => ({
  team_id: 'e1',
  point_id,
  arrived_at,
  left_at: null,
  source: 'auto',
})

const pts = [point('p1', 'Museo'), point('p2', 'Parque')]
const summary = (teams: Team[], stops: ReportStop[], visits: Visit[], now: number) =>
  summarySheet(liveRuns(teams, stops, visits, pts), now)
const detail = (teams: Team[], stops: ReportStop[], visits: Visit[], points: Point[]) =>
  detailSheet(liveRuns(teams, stops, visits, points))

describe('routeMs', () => {
  it('mide de inicio a fin cuando la ruta se completó', () => {
    // El fin manda: el 'ahora' no mueve un tiempo ya cerrado.
    const t = team({ route_started_at: at(0), route_finished_at: at(90 * MIN) })
    expect(routeMs(t, t0.getTime() + 300 * MIN)).toBe(90 * MIN)
  })

  it('sigue corriendo mientras la ruta no se completa', () => {
    expect(routeMs(team({ route_started_at: at(0) }), t0.getTime() + 20 * MIN)).toBe(20 * MIN)
  })

  it('no hay tiempo antes de arrancar', () => {
    expect(routeMs(team(), t0.getTime())).toBeNull()
  })

  it('un reloj adelantado no produce tiempo negativo', () => {
    expect(routeMs(team({ route_started_at: at(10 * MIN), route_finished_at: at(0) }), 0)).toBe(0)
  })
})

/** Valor plano de una celda, ya sea texto suelto o celda con tipo. */
const val = (row: Row, i: number) => {
  const c = row[i]
  return c && typeof c === 'object' && 'value' in c ? c.value : c
}
/** Una duración de Excel es una fracción de día; se lee en minutos. */
const durMin = (row: Row, i: number) => {
  const v = val(row, i)
  return typeof v === 'number' ? Math.round(v * 24 * 60) : v
}

describe('summarySheet', () => {
  const stops = [stop('p1', 1), stop('p2', 2)]

  it('una fila por ruta, con su tiempo total', () => {
    const [head, r1] = summary(
      [team({ route_started_at: at(0), route_finished_at: at(75 * MIN) })],
      stops,
      [visit('p1', at(30 * MIN)), visit('p2', at(75 * MIN))],
      t0.getTime(),
    )
    expect(val(head, 0)).toBe('Ruta')
    expect(val(r1, 0)).toBe('Equipo 1')
    expect(val(r1, 3)).toBe('Completada')
    expect(val(r1, 4)).toBe(2)
    expect(val(r1, 5)).toBe(2)
    // La celda lleva la hora del reloj local, que Excel guarda como si fuera UTC.
    const inicio = val(r1, 6) as Date
    expect(inicio.getUTCHours()).toBe(new Date(at(0)).getHours())
    expect(inicio.getUTCMinutes()).toBe(new Date(at(0)).getMinutes())
    expect(durMin(r1, 8)).toBe(75)
  })

  it('el tiempo sigue corriendo si la ruta no se completó', () => {
    const [, r1] = summary(
      [team({ route_started_at: at(0) })],
      stops,
      [visit('p1', at(10 * MIN))],
      t0.getTime() + 40 * MIN,
    )
    expect(val(r1, 3)).toBe('En ruta')
    expect(val(r1, 5)).toBe(1)
    expect(durMin(r1, 8)).toBe(40)
  })

  it('una ruta sin arrancar no inventa tiempo', () => {
    const [, r1] = summary([team()], stops, [], t0.getTime())
    expect(val(r1, 3)).toBe('Sin empezar')
    expect(val(r1, 6)).toBeNull()
    expect(val(r1, 8)).toBeNull()
  })

  it('no cuenta visitas de paradas que ya no están en la ruta', () => {
    const [, r1] = summary(
      [team({ route_started_at: at(0) })],
      [stop('p1', 1)],
      [visit('p1', at(10 * MIN)), visit('p2', at(20 * MIN))],
      t0.getTime(),
    )
    expect(val(r1, 4)).toBe(1)
    expect(val(r1, 5)).toBe(1)
  })
})

describe('detailSheet', () => {
  const points = [point('p1', 'Museo'), point('p2', 'Parque')]
  const stops = [stop('p1', 1), stop('p2', 2)]

  it('una fila por parada, en el orden de la ruta', () => {
    const [head, r1, r2] = detail(
      [team({ route_started_at: at(0), route_finished_at: at(75 * MIN) })],
      [stop('p2', 2), stop('p1', 1)],
      [{ ...visit('p1', at(30 * MIN)), left_at: at(50 * MIN) }, visit('p2', at(75 * MIN))],
      points,
    )
    expect(val(head, 3)).toBe('Parada')
    expect(val(r1, 2)).toBe(1)
    expect(val(r1, 3)).toBe('Museo')
    const llegada = val(r1, 4) as Date
    expect(llegada.getUTCHours()).toBe(new Date(at(30 * MIN)).getHours())
    expect(durMin(r1, 6)).toBe(20)
    // Llegada contra llegada: incluye la estancia y el traslado.
    expect(durMin(r1, 7)).toBe(45)
    expect(val(r2, 3)).toBe('Parque')
  })

  it('sin cierre de estancia no inventa la hora de salida', () => {
    const [, r1] = detail(
      [team({ route_started_at: at(0) })],
      stops,
      [visit('p1', at(10 * MIN)), visit('p2', at(40 * MIN))],
      points,
    )
    expect(val(r1, 5)).toBeNull()
    expect(val(r1, 6)).toBeNull()
    expect(durMin(r1, 7)).toBe(30)
  })

  it('la última parada no tiene siguiente', () => {
    const [, , r2] = detail(
      [team({ route_started_at: at(0) })],
      stops,
      [visit('p1', at(10 * MIN)), visit('p2', at(40 * MIN))],
      points,
    )
    expect(val(r2, 7)).toBeNull()
  })

  it('una parada sin visitar sale igual, sin horas', () => {
    const rows = detail([team({ route_started_at: at(0) })], stops, [], points)
    expect(rows).toHaveLength(3)
    expect(val(rows[1], 3)).toBe('Museo')
    expect(val(rows[1], 4)).toBeNull()
    expect(val(rows[2], 4)).toBeNull()
  })

  it('una ruta sin paradas no aporta filas', () => {
    expect(detail([team()], [], [], points)).toHaveLength(1)
  })
})

describe('vueltas archivadas', () => {
  const run = (over: Partial<Run> = {}): Run => ({
    route_name: 'Equipo 1',
    driver_name: 'Ana',
    phone: '555',
    started_at: at(0),
    finished_at: at(60 * MIN),
    reset_at: at(24 * 60 * MIN),
    stops: [
      { seq: 1, name: 'Museo', arrived_at: at(20 * MIN), left_at: null },
      { seq: 2, name: 'Parque', arrived_at: at(60 * MIN), left_at: null },
    ],
    ...over,
  })

  it('cada lunes sale como una vuelta aparte, con su fecha', () => {
    const lunes2 = run({ started_at: at(7 * 24 * 60 * MIN), finished_at: at(7 * 24 * 60 * MIN + 90 * MIN) })
    const [, r1, r2] = summarySheet(sortRuns([lunes2, run()]), t0.getTime())
    expect(durMin(r1, 8)).toBe(60)
    expect(durMin(r2, 8)).toBe(90)
    expect(detailSheet([run(), lunes2])).toHaveLength(5)
  })

  it('una vuelta restablecida a medias queda incompleta y sin tiempo', () => {
    const [, r1] = summarySheet([run({ finished_at: null })], t0.getTime() + 999 * MIN)
    expect(val(r1, 3)).toBe('Incompleta')
    expect(val(r1, 8)).toBeNull()
  })

  it('la vuelta actual va después de las archivadas de la misma ruta', () => {
    const live = liveRuns([team()], [stop('p1', 1)], [], pts)[0]
    const sorted = sortRuns([live, run(), run({ route_name: 'Antes' })])
    expect(sorted.map((r) => r.reset_at === null)).toEqual([false, false, true])
    expect(sorted[0].route_name).toBe('Antes')
  })
})
