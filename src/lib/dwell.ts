// Cuenta regresiva de permanencia en una parada.
//
// No hay temporizador que corra en ningún lado: todo se deriva de la hora de
// llegada guardada en la base. Recargar la pestaña, quedarse sin señal o mirar
// desde el panel dan exactamente el mismo número.

/** Minutos restantes que se anuncian por voz al chofer. */
export const DWELL_ALERTS = [10, 5]

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
