// Pruebas que pasan por el formato de verdad: se escribe un archivo y se vuelve
// a leer. El resto se prueba sobre las filas, pero solo esto atrapa una celda
// que la librería rechace y, sobre todo, un encabezado de la plantilla que deje
// de coincidir con los alias que entiende el importador.
import { expect, it } from 'vitest'
import readXlsxFile, { readSheet } from 'read-excel-file/node'
import writeXlsxFile from 'write-excel-file/node'
import { strFromU8, unzipSync } from 'fflate'
import { STOP_ICONS } from '../components/icons'
import { dropdownFeature } from './xlsxDropdowns'
import { parsePoints, parseTeams, sheets, templates } from './bulk'
import { detailSheet, summarySheet } from './report'
import type { Point, Team, Visit } from './supabase'
import { asCells, type SheetSpec } from './xlsx'

const t0 = new Date('2026-09-17T14:00:00Z').getTime()
const MIN = 60_000
const iso = (m: number) => new Date(t0 + m * MIN).toISOString()

const team: Team = {
  id: 'e1', name: 'Equipo 1', driver_name: 'Ana', phone: '555-1234', color: '#2563eb',
  token: 'abc123', active: true, device_id: null, device_seen: null, lunch_after_seq: null,
  lunch_started_at: null, lunch_ended_at: null,
  route_started_at: iso(0), route_finished_at: iso(95),
}
const points: Point[] = [
  { id: 'p1', name: 'Museo', lat: 19.426, lng: -99.186, color: '#e11d48', icon: 'museo', radius_m: 60, dwell_min: 20 },
  { id: 'p2', name: 'Parque, centro', lat: 19.4, lng: -99.1, color: '#2563eb', icon: 'pin', radius_m: 50, dwell_min: 0 },
]
const stops = [
  { team_id: 'e1', point_id: 'p1', seq: 1 },
  { team_id: 'e1', point_id: 'p2', seq: 2 },
]
const visits: Visit[] = [
  { team_id: 'e1', point_id: 'p1', arrived_at: iso(25), left_at: iso(48), source: 'auto' },
  { team_id: 'e1', point_id: 'p2', arrived_at: iso(95), left_at: null, source: 'manual' },
]

/** Mismo armado que writeXlsx, pero contra un Buffer en vez de una descarga. */
const build = (specs: SheetSpec[]) =>
  writeXlsxFile(
    specs.map((s) => ({ sheet: s.name, data: s.rows, stickyRowsCount: 1 })),
    { fontFamily: 'Calibri', fontSize: 11, features: [dropdownFeature(specs)] },
  ).toBuffer()

it('el reporte se escribe con sus dos hojas', async () => {
  const file = await build([
    { name: 'Resumen', rows: summarySheet([team], stops, visits, t0 + 120 * MIN) },
    { name: 'Detalle', rows: detailSheet([team], stops, visits, points) },
  ])
  const book = await readXlsxFile(file)
  expect(book.map((s) => s.sheet)).toEqual(['Resumen', 'Detalle'])
  expect(book[1].data).toHaveLength(3)
})

it('la plantilla de paradas se llena y se vuelve a importar', async () => {
  const file = await build(templates.points())
  const { rows, errors } = parsePoints(asCells(await readSheet(file, 1)))
  expect(errors).toEqual([])
  expect(rows[0]).toMatchObject({ name: 'Parada de ejemplo', icon: 'pin', radius_m: 60, dwell_min: 20 })
  const files = unzipSync(file)
  const xml = strFromU8(files['xl/worksheets/sheet1.xml'])
  expect(xml).toContain('sqref="D2:D1048576"')
  expect(xml).toContain('showDropDown="0"')
  expect(xml).toContain('allowBlank="1"')
  expect(xml).toContain(`<formula1>"${Object.keys(STOP_ICONS).join(',')}"</formula1>`)
  expect(xml.indexOf('<dataValidations')).toBeGreaterThan(xml.indexOf('</sheetData>'))
  expect(strFromU8(files['xl/worksheets/sheet2.xml'])).not.toContain('<dataValidations')
})

it('la plantilla de equipos se llena y se vuelve a importar', async () => {
  const file = await build(templates.teams())
  const { rows, errors } = parseTeams(asCells(await readSheet(file, 1)))
  expect(errors).toEqual([])
  expect(rows[0]).toMatchObject({ name: 'Ruta 1', driver_name: 'Ana Pérez' })
})

it('lo exportado se puede volver a importar', async () => {
  const file = await build(sheets.points(points))
  const { rows, errors } = parsePoints(asCells(await readSheet(file, 1)))
  expect(errors).toEqual([])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ name: 'Museo', lat: 19.426, lng: -99.186, icon: 'museo' })
})

it('los equipos exportados se reimportan ignorando la columna del link', async () => {
  const file = await build(sheets.teams([team], 'https://mapdash.app'))
  const { rows, errors } = parseTeams(asCells(await readSheet(file, 1)))
  expect(errors).toEqual([])
  expect(rows[0]).toMatchObject({ name: 'Equipo 1', driver_name: 'Ana', phone: '555-1234' })
})
