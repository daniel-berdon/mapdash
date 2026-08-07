import { describe, expect, it } from 'vitest'
import {
  bufferFix,
  fmtAge,
  clearBuffer,
  currentStepIndex,
  distM,
  metersAlong,
  projectOnLine,
  readBuffer,
  shouldSend,
  splitLegs,
  type Fix,
  type LngLat,
  type Step,
} from './geo'

describe('distM', () => {
  it('mide una distancia conocida', () => {
    // Zócalo CDMX -> Ángel de la Independencia, ~3.2 km
    const zocalo: LngLat = [-99.1332, 19.4326]
    const angel: LngLat = [-99.1677, 19.4270]
    expect(distM(zocalo, angel)).toBeGreaterThan(3400)
    expect(distM(zocalo, angel)).toBeLessThan(3900)
  })

  it('da 0 para el mismo punto y es simétrica', () => {
    const a: LngLat = [-99.13, 19.43]
    const b: LngLat = [-99.14, 19.44]
    expect(distM(a, a)).toBe(0)
    expect(distM(a, b)).toBeCloseTo(distM(b, a), 6)
  })
})

describe('projectOnLine', () => {
  // Tramo recto de ~1 km hacia el este sobre el mismo paralelo
  const line: LngLat[] = [
    [-99.140, 19.430],
    [-99.130, 19.430],
    [-99.120, 19.430],
  ]

  it('da distancia ~0 para un punto sobre la línea', () => {
    const p = projectOnLine([-99.135, 19.43], line)!
    expect(p.distM).toBeLessThan(1)
  })

  it('mide la separación perpendicular de un punto fuera de ruta', () => {
    // ~111 m al norte (0.001 grados de latitud)
    const p = projectOnLine([-99.135, 19.431], line)!
    expect(p.distM).toBeGreaterThan(100)
    expect(p.distM).toBeLessThan(120)
  })

  it('recorta a los extremos en vez de extender la línea', () => {
    const p = projectOnLine([-99.200, 19.430], line)!
    expect(p.index).toBe(0)
    expect(p.point[0]).toBeCloseTo(-99.14, 5)
  })

  it('avanza el índice conforme el chofer recorre la ruta', () => {
    expect(projectOnLine([-99.1395, 19.43], line)!.index).toBe(0)
    expect(projectOnLine([-99.1205, 19.43], line)!.index).toBe(2)
  })

  it('no truena con línea vacía', () => {
    expect(projectOnLine([-99.1, 19.4], [])).toBeNull()
  })
})

describe('splitLegs', () => {
  const line: LngLat[] = [
    [-99.14, 19.43],
    [-99.13, 19.43],
    [-99.12, 19.43],
    [-99.11, 19.43],
    [-99.10, 19.43],
  ]

  it('parte en un tramo por cada parada', () => {
    const legs = splitLegs(line, [
      [-99.12, 19.43],
      [-99.10, 19.43],
    ])
    expect(legs).toHaveLength(2)
    expect(legs[0][0]).toEqual([-99.14, 19.43])
    expect(legs[0][legs[0].length - 1]).toEqual([-99.12, 19.43])
    expect(legs[1][0]).toEqual([-99.12, 19.43])
    expect(legs[1][legs[1].length - 1]).toEqual([-99.10, 19.43])
  })

  it('no retrocede si una parada cae antes en la línea', () => {
    const legs = splitLegs(line, [
      [-99.11, 19.43],
      [-99.13, 19.43], // atrás: se ancla al mismo vértice o posterior
    ])
    expect(legs.length).toBeLessThanOrEqual(2)
    for (const leg of legs) expect(leg.length).toBeGreaterThanOrEqual(2)
  })
})

describe('currentStepIndex', () => {
  const steps: Step[] = [
    { instruction: 'Sigue derecho', distance: 100, duration: 20, way_points: [0, 3] },
    { instruction: 'Gira a la derecha', distance: 200, duration: 40, way_points: [3, 7] },
    { instruction: 'Has llegado', distance: 0, duration: 0, way_points: [7, 7] },
  ]

  it('elige la maniobra del tramo en curso', () => {
    expect(currentStepIndex(steps, 0)).toBe(0)
    expect(currentStepIndex(steps, 2)).toBe(0)
    expect(currentStepIndex(steps, 3)).toBe(1)
    expect(currentStepIndex(steps, 6)).toBe(1)
  })

  it('devuelve -1 al terminar la ruta', () => {
    expect(currentStepIndex(steps, 7)).toBe(-1)
  })

  it('nunca retrocede mientras el índice avanza', () => {
    let last = -Infinity
    for (let i = 0; i < 7; i++) {
      const s = currentStepIndex(steps, i)
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
  })
})

describe('metersAlong', () => {
  const line: LngLat[] = [
    [-99.140, 19.430],
    [-99.130, 19.430],
    [-99.120, 19.430],
  ]

  it('suma los segmentos hasta el vértice destino', () => {
    const d = metersAlong(line, [-99.140, 19.430], 0, 2)
    expect(d).toBeGreaterThan(2000) // ~2.1 km
    expect(d).toBeLessThan(2200)
  })

  it('se acorta conforme el chofer se acerca', () => {
    const lejos = metersAlong(line, [-99.140, 19.43], 0, 2)
    const cerca = metersAlong(line, [-99.125, 19.43], 1, 2)
    expect(cerca).toBeLessThan(lejos)
  })
})

describe('shouldSend', () => {
  const base: Fix = { lng: -99.13, lat: 19.43, at: 1_000_000 }

  it('siempre manda la primera posición', () => {
    expect(shouldSend(null, base)).toBe(true)
  })

  it('calla si no pasó tiempo ni hubo movimiento', () => {
    expect(shouldSend(base, { ...base, at: base.at + 500 })).toBe(false)
  })

  it('manda al cumplirse el intervalo aunque esté parado', () => {
    expect(shouldSend(base, { ...base, at: base.at + 3000 })).toBe(true)
  })

  it('manda si se movió lo suficiente aunque sea inmediato', () => {
    // ~55 m al este
    expect(shouldSend(base, { ...base, lng: -99.1295, at: base.at + 100 })).toBe(true)
  })
})

describe('buffer offline', () => {
  // Storage mínimo en memoria — no hace falta jsdom para esto
  const mem = (): Storage => {
    const m = new Map<string, string>()
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      length: 0,
    } as Storage
  }

  it('guarda y recupera posiciones en orden', () => {
    const s = mem()
    bufferFix({ lng: -99.13, lat: 19.43, at: 1 }, s)
    bufferFix({ lng: -99.14, lat: 19.44, at: 2 }, s)
    expect(readBuffer(s).map((f) => f.at)).toEqual([1, 2])
  })

  it('descarta las más viejas en vez de crecer sin límite', () => {
    const s = mem()
    for (let i = 0; i < 400; i++) bufferFix({ lng: -99.13, lat: 19.43, at: i }, s)
    const out = readBuffer(s)
    expect(out).toHaveLength(300)
    expect(out[out.length - 1].at).toBe(399) // se conservan las recientes
  })

  it('devuelve vacío si el JSON está corrupto en vez de tumbar el tracking', () => {
    const s = mem()
    s.setItem('mapdash:pending', '{no es json')
    expect(readBuffer(s)).toEqual([])
  })

  it('clearBuffer vacía', () => {
    const s = mem()
    bufferFix({ lng: -99.13, lat: 19.43, at: 1 }, s)
    clearBuffer(s)
    expect(readBuffer(s)).toEqual([])
  })
})

describe('fmtAge', () => {
  const min = 60_000
  it('usa segundos abajo del minuto', () => {
    expect(fmtAge(12_000)).toBe('12 s')
  })
  it('usa minutos abajo de la hora', () => {
    expect(fmtAge(59 * min)).toBe('59 min')
  })
  it('parte en horas y minutos', () => {
    expect(fmtAge(125 * min)).toBe('2 h 5 min')
  })
  it('parte en días y horas', () => {
    expect(fmtAge(2089 * min)).toBe('1 d 10 h')
  })
  it('omite la unidad menor cuando es cero', () => {
    expect(fmtAge(3 * 60 * min)).toBe('3 h')
    expect(fmtAge(48 * 60 * min)).toBe('2 d')
  })
  it('sin dato conocido no inventa un número', () => {
    expect(fmtAge(Infinity)).toBe('—')
  })
})
