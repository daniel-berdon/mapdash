import {
  Flag,
  Navigation,
  Play,
  Power,
  RotateCcw,
  Trophy,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { createElement, useCallback, useEffect, useState } from 'react'
import { readable } from '../lib/color'
import { supabase, type EventKind, type EventRow, type Point, type Team } from '../lib/supabase'

/** Cuántos eventos se guardan en pantalla. Los viejos siguen en la base. */
const LIMIT = 60

const KINDS: Record<EventKind, { Icon: LucideIcon; text: string; cls: string }> = {
  inicio: { Icon: Play, text: 'empezó a compartir ubicación', cls: 'ok' },
  regreso: { Icon: RotateCcw, text: 'volvió a la app', cls: 'ok' },
  reconexion: { Icon: Wifi, text: 'recuperó la conexión', cls: 'ok' },
  llegada: { Icon: Flag, text: 'llegó a', cls: 'hit' },
  completada: { Icon: Trophy, text: 'completó su ruta', cls: 'complete' },
  maps: { Icon: Navigation, text: 'salió a Google Maps', cls: 'warn' },
  senal: { Icon: WifiOff, text: 'estuvo sin reportar', cls: 'bad' },
  pausa: { Icon: Power, text: 'dejó de compartir ubicación', cls: 'bad' },
}

export default function EventLog({ teams, points }: { teams: Team[]; points: Point[] }) {
  const [rows, setRows] = useState<EventRow[]>([])

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('events')
      .select('*')
      .order('at', { ascending: false })
      .limit(LIMIT)
    if (data) setRows(data)
  }, [])

  useEffect(() => {
    void load()
    const ch = supabase
      .channel('events')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (p) => {
        // Se antepone en memoria en vez de recargar: son decenas por hora y
        // recargar la lista entera en cada llegada es tirar consultas al aire.
        setRows((prev) => [p.new as EventRow, ...prev].slice(0, LIMIT))
      })
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  if (!rows.length) {
    return (
      <div className="log">
        <h4>Últimos eventos</h4>
        <p className="muted">Todavía no hay actividad.</p>
      </div>
    )
  }

  return (
    <div className="log">
      <h4>Últimos eventos</h4>
      <ol>
        {rows.map((e) => {
          const team = teams.find((t) => t.id === e.team_id)
          const point = e.point_id ? points.find((p) => p.id === e.point_id) : null
          const k = KINDS[e.kind]
          if (!k) return null

          return (
            <li key={e.id} className={k.cls}>
              <time>{new Date(e.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</time>
              {createElement(k.Icon, { size: 13 })}
              <span className="txt">
                <b style={{ color: readable(team?.color ?? '#9c9ca6') }}>{team?.name ?? 'Equipo'}</b>{' '}
                {k.text}
                {point && <> <b>{point.name}</b></>}
                {e.detail && <span className="muted"> · {e.detail}</span>}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
