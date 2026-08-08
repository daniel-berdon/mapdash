import {
  Check,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Flag,
  Info,
  MapPin,
  Navigation,
  Play,
  Power,
  Radio,
  RefreshCw,
  Sandwich,
  Smartphone,
  Timer,
  TriangleAlert,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react'
import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Brand from '../components/Brand'
import { VanIcon, stopIcon } from '../components/icons'
import Map, { type MapPoint, type MapRoute } from '../components/Map'
import { alpha, contrastText, readable } from '../lib/color'
import {
  DWELL_ALERTS,
  dwellAlertDue,
  dwellLeftMs,
  dwellLevel,
  fmtCountdown,
  lunchStatus,
} from '../lib/dwell'
import {
  currentStepIndex,
  distM,
  fmtDist,
  fmtDur,
  metersAlong,
  projectOnLine,
  splitLegs,
  type LngLat,
  type Step,
} from '../lib/geo'
import { getRoute } from '../lib/routing'
import {
  claimTeam,
  finishDwell,
  getDriverContext,
  listTeams,
  manualCheckin,
  registerTrackingStart,
  setLunch,
  type DriverContext,
  type Stop,
  type TeamChoice,
} from '../lib/supabase'
import { claimDevice, deviceId, onDeviceTaken } from '../lib/deviceLock'
import { useTracking } from '../lib/useTracking'

// iOS exige que la primera locución salga de un gesto del usuario, por eso se
// dispara una vez al tocar "Iniciar". Después ya funciona sola.
function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'es-MX'
  window.speechSynthesis.speak(u)
}

/** ORS dice "Camina" aunque la ruta sea en coche; se corrige al narrar/mostrar. */
function driveWording(text: string): string {
  return text
    .replace(/\bCamina\b/gi, 'Conduce')
    .replace(/\bCamine\b/gi, 'Conduce')
    .replace(/\bCaminar\b/gi, 'Conducir')
    .replace(/\ba pie\b/gi, 'en auto')
    .replace(/\bpeatonal\b/gi, 'vehicular')
}

const OFF_ROUTE_M = 100
const OFF_ROUTE_MS = 15000
const ANNOUNCE_M = [300, 50]

const TOKEN_KEY = 'mapdash:team'
const STARTED_KEY = 'mapdash:started'

export default function Driver() {
  const { token: urlToken } = useParams()
  const navigate = useNavigate()
  // /seleccion siempre muestra la lista. Al elegir se navega al enlace individual,
  // que conserva el equipo también después de recargar la pestaña.
  const token = urlToken ?? ''

  const [ctx, setCtx] = useState<DriverContext | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Persistido: iOS descarta y recarga pestañas inactivas cuando anda escaso de
  // memoria. Si esto viviera solo en memoria, el chofer volvería a la pantalla
  // de bienvenida y dejaría de compartir ubicación sin enterarse.
  const [started, setStarted] = useState(() => localStorage.getItem(STARTED_KEY) === '1')
  // La cámara sigue al chofer, pero si él mueve el mapa con el dedo se suelta:
  // si no, cada lectura de GPS le arrancaría el mapa de las manos.
  const [follow, setFollow] = useState(true)
  const [voice, setVoice] = useState(true)
  const [showList, setShowList] = useState(false)
  const [checkingIn, setCheckingIn] = useState(false)
  /** Ruta recalculada en vivo tras un desvío; pisa a la de la base. */
  const [detour, setDetour] = useState<{ coordinates: LngLat[]; steps: Step[] } | null>(null)

  const t = useTracking(token)

  // Abrir el link individual también deja el equipo guardado: si el chofer
  // pierde el mensaje de WhatsApp, entra por el link general y sigue siendo él.
  useEffect(() => {
    if (urlToken) localStorage.setItem(TOKEN_KEY, urlToken)
  }, [urlToken])

  // Tras una recarga inesperada, volver a rastrear sin pedirle nada al chofer:
  // el permiso de ubicación ya está concedido y él ya dio su consentimiento.
  const resumed = useRef(false)
  useEffect(() => {
    if (!started || !token || resumed.current) return
    resumed.current = true
    claimDevice(token)
    // Al reanudar tras una recarga también hay que revalidar: mientras la
    // pestaña estuvo muerta, otro teléfono pudo haber tomado el equipo.
    const device = deviceId()
    void claimTeam(token, device)
      .then(async (r) => {
        if (!r.ok) return setTaken(r.minutes ?? 0)
        await registerTrackingStart(token, device).catch(() => {})
        return t.start()
      })
      .catch(() => t.start())
    // `t` cambia de identidad en cada render; el ref es lo que evita repetirlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, token])

  // Otra pestaña de este mismo teléfono se quedó con el rastreo: esta suelta el
  // GPS. Si no, el panel vería dos equipos moviéndose a la vez desde un dispositivo.
  const [displaced, setDisplaced] = useState(false)
  /** Minutos que lleva el otro dispositivo, si este equipo ya está tomado. */
  const [taken, setTaken] = useState<number | null>(null)
  useEffect(
    () =>
      onDeviceTaken(() => {
        setDisplaced(true)
        void t.stop()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const load = useCallback(async () => {
    if (!token) return
    try {
      setCtx(await getDriverContext(token))
      setErr(null)
    } catch (e) {
      // El chofer no puede hacer nada con un stack trace. Dos casos reales:
      // el link está mal, o no hay señal.
      setErr(
        (e as Error).message.includes('token')
          ? 'Este link no es válido. Pídele al organizador que te mande el tuyo.'
          : 'Sin conexión. Revisa tus datos móviles y vuelve a intentar.',
      )
    }
  }, [token])

  useEffect(() => {
    void load()
    // El admin puede reordenar la ruta o mover una parada durante la dinámica.
    const id = setInterval(() => void load(), 30000)
    return () => clearInterval(id)
  }, [load])

  // Check-in automático: el servidor decide, aquí solo se refleja y se anuncia.
  const announced = useRef(new Set<string>())
  useEffect(() => {
    if (!t.arrived.length || !ctx) return
    for (const id of t.arrived) {
      if (announced.current.has(id)) continue
      announced.current.add(id)
      const p = ctx.stops.find((s) => s.id === id)
      if (p && voice) speak(`Llegaste a ${p.name}`)
    }
    void load()
  }, [t.arrived, ctx, voice, load])

  /**
   * speechSynthesis tiene su propia cola y sobrevive a que cambie la pantalla:
   * al desvincular el equipo, el chofer volvía al selector con la voz todavía
   * narrando maniobras de una ruta que ya no es suya. Silenciar la voz tampoco
   * callaba lo que ya estaba encolado.
   */
  const onRoute = Boolean(token && started && ctx && taken === null && !t.inUse && !displaced)
  useEffect(() => {
    if (!onRoute || !voice) window.speechSynthesis?.cancel()
    return () => window.speechSynthesis?.cancel()
  }, [onRoute, voice])

  const me: LngLat | null = t.fix ? [t.fix.lng, t.fix.lat] : null
  const pending = useMemo(() => (ctx?.stops ?? []).filter((s) => !s.visited_at), [ctx])
  const next: Stop | undefined = pending[0]

  // --- permanencia en la parada (capa 4) ---
  // El cronómetro se deriva de la hora de llegada que guardó el servidor, no de
  // un contador local: recargar la pestaña o perder señal no lo reinician.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const dwell = useMemo(() => {
    let best: { stop: Stop; left: number; at: number } | null = null
    for (const s of ctx?.stops ?? []) {
      // left_at = el chofer ya cerró la actividad; el reloj no vuelve a correr.
      if (!s.visited_at || s.left_at) continue
      const left = dwellLeftMs(s.visited_at, s.dwell_min, now)
      if (!left) continue
      const at = new Date(s.visited_at).getTime()
      if (!best || at > best.at) best = { stop: s, left, at }
    }
    return best
  }, [ctx, now])

  // El lunch pausa la ruta: no es una parada, no tiene lugar ni geofence.
  const lunch = lunchStatus(
    ctx?.team.lunch_started_at ?? null,
    ctx?.team.lunch_ended_at ?? null,
    ctx?.lunch_min ?? 45,
    now,
  )

  // Avisos por voz: faltan 10, faltan 5, y el aviso de que ya puede seguir.
  const dwellSaid = useRef(new Set<string>())
  const dwellingAt = useRef<Stop | null>(null)
  useEffect(() => {
    const prev = dwellingAt.current
    dwellingAt.current = dwell?.stop ?? null
    if (!dwell) {
      // Se cumplió mientras la pantalla estaba abierta. Tras una recarga con el
      // tiempo ya vencido, prev es null y no se anuncia nada viejo.
      if (prev && voice) speak(`Tiempo cumplido en ${prev.name}. Puedes continuar.`)
      return
    }
    for (const mark of DWELL_ALERTS) {
      const key = `${dwell.stop.id}@${mark}`
      if (!dwellAlertDue(dwell.left, mark) || dwellSaid.current.has(key)) continue
      dwellSaid.current.add(key)
      if (voice) speak(`Quedan ${mark} minutos en ${dwell.stop.name}`)
    }
  }, [dwell, voice])

  const line = detour?.coordinates ?? ctx?.route?.geometry?.coordinates ?? []
  const steps = detour?.steps ?? ctx?.route?.steps ?? []

  // --- navegación propia (capa 3) ---
  const proj = useMemo(() => (me && line.length ? projectOnLine(me, line) : null), [me, line])
  const stepIdx = proj ? currentStepIndex(steps, proj.index) : -1
  const step = stepIdx >= 0 ? steps[stepIdx] : null
  const instruction = step ? driveWording(step.instruction) : ''
  const toManeuver =
    step && me && proj ? metersAlong(line, me, proj.index, step.way_points[1]) : null

  // Voz: cada maniobra se anuncia a 300 m y a 50 m, una sola vez cada una.
  const spoken = useRef(new Set<string>())
  useEffect(() => {
    if (!voice || !step || !instruction || toManeuver == null || stepIdx < 0) return
    for (const mark of ANNOUNCE_M) {
      const key = `${stepIdx}@${mark}`
      if (toManeuver <= mark && !spoken.current.has(key)) {
        spoken.current.add(key)
        speak(mark >= 200 ? `En ${fmtDist(toManeuver)}, ${instruction}` : instruction)
        break
      }
    }
  }, [stepIdx, toManeuver, step, instruction, voice])

  // La ruta de la base va de parada a parada. Aquí se traza desde DONDE ESTÁ
  // el chofer: al arrancar, al llegar a una parada y si se desvía.
  const offSince = useRef<number | null>(null)
  const recalculating = useRef(false)
  // Firma de las paradas pendientes con las que se calculó el trazo actual.
  // Cambia al llegar o si el admin reordena: hay que pedir ruta nueva.
  const routedFor = useRef<string | null>(null)
  const pendingKey = pending.map((s) => s.id).join(',')
  const pendingKeyRef = useRef(pendingKey)
  pendingKeyRef.current = pendingKey
  // Empujón para reintentar si las paradas cambiaron a mitad de un cálculo.
  const [routeTick, setRouteTick] = useState(0)

  useEffect(() => {
    if (!pending.length) {
      setDetour(null)
      routedFor.current = null
      offSince.current = null
      return
    }
    if (!me || recalculating.current) return

    const key = pendingKey
    const stale = routedFor.current !== key
    const offRoute = proj != null && proj.distM > OFF_ROUTE_M
    if (offRoute) offSince.current ??= Date.now()
    else if (!stale) offSince.current = null

    const offLongEnough =
      offRoute && offSince.current != null && Date.now() - offSince.current >= OFF_ROUTE_MS

    // Primera vez (o tras un check-in): se pide ya, sin esperar el desvío.
    // Desvío: solo tras OFF_ROUTE_MS, para que un GPS nervioso no dispare ORS.
    if (!stale && !offLongEnough) return

    recalculating.current = true
    const announce = offLongEnough && !stale
    getRoute([me, ...pending.map((s) => [s.lng, s.lat] as LngLat)])
      .then((r) => {
        setDetour({ coordinates: r.geometry.coordinates, steps: r.steps })
        routedFor.current = key
        spoken.current.clear()
        offSince.current = null
        if (announce && voice) speak('Recalculando ruta')
      })
      // Si ORS falla se conserva lo que haya: peor es dejar la pantalla vacía.
      .catch(() => {})
      .finally(() => {
        recalculating.current = false
        // Si llegó otra parada mientras ORS respondía, hay que trazar de nuevo.
        if (routedFor.current !== pendingKeyRef.current) setRouteTick((n) => n + 1)
      })
  }, [me, proj, pending, pendingKey, voice, routeTick])

  const handleStart = async () => {
    // Reservar el equipo ANTES de encender el GPS: si lo tiene otro teléfono,
    // no tiene sentido empezar a rastrear para que el servidor lo rechace.
    try {
      const device = deviceId()
      const r = await claimTeam(token, device)
      if (!r.ok) {
        setTaken(r.minutes ?? 0)
        return
      }
      await registerTrackingStart(token, device).catch(() => {})
    } catch {
      alert('No se pudo verificar el equipo. Revisa la conexión e intenta de nuevo.')
      return
    }
    setTaken(null)
    localStorage.setItem(STARTED_KEY, '1')
    claimDevice(token)
    setDisplaced(false)
    resumed.current = true // ya arrancamos aquí; el efecto no debe repetirlo
    setStarted(true)
    speak('Compartiendo ubicación') // desbloquea la voz en iOS
    await t.start()
  }

  const handleStop = async () => {
    localStorage.removeItem(STARTED_KEY)
    resumed.current = false
    await t.stop()
    setStarted(false)
  }

  /** Por si el GPS no dispara el geofence: el chofer marca la parada a mano. */
  const handleCheckin = async () => {
    if (!next || checkingIn) return
    if (!confirm(`¿Registrar llegada a ${next.name}?`)) return
    setCheckingIn(true)
    try {
      const arrived = await manualCheckin(token, next.id, deviceId())
      for (const id of arrived) {
        if (announced.current.has(id)) continue
        announced.current.add(id)
        if (voice) speak(`Llegaste a ${next.name}`)
      }
      await load()
    } catch {
      alert('No se pudo registrar la parada. Revisa la conexión e intenta de nuevo.')
    } finally {
      setCheckingIn(false)
    }
  }

  /**
   * Cerrar la actividad antes de que se agote el tiempo. Se guarda en el
   * servidor (left_at); si solo se apagara en pantalla, el cronómetro volvería
   * con la siguiente recarga.
   */
  const handleFinishDwell = async () => {
    if (!dwell || checkingIn) return
    const ok = confirm(
      `¿Ya terminaron la actividad en ${dwell.stop.name}?\n\n` +
        `Quedan ${fmtCountdown(dwell.left)}. Al continuar se cierra el tiempo de ` +
        `esta parada y sigues con la ruta.`,
    )
    if (!ok) return
    setCheckingIn(true)
    try {
      await finishDwell(token, dwell.stop.id, deviceId())
      await load()
    } catch {
      alert('No se pudo cerrar el tiempo de la parada. Revisa la conexión e intenta de nuevo.')
    } finally {
      setCheckingIn(false)
    }
  }

  /** Botón de lunch break: arrancarlo antes de tiempo o darlo por terminado. */
  const handleLunch = async (start: boolean) => {
    if (checkingIn) return
    const min = ctx?.lunch_min ?? 45
    const ok = confirm(
      start
        ? `¿Iniciar el lunch break?\n\nSon ${min} minutos y la ruta queda en pausa mientras tanto.`
        : `¿Terminar el lunch break y seguir con la ruta?`,
    )
    if (!ok) return
    setCheckingIn(true)
    try {
      await setLunch(token, deviceId(), start)
      await load()
      if (voice) speak(start ? 'Lunch break iniciado' : 'Lunch break terminado. Continúa la ruta.')
    } catch {
      alert('No se pudo cambiar el lunch break. Revisa la conexión e intenta de nuevo.')
    } finally {
      setCheckingIn(false)
    }
  }

  const forget = () => {
    void t.stop()
    localStorage.removeItem(TOKEN_KEY)
    // Cambiar de equipo no debe dejar el rastreo colgado del equipo anterior.
    localStorage.removeItem(STARTED_KEY)
    resumed.current = false
    t.resetAccess()
    setStarted(false)
    setCtx(null)
    setTaken(null)
    setDisplaced(false)
    setErr(null)
    navigate('/seleccion', { replace: true })
  }

  // El admin liberó este teléfono. Se limpia la sesión y se vuelve al selector;
  // incluso si entró por /d/:token hay que quitar ese token de la URL.
  useEffect(() => {
    if (!t.released) return
    forget()
  }, [t.released]) // eslint-disable-line react-hooks/exhaustive-deps

  // Selector general: el chofer elige su equipo. Sin contraseña.
  if (!token) return <TeamPicker onPick={(tk) => {
    localStorage.setItem(TOKEN_KEY, tk)
    navigate(`/d/${tk}`)
  }} />

  if (err && !ctx) {
    return (
      <div className="splash">
        <h1>No se pudo abrir tu ruta</h1>
        <p className="muted">{err}</p>
        <button className="big" onClick={() => void load()}>
          Reintentar
        </button>
        <button className="ghost" onClick={forget}>
          Elegir otro equipo
        </button>
      </div>
    )
  }
  if (!ctx) return <Splash title="Cargando tu ruta…" sub="Un momento" />

  // El equipo ya lo tiene OTRO teléfono. Detectado al reclamar, o porque el
  // servidor rechazó una posición (t.inUse) mientras rastreábamos.
  if (taken !== null || t.inUse) {
    return (
      <div className="splash">
        <Brand big />
        <h1>Este enlace ya está en uso</h1>
        <p className="muted">
          Otro dispositivo está compartiendo la ubicación de <b>{ctx.team.name}</b>
          {taken ? ` y reportó hace ${taken} min` : ''}. Un equipo solo puede llevarlo un teléfono
          a la vez.
        </p>
        <div className="card">
          <h3>
            <Info size={16} /> Qué hacer
          </h3>
          <ul>
            <li>
              <Smartphone size={16} />
              <span>
                Si el otro teléfono es el correcto, cierra esta pestaña: aquí no hace falta nada.
              </span>
            </li>
            <li>
              <Power size={16} />
              <span>
                Si eres tú quien debe llevar el equipo, pídele al organizador que libere el enlace
                desde el panel. También se libera solo tras 5 minutos sin reportar.
              </span>
            </li>
          </ul>
        </div>
        <button className="b-primary b-big" onClick={() => void handleStart()}>
          <RefreshCw size={18} /> Volver a intentar
        </button>
      </div>
    )
  }

  // Otra pestaña de este mismo teléfono se quedó con el rastreo.
  if (displaced) {
    return (
      <div className="splash">
        <Brand big />
        <h1>Este equipo se movió a otra pestaña</h1>
        <p className="muted">
          Un teléfono solo puede compartir la ubicación de un equipo a la vez. Aquí se detuvo el
          envío; la otra pestaña es la que está reportando.
        </p>
        <button className="b-ok b-big" onClick={() => void handleStart()}>
          <Play size={18} /> Compartir {ctx.team.name} desde aquí
        </button>
        <p className="muted">Si haces esto, la otra pestaña dejará de enviar.</p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Pantalla previa: consentimiento + instrucciones. Aquí es donde el chofer se
  // entera de que se le rastrea y de cómo usar Google Maps sin romper el envío.
  // ---------------------------------------------------------------------------
  if (!started) {
    return (
      <div className="splash">
        <Brand big />
        <h1 className="team-heading">
          <span
            className="team-tag"
            style={{
              color: readable(ctx.team.color),
              background: alpha(ctx.team.color, 0.18),
              borderColor: readable(ctx.team.color),
            }}
          >
            <VanIcon size={18} /> {ctx.team.name}
          </span>
        </h1>
        <p className="muted">
          {ctx.stops.length} paradas
          {ctx.route?.distance_m ? ` · ${fmtDist(ctx.route.distance_m)}` : ''}
          {ctx.route?.duration_s ? ` · ${fmtDur(ctx.route.duration_s)}` : ''}
        </p>

        <div className="card">
          <h3>
            <Info size={16} /> Antes de arrancar
          </h3>
          <ul>
            <li>
              <MapPin size={16} />
              <span>Se compartirá tu ubicación con el organizador mientras dure la dinámica.</span>
            </li>
            <li>
              <Smartphone size={16} />
              <span>
                Deja <b>esta pantalla al frente</b> y el teléfono en el soporte. Si bloqueas el
                teléfono o pasas a otra app, se deja de compartir tu ubicación.
              </span>
            </li>
            <li>
              <Volume2 size={16} />
              <span>
                Si usas Google Maps, <b>regresa a esta pestaña</b> después de iniciar la
                navegación: Maps te sigue hablando desde el fondo y aquí sigue tu ubicación activa.
              </span>
            </li>
            <li>
              <Power size={16} />
              <span>Puedes terminar cuando quieras con el botón rojo.</span>
            </li>
          </ul>
        </div>

        <button className="b-ok b-big" onClick={handleStart}>
          <Play size={18} /> Iniciar y compartir ubicación
        </button>
        <button className="b-ghost" onClick={forget}>
          <RefreshCw size={15} /> No soy este equipo
        </button>
      </div>
    )
  }

  const mapPoints: MapPoint[] = ctx.stops.map((s) => ({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    color: s.color,
    icon: s.icon,
    seq: s.seq,
    visited: !!s.visited_at,
  }))

  // Tramo en curso a color pleno; el resto de la ruta, más tenue.
  const mapRoutes: MapRoute[] = (() => {
    if (line.length < 2) return []
    const legs = splitLegs(
      line,
      pending.map((s) => [s.lng, s.lat] as LngLat),
    )
    if (!legs.length) {
      return [{ id: 'r', color: ctx.team.color, coordinates: line, opacity: 0.9 }]
    }
    // Primero los tenues (abajo), el activo al final para que quede encima.
    return [
      ...legs.slice(1).map((coordinates, i) => ({
        id: `ahead-${i}`,
        color: ctx.team.color,
        coordinates,
        opacity: 0.28,
      })),
      {
        id: 'active',
        color: ctx.team.color,
        coordinates: legs[0],
        opacity: 0.92,
      },
    ]
  })()

  const toNext = me && next ? distM(me, [next.lng, next.lat]) : null

  return (
    <div className="driver">
      <StatusBar t={t} />

      {step ? (
        <div className="maneuver">
          <b>{toManeuver != null ? fmtDist(toManeuver) : ''}</b>
          <span>{instruction}</span>
        </div>
      ) : (
        // Sin ruta calculada no hay maniobras que dictar. Antes esto dejaba una
        // franja vacía y parecía que la app no hacía nada.
        next && (
          <div className="maneuver plain">
            <b>{toNext != null ? fmtDist(toNext) : '—'}</b>
            <span>
              {line.length > 1 ? `Rumbo a ${next.name}` : `Sin ruta trazada · ve a ${next.name}`}
            </span>
          </div>
        )
      )}

      {/* El cronómetro flota sobre el mapa en vez de ocupar una fila del panel:
          en un teléfono cada píxel que le quita al mapa es calle que el chofer
          deja de ver. */}
      <div className="map-area">
        <Map
          className="map"
          points={mapPoints}
          routes={mapRoutes}
          me={t.fix ? { lat: t.fix.lat, lng: t.fix.lng, heading: t.fix.heading } : null}
          follow={follow}
          onUserMove={() => setFollow(false)}
          fitKey={ctx.stops.length ? 'stops' : ''}
          fitTo={ctx.stops.map((s) => [s.lng, s.lat] as LngLat)}
        />

        {/* Flotante, no en la fila de abajo: es un interruptor que se toca una
            vez cada tanto y estaba comiéndole ancho a Centrar y Google Maps. */}
        <button
          className={`map-fab ${voice ? 'on' : ''}`}
          title={voice ? 'Silenciar voz' : 'Activar voz'}
          onClick={() => setVoice((v) => !v)}
        >
          {voice ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>

        {/* El lunch pausa la ruta, así que manda sobre el cronómetro de la
            parada: los dos no pueden estar corriendo a la vez. */}
        {lunch.phase === 'activo' ? (
          <div className={`dwell-pill lunch ${dwellLevel(lunch.left)}`}>
            <Sandwich size={15} />
            <b>{fmtCountdown(lunch.left)}</b>
            <span>Lunch break · ruta en pausa</span>
          </div>
        ) : (
          dwell && (
            <div className={`dwell-pill ${dwellLevel(dwell.left)}`}>
              <Timer size={15} />
              <b>{fmtCountdown(dwell.left)}</b>
              <span>
                Corre tu tiempo en{' '}
                <em style={{ color: readable(dwell.stop.color) }}>{dwell.stop.name}</em>
              </span>
            </div>
          )
        )}
      </div>

      <div className="panel">
        {next ? (
          <>
            <div className="next" onClick={() => setShowList((v) => !v)}>
              <span className="ico" style={{ background: next.color, color: contrastText(next.color) }}>
                {createElement(stopIcon(next.icon), { size: 18 })}
              </span>
              <div>
                <b>{next.name}</b>
                <small>
                  {toNext != null ? fmtDist(toNext) : '—'} · faltan {pending.length} de{' '}
                  {ctx.stops.length}
                </small>
              </div>
              <span className="chev">
                {showList ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </span>
            </div>

            {showList && (
              <ol className="stops">
                {ctx.stops.map((s) => (
                  // Fragment: el lunch se cuela entre dos paradas, no es una.
                  <Fragment key={s.id}>
                    <li className={s.visited_at ? 'done' : ''}>
                      <span className="n">{s.seq}</span>
                      <span style={{ color: readable(s.color), display: 'flex' }}>
                        {createElement(stopIcon(s.icon), { size: 15 })}
                      </span>
                      <span className="nm">{s.name}</span>
                      {s.dwell_min > 0 && <small className="dwell-tag">{s.dwell_min} min</small>}
                      {s.visited_at && <Check size={15} color="var(--ok-2)" />}
                    </li>
                    {ctx.team.lunch_after_seq === s.seq && (
                      <li className={`lunch-row ${lunch.phase === 'terminado' ? 'done' : ''}`}>
                        <span className="n" />
                        <Sandwich size={15} />
                        <span className="nm">Lunch break</span>
                        <small className="dwell-tag">{ctx.lunch_min} min</small>
                        {lunch.phase === 'terminado' && <Check size={15} color="var(--ok-2)" />}
                      </li>
                    )}
                  </Fragment>
                ))}
              </ol>
            )}

            <div className="actions">
              <button
                className={follow ? 'b-on' : 'b-info'}
                disabled={follow}
                onClick={() => setFollow(true)}
              >
                <Crosshair size={16} />
                {follow ? 'Siguiéndote' : 'Centrar'}
              </button>
              <button className="b-primary" onClick={() => void t.goToMaps(next.lat, next.lng)}>
                <Navigation size={16} /> Google Maps
              </button>
            </div>

          </>
        ) : (
          <div className="next done">
            <Flag size={18} color="var(--ok-2)" />
            <b>Ruta completada</b>
          </div>
        )}

        {/* Un solo botón principal, el que toque según el momento. Va fuera del
            bloque de arriba porque la última parada también tiene estancia y
            para entonces ya no hay "siguiente". */}
        {lunch.phase === 'activo' ? (
          <button className="b-ok" disabled={checkingIn} onClick={() => void handleLunch(false)}>
            <Play size={16} />
            {checkingIn ? 'Cerrando…' : 'Terminar lunch break'}
          </button>
        ) : dwell ? (
          <button
            className="b-ok"
            disabled={checkingIn}
            onClick={() => void handleFinishDwell()}
          >
            <Play size={16} />
            {checkingIn ? 'Cerrando…' : 'Continuar ruta'}
          </button>
        ) : (
          next && (
            <button className="b-ok" disabled={checkingIn} onClick={() => void handleCheckin()}>
              <Check size={16} />
              {checkingIn ? 'Registrando…' : 'Registrar llegada'}
            </button>
          )
        )}

        {/* Lunch y Terminar comparten fila. Se puede comer antes de lo
            programado, pero una sola vez: cerrado el lunch, el botón se va. */}
        <div className="actions end">
          {lunch.phase !== 'activo' && lunch.phase !== 'terminado' && (
            <button
              className="b-warn b-third"
              disabled={checkingIn}
              title={`Lunch break de ${ctx.lunch_min} min`}
              onClick={() => void handleLunch(true)}
            >
              <Sandwich size={16} /> Lunch
            </button>
          )}
          <button className="b-danger" onClick={() => void handleStop()}>
            <Power size={16} /> Terminar
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusBar({ t }: { t: ReturnType<typeof useTracking> }) {
  // Las dos barras rojas son botones: tocarlas vuelve a pedir el permiso y
  // reengancha el GPS, que es lo primero que intenta cualquiera al verlas.
  if (t.error === 'permiso') {
    return (
      <button className="status bad" onClick={() => void t.retry()}>
        <TriangleAlert size={16} />
        Sin permiso de ubicación. Toca aquí para volver a pedirlo.
      </button>
    )
  }
  if (!t.tracking) {
    return (
      <button className="status bad" onClick={() => void t.retry()}>
        <Power size={16} /> Detenido — toca para volver a compartir tu ubicación
      </button>
    )
  }
  if (!t.online) {
    return (
      <div className="status warn">
        <WifiOff size={16} /> Sin señal — guardando {t.pending} posiciones
      </div>
    )
  }
  return (
    <div className="status ok">
      <Radio size={16} />
      Compartiendo ubicación{!t.awake && ' · la pantalla puede apagarse sola'}
    </div>
  )
}

/** Link general: una lista de botones grandes, uno por equipo. Nada más. */
function TeamPicker({ onPick }: { onPick: (token: string) => void }) {
  const [teams, setTeams] = useState<TeamChoice[] | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let active = true
    const loadTeams = () => {
      listTeams()
        .then((rows) => {
          if (!active) return
          setTeams(rows)
          setErr(false)
        })
        .catch(() => active && setErr(true))
    }
    loadTeams()
    const id = setInterval(loadTeams, 5000)
    const onVisible = () => document.visibilityState === 'visible' && loadTeams()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', loadTeams)
    return () => {
      active = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', loadTeams)
    }
  }, [])

  if (err) {
    return (
      <div className="splash">
        <Brand big />
        <h1>Sin conexión</h1>
        <p className="muted">Revisa tus datos móviles y recarga la página.</p>
      </div>
    )
  }
  if (!teams) return <Splash title="Cargando equipos…" sub="Un momento" />
  if (!teams.length) {
    return (
      <Splash title="Todavía no hay equipos" sub="El organizador aún no los ha dado de alta." />
    )
  }

  return (
    <div className="splash">
      <Brand big />
      <h1>¿Cuál es tu equipo?</h1>
      <p className="muted">Elige el tuyo para ver tu ruta.</p>
      <div className="picker">
        {teams.map((t) => (
          <button
            key={t.id}
            // Los tomados se ven, pero no se pueden elegir: así el chofer
            // entiende que existe y que alguien ya lo lleva.
            disabled={t.taken}
            onClick={() => onPick(t.token)}
            style={{ borderColor: t.taken ? 'var(--line)' : t.color }}
          >
            <VanIcon size={22} color={t.taken ? 'var(--muted)' : readable(t.color)} />
            <span className="picker-name">
              <b>{t.name}</b>
              <small>
                {t.driver_name ? `Conductor: ${t.driver_name}` : 'Sin conductor asignado'}
              </small>
            </span>
            <span className={`picker-state ${t.taken ? 'used' : 'free'}`}>
              {t.taken ? 'En uso' : 'Disponible'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Splash({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="splash">
      <h1>{title}</h1>
      <p className="muted">{sub}</p>
    </div>
  )
}
