import { describe, expect, it } from 'vitest'
import { toPlaces } from './geocode'

describe('toPlaces', () => {
  it('encuadra con las dos esquinas del bbox cuando viene', () => {
    const [p] = toPlaces({
      features: [
        {
          id: 'place.1',
          place_name_es: 'Monterrey, Nuevo León',
          center: [-100.31, 25.68],
          bbox: [-100.5, 25.5, -100.1, 25.9],
        },
      ],
    })
    expect(p.name).toBe('Monterrey, Nuevo León')
    expect(p.coords).toEqual([
      [-100.5, 25.5],
      [-100.1, 25.9],
    ])
  })

  it('usa el punto cuando no hay bbox', () => {
    const [p] = toPlaces({
      features: [{ id: 'a.1', place_name: 'Av. Constitución 100', center: [-100.31, 25.68] }],
    })
    expect(p.coords).toEqual([[-100.31, 25.68]])
  })

  it('descarta lo que no trae coordenadas y aguanta una respuesta vacía', () => {
    expect(toPlaces({ features: [{ id: 'x', text: 'sin coords' }] })).toEqual([])
    expect(toPlaces({})).toEqual([])
  })
})
