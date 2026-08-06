import {
  LngLatBounds,
  Map as MLMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre calcula la URL de su worker en tiempo de ejecución con
// `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Ningún empaquetador
// puede verlo, así que Vite nunca copia ese archivo y en producción la URL
// devuelve el index.html. Resultado: el mapa pinta el fondo, no da ningún
// error, y no dibuja una sola calle. Con `?worker&url` Vite sí lo empaqueta
// (siguiendo sus imports) y nos da la ruta buena.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useCallback, useEffect, useRef } from 'react'
import { alpha, contrastText, readable } from '../lib/color'
import type { LngLat } from '../lib/geo'
import { stopIconSvg, VAN_SVG } from './icons'

setWorkerUrl(workerUrl)

export interface MapPoint {
  id: string
  name: string
  lat: number
  lng: number
  color: string
  icon: string
  /** Tachado y translúcido cuando ya se visitó. */
  visited?: boolean
  /** Número de orden dentro de la ruta, si aplica. */
  seq?: number
  draggable?: boolean
}

export interface MapVan {
  id: string
  name: string
  lat: number
  lng: number
  color: string
  heading?: number | null
  /** Gris cuando no hay datos frescos. */
  stale?: boolean
  /** Estado de conexión: live / maps / offline. */
  status?: 'ok' | 'warn' | 'bad'
}

export interface MapRoute {
  id: string
  color: string
  coordinates: LngLat[]
  /** 0–1. El tramo activo va opaco; los siguientes, más tenues. */
  opacity?: number
}

interface Props {
  points?: MapPoint[]
  vans?: MapVan[]
  routes?: MapRoute[]
  /** Posición propia del chofer. */
  me?: { lat: number; lng: number; heading?: number | null } | null
  /** Modo navegación: la cámara sigue y rota con el rumbo. */
  follow?: boolean
  onMapClick?: (lngLat: LngLat) => void
  /** El usuario movió el mapa a mano: quien lo use debe soltar el seguimiento. */
  onUserMove?: () => void
  onPointDragEnd?: (id: string, lngLat: LngLat) => void
  onPointClick?: (id: string) => void
  /** Encuadra estas coordenadas cuando cambia la clave. */
  fitKey?: string
  fitTo?: LngLat[]
  className?: string
}

const STYLE = `https://api.maptiler.com/maps/streets-v2/style.json?key=${
  import.meta.env.VITE_MAPTILER_KEY
}`

// Sin key de MapTiler el mapa saldría en blanco sin decir por qué. OpenFreeMap
// no pide key: mejor un mapa feo que una pantalla vacía el día del evento.
const FALLBACK_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

function el(html: string): HTMLElement {
  const d = document.createElement('div')
  d.innerHTML = html.trim()
  return d.firstElementChild as HTMLElement
}

/** Escapa el nombre: lo escribe el admin y aquí se inyecta como HTML. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

/**
 * Parada: círculo relleno del color elegido con su icono dentro, y etiqueta
 * en ese mismo color. Nada de emojis ni de gris para todos.
 */
function pointEl(p: MapPoint): HTMLElement {
  const seq = p.seq != null ? `<b class="seq">${p.seq}</b>` : ''
  const vars = [
    `--c:${p.color}`,
    `--on-c:${contrastText(p.color)}`,
    // El color tal cual puede ser ilegible sobre el gris oscuro del fondo,
    // así que la etiqueta usa una versión aclarada del mismo matiz.
    `--c-txt:${readable(p.color)}`,
    `--c-soft:${alpha(p.color, 0.16)}`,
  ].join(';')

  return el(`
    <div class="mk mk-point${p.visited ? ' visited' : ''}" style="${vars}">
      <span class="ic">${stopIconSvg(p.icon)}${seq}</span>
      <span class="lb">${esc(p.name)}</span>
    </div>`)
}

function vanEl(v: MapVan): HTMLElement {
  const vars = [
    `--c:${v.color}`,
    `--on-c:${contrastText(v.color)}`,
    `--c-txt:${readable(v.color)}`,
    `--c-soft:${alpha(v.color, 0.16)}`,
  ].join(';')
  // El rumbo va en una aguja alrededor del círculo: rotar la furgoneta entera
  // la dejaría boca abajo la mitad del tiempo.
  const needle =
    v.heading != null ? `<i class="needle" style="transform:rotate(${v.heading}deg)"></i>` : ''
  const st = v.status ?? (v.stale ? 'bad' : 'ok')

  return el(`
    <div class="mk mk-van${v.stale ? ' stale' : ''}" style="${vars}">
      <span class="ic">${needle}${VAN_SVG}<i class="st-dot st-${st}"></i></span>
      <span class="lb">${esc(v.name)}</span>
    </div>`)
}

export default function Map({
  points = [],
  vans = [],
  routes = [],
  me,
  follow,
  onMapClick,
  onUserMove,
  onPointDragEnd,
  onPointClick,
  fitKey,
  fitTo,
  className,
}: Props) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MLMap | null>(null)
  // El marcador y la firma de su contenido visual (sin la posición). La firma
  // evita rehacer el DOM cuando lo único que cambió es dónde está.
  const marks = useRef(new globalThis.Map<string, { mk: Marker; sig: string }>())
  const meMark = useRef<Marker | null>(null)
  // Los callbacks van por ref para no re-crear el mapa en cada render del padre.
  const cb = useRef({ onMapClick, onUserMove, onPointDragEnd, onPointClick })
  cb.current = { onMapClick, onUserMove, onPointDragEnd, onPointClick }

  const routesRef = useRef(routes)
  routesRef.current = routes

  /**
   * Vuelca las rutas en el mapa, creando la fuente y la capa si no existen.
   *
   * Se llama en cada 'styledata' y no una sola vez: cargar un estilo reemplaza
   * las fuentes y capas del mapa, así que una capa añadida antes de que
   * termine el estilo definitivo desaparece sin avisar y las rutas dejan de
   * dibujarse. Re-crearla es barato y quita ese modo de fallo.
   */
  // Firma de lo último que se volcó al mapa. Sin esto, cada 'idle' llamaría a
  // setData, eso marca la fuente como modificada, el mapa deja de estar en
  // reposo, vuelve a emitir 'idle'... y el mapa nunca termina de asentarse ni
  // llega a pintar el fondo.
  const applied = useRef('')

  const syncRoutes = useCallback(() => {
    const m = map.current
    if (!m) return
    try {
      let created = false
      if (!m.getSource('routes')) {
        created = true
        m.addSource('routes', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        m.addLayer({
          id: 'routes',
          type: 'line',
          source: 'routes',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 5,
            'line-opacity': ['coalesce', ['get', 'opacity'], 0.75],
          },
        })
      }
      const data = {
        type: 'FeatureCollection' as const,
        features: routesRef.current
          .filter((r) => r.coordinates?.length > 1)
          .map((r) => ({
            type: 'Feature' as const,
            properties: { color: r.color, opacity: r.opacity ?? 0.75 },
            geometry: { type: 'LineString' as const, coordinates: r.coordinates },
          })),
      }
      const sig = JSON.stringify(data)
      if (created || sig !== applied.current) {
        ;(m.getSource('routes') as GeoJSONSource).setData(data)
        applied.current = sig
      }
    } catch {
      // Estilo aún a medias ("Style is not done loading"). Se reintenta solo en
      // el siguiente evento. Preferible a fiarse de isStyleLoaded(), que con
      // conexiones lentas puede quedarse en false más de lo que uno espera.
    }
  }, [])

  useEffect(() => {
    if (!box.current) return
    const m = new MLMap({
      container: box.current,
      style: import.meta.env.VITE_MAPTILER_KEY ? STYLE : FALLBACK_STYLE,
      center: [-99.1332, 19.4326],
      zoom: 11,
      attributionControl: { compact: true },
    })
    map.current = m
    m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')

    // Si MapTiler rechaza el origen (p. ej. IP local no está en Allowed Origins),
    // el mapa queda en blanco. Se cae a OpenFreeMap, que no pide key.
    let fellBack = false
    m.on('error', (e) => {
      const msg = String((e as { error?: Error }).error?.message ?? e)
      if (fellBack || !import.meta.env.VITE_MAPTILER_KEY) return
      if (/ajax|fetch|status|403|401|failed/i.test(msg)) {
        fellBack = true
        m.setStyle(FALLBACK_STYLE)
      }
    })

    // 'styledata', no 'load': load espera además a que bajen los primeros
    // tiles, así que con mala señal no dispara nunca y el mapa se quedaría sin
    // rutas. Para añadir fuentes basta con que el estilo esté listo.
    m.on('styledata', syncRoutes)
    m.on('idle', syncRoutes)

    m.on('click', (e: MapMouseEvent) => cb.current.onMapClick?.([e.lngLat.lng, e.lngLat.lat]))

    // `originalEvent` solo viene si lo movió un dedo, no nuestras propias
    // llamadas a easeTo: si no, el seguimiento se apagaría a sí mismo.
    const userMoved = (e: any) => e.originalEvent && cb.current.onUserMove?.()
    m.on('dragstart', userMoved)
    m.on('zoomstart', userMoved)
    m.on('rotatestart', userMoved)

    // MapLibre solo escucha el resize de la ventana. Aquí el contenedor cambia
    // sin que la ventana cambie: al montar (mide antes de aplicarse el CSS),
    // al plegarse el panel del admin y al rotar el teléfono. Sin esto el mapa
    // se queda dibujado en una esquina.
    const ro = new ResizeObserver(() => m.resize())
    ro.observe(box.current)

    return () => {
      ro.disconnect()
      m.remove()
      map.current = null
      marks.current.clear()
      meMark.current = null
    }
  }, [])

  // --- rutas ---
  useEffect(() => syncRoutes(), [routes, syncRoutes])

  // --- marcadores (puntos + vans) ---
  useEffect(() => {
    const m = map.current
    if (!m) return

    const seen = new Set<string>()

    /**
     * Reutiliza el marcador si su contenido no cambió y solo lo mueve.
     *
     * Antes se recreaba siempre. `points` y `vans` son arrays nuevos en cada
     * render del padre, y la vista del chofer re-renderiza con cada lectura de
     * GPS: eso borraba y volvía a insertar el DOM de todos los marcadores una
     * vez por segundo, que es el parpadeo que se veía en el teléfono.
     */
    const upsert = (key: string, sig: string, lngLat: LngLat, build: () => Marker) => {
      seen.add(key)
      const prev = marks.current.get(key)
      if (prev && prev.sig === sig) {
        prev.mk.setLngLat(lngLat)
        return
      }
      prev?.mk.remove()
      marks.current.set(key, { mk: build().setLngLat(lngLat).addTo(m), sig })
    }

    for (const p of points) {
      upsert(
        `p:${p.id}`,
        `${p.name}|${p.color}|${p.icon}|${p.seq}|${p.visited}|${p.draggable}`,
        [p.lng, p.lat],
        () => {
          const mk = new Marker({ element: pointEl(p), draggable: !!p.draggable })
          if (p.draggable) {
            mk.on('dragend', () => {
              const { lng, lat } = mk.getLngLat()
              cb.current.onPointDragEnd?.(p.id, [lng, lat])
            })
          }
          mk.getElement().addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation()
            cb.current.onPointClick?.(p.id)
          })
          return mk
        },
      )
    }

    for (const v of vans) {
      // El rumbo va en la firma: si cambia hay que redibujar la aguja.
      upsert(
        `v:${v.id}`,
        `${v.name}|${v.color}|${v.stale}|${v.status}|${Math.round(v.heading ?? -1)}`,
        [v.lng, v.lat],
        () => new Marker({ element: vanEl(v) }),
      )
    }

    for (const [key, entry] of marks.current) {
      if (!seen.has(key)) {
        entry.mk.remove()
        marks.current.delete(key)
      }
    }
  }, [points, vans])

  // --- posición propia + cámara en modo navegación ---
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (!me) {
      meMark.current?.remove()
      meMark.current = null
      return
    }
    if (!meMark.current) {
      // setLngLat ANTES de addTo: al añadirlo el marcador se posiciona de
      // inmediato, y sin coordenadas revienta.
      meMark.current = new Marker({ element: el('<div class="mk mk-me"></div>') })
        .setLngLat([me.lng, me.lat])
        .addTo(m)
    }
    meMark.current.setLngLat([me.lng, me.lat])

    if (follow) {
      m.easeTo({
        center: [me.lng, me.lat],
        // Solo se rota con un rumbo confiable; parado el GPS da heading basura
        // y el mapa giraría solo, que marea más que ayudar.
        bearing: me.heading ?? m.getBearing(),
        pitch: 55,
        zoom: Math.max(m.getZoom(), 16),
        duration: 800,
      })
    }
  }, [me, follow])

  // --- encuadre ---
  useEffect(() => {
    const m = map.current
    if (!m || !fitTo?.length) return
    // Mover la cámara no depende del estilo, así que va directo.
    // duration 0 a propósito: el resize del contenedor al montar aborta
    // cualquier animación en curso y el encuadre se quedaría a medias.
    const b = fitTo.reduce((acc, c) => acc.extend(c), new LngLatBounds(fitTo[0], fitTo[0]))
    // maxZoom importa cuando se encuadra un solo punto (ubicar una van): sin
    // tope, fitBounds de un punto se iría al zoom máximo.
    m.fitBounds(b, { padding: 80, maxZoom: 16, duration: 0 })
    // fitKey evita re-encuadrar en cada tick de GPS y quitarle el control al usuario
  }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} className={className ?? 'map'} />
}
