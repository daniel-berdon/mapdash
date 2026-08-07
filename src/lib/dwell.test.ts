import { describe, expect, it } from 'vitest'
import { dwellAlertDue, dwellLeftMs, dwellLevel, fmtCountdown, lunchStatus } from './dwell'

const MIN = 60_000
const t0 = new Date('2026-08-07T12:00:00Z')
const at = (ms: number) => t0.getTime() + ms

describe('dwellLeftMs', () => {
  it('descuenta desde la llegada', () => {
    expect(dwellLeftMs(t0.toISOString(), 30, at(10 * MIN))).toBe(20 * MIN)
  })

  it('no baja de cero cuando ya se cumplió', () => {
    expect(dwellLeftMs(t0.toISOString(), 30, at(90 * MIN))).toBe(0)
  })

  it('una parada de paso no tiene cuenta regresiva', () => {
    expect(dwellLeftMs(t0.toISOString(), 0, at(MIN))).toBe(0)
  })
})

describe('fmtCountdown', () => {
  it('cuenta en mm:ss', () => {
    expect(fmtCountdown(9 * MIN + 5_000)).toBe('9:05')
  })

  it('pasa a h:mm:ss arriba de la hora', () => {
    expect(fmtCountdown(75 * MIN)).toBe('1:15:00')
  })

  it('redondea hacia arriba: 0:00 solo cuando de verdad terminó', () => {
    expect(fmtCountdown(200)).toBe('0:01')
    expect(fmtCountdown(0)).toBe('0:00')
  })
})

describe('dwellAlertDue', () => {
  it('avisa al cruzar la marca', () => {
    expect(dwellAlertDue(10 * MIN, 10)).toBe(true)
    expect(dwellAlertDue(9.5 * MIN, 10)).toBe(true)
  })

  it('todavía no, si falta más que la marca', () => {
    expect(dwellAlertDue(11 * MIN, 10)).toBe(false)
  })

  // El caso que motiva la ventana: recargar con la marca ya pasada.
  it('no dispara un aviso vencido', () => {
    expect(dwellAlertDue(3 * MIN, 10)).toBe(false)
    expect(dwellAlertDue(3 * MIN, 5)).toBe(false)
  })
})

describe('dwellLevel', () => {
  it('sin urgencia arriba de 10 minutos', () => {
    expect(dwellLevel(11 * MIN)).toBe('')
  })

  it('naranja de 10 a 5 minutos', () => {
    expect(dwellLevel(10 * MIN)).toBe('orange')
    expect(dwellLevel(5 * MIN + 1)).toBe('orange')
  })

  it('rojo en los últimos 5', () => {
    expect(dwellLevel(5 * MIN)).toBe('red')
    expect(dwellLevel(1_000)).toBe('red')
  })
})

describe('lunchStatus', () => {
  const started = (ms: number) => new Date(at(ms)).toISOString()

  it('sin lunch mientras no haya hora de inicio', () => {
    expect(lunchStatus(null, null, 45, at(0)).phase).toBe('none')
  })

  // Se programa al llegar a la parada anterior: la hora queda en el futuro
  // hasta que esa parada termina.
  it('programado si la hora todavía no llegó', () => {
    const r = lunchStatus(started(30 * MIN), null, 45, at(0))
    expect(r.phase).toBe('programado')
    expect(r.left).toBe(30 * MIN)
  })

  it('activo descuenta desde el inicio', () => {
    const r = lunchStatus(started(0), null, 45, at(10 * MIN))
    expect(r.phase).toBe('activo')
    expect(r.left).toBe(35 * MIN)
  })

  it('terminado al agotarse el tiempo', () => {
    expect(lunchStatus(started(0), null, 45, at(46 * MIN)).phase).toBe('terminado')
  })

  it('terminado si el chofer lo cerró antes', () => {
    expect(lunchStatus(started(0), started(5 * MIN), 45, at(10 * MIN)).phase).toBe('terminado')
  })
})
