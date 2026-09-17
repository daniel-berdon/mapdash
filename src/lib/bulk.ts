// Alta masiva de paradas y de rutas desde una hoja de cálculo, y la
// exportación que sirve a la vez de respaldo y de plantilla ya llena.
//
// El archivo lo llena una persona a mano, así que nada de lo que traiga se da
// por bueno: cada celda se valida aquí antes de acercarse a la base. Lo que no
// pasa se reporta con su número de fila, que es lo que la persona ve en Excel.

import { STOP_ICONS } from '../components/icons'
import { POINT_COLOR, TEAM_COLORS } from './color'
import type { Point, Team } from './supabase'
import { head, type CellValue, type Row } from './xlsx'

const ICONS = Object.keys(STOP_ICONS)

export interface PointInput {
  name: string
  lat: number
  lng: number
  icon: string
  color: string
  radius_m: number
  dwell_min: number
}

export interface TeamInput {
  name: string
  driver_name: string | null
  phone: string | null
  color: string
}

export interface Parsed<T> {
  rows: T[]
  /** Un renglón por fila descartada, con su número tal como sale en Excel. */
  errors: string[]
}

// --------------------------------------------------------------- columnas ---

const POINT_HEAD = ['Nombre', 'Latitud', 'Longitud', 'Icono', 'Color', 'Radio (m)', 'Minutos en parada']
const POINT_WIDTHS = [26, 12, 12, 14, 11, 11, 18]
const TEAM_HEAD = ['Nombre', 'Chofer', 'Teléfono', 'Color']
const TEAM_WIDTHS = [22, 22, 16, 11]

/**
 * Sin acentos, sin signos y en minúsculas: así "Radio (m)", "radio_m" y "RADIO"
 * son la misma columna y nadie pierde una importación por un acento.
 */
const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Alias aceptados por columna. El primero es el de la plantilla. */
const POINT_KEYS: Record<keyof PointInput, string[]> = {
  name: ['nombre', 'parada', 'name'],
  lat: ['latitud', 'lat'],
  lng: ['longitud', 'lng', 'lon', 'long'],
  icon: ['icono', 'icon'],
  color: ['color'],
  radius_m: ['radiom', 'radio', 'radius', 'radiusm'],
  dwell_min: ['minutosenparada', 'minutos', 'permanencia', 'dwell', 'dwellmin'],
}

const TEAM_KEYS: Record<keyof TeamInput, string[]> = {
  name: ['nombre', 'ruta', 'equipo', 'name'],
  driver_name: ['chofer', 'conductor', 'drivername', 'driver'],
  phone: ['telefono', 'phone', 'celular'],
  color: ['color'],
}

/** Dónde cayó cada columna conocida. -1 = la hoja no la trae. */
function index<T>(header: CellValue[], keys: Record<keyof T, string[]>): Record<keyof T, number> {
  const seen = header.map((h) => norm(String(h ?? '')))
  const out = {} as Record<keyof T, number>
  for (const field of Object.keys(keys) as (keyof T)[]) {
    out[field] = seen.findIndex((h) => h !== '' && keys[field].includes(h))
  }
  return out
}

const text = (v: CellValue): string => String(v ?? '').trim()

/** Un número de verdad, ya venga como número o como texto con coma decimal. */
function number(v: CellValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = text(v).replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** #rgb o #rrggbb; se admite sin almohadilla porque Excel se la come. */
function color(v: CellValue): string | null {
  const s = text(v).replace(/^#?/, '#')
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : null
}

// -------------------------------------------------------------- importar ---

/** ¿Fila vacía? Excel devuelve filas de puros null al final de la hoja. */
const empty = (row: CellValue[]): boolean => row.every((c) => text(c) === '')

/**
 * Paradas de la hoja. Nombre y coordenadas son obligatorios; lo demás cae en el
 * valor por omisión, que es el mismo que usa el botón "Agregar parada".
 */
export function parsePoints(sheet: CellValue[][]): Parsed<PointInput> {
  const [header = [], ...body] = sheet
  const at = index<PointInput>(header, POINT_KEYS)
  const rows: PointInput[] = []
  const errors: string[] = []

  if (at.name < 0 || at.lat < 0 || at.lng < 0) {
    return { rows, errors: ['La hoja necesita las columnas Nombre, Latitud y Longitud.'] }
  }

  body.forEach((row, i) => {
    // +2: la fila 1 es el encabezado y Excel cuenta desde 1.
    const n = i + 2
    if (empty(row)) return

    const name = text(row[at.name])
    const lat = number(row[at.lat])
    const lng = number(row[at.lng])
    if (!name) return void errors.push(`Fila ${n}: falta el nombre.`)
    if (lat == null || lng == null) return void errors.push(`Fila ${n}: falta la coordenada.`)
    if (lat < -90 || lat > 90) return void errors.push(`Fila ${n}: latitud fuera de rango (${lat}).`)
    if (lng < -180 || lng > 180)
      return void errors.push(`Fila ${n}: longitud fuera de rango (${lng}).`)

    const icon = at.icon < 0 ? '' : norm(text(row[at.icon]))
    if (icon && !ICONS.includes(icon))
      return void errors.push(`Fila ${n}: icono desconocido "${text(row[at.icon])}".`)

    const radius = at.radius_m < 0 ? null : number(row[at.radius_m])
    if (radius != null && (radius < 10 || radius > 1000))
      return void errors.push(`Fila ${n}: el radio va de 10 a 1000 m (${radius}).`)

    const dwell = at.dwell_min < 0 ? null : number(row[at.dwell_min])
    if (dwell != null && dwell < 0) return void errors.push(`Fila ${n}: los minutos no pueden ser negativos.`)

    rows.push({
      name,
      lat,
      lng,
      icon: icon || 'pin',
      color: (at.color < 0 ? null : color(row[at.color])) ?? POINT_COLOR,
      radius_m: Math.round(radius ?? 50),
      dwell_min: Math.round(dwell ?? 0),
    })
  })

  return { rows, errors }
}

/**
 * Rutas de la hoja. Solo el nombre es obligatorio: el token del link lo genera
 * la base, y el color se reparte de la paleta si la hoja no trae uno.
 *
 * `taken` es cuántas rutas ya existen, para que los colores sigan la vuelta de
 * la paleta en vez de repetir siempre los primeros.
 *
 * Se sigue aceptando "Equipo" como encabezado: las plantillas que ya se hayan
 * bajado tienen que poder importarse igual.
 */
export function parseTeams(sheet: CellValue[][], taken = 0): Parsed<TeamInput> {
  const [header = [], ...body] = sheet
  const at = index<TeamInput>(header, TEAM_KEYS)
  const rows: TeamInput[] = []
  const errors: string[] = []

  if (at.name < 0) return { rows, errors: ['La hoja necesita una columna Nombre.'] }

  body.forEach((row, i) => {
    const n = i + 2
    if (empty(row)) return

    const name = text(row[at.name])
    if (!name) return void errors.push(`Fila ${n}: falta el nombre.`)

    rows.push({
      name,
      driver_name: at.driver_name < 0 ? null : text(row[at.driver_name]) || null,
      phone: at.phone < 0 ? null : text(row[at.phone]) || null,
      color:
        (at.color < 0 ? null : color(row[at.color])) ??
        TEAM_COLORS[(taken + rows.length) % TEAM_COLORS.length],
    })
  })

  return { rows, errors }
}

// -------------------------------------------------------------- exportar ---

export function pointSheet(points: Point[]): Row[] {
  return [
    head(POINT_HEAD),
    ...points.map((p): Row => [
      p.name,
      { value: p.lat, type: Number, format: '0.000000' },
      { value: p.lng, type: Number, format: '0.000000' },
      p.icon,
      p.color,
      { value: p.radius_m, type: Number },
      { value: p.dwell_min, type: Number },
    ]),
  ]
}

export function teamSheet(teams: Team[], origin: string): Row[] {
  return [
    head([...TEAM_HEAD, 'Link del chofer']),
    ...teams.map((t): Row => [
      t.name,
      t.driver_name,
      t.phone,
      t.color,
      `${origin}/d/${t.token}`,
    ]),
  ]
}

/** Hoja de ayuda de la plantilla de paradas: qué se puede poner en Icono. */
function iconHelp(): Row[] {
  return [
    head(['Icono', 'Qué dibuja']),
    ...Object.entries(STOP_ICONS).map(([key, { label }]): Row => [key, label]),
  ]
}

/** Las hojas de cada archivo, listas para writeXlsx. */
export const sheets = {
  points: (points: Point[]) => [
    { name: 'Paradas', rows: pointSheet(points), widths: POINT_WIDTHS },
    { name: 'Iconos', rows: iconHelp(), widths: [16, 22] },
  ],
  teams: (teams: Team[], origin: string) => [
    { name: 'Rutas', rows: teamSheet(teams, origin), widths: [...TEAM_WIDTHS, 42] },
  ],
}

/**
 * Plantillas: las mismas hojas de la exportación, con una fila de ejemplo en vez
 * de datos. El ejemplo se borra al llenarla; está para que se vea el formato de
 * una coordenada y de un color sin tener que adivinarlo.
 */
export const templates = {
  points: () => [
    {
      name: 'Paradas', rows: pointTemplate(), widths: POINT_WIDTHS,
      dropdowns: [{ range: 'D2:D1048576', values: ICONS }],
    },
    { name: 'Iconos', rows: iconHelp(), widths: [16, 22] },
  ],
  teams: () => [{ name: 'Rutas', rows: teamTemplate(), widths: TEAM_WIDTHS }],
}

export function pointTemplate(): Row[] {
  return [
    head(POINT_HEAD),
    ['Parada de ejemplo', 19.426, -99.186, 'pin', POINT_COLOR, 60, 20],
  ]
}

export function teamTemplate(): Row[] {
  return [head(TEAM_HEAD), ['Ruta 1', 'Ana Pérez', '5551234567', TEAM_COLORS[0]]]
}
