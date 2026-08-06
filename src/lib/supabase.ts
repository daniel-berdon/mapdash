import { createClient } from '@supabase/supabase-js'
import type { LngLat, Step } from './geo'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** Sin esto la app no puede hacer nada; App.tsx muestra qué falta. */
export const configOk = Boolean(url && anonKey)

// Valores de relleno para que el módulo cargue y App pueda pintar el aviso de
// configuración en vez de una pantalla en blanco con un error en la consola.
export const supabase = createClient(url || 'http://localhost', anonKey || 'anon')

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Point {
  id: string
  name: string
  lat: number
  lng: number
  color: string
  icon: string
  radius_m: number
}

export interface Team {
  id: string
  name: string
  driver_name: string | null
  phone: string | null
  color: string
  token: string
  active: boolean
  /** Dispositivo que tiene reservado el enlace, si hay alguno. */
  device_id: string | null
  device_seen: string | null
}

export type TrackStatus = 'live' | 'en_maps' | 'pausado'

export interface Position {
  team_id: string
  lat: number
  lng: number
  accuracy: number | null
  heading: number | null
  speed: number | null
  status: TrackStatus
  updated_at: string
}

export interface Visit {
  team_id: string
  point_id: string
  arrived_at: string
  source: 'auto' | 'manual' | 'admin'
}

export type EventKind =
  | 'inicio'
  | 'pausa'
  | 'maps'
  | 'regreso'
  | 'reconexion'
  | 'llegada'
  | 'senal'
  | 'completada'

export interface EventRow {
  id: number
  team_id: string
  point_id: string | null
  kind: EventKind
  detail: string | null
  at: string
}

export interface RouteRow {
  team_id: string
  geometry: { type: 'LineString'; coordinates: LngLat[] } | null
  steps: Step[] | null
  distance_m: number | null
  duration_s: number | null
}

/** Parada de la ruta del chofer, tal como la devuelve get_driver_context. */
export interface Stop extends Point {
  seq: number
  visited_at: string | null
}

export interface DriverContext {
  team: Pick<Team, 'id' | 'name' | 'driver_name' | 'color'>
  stops: Stop[]
  route: {
    geometry: { type: 'LineString'; coordinates: LngLat[] } | null
    steps: Step[] | null
    distance_m: number | null
    duration_s: number | null
  } | null
}

// ---------------------------------------------------------------------------
// RPC del chofer — es todo lo que el rol anon puede hacer
// ---------------------------------------------------------------------------

export interface TeamChoice {
  id: string
  name: string
  driver_name: string | null
  color: string
  token: string
  /** Ya lo tiene otro dispositivo y sigue reportando. */
  taken: boolean
}

/** Equipos para el selector del link general /d. */
export async function listTeams(): Promise<TeamChoice[]> {
  const { data, error } = await supabase.rpc('list_teams')
  if (error) throw error
  return (data ?? []) as TeamChoice[]
}

export async function getDriverContext(token: string): Promise<DriverContext> {
  const { data, error } = await supabase.rpc('get_driver_context', { p_token: token })
  if (error) throw error
  return data as DriverContext
}

export interface ReportInput {
  lat: number
  lng: number
  accuracy?: number | null
  heading?: number | null
  speed?: number | null
  status?: TrackStatus
  /** Hora real de la lectura — importa al vaciar el buffer offline. */
  at?: number
}

/** El servidor rechaza al dispositivo que no tiene el equipo vinculado. */
export const IN_USE = '55006'
export const RELEASED = '55007'

export function isInUse(e: unknown): boolean {
  return (e as { code?: string })?.code === IN_USE
}

export function isReleased(e: unknown): boolean {
  return (e as { code?: string })?.code === RELEASED
}

/**
 * Reserva el equipo para este dispositivo. `ok:false` = lo tiene otro teléfono
 * y sigue activo; `minutes` es cuánto lleva sin reportar.
 */
export async function claimTeam(
  token: string,
  device: string,
): Promise<{ ok: boolean; minutes?: number }> {
  const { data, error } = await supabase.rpc('claim_team', { p_token: token, p_device: device })
  if (error) throw error
  return data as { ok: boolean; minutes?: number }
}

/** Registra cada arranque real del envío de ubicación. */
export async function registerTrackingStart(token: string, device: string): Promise<void> {
  const { error } = await supabase.rpc('register_tracking_start', {
    p_token: token,
    p_device: device,
  })
  if (error) throw error
}

/** Devuelve los ids de los puntos que se marcaron como visitados en esta llamada. */
export async function reportPosition(
  token: string,
  fix: ReportInput,
  device: string,
): Promise<string[]> {
  const { data, error } = await supabase.rpc('report_position', {
    p_token: token,
    p_lat: fix.lat,
    p_lng: fix.lng,
    p_accuracy: fix.accuracy ?? null,
    p_heading: fix.heading ?? null,
    p_speed: fix.speed ?? null,
    p_status: fix.status ?? 'live',
    p_at: fix.at ? new Date(fix.at).toISOString() : null,
    p_device: device,
  })
  if (error) throw error
  return (data as { arrived: string[] })?.arrived ?? []
}

/** Check-in a mano cuando el GPS no dispara el geofence. */
export async function manualCheckin(
  token: string,
  pointId: string,
  device: string,
): Promise<string[]> {
  const { data, error } = await supabase.rpc('manual_checkin', {
    p_token: token,
    p_point_id: pointId,
    p_device: device,
  })
  if (error) throw error
  return (data as { arrived: string[] })?.arrived ?? []
}
