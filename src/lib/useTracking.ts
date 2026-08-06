import { useCallback, useEffect, useRef, useState } from 'react'
import { bufferFix, clearBuffer, readBuffer, shouldSend, type Fix } from './geo'
import { deviceId } from './deviceLock'
import { isInUse, isReleased, reportPosition, type TrackStatus } from './supabase'

export type TrackError = 'permiso' | 'no-disponible' | 'sin-soporte' | null

interface State {
  fix: Fix | null
  tracking: boolean
  /** El navegador prometió mantener la pantalla encendida. */
  awake: boolean
  online: boolean
  pending: number
  error: TrackError
  /** Ids de puntos alcanzados en el último reporte. */
  arrived: string[]
  /** El servidor rechazó este dispositivo: el equipo lo tiene otro teléfono. */
  inUse: boolean
  /** El admin liberó el vínculo mientras este teléfono estaba reportando. */
  released: boolean
}

/**
 * Comparte la ubicación del chofer y mantiene la pantalla encendida.
 *
 * Lo que este hook NO puede hacer, y ningún hook puede: seguir mandando
 * posiciones con el teléfono bloqueado o con otra app al frente. iOS suspende
 * la pestaña y `watchPosition` deja de disparar. Por eso el estado se reporta
 * explícitamente ('en_maps') antes de salir y se reanuda solo al volver.
 */
export function useTracking(token: string) {
  const [state, setState] = useState<State>({
    fix: null,
    tracking: false,
    awake: false,
    online: navigator.onLine,
    pending: readBuffer().length,
    error: null,
    arrived: [],
    inUse: false,
    released: false,
  })

  // Identidad del navegador, estable entre recargas.
  const [device] = useState(deviceId)

  const watchId = useRef<number | null>(null)
  const lock = useRef<WakeLockSentinel | null>(null)
  const lastSent = useRef<Fix | null>(null)
  const latestFix = useRef<Fix | null>(null)
  const status = useRef<TrackStatus>('live')
  const sending = useRef(false)

  const acquireLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return
    try {
      lock.current = await navigator.wakeLock.request('screen')
      lock.current.addEventListener('release', () => setState((s) => ({ ...s, awake: false })))
      setState((s) => ({ ...s, awake: true }))
    } catch {
      // Safari lo rechaza en batería baja. No es fatal: el tracking sigue
      // mientras la pantalla esté encendida, solo que se apagará sola.
      setState((s) => ({ ...s, awake: false }))
    }
  }, [])

  /** Envía la posición y, si hay backlog del túnel, lo vacía primero. */
  const send = useCallback(
    async (fix: Fix) => {
      if (sending.current) return
      sending.current = true
      try {
        const backlog = readBuffer()
        if (backlog.length) {
          // En orden cronológico: report_position descarta lo que llegue viejo.
          for (const b of backlog) {
            await reportPosition(token, { ...b, status: status.current, at: b.at }, device)
          }
          clearBuffer()
          setState((s) => ({ ...s, pending: 0 }))
        }
        const arrived = await reportPosition(
          token,
          { ...fix, status: status.current, at: fix.at },
          device,
        )
        lastSent.current = fix
        setState((s) => ({ ...s, online: true, arrived }))
      } catch (e) {
        // El equipo lo tomó otro teléfono: guardar estas posiciones no serviría
        // de nada, el servidor las va a seguir rechazando. Se corta y se avisa.
        if (isInUse(e)) {
          clearBuffer()
          if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
          watchId.current = null
          setState((s) => ({ ...s, tracking: false, inUse: true }))
          return
        }
        if (isReleased(e)) {
          clearBuffer()
          if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
          watchId.current = null
          void lock.current?.release().catch(() => {})
          lock.current = null
          setState((s) => ({
            ...s,
            tracking: false,
            awake: false,
            pending: 0,
            released: true,
          }))
          return
        }
        bufferFix(fix)
        setState((s) => ({ ...s, online: false, pending: readBuffer().length }))
      } finally {
        sending.current = false
      }
    },
    [token, device],
  )

  const start = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      setState((s) => ({ ...s, error: 'sin-soporte' }))
      return
    }
    // Ya hay un watch vivo. Sin esto, un segundo start (StrictMode, o el
    // reanudar automático solapado con el botón) dejaría el primero huérfano
    // y duplicaría los envíos de posición.
    if (watchId.current != null) return
    status.current = 'live'
    await acquireLock()

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: Fix = {
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          at: pos.timestamp,
        } as Fix
        latestFix.current = fix
        setState((s) => ({ ...s, fix, tracking: true, error: null }))
        if (shouldSend(lastSent.current, fix)) void send(fix)
      },
      (err) => {
        setState((s) => ({
          ...s,
          error: err.code === err.PERMISSION_DENIED ? 'permiso' : 'no-disponible',
          tracking: false,
        }))
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    )
    setState((s) => ({ ...s, tracking: true }))
  }, [acquireLock, send])

  // Además de las lecturas del GPS, mantiene vivo el vínculo cada 5 s. Esto
  // permite detectar una liberación del admin aunque el teléfono esté quieto y
  // watchPosition no produzca una lectura nueva.
  useEffect(() => {
    const id = setInterval(() => {
      if (watchId.current == null || !latestFix.current) return
      void send({ ...latestFix.current, at: Date.now() })
    }, 5000)
    return () => clearInterval(id)
  }, [send])

  const stop = useCallback(async () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
    watchId.current = null
    await lock.current?.release().catch(() => {})
    lock.current = null
    status.current = 'pausado'
    const last = state.fix
    if (last) await reportPosition(token, { ...last, status: 'pausado' }, device).catch(() => {})
    setState((s) => ({ ...s, tracking: false, awake: false }))
  }, [state.fix, token, device])

  /**
   * Capa 1/2: el chofer sale a Google Maps.
   * Se avisa ANTES de salir, con la última posición conocida, para que el panel
   * lo pinte en ámbar ("en Maps") y no en gris ("lo perdimos").
   */
  const goToMaps = useCallback(
    async (lat: number, lng: number) => {
      status.current = 'en_maps'
      if (state.fix) {
        await reportPosition(token, { ...state.fix, status: 'en_maps' }, device).catch(() => {})
      }
      // El esquema comgooglemaps:// abre la app nativa (que sí navega en
      // segundo plano). Si no está instalada, el navegador ignora el salto y
      // el fallback web se abre a los 600 ms.
      const started = Date.now()
      window.location.href = `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`
      setTimeout(() => {
        if (Date.now() - started < 1500 && document.visibilityState === 'visible') {
          window.location.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
        }
      }, 600)
    },
    [state.fix, token, device],
  )

  // Al volver de Maps (o de bloquear el teléfono) se reanuda solo: se recupera
  // el wake lock, se vuelve a marcar 'live' y se vacía el buffer. Sin tocar nada.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !state.tracking) return
      status.current = 'live'
      void acquireLock()
      const pending = readBuffer()
      if (pending.length && state.fix) void send(state.fix)
    }
    const onOnline = () => {
      setState((s) => ({ ...s, online: true }))
      if (state.fix && state.tracking) void send(state.fix)
    }
    const onOffline = () => setState((s) => ({ ...s, online: false }))

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [acquireLock, send, state.fix, state.tracking])

  useEffect(() => {
    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
      void lock.current?.release().catch(() => {})
    }
  }, [])

  const resetAccess = useCallback(() => {
    setState((s) => ({ ...s, inUse: false, released: false }))
  }, [])

  return { ...state, start, stop, goToMaps, resetAccess }
}
