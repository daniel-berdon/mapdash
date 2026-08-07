import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  Flag,
  Info,
  LocateFixed,
  LogOut,
  MapPin,
  MousePointerClick,
  Navigation,
  Plus,
  RefreshCw,
  RotateCcw,
  Sandwich,
  Search,
  Sparkles,
  Smartphone,
  Timer,
  Trash2,
  TriangleAlert,
  Unlink,
  X,
} from 'lucide-react'
import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Brand from '../components/Brand'
import EventLog from '../components/EventLog'
import { STOP_ICONS, VanIcon, stopIcon } from '../components/icons'
import Map, { type MapPoint, type MapVan } from '../components/Map'
import { contrastText, readable } from '../lib/color'
import { dwellLeftMs, fmtCountdown, lunchStatus } from '../lib/dwell'
import { fmtAge, fmtDist, fmtDur, type LngLat } from '../lib/geo'
import { geocodeOk, searchPlaces, type Place } from '../lib/geocode'
import { getRoute, optimizeOrder } from '../lib/routing'
import {
  supabase,
  type Point,
  type Position,
  type RouteRow,
  type Team,
  type AppSettings,
  type Visit,
} from '../lib/supabase'

interface Stop {
  team_id: string
  point_id: string
  seq: number
}

/** Sin datos en este tiempo, la van se pinta en gris. */
const STALE_MS = 30000

/**
 * Espejo de device_stale_after() en la base (migración 0009). Si allá cambia,
 * aquí también: es lo único que decide si el panel dice "En uso" o "liberable".
 */
const DEVICE_STALE_MS = 5 * 60_000

const COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#9333ea',
  '#0891b2', '#ca8a04', '#db2777', '#4b5563',
]

export default function Admin() {
  const [points, setPoints] = useState<Point[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [stops, setStops] = useState<Stop[]>([])
  const [routes, setRoutes] = useState<RouteRow[]>([])
  const [positions, setPositions] = useState<Record<string, Position>>({})
  const [visits, setVisits] = useState<Visit[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)

  const [tab, setTab] = useState<'equipos' | 'paradas'>('equipos')
  const [selTeam, setSelTeam] = useState<string | null>(null)
  const [editPoint, setEditPoint] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /** Qué debe encuadrar el mapa. La clave cambia para forzar el reencuadre. */
  const [focus, setFocus] = useState<{ key: string; coords: LngLat[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** Id del equipo cuyo link se acaba de copiar. */
  const [copied, setCopied] = useState<string | null>(null)
  /** Equipos ocultos en el mapa (ruta + ubicación). */
  const [hiddenTeams, setHiddenTeams] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(Date.now())

  // Reloj propio: la van no manda nada al quedarse sin señal, así que el paso
  // a gris tiene que venir del tiempo, no de un evento. Cada segundo, para que
  // las cuentas regresivas de permanencia no avancen a saltos; el mapa
  // compara firmas antes de tocar un marcador, así que re-renderizar sale casi
  // gratis.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const loadAll = useCallback(async () => {
    const [p, t, s, r, pos, v, cfg] = await Promise.all([
      supabase.from('points').select('*').order('created_at'),
      supabase.from('teams').select('*').order('created_at'),
      supabase.from('route_stops').select('*').order('seq'),
      supabase.from('routes').select('*'),
      supabase.from('positions').select('*'),
      supabase.from('visits').select('*'),
      supabase.from('app_settings').select('*').maybeSingle(),
    ])
    if (p.data) setPoints(p.data)
    if (t.data) setTeams(t.data)
    if (s.data) setStops(s.data)
    if (r.data) setRoutes(r.data)
    if (pos.data) setPositions(Object.fromEntries(pos.data.map((x) => [x.team_id, x])))
    if (v.data) setVisits(v.data)
    if (cfg.data) setSettings(cfg.data)
  }, [])

  useEffect(() => {
    void loadAll()
    const ch = supabase
      .channel('admin')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'teams' }, (p) => {
        const row = p.new as Team
        // report_position toca device_seen cada 5 s. Reemplazar la fila entera
        // pisaba el texto local mientras el admin escribía nombre o teléfono.
        if (row?.id) {
          setTeams((prev) =>
            prev.map((team) =>
              team.id === row.id
                ? {
                    ...team,
                    device_id: row.device_id,
                    device_seen: row.device_seen,
                    lunch_after_seq: row.lunch_after_seq,
                    lunch_started_at: row.lunch_started_at,
                    lunch_ended_at: row.lunch_ended_at,
                  }
                : team,
            ),
          )
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, (p) => {
        const row = p.new as Position
        if (row?.team_id) setPositions((prev) => ({ ...prev, [row.team_id]: row }))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, () => {
        void supabase
          .from('visits')
          .select('*')
          .then(({ data }) => data && setVisits(data))
      })
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [loadAll])

  // --------------------------------------------------------------- paradas ---
  const addPoint = async (lngLat: LngLat) => {
    const { data } = await supabase
      .from('points')
      .insert({ name: `Parada ${points.length + 1}`, lng: lngLat[0], lat: lngLat[1] })
      .select()
      .single()
    if (data) {
      setPoints((p) => [...p, data])
      setEditPoint(data.id)
    }
    setAdding(false)
  }

  const patchPoint = async (id: string, patch: Partial<Point>) => {
    setPoints((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    await supabase.from('points').update(patch).eq('id', id)
    // Mover una parada invalida toda ruta que pase por ella.
    for (const teamId of new Set(stops.filter((s) => s.point_id === id).map((s) => s.team_id))) {
      if (patch.lat != null || patch.lng != null) void recalc(teamId)
    }
  }

  const delPoint = async (id: string) => {
    if (!confirm('¿Borrar esta parada? Se quita de todas las rutas.')) return
    const affected = [...new Set(stops.filter((s) => s.point_id === id).map((s) => s.team_id))]
    await supabase.from('points').delete().eq('id', id)
    setPoints((p) => p.filter((x) => x.id !== id))
    setStops((s) => s.filter((x) => x.point_id !== id))
    setEditPoint(null)
    for (const teamId of affected) void resequence(teamId)
  }

  // --------------------------------------------------------------- equipos ---
  const addTeam = async () => {
    const n = teams.length
    const { data } = await supabase
      .from('teams')
      .insert({ name: `Equipo ${n + 1}`, color: COLORS[n % COLORS.length] })
      .select()
      .single()
    if (data) {
      setTeams((t) => [...t, data])
      setSelTeam(data.id)
    }
  }

  /** La duración del lunch es global: una fila, un valor para todos. */
  const patchSettings = async (patch: Partial<AppSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    await supabase.from('app_settings').update(patch).eq('id', true)
  }

  const patchTeam = async (id: string, patch: Partial<Team>) => {
    setTeams((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    await supabase.from('teams').update(patch).eq('id', id)
  }

  // Los inputs se guardan al dejar de teclear un instante. Además de evitar una
  // petición por letra, garantiza que una respuesta vieja no sobrescriba la nueva.
  const teamSaveTimers = useRef(new globalThis.Map<string, number>())
  useEffect(
    () => () => {
      for (const timer of teamSaveTimers.current.values()) clearTimeout(timer)
    },
    [],
  )
  const editTeamText = (id: string, field: 'name' | 'driver_name' | 'phone', value: string) => {
    setTeams((prev) =>
      prev.map((team) => (team.id === id ? { ...team, [field]: value } : team)),
    )
    const key = `${id}:${field}`
    const previous = teamSaveTimers.current.get(key)
    if (previous) clearTimeout(previous)
    teamSaveTimers.current.set(
      key,
      window.setTimeout(() => {
        teamSaveTimers.current.delete(key)
        void saveTeamText(id, field, value)
      }, 350),
    )
  }
  const saveTeamText = async (
    id: string,
    field: 'name' | 'driver_name' | 'phone',
    value: string,
  ) => {
    const { error } = await supabase.from('teams').update({ [field]: value }).eq('id', id)
    if (error) alert('No se pudo guardar el dato del equipo. Revisa la conexión.')
  }
  const flushTeamText = (id: string, field: 'name' | 'driver_name' | 'phone', value: string) => {
    const key = `${id}:${field}`
    const timer = teamSaveTimers.current.get(key)
    if (timer) clearTimeout(timer)
    teamSaveTimers.current.delete(key)
    void saveTeamText(id, field, value)
  }

  const delTeam = async (id: string) => {
    if (!confirm('¿Quitar este equipo? Se borra su ruta y su posición.')) return
    await supabase.from('teams').delete().eq('id', id)
    setTeams((t) => t.filter((x) => x.id !== id))
    if (selTeam === id) {
      setSelTeam(null)
      setFocus(null)
    }
  }

  // El botón confirma en sí mismo durante metro segundo y medio. Sin esto, el
  // organizador toca "Copiar" y no sabe si funcionó hasta que pega en WhatsApp.
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), [])

  const copyLink = async (teamId: string, token: string) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/d/${token}`)
      setCopied(teamId)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(null), 1600)
    } catch {
      // Pasa si el navegador no da permiso de portapapeles (o sin HTTPS).
      // Se muestra el link para copiarlo a mano en vez de fallar en silencio.
      prompt('Copia el link:', `${location.origin}/d/${token}`)
    }
  }

  /** Suelta el enlace para que otro teléfono pueda tomarlo. */
  /**
   * Liberar el enlace deja al equipo como recién creado: sin teléfono y sin
   * ubicación. Conservar la última posición dejaba una van fantasma clavada en
   * el mapa que ya no correspondía a nadie.
   */
  const freeDevice = async (id: string) => {
    if (!confirm('¿Liberar el enlace? El teléfono que lo tenga dejará de reportar.')) return
    await patchTeam(id, { device_id: null, device_seen: null })
    await supabase.from('positions').delete().eq('team_id', id)
    setPositions((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    // Sin van que encuadrar, el mapa vuelve a la ruta del equipo.
    const coords = teamStops(id).map((p) => [p.lng, p.lat] as LngLat)
    setFocus(coords.length ? { key: `free:${id}:${Date.now()}`, coords } : null)
  }

  const regenToken = async (id: string) => {
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    // Un enlace nuevo empieza libre: si no, el teléfono viejo seguiría
    // reservándolo y el chofer nuevo no podría entrar con su link recién dado.
    await patchTeam(id, { token, device_id: null, device_seen: null })
    alert('Link nuevo generado. El link anterior deja de funcionar.')
  }

  // ----------------------------------------------------------------- rutas ---
  const teamStops = useCallback(
    (teamId: string) =>
      stops
        .filter((s) => s.team_id === teamId)
        .sort((a, b) => a.seq - b.seq)
        .map((s) => points.find((p) => p.id === s.point_id))
        .filter((p): p is Point => !!p),
    [stops, points],
  )

  /** Reescribe la ruta completa: es más simple y más seguro que parchear seq. */
  const saveRoute = async (teamId: string, ordered: Point[]) => {
    setStops((s) => [
      ...s.filter((x) => x.team_id !== teamId),
      ...ordered.map((p, i) => ({ team_id: teamId, point_id: p.id, seq: i + 1 })),
    ])
    await supabase.from('route_stops').delete().eq('team_id', teamId)
    if (ordered.length) {
      await supabase
        .from('route_stops')
        .insert(ordered.map((p, i) => ({ team_id: teamId, point_id: p.id, seq: i + 1 })))
    }
    // Quitar paradas puede dejar el lunch apuntando a una posición que ya no
    // existe, y ahí no volvería a dispararse solo. Se recorta al nuevo final.
    const team = teams.find((t) => t.id === teamId)
    if (team?.lunch_after_seq != null && team.lunch_after_seq > ordered.length) {
      await patchTeam(teamId, { lunch_after_seq: ordered.length || null })
    }

    await recalc(teamId, ordered)
  }

  const resequence = (teamId: string) => saveRoute(teamId, teamStops(teamId))

  /**
   * Mueve el lunch dentro de la ruta. Queda siempre después de alguna parada:
   * es lo que le da su disparador automático, así que el rango es 1..n.
   */
  const moveLunch = (team: Team, delta: number) => {
    const total = teamStops(team.id).length
    const next = Math.min(total, Math.max(1, (team.lunch_after_seq ?? total) + delta))
    return patchTeam(team.id, { lunch_after_seq: next })
  }

  /** Devuelve el lunch a "sin usar", como desmarcar una llegada. */
  const resetLunch = (teamId: string) =>
    patchTeam(teamId, { lunch_started_at: null, lunch_ended_at: null })

  const recalc = async (teamId: string, ordered?: Point[]) => {
    const list = ordered ?? teamStops(teamId)
    if (list.length < 2) {
      await supabase.from('routes').delete().eq('team_id', teamId)
      setRoutes((r) => r.filter((x) => x.team_id !== teamId))
      return
    }
    setBusy(teamId)
    try {
      const r = await getRoute(list.map((p) => [p.lng, p.lat] as LngLat))
      const row = {
        team_id: teamId,
        geometry: r.geometry,
        steps: r.steps,
        distance_m: r.distance_m,
        duration_s: r.duration_s,
        updated_at: new Date().toISOString(),
      }
      await supabase.from('routes').upsert(row)
      setRoutes((prev) => [...prev.filter((x) => x.team_id !== teamId), row as RouteRow])
    } catch (e) {
      alert(routeError(e, list))
    } finally {
      setBusy(null)
    }
  }

  const optimize = async (teamId: string) => {
    const list = teamStops(teamId)
    if (list.length < 3) return alert('Se necesitan al menos 3 paradas para optimizar.')
    setBusy(teamId)
    try {
      // El primero se respeta como salida: en estas dinámicas todos arrancan
      // del mismo lugar y reordenarlo no tendría sentido.
      const [start, ...rest] = list
      const order = await optimizeOrder(
        rest.map((p) => [p.lng, p.lat] as LngLat),
        [start.lng, start.lat],
      )
      await saveRoute(teamId, [start, ...order.map((i) => rest[i])])
    } catch (e) {
      // El índice que devuelve ORS es sobre `rest`, que no incluye la salida.
      alert(routeError(e, list.slice(1)))
    } finally {
      setBusy(null)
    }
  }

  const move = (teamId: string, from: number, to: number) => {
    const list = teamStops(teamId)
    if (to < 0 || to >= list.length) return
    const [x] = list.splice(from, 1)
    list.splice(to, 0, x)
    void saveRoute(teamId, list)
  }

  const forceVisit = async (teamId: string, pointId: string, visited: boolean) => {
    if (visited) {
      await supabase.from('visits').delete().eq('team_id', teamId).eq('point_id', pointId)
      setVisits((v) => v.filter((x) => !(x.team_id === teamId && x.point_id === pointId)))
    } else {
      const row: Visit = {
        team_id: teamId,
        point_id: pointId,
        arrived_at: new Date().toISOString(),
        left_at: null,
        source: 'admin' as const,
      }
      await supabase.from('visits').insert(row)
      setVisits((v) => [...v, row])
    }
  }

  // ---------------------------------------------------------------- encuadre ---

  /** Seleccionar un equipo encuadra su van junto con toda su ruta. */
  const selectTeam = (teamId: string | null) => {
    setSelTeam(teamId)
    if (!teamId) return setFocus(null)
    const pos = positions[teamId]
    const coords: LngLat[] = [
      ...(pos ? [[pos.lng, pos.lat] as LngLat] : []),
      ...teamStops(teamId).map((p) => [p.lng, p.lat] as LngLat),
    ]
    if (coords.length) setFocus({ key: `team:${teamId}`, coords })
  }

  /** Botón Ubicar: acercarse a la van y nada más. */
  const locate = (teamId: string) => {
    const pos = positions[teamId]
    if (!pos) return
    // La clave lleva marca de tiempo para que dos toques seguidos vuelvan a
    // encuadrar aunque la van no se haya movido.
    setFocus({ key: `loc:${teamId}:${Date.now()}`, coords: [[pos.lng, pos.lat]] })
  }

  const toggleTeam = (teamId: string) => {
    setHiddenTeams((prev) => {
      const next = new Set(prev)
      if (next.has(teamId)) next.delete(teamId)
      else next.add(teamId)
      return next
    })
  }

  // ----------------------------------------------------------------- vista ---
  const vans: MapVan[] = useMemo(
    () =>
      teams
        .filter((t) => t.active && positions[t.id] && !hiddenTeams.has(t.id))
        .map((t) => {
          const p = positions[t.id]
          const age = now - new Date(p.updated_at).getTime()
          const status =
            p.status === 'en_maps' ? 'warn' : age < STALE_MS ? 'ok' : ('bad' as const)
          return {
            id: t.id,
            name: t.name,
            lat: p.lat,
            lng: p.lng,
            color: t.color,
            heading: p.heading,
            stale: status === 'bad',
            status,
          }
        }),
    [teams, positions, now, hiddenTeams],
  )

  const shownRoutes = useMemo(
    () =>
      routes
        .filter((r) => r.geometry?.coordinates?.length && !hiddenTeams.has(r.team_id))
        .map((r) => ({
          id: r.team_id,
          color: teams.find((t) => t.id === r.team_id)?.color ?? '#666',
          coordinates: r.geometry!.coordinates,
        })),
    [routes, teams, hiddenTeams],
  )

  const mapPoints: MapPoint[] = points.map((p) => ({
    ...p,
    seq: selTeam ? stops.find((s) => s.team_id === selTeam && s.point_id === p.id)?.seq : undefined,
    visited: selTeam ? visits.some((v) => v.team_id === selTeam && v.point_id === p.id) : false,
    draggable: tab === 'paradas',
  }))

  const point = points.find((p) => p.id === editPoint)
  const sel = teams.find((t) => t.id === selTeam)
  const selRoute = routes.find((r) => r.team_id === selTeam)
  const access = sel ? deviceAccess(sel, now) : null
  const lunch = lunchStatus(
    sel?.lunch_started_at ?? null,
    sel?.lunch_ended_at ?? null,
    settings?.lunch_min ?? 45,
    now,
  )

  return (
    <div className="admin">
      <aside>
        <header>
          <Brand />
          <button className="b-ghost b-sm" onClick={() => void supabase.auth.signOut()}>
            <LogOut size={15} /> Salir
          </button>
        </header>

        <nav>
          <button
            className={tab === 'equipos' ? 'b-on' : ''}
            onClick={() => setTab('equipos')}
          >
            <VanIcon size={16} /> Equipos
          </button>
          <button
            className={tab === 'paradas' ? 'b-on' : ''}
            onClick={() => setTab('paradas')}
          >
            <MapPin size={16} /> Paradas
          </button>
        </nav>

        {/* Solo esta zona hace scroll, para que la bitácora de abajo no se
            escape de la vista al recorrer una lista larga de equipos. */}
        <div className="scroll">

        {tab === 'equipos' && (
          <div className="list">
            {teams.map((t) => {
              const pos = positions[t.id]
              const age = pos ? now - new Date(pos.updated_at).getTime() : Infinity
              const done = visits.filter((v) => v.team_id === t.id).length
              const total = stops.filter((s) => s.team_id === t.id).length
              const finished = total > 0 && done >= total
              const state =
                pos?.status === 'en_maps' ? 'warn' : age < STALE_MS ? 'ok' : pos ? 'bad' : 'off'
              const dwell = activeDwell(t.id, visits, points, now)
              const lunch = lunchStatus(
                t.lunch_started_at,
                t.lunch_ended_at,
                settings?.lunch_min ?? 45,
                now,
              )
              return (
                <div
                  key={t.id}
                  className={`team ${selTeam === t.id ? 'sel' : ''}${finished ? ' done' : ''}`}
                  onClick={() => selectTeam(selTeam === t.id ? null : t.id)}
                >
                  <div className="row">
                    <i
                      className={`led ${state === 'off' ? 'off' : ''}`}
                      style={{ background: t.color }}
                    />
                    <VanIcon size={16} color={readable(t.color)} />
                    <b>{t.name}</b>
                    <span className="grow">
                      {finished ? (
                        <span className="badge-done">
                          <Flag size={12} /> Completada
                        </span>
                      ) : (
                        `${done}/${total}`
                      )}
                    </span>
                    <button
                      className="b-ghost b-icon"
                      title={
                        hiddenTeams.has(t.id)
                          ? 'Mostrar equipo en el mapa'
                          : 'Ocultar equipo del mapa'
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleTeam(t.id)
                      }}
                    >
                      {hiddenTeams.has(t.id) ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                      className="b-ghost b-icon"
                      title={
                        pos ? 'Centrar el mapa en esta van' : 'Todavía no ha reportado posición'
                      }
                      disabled={!pos}
                      onClick={(e) => {
                        e.stopPropagation()
                        locate(t.id)
                      }}
                    >
                      <LocateFixed size={16} />
                    </button>
                  </div>
                  <small className={`state ${finished ? 'hit' : state}`}>
                    {finished ? (
                      <>
                        <Flag size={13} /> Ruta completada
                      </>
                    ) : (
                      <>
                        {state === 'ok' && (
                          <>
                            <i className="live-dot" />
                            En vivo
                          </>
                        )}
                        {state === 'warn' && (
                          <>
                            <Navigation size={13} /> En Google Maps · {fmtAge(age)}
                          </>
                        )}
                        {state === 'bad' && (
                          <>
                            <TriangleAlert size={13} /> Sin datos hace {fmtAge(age)}
                          </>
                        )}
                        {state === 'off' && 'No ha iniciado'}
                      </>
                    )}
                  </small>

                  {/* Misma línea siempre, para que la tarjeta no cambie de alto:
                      o el equipo está cumpliendo tiempo en una parada, o va en
                      camino a la siguiente. Solo se calla si nunca arrancó. */}
                  {lunch.phase === 'activo' ? (
                    <small className="state lunch">
                      <Sandwich size={13} /> Lunch break · {fmtCountdown(lunch.left)}
                    </small>
                  ) : dwell ? (
                    <small className="state dwell">
                      <Timer size={13} /> {fmtCountdown(dwell.left)} en {dwell.point.name}
                    </small>
                  ) : (
                    pos &&
                    !finished && (
                      <small className="state ruta">
                        <Navigation size={13} /> En ruta
                      </small>
                    )
                  )}

                </div>
              )
            })}
            <button className="b-primary" onClick={() => void addTeam()}>
              <Plus size={16} /> Agregar equipo
            </button>
          </div>
        )}

        {tab === 'paradas' && (
          <div className="list">
            <p className="hint">
              <Info size={15} />
              <span>
                Arrastra un marcador para reubicarlo, o toca “Agregar” y luego haz clic en el mapa.
              </span>
            </p>
            <button
              className={adding ? 'b-on' : 'b-primary'}
              onClick={() => setAdding((v) => !v)}
            >
              {adding ? <MousePointerClick size={16} /> : <Plus size={16} />}
              {adding ? 'Haz clic en el mapa…' : 'Agregar parada'}
            </button>

            {points.map((p) => (
              <div
                key={p.id}
                className={`team ${editPoint === p.id ? 'sel' : ''}`}
                onClick={() => setEditPoint(editPoint === p.id ? null : p.id)}
              >
                <div className="row">
                  <span
                    className="chip"
                    style={{ background: p.color, color: contrastText(p.color) }}
                  >
                    {createElement(stopIcon(p.icon), { size: 14 })}
                  </span>
                  {/* Título en el color de la parada, no en gris para todas. */}
                  <b style={{ color: readable(p.color) }}>{p.name}</b>
                </div>
              </div>
            ))}
          </div>
        )}

        </div>

        <EventLog teams={teams} points={points} />
        <footer className="admin-foot">
          Desarrollado por{' '}
          <a href="https://cactusdigital.mx" target="_blank" rel="noreferrer">
            cactusdigital.mx
          </a>
        </footer>
      </aside>

      {/* Ficha flotante sobre el mapa. Antes el detalle se abría DENTRO de la
          tarjeta y empujaba fuera de vista al resto de equipos o paradas: para
          comparar dos había que cerrar uno. Aquí la lista se queda entera y el
          seleccionado solo se marca con el contorno. */}
      {tab === 'equipos' && sel && (
        <div className="sheet">
          <div className="sheet-head">
            <VanIcon size={16} color={readable(sel.color)} />
            <b>{sel.name}</b>
            <button className="b-ghost b-icon" title="Cerrar" onClick={() => selectTeam(null)}>
              <X size={16} />
            </button>
          </div>
          <div className="sheet-body detail">
            <input
              value={sel.name}
              onChange={(e) => editTeamText(sel.id, 'name', e.target.value)}
              onBlur={(e) => flushTeamText(sel.id, 'name', e.target.value)}
            />
            <input
              placeholder="nombre del chofer"
              value={sel.driver_name ?? ''}
              onChange={(e) => editTeamText(sel.id, 'driver_name', e.target.value)}
              onBlur={(e) => flushTeamText(sel.id, 'driver_name', e.target.value)}
            />
            <input
              placeholder="teléfono"
              value={sel.phone ?? ''}
              onChange={(e) => editTeamText(sel.id, 'phone', e.target.value)}
              onBlur={(e) => flushTeamText(sel.id, 'phone', e.target.value)}
            />
            <label>
              Color
              <input
                type="color"
                value={sel.color}
                onChange={(e) => void patchTeam(sel.id, { color: e.target.value })}
              />
            </label>

            <section className="access-card">
              <div className="access-head">
                <span className="access-title">
                  <Smartphone size={14} /> Acceso del conductor
                </span>
                {access && (
                  <span className={`access-state ${access.state}`}>{access.label}</span>
                )}
              </div>

              <div className="access-url">
                <code>/d/{sel.token}</code>
                <button
                  className={`b-sm b-copy ${copied === sel.id ? 'b-ok copied' : 'b-info'}`}
                  onClick={() => void copyLink(sel.id, sel.token)}
                >
                  {copied === sel.id ? (
                    <>
                      <Check size={14} /> ¡Copiado!
                    </>
                  ) : (
                    <>
                      <Copy size={14} /> Copiar
                    </>
                  )}
                </button>
              </div>

              {sel.device_id && sel.device_seen && (
                <small>
                  Último reporte hace {fmtAge(now - new Date(sel.device_seen).getTime())}
                </small>
              )}

              <div className="access-actions">
                <button className="b-ghost b-sm" onClick={() => void regenToken(sel.id)}>
                  <RefreshCw size={14} /> Generar enlace nuevo
                </button>
                {sel.device_id && (
                  <button className="b-warn b-sm" onClick={() => void freeDevice(sel.id)}>
                    <Unlink size={14} /> Liberar dispositivo
                  </button>
                )}
              </div>
            </section>

            <div className="route">
              <div className="row">
                <b>Ruta</b>
                {selRoute?.distance_m != null && (
                  <small className="muted">
                    {fmtDist(selRoute.distance_m)} · {fmtDur(selRoute.duration_s ?? 0)}
                  </small>
                )}
              </div>

              <ol>
                {teamStops(sel.id).map((p, i, arr) => {
                  const done = visits.some(
                    (v) => v.team_id === sel.id && v.point_id === p.id,
                  )
                  return (
                    // Fragment: el lunch se intercala entre paradas sin ser una.
                    <Fragment key={p.id}>
                      <li className={done ? 'done' : ''}>
                        <span className="n">{i + 1}</span>
                        <i className="sw" style={{ background: p.color }} />
                        <span className="nm">{p.name}</span>
                        <button
                          className="b-ghost b-icon"
                          title="Subir"
                          onClick={() => move(sel.id, i, i - 1)}
                          disabled={i === 0}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="b-ghost b-icon"
                          title="Bajar"
                          onClick={() => move(sel.id, i, i + 1)}
                          disabled={i === arr.length - 1}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          className="b-ghost b-icon"
                          title={done ? 'Desmarcar llegada' : 'Marcar llegada'}
                          onClick={() => void forceVisit(sel.id, p.id, done)}
                        >
                          {done ? <RotateCcw size={14} /> : <Check size={14} />}
                        </button>
                        <button
                          className="b-ghost b-icon"
                          title="Quitar de la ruta"
                          onClick={() =>
                            void saveRoute(
                              sel.id,
                              arr.filter((x) => x.id !== p.id),
                            )
                          }
                        >
                          <X size={14} />
                        </button>
                      </li>

                      {sel.lunch_after_seq === i + 1 && (
                        <li className={`lunch-row ${lunch.phase === 'terminado' ? 'done' : ''}`}>
                          <span className="n" />
                          <Sandwich size={14} />
                          <span className="nm">
                            Lunch break
                            {lunch.phase === 'activo' && ` · ${fmtCountdown(lunch.left)}`}
                            {lunch.phase === 'terminado' && ' · usado'}
                          </span>
                          <button
                            className="b-ghost b-icon"
                            title="Subir"
                            onClick={() => void moveLunch(sel, -1)}
                            disabled={i === 0}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            className="b-ghost b-icon"
                            title="Bajar"
                            onClick={() => void moveLunch(sel, 1)}
                            disabled={i === arr.length - 1}
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            className="b-ghost b-icon"
                            title="Volver a dejarlo disponible"
                            disabled={lunch.phase === 'none'}
                            onClick={() => void resetLunch(sel.id)}
                          >
                            <RotateCcw size={14} />
                          </button>
                          <button
                            className="b-ghost b-icon"
                            title="Quitar de la ruta"
                            onClick={() => void patchTeam(sel.id, { lunch_after_seq: null })}
                          >
                            <X size={14} />
                          </button>
                        </li>
                      )}
                    </Fragment>
                  )
                })}
              </ol>

              <select
                value=""
                onChange={(e) => {
                  if (e.target.value === 'lunch') {
                    // Entra al final; desde ahí se mueve con las flechas.
                    void patchTeam(sel.id, { lunch_after_seq: teamStops(sel.id).length })
                    return
                  }
                  const p = points.find((x) => x.id === e.target.value)
                  if (p) void saveRoute(sel.id, [...teamStops(sel.id), p])
                }}
              >
                <option value="">+ agregar a la ruta…</option>
                {sel.lunch_after_seq == null && teamStops(sel.id).length > 0 && (
                  <option value="lunch">Lunch break</option>
                )}
                {points
                  .filter((p) => !teamStops(sel.id).some((x) => x.id === p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>

              {sel.lunch_after_seq != null && (
                <label className="lunch-cfg">
                  Duración del lunch: {settings?.lunch_min ?? 45} min{' '}
                  <small className="muted">(igual para todos los equipos)</small>
                  <input
                    type="range"
                    min={5}
                    max={120}
                    step={5}
                    value={settings?.lunch_min ?? 45}
                    onChange={(e) => void patchSettings({ lunch_min: +e.target.value })}
                  />
                </label>
              )}

              <div className="row">
                <button
                  className="b-primary b-sm"
                  onClick={() => void optimize(sel.id)}
                  disabled={busy === sel.id}
                >
                  <Sparkles size={14} />
                  {busy === sel.id ? 'Calculando…' : 'Optimizar orden'}
                </button>
                <button className="b-ghost b-sm" onClick={() => void recalc(sel.id)}>
                  <RefreshCw size={14} /> Recalcular
                </button>
              </div>
            </div>

            <button className="b-danger" onClick={() => void delTeam(sel.id)}>
              <Trash2 size={15} /> Quitar equipo
            </button>
          </div>
        </div>
      )}

      {tab === 'paradas' && point && (
        <div className="sheet">
          <div className="sheet-head">
            <span className="chip" style={{ background: point.color, color: contrastText(point.color) }}>
              {createElement(stopIcon(point.icon), { size: 14 })}
            </span>
            <b>{point.name}</b>
            <button className="b-ghost b-icon" title="Cerrar" onClick={() => setEditPoint(null)}>
              <X size={16} />
            </button>
          </div>
          <div className="sheet-body detail">
            <input value={point.name} onChange={(e) => void patchPoint(point.id, { name: e.target.value })} />
            <label>
              Color
              <input
                type="color"
                value={point.color}
                onChange={(e) => void patchPoint(point.id, { color: e.target.value })}
              />
            </label>
            <label>
              Icono
              <select
                value={point.icon}
                onChange={(e) => void patchPoint(point.id, { icon: e.target.value })}
              >
                {Object.entries(STOP_ICONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Radio de llegada: {point.radius_m} m
              <input
                type="range"
                min={10}
                max={300}
                step={10}
                value={point.radius_m}
                onChange={(e) => void patchPoint(point.id, { radius_m: +e.target.value })}
              />
            </label>
            <label>
              Tiempo de visita: {point.dwell_min ? `${point.dwell_min} min` : 'sin mínimo'}
              <input
                type="range"
                min={0}
                max={120}
                step={5}
                // ?? 0: mientras la migración 0010 no esté aplicada la columna
                // no llega y el input se volvería no controlado.
                value={point.dwell_min ?? 0}
                onChange={(e) => void patchPoint(point.id, { dwell_min: +e.target.value })}
              />
            </label>
            <button className="b-danger" onClick={() => void delPoint(point.id)}>
              <Trash2 size={15} /> Borrar parada
            </button>
          </div>
        </div>
      )}

      <div className="map-wrap">
        <Map
          className="map"
          points={mapPoints}
          vans={vans}
          routes={shownRoutes}
          onMapClick={adding ? (ll) => void addPoint(ll) : undefined}
          onPointClick={(id) => {
            setTab('paradas')
            setEditPoint(id)
          }}
          onPointDragEnd={(id, ll) => void patchPoint(id, { lng: ll[0], lat: ll[1] })}
          fitKey={focus?.key ?? (points.length ? 'pts' : '')}
          fitTo={focus?.coords ?? points.map((p) => [p.lng, p.lat] as LngLat)}
        />
        <MapSearch
          near={points.length ? [points[0].lng, points[0].lat] : undefined}
          onPick={(place) =>
            // La marca de tiempo en la clave permite volver al mismo sitio dos
            // veces seguidas después de haber movido el mapa a mano.
            setFocus({ key: `place:${place.id}:${Date.now()}`, coords: place.coords })
          }
        />
      </div>
    </div>
  )
}

/**
 * Buscador de direcciones sobre el mapa. Escribe una ciudad, una calle con
 * número o el nombre de un lugar y el mapa se va ahí; no crea nada, solo mueve
 * la cámara para poder poner la parada donde toca.
 */
function MapSearch({ near, onPick }: { near?: LngLat; onPick: (place: Place) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!geocodeOk) return null

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = q.trim()
    if (!text || searching) return
    setSearching(true)
    setErr(null)
    try {
      const found = await searchPlaces(text, near)
      setResults(found)
      if (!found.length) setErr('Sin resultados. Prueba con la ciudad o el estado.')
      // Un solo resultado no merece una lista: se va directo.
      else if (found.length === 1) {
        onPick(found[0])
        setResults(null)
      }
    } catch {
      setErr('No se pudo buscar. Revisa la conexión.')
    } finally {
      setSearching(false)
    }
  }

  const close = () => {
    setOpen(false)
    setQ('')
    setResults(null)
    setErr(null)
  }

  // Plegado: solo la lupa, para no tapar el mapa cuando se quiere verlo entero.
  if (!open) {
    return (
      <button
        className="map-search-toggle"
        title="Buscar dirección o ciudad"
        onClick={() => setOpen(true)}
      >
        <Search size={18} />
      </button>
    )
  }

  return (
    <div className="map-search">
      <form onSubmit={(e) => void search(e)}>
        <Search size={16} />
        <input
          // El campo aparece al abrir: se enfoca solo para poder escribir ya.
          autoFocus
          value={q}
          placeholder="Buscar ciudad, calle o lugar…"
          onChange={(e) => {
            setQ(e.target.value)
            setErr(null)
          }}
          onKeyDown={(e) => e.key === 'Escape' && close()}
        />
        <button type="submit" className="b-primary b-sm" disabled={searching || !q.trim()}>
          {searching ? 'Buscando…' : 'Ir'}
        </button>
        <button type="button" className="b-ghost b-icon" title="Cerrar buscador" onClick={close}>
          <X size={15} />
        </button>
      </form>

      {err && <p className="map-search-err">{err}</p>}

      {results?.length ? (
        <ul>
          {results.map((p) => (
            <li key={p.id}>
              <button
                className="b-ghost"
                onClick={() => {
                  onPick(p)
                  setResults(null)
                }}
              >
                <MapPin size={15} />
                <span>{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Traduce el error de ORS y, sobre todo, dice QUÉ parada falla.
 * El caso real: el admin marca una parada en medio de un parque o un descampado
 * y ORS no encuentra calle cerca. En inglés y con coordenadas crudas no hay
 * forma de saber cuál mover.
 */
function routeError(e: unknown, list: Point[]): string {
  const msg = (e as Error).message ?? ''
  const idx = [...msg.matchAll(/coordinate (\d+)/g)].map((m) => Number(m[1]))
  if (idx.length) {
    const names = [...new Set(idx.map((i) => list[i]?.name ?? `parada ${i + 1}`))]
    return `No hay ninguna calle cerca de: ${names.join(', ')}.\n\nArrastra ${
      names.length > 1 ? 'esos marcadores' : 'ese marcador'
    } sobre una calle y vuelve a intentar.`
  }
  return `No se pudo calcular la ruta.\n\n${msg}`
}

/**
 * Permanencia en curso de un equipo: la llegada más reciente cuya parada
 * todavía le exige quedarse. Null si no está cumpliendo tiempo en ninguna.
 */
function activeDwell(teamId: string, visits: Visit[], points: Point[], now: number) {
  let best: { point: Point; left: number; at: number } | null = null
  for (const v of visits) {
    // left_at: el chofer cerró la actividad antes de tiempo.
    if (v.team_id !== teamId || v.left_at) continue
    const point = points.find((p) => p.id === v.point_id)
    if (!point) continue
    const left = dwellLeftMs(v.arrived_at, point.dwell_min, now)
    if (!left) continue
    const at = new Date(v.arrived_at).getTime()
    if (!best || at > best.at) best = { point, left, at }
  }
  return best
}

/**
 * Estado del vínculo con el teléfono, con la MISMA regla que la base:
 * pasado device_stale_after() cualquier otro dispositivo puede reclamar el
 * equipo, así que el panel no puede seguir diciendo "En uso" a secas mientras
 * el selector de choferes ya lo ofrece como libre.
 */
function deviceAccess(t: Team, now: number) {
  if (!t.device_id) return { state: 'free', label: 'Disponible' }
  const idle = now - new Date(t.device_seen ?? 0).getTime()
  if (idle > DEVICE_STALE_MS) return { state: 'stale', label: 'En uso (liberable)' }
  return { state: 'used', label: 'En uso' }
}
