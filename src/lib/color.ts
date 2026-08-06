// Los colores de paradas y equipos los elige el usuario con un selector, así
// que puede salir cualquier cosa: amarillo chillón o azul marino. El texto
// encima tiene que seguir leyéndose en los dos casos.

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Luminancia relativa (WCAG). 0 = negro, 1 = blanco. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Texto blanco o negro, el que contraste con el fondo dado. */
export function contrastText(hex: string): string {
  return luminance(hex) > 0.45 ? '#111318' : '#ffffff'
}

/** El mismo color con transparencia, para fondos suaves. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

/**
 * Aclara un color oscuro lo justo para que se lea sobre fondo gris oscuro.
 * Un azul marino como texto sobre #18181b es ilegible; esto lo sube de tono
 * sin cambiar el matiz que eligió el usuario.
 */
export function readable(hex: string, min = 0.28): string {
  const l = luminance(hex)
  if (l >= min) return hex
  const [r, g, b] = rgb(hex)
  const k = Math.min(2.4, Math.sqrt(min / Math.max(l, 0.01)))
  const up = (v: number) => Math.round(Math.min(255, v * k + 40))
  return `rgb(${up(r)},${up(g)},${up(b)})`
}
