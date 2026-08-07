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
  Search,
  Sparkles,
  Smartphone,
  Trash2,
  TriangleAlert,
  Unlink,
  X,
} from 'lucide-react'
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Brand from '../components/Brand'
import EventLog from '../components/EventLog'
import { STOP_ICONS, VanIcon, stopIcon } from '../components/icons'
import Map, { type MapPoint, type MapVan } from '../components/Map'
import { contrastText, readable } from '../lib/color'
import { fmtDist, fmtDur, type LngLat } from '../lib/geo'
import { geocodeOk, searchPlaces, type Place } from '../lib/geocode'
import { getRoute, optimizeOrder } from '../lib/routing'
import {
  supabase,
  type Point,
  type Position,
  type RouteRow,
  type Team,
  type Visit,
} from '../lib/supabase'

interface Stop {
  team_id: string
  point_id: string
  seq: number
}

/** Sin datos en este tiempo, la van se pinta en gris. */
const STALE_MS = 30000

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
  // a gris tiene que venir del tiempo, no de un evento.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const loadAll = useCallback(async () => {
    const [p, t, s, r, pos, v] = await Promise.all([
      supabase.from('points').select('*').order('created_at'),
      supabase.from('teams').select('*').order('created_at'),
      supabase.from('route_stops').select('*').order('seq'),
      supabase.from('routes').select('*'),
      supabase.from('positions').select('*'),
      supabase.from('visits').select('*'),
    ])
    if (p.data) setPoints(p.data)
    if (t.data) setTeams(t.data)
    if (s.data) setStops(s.data)
    if (r.data) setRoutes(r.data)
    if (pos.data) setPositions(Object.fromEntries(pos.data.map((x) => [x.team_id, x])))
    if (v.data) setVisits(v.data)
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
                ? { ...team, device_id: row.device_id, device_seen: row.device_seen }
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
  const freeDevice = async (id: string) => {
    if (!confirm('¿Liberar el enlace? El teléfono que lo tenga dejará de reportar.')) return
    await patchTeam(id, { device_id: null, device_seen: null })
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
    await recalc(teamId, ordered)
  }

  const resequence = (teamId: string) => saveRoute(teamId, teamStops(teamId))

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
      const row = {
        team_id: teamId,
        point_id: pointId,
        arrived_at: new Date().toISOString(),
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
              const route = routes.find((r) => r.team_id === t.id)
              const state =
                pos?.status === 'en_maps' ? 'warn' : age < STALE_MS ? 'ok' : pos ? 'bad' : 'off'
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

                  {selTeam === t.id && (
                    <div className="detail" onClick={(e) => e.stopPropagation()}>
                      <input
                        value={t.name}
                        onChange={(e) => editTeamText(t.id, 'name', e.target.value)}
                        onBlur={(e) => flushTeamText(t.id, 'name', e.target.value)}
                      />
                      <input
                        placeholder="nombre del chofer"
                        value={t.driver_name ?? ''}
                        onChange={(e) => editTeamText(t.id, 'driver_name', e.target.value)}
                        onBlur={(e) => flushTeamText(t.id, 'driver_name', e.target.value)}
                      />
                      <input
                        placeholder="teléfono"
                        value={t.phone ?? ''}
                        onChange={(e) => editTeamText(t.id, 'phone', e.target.value)}
                        onBlur={(e) => flushTeamText(t.id, 'phone', e.target.value)}
                      />
                      <label>
                        Color
                        <input
                          type="color"
                          value={t.color}
                          onChange={(e) => void patchTeam(t.id, { color: e.target.value })}
                        />
                      </label>

                      <section className="access-card">
                        <div className="access-head">
                          <span className="access-title">
                            <Smartphone size={14} /> Acceso del conductor
                          </span>
                          <span className={`access-state ${t.device_id ? 'used' : 'free'}`}>
                            {t.device_id ? 'En uso' : 'Disponible'}
                          </span>
                        </div>

                        <div className="access-url">
                          <code>/d/{t.token}</code>
                          <button
                            className={`b-sm b-copy ${copied === t.id ? 'b-ok copied' : 'b-info'}`}
                            onClick={() => void copyLink(t.id, t.token)}
                          >
                            {copied === t.id ? (
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

                        {t.device_id && t.device_seen && (
                          <small>
                            Último reporte hace {fmtAge(now - new Date(t.device_seen).getTime())}
                          </small>
                        )}

                        <div className="access-actions">
                          <button className="b-ghost b-sm" onClick={() => void regenToken(t.id)}>
                            <RefreshCw size={14} /> Generar enlace nuevo
                          </button>
                          {t.device_id && (
                            <button className="b-warn b-sm" onClick={() => void freeDevice(t.id)}>
                              <Unlink size={14} /> Liberar dispositivo
                            </button>
                          )}
                        </div>
                      </section>

                      <div className="route">
                        <div className="row">
                          <b>Ruta</b>
                          {route?.distance_m != null && (
                            <small className="muted">
                              {fmtDist(route.distance_m)} · {fmtDur(route.duration_s ?? 0)}
                            </small>
                          )}
                        </div>

                        <ol>
                          {teamStops(t.id).map((p, i, arr) => {
                            const done = visits.some(
                              (v) => v.team_id === t.id && v.point_id === p.id,
                            )
                            return (
                              <li key={p.id} className={done ? 'done' : ''}>
                                <span className="n">{i + 1}</span>
                                <i className="sw" style={{ background: p.color }} />
                                <span className="nm">{p.name}</span>
                                <button
                                  className="b-ghost b-icon"
                                  title="Subir"
                                  onClick={() => move(t.id, i, i - 1)}
                                  disabled={i === 0}
                                >
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  className="b-ghost b-icon"
                                  title="Bajar"
                                  onClick={() => move(t.id, i, i + 1)}
                                  disabled={i === arr.length - 1}
                                >
                                  <ArrowDown size={14} />
                                </button>
                                <button
                                  className="b-ghost b-icon"
                                  title={done ? 'Desmarcar llegada' : 'Marcar llegada'}
                                  onClick={() => void forceVisit(t.id, p.id, done)}
                                >
                                  {done ? <RotateCcw size={14} /> : <Check size={14} />}
                                </button>
                                <button
                                  className="b-ghost b-icon"
                                  title="Quitar de la ruta"
                                  onClick={() =>
                                    void saveRoute(
                                      t.id,
                                      arr.filter((x) => x.id !== p.id),
                                    )
                                  }
                                >
                                  <X size={14} />
                                </button>
                              </li>
                            )
                          })}
                        </ol>

                        <select
                          value=""
                          onChange={(e) => {
                            const p = points.find((x) => x.id === e.target.value)
                            if (p) void saveRoute(t.id, [...teamStops(t.id), p])
                          }}
                        >
                          <option value="">+ agregar parada…</option>
                          {points
                            .filter((p) => !teamStops(t.id).some((x) => x.id === p.id))
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>

                        <div className="row">
                          <button
                            className="b-primary b-sm"
                            onClick={() => void optimize(t.id)}
                            disabled={busy === t.id}
                          >
                            <Sparkles size={14} />
                            {busy === t.id ? 'Calculando…' : 'Optimizar orden'}
                          </button>
                          <button className="b-ghost b-sm" onClick={() => void recalc(t.id)}>
                            <RefreshCw size={14} /> Recalcular
                          </button>
                        </div>
                      </div>

                      <button className="b-danger" onClick={() => void delTeam(t.id)}>
                        <Trash2 size={15} /> Quitar equipo
                      </button>
                    </div>
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

        {point && tab === 'paradas' && (
          <div className="detail sticky">
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
            <button className="b-danger" onClick={() => void delPoint(point.id)}>
              <Trash2 size={15} /> Borrar parada
            </button>
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

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  return `${Math.round(s / 60)} min`
}
