// Cuenta regresiva de permanencia en una parada.
//
// No hay temporizador que corra en ningún lado: todo se deriva de la hora de
// llegada guardada en la base. Recargar la pestaña, quedarse sin señal o mirar
// desde el panel dan exactamente el mismo número.

/** Minutos restantes que se anuncian por voz al chofer. */
export const DWELL_ALERTS = [10, 5]

/**
 * Urgencia del cronómetro, con los mismos cortes que los avisos por voz: el
 * color y la locución tienen que decir lo mismo en el mismo momento.
 */
export function dwellLevel(leftMs: number): '' | 'orange' | 'red' {
  if (leftMs <= 5 * 60_000) return 'red'
  if (leftMs <= 10 * 60_000) return 'orange'
  return ''
}

export type LunchPhase = 'none' | 'programado' | 'activo' | 'terminado'

/**
 * Estado del lunch break, con la misma idea que la estancia: solo se guarda la
 * hora de inicio y todo lo demás se deriva.
 *
 * `lunch_started_at` puede estar en el futuro — se programa al llegar a la
 * parada anterior y corre recién cuando esa parada termina. De ahí que haya un
 * estado 'programado' además de 'activo'; `left` es la cuenta regresiva del
 * que esté en curso.
 */
export function lunchStatus(
  startedAt: string | null,
  endedAt: string | null,
  lunchMin: number,
  now: number,
): { phase: LunchPhase; left: number } {
  if (!startedAt) return { phase: 'none', left: 0 }
  if (endedAt) return { phase: 'terminado', left: 0 }
  const start = new Date(startedAt).getTime()
  if (now < start) return { phase: 'programado', left: start - now }
  const left = start + lunchMin * 60_000 - now
  return left > 0 ? { phase: 'activo', left } : { phase: 'terminado', left: 0 }
}

/** Milisegundos que faltan para cumplir la estancia. 0 = cumplida o sin tiempo. */
export function dwellLeftMs(arrivedAt: string, dwellMin: number, now: number): number {
  if (!dwellMin) return 0
  const left = new Date(arrivedAt).getTime() + dwellMin * 60_000 - now
  return left > 0 ? left : 0
}

/** mm:ss, o h:mm:ss cuando la estancia pasa de una hora. */
export function fmtCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  if (m < 60) return `${m}:${two(s)}`
  return `${Math.floor(m / 60)}:${two(m % 60)}:${two(s)}`
}

/**
 * ¿Toca anunciar los `mark` minutos restantes?
 *
 * Solo durante el minuto siguiente al cruce. Sin esa ventana, un chofer que
 * recarga la pestaña con 3 minutos por delante oiría "quedan 10 minutos" y
 * "quedan 5": los avisos ya vencidos no se pueden disparar tarde.
 */
export function dwellAlertDue(leftMs: number, mark: number): boolean {
  const at = mark * 60_000
  return leftMs <= at && leftMs > at - 60_000
}
