// Un solo equipo por dispositivo.
//
// El caso real: el chofer abre el link de un equipo, y más tarde el de otro sin
// cerrar la pestaña anterior. Las dos siguen mandando posiciones y en el panel
// aparecen dos vans moviéndose exactamente igual.
//
// Se resuelve con un dueño único guardado en localStorage. Gana el último que
// reclama, y las demás pestañas se enteran por el evento `storage`, que solo
// llega a las *otras* pestañas del mismo origen — justo lo que hace falta.
//
// Sin heartbeat ni caducidad a propósito: si una pestaña se cierra, su marca
// queda, pero la siguiente que arranque la reclama igual. Nunca hay bloqueo.

const KEY = 'mapdash:owner'
const DEVICE_KEY = 'mapdash:device'

/**
 * Identidad estable de ESTE navegador, para que el servidor pueda vincular un
 * equipo a un solo dispositivo. Persiste entre recargas; se pierde si el chofer
 * borra los datos del navegador, y para ese caso existe la liberación por
 * inactividad del lado del servidor.
 */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

/** Identidad de ESTA pestaña. Vive en memoria: una recarga es una pestaña nueva. */
const TAB = Math.random().toString(36).slice(2)

interface Owner {
  tab: string
  token: string
}

function read(): Owner | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Owner) : null
  } catch {
    return null
  }
}

/** Esta pestaña pasa a ser la única que rastrea en el dispositivo. */
export function claimDevice(token: string): void {
  localStorage.setItem(KEY, JSON.stringify({ tab: TAB, token } satisfies Owner))
}

export function isDeviceOwner(): boolean {
  const o = read()
  // Sin dueño todavía, el primero que pregunte puede seguir: el arranque
  // reclama de inmediato y no tiene sentido bloquear al único que hay.
  return !o || o.tab === TAB
}

/** Token del equipo que se quedó con el dispositivo, para poder nombrarlo. */
export function ownerToken(): string | null {
  return read()?.token ?? null
}

/** Avisa cuando otra pestaña reclama el dispositivo. Devuelve la baja. */
export function onDeviceTaken(fn: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === KEY && !isDeviceOwner()) fn()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
