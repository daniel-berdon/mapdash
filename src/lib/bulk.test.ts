import { describe, expect, it } from 'vitest'
import { parsePoints, parseTeams, pointTemplate, teamTemplate } from './bulk'
import type { CellValue, Row } from './xlsx'

const sheet = (...rows: CellValue[][]): CellValue[][] => rows

/**
 * Las celdas que se escriben llevan estilo; las que se leen, no. Esto deja la
 * plantilla como la devolvería el lector, que es lo que hace valer la prueba:
 * si un encabezado de la plantilla deja de coincidir con los alias, se ve aquí.
 */
const asRead = (rows: Row[]): CellValue[][] =>
  rows.map((r) =>
    r.map((c) => (c && typeof c === 'object' && 'value' in c ? (c.value as CellValue) : (c as CellValue))),
  )
const POINT_HEAD = ['Nombre', 'Latitud', 'Longitud', 'Icono', 'Color', 'Radio (m)', 'Minutos en parada']

describe('parsePoints', () => {
  it('lee una fila completa', () => {
    const { rows, errors } = parsePoints(
      sheet(POINT_HEAD, ['Museo', 19.426, -99.186, 'museo', '#112233', 60, 20]),
    )
    expect(errors).toEqual([])
    expect(rows[0]).toEqual({
      name: 'Museo',
      lat: 19.426,
      lng: -99.186,
      icon: 'museo',
      color: '#112233',
      radius_m: 60,
      dwell_min: 20,
    })
  })

  it('rellena lo que la hoja no trae', () => {
    const { rows } = parsePoints(sheet(['Nombre', 'Latitud', 'Longitud'], ['Plaza', 19, -99]))
    expect(rows[0]).toMatchObject({ icon: 'pin', color: '#e11d48', radius_m: 50, dwell_min: 0 })
  })

  it('acepta el encabezado con otro acento, otra caja y otro orden', () => {
    const { rows, errors } = parsePoints(sheet(['LONGITUD', 'nombre', 'Lat'], [-99, 'Plaza', 19]))
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ name: 'Plaza', lat: 19, lng: -99 })
  })

  it('lee números escritos como texto, con coma decimal', () => {
    const { rows } = parsePoints(sheet(POINT_HEAD, ['Plaza', '19,426', '-99,186', '', '', '', '']))
    expect(rows[0]).toMatchObject({ lat: 19.426, lng: -99.186 })
  })

  it('completa la almohadilla del color', () => {
    const { rows } = parsePoints(sheet(POINT_HEAD, ['Plaza', 19, -99, '', 'AABBCC', '', '']))
    expect(rows[0].color).toBe('#aabbcc')
  })

  it('descarta la fila sin nombre o sin coordenada, y sigue con las demás', () => {
    const { rows, errors } = parsePoints(
      sheet(POINT_HEAD, ['', 19, -99], ['Plaza', '', -99], ['Museo', 19.4, -99.1]),
    )
    expect(rows).toHaveLength(1)
    expect(errors).toEqual(['Fila 2: falta el nombre.', 'Fila 3: falta la coordenada.'])
  })

  it('rechaza coordenadas fuera del planeta', () => {
    const { rows, errors } = parsePoints(sheet(POINT_HEAD, ['Plaza', 119, -99]))
    expect(rows).toEqual([])
    expect(errors[0]).toContain('latitud fuera de rango')
  })

  it('rechaza un radio que la base no aceptaría', () => {
    const { errors } = parsePoints(sheet(POINT_HEAD, ['Plaza', 19, -99, '', '', 5, '']))
    expect(errors[0]).toContain('10 a 1000')
  })

  it('rechaza un icono que no existe', () => {
    const { errors } = parsePoints(sheet(POINT_HEAD, ['Plaza', 19, -99, 'catedral', '', '', '']))
    expect(errors[0]).toContain('icono desconocido')
  })

  it('ignora las filas vacías del final de la hoja', () => {
    const { rows, errors } = parsePoints(
      sheet(POINT_HEAD, ['Plaza', 19, -99], [null, null, null], ['', '', '']),
    )
    expect(rows).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('avisa si el archivo no es la plantilla', () => {
    const { errors } = parsePoints(sheet(['Cosa', 'Otra'], ['x', 'y']))
    expect(errors[0]).toContain('Nombre, Latitud y Longitud')
  })

  it('la plantilla se puede volver a leer tal cual', () => {
    const { rows, errors } = parsePoints(asRead(pointTemplate()))
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
  })
})

describe('parseTeams', () => {
  it('solo exige el nombre', () => {
    const { rows, errors } = parseTeams(sheet(['Nombre'], ['Equipo 1']))
    expect(errors).toEqual([])
    expect(rows[0]).toEqual({
      name: 'Equipo 1',
      driver_name: null,
      phone: null,
      color: '#2563eb',
    })
  })

  it('sigue la paleta a partir de los equipos que ya existen', () => {
    const { rows } = parseTeams(sheet(['Nombre'], ['A'], ['B']), 2)
    expect(rows.map((r) => r.color)).toEqual(['#16a34a', '#ea580c'])
  })

  it('respeta el color de la hoja', () => {
    const { rows } = parseTeams(sheet(['Nombre', 'Color'], ['A', '#123456']))
    expect(rows[0].color).toBe('#123456')
  })

  it('el teléfono en blanco queda en nulo, no en cadena vacía', () => {
    const { rows } = parseTeams(sheet(['Nombre', 'Chofer', 'Teléfono'], ['A', 'Ana', '']))
    expect(rows[0]).toMatchObject({ driver_name: 'Ana', phone: null })
  })

  it('ignora columnas que no conoce, como el link exportado', () => {
    const { rows, errors } = parseTeams(
      sheet(['Nombre', 'Link del chofer'], ['A', 'https://x/d/abc']),
    )
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
  })

  it('la plantilla se puede volver a leer tal cual', () => {
    const { rows, errors } = parseTeams(asRead(teamTemplate()))
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ name: 'Ruta 1', driver_name: 'Ana Pérez' })
  })
})
