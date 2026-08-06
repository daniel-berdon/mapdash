<div align="center">

<img src="public/logo.png" alt="MapDash" width="96" />

# MapDash

**Seguimiento en vivo de vans durante una dinámica urbana.**

Panel de organizador con todas las vans en tiempo real, y una vista por chofer
que comparte ubicación, muestra su ruta y navega con voz — todo en el navegador,
sin app nativa que instalar.

[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)](https://vite.dev)
[![MapLibre](https://img.shields.io/badge/MapLibre_GL-6-295daa?logo=maplibre&logoColor=white)](https://maplibre.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres_·_Realtime-3ecf8e?logo=supabase&logoColor=white)](https://supabase.com)

</div>

---

## Qué resuelve

Una dinámica urbana con varias vans tiene tres problemas a la vez: **saber dónde
está cada una**, **que cada chofer sepa a dónde va**, y **enterarse cuando algo
se rompe** (se quedó sin señal, cerró la pestaña, se saltó una parada). MapDash
cubre los tres en una sola pantalla y con un link por chofer.

| Rol | Entra por | Qué ve |
|---|---|---|
| Organizador | `/admin` — usuario y contraseña | Mapa de todas las vans, rutas, paradas y bitácora |
| Chofer | `/d/<token>` — link individual | Su ruta, su siguiente parada y navegación por voz |
| Chofer | `/seleccion` — link general | Lista de equipos; elige el suyo y entra sin contraseña |

---

## Panel del organizador

### Paradas

- **Crear con un clic en el mapa**, o arrastrar el marcador para reubicarla.
- Cada parada tiene **nombre, color, icono** (de un catálogo) y **radio de llegada** ajustable de 10 a 300 m.
- Mover o borrar una parada **recalcula sola** toda ruta que pasaba por ella.
- Si una parada cae donde no hay calle, el error dice **cuál es** por su nombre, no coordenadas crudas.

### Equipos y rutas

- Alta de equipos con color propio, nombre del chofer y teléfono. Los campos se **guardan solos** al dejar de teclear.
- Ruta por arrastre de paradas: agregar, quitar, reordenar con ▲▼.
- **Optimizar orden** resuelve el TSP con el motor VROOM de OpenRouteService, respetando la primera parada como salida fija.
- Cada ruta guarda su **trazo por calles, sus maniobras, distancia y duración**.
- **Ocultar/mostrar** un equipo del mapa, y **Ubicar** para centrarse en su van.

### Semáforo en vivo

Cada equipo lleva un estado que se actualiza por Realtime, y un reloj propio en
el panel: si la van deja de reportar, no manda nada — el gris tiene que salir
del tiempo transcurrido, no de un evento.

| Estado | Significa | Qué hacer |
|---|---|---|
| 🟢 **En vivo** | Datos frescos (<30 s) | Nada |
| 🟠 **En Google Maps** | El chofer salió a Maps; se ve su última posición | Nada, es normal |
| 🔴 **Sin datos hace X** | Más de 30 s callado | Llamarlo: teléfono bloqueado, sin señal o pestaña cerrada |
| ⚪ **No ha iniciado** | Nunca abrió el link | Recordarle que lo abra |
| 🏁 **Completada** | Todas sus paradas registradas | Nada |

### Check-ins

El check-in es **automático al entrar en el radio** de la parada, y lo decide el
servidor: el cliente no puede falsear llegadas. Si el GPS falla, tanto el chofer
como el organizador pueden marcar la llegada a mano — y el organizador también
desmarcarla.

### Bitácora de eventos

**Últimos eventos** registra quién inició, quién llegó a qué parada, quién salió
a Google Maps, quién recuperó la conexión, quién estuvo sin reportar y quién
completó su ruta. Se genera con **triggers en la base**, así que queda escrito
aunque el panel esté cerrado y sobrevive a recargar la página.

### Control de acceso del chofer

- **Copiar link** de cada equipo, listo para mandar por WhatsApp.
- **Generar enlace nuevo** invalida al instante el anterior si se filtró.
- **Liberar dispositivo** suelta el enlace para que otro teléfono lo tome.

---

## Vista del chofer

### Antes de arrancar

Pantalla de consentimiento explícito: se le dice que se compartirá su ubicación,
que deje la pestaña al frente, cómo usar Google Maps sin romper el envío, y que
puede terminar cuando quiera.

### Durante la ruta

- **Banda de maniobra** arriba: instrucción y metros que faltan al giro.
- **Voz en español** que anuncia cada maniobra a 300 m y a 50 m, una vez cada una, y silenciable.
- **Mapa que sigue y rota** con el rumbo. Si el chofer mueve el mapa con el dedo la cámara se suelta —para poder mirar alrededor— y **Centrar** la vuelve a enganchar.
- **Ruta en dos tonos**: el tramo en curso a color pleno, lo que queda más tenue.
- Lista de paradas plegable con las visitadas tachadas, y **Registrar llegada** a mano.
- **Barra de estado** permanente: compartiendo, sin señal (con las posiciones en cola), detenido o sin permiso de ubicación.
- **Botón rojo** para terminar y dejar de compartir, siempre visible.

### Un solo teléfono por equipo

El equipo se **reserva para un dispositivo** al iniciar. Si otro teléfono intenta
entrar con el mismo link, ve una pantalla que le explica qué pasa y qué hacer; el
enlace se libera solo tras **5 minutos sin reportar**, o al instante desde el
panel. Dos pestañas del mismo teléfono también se resuelven: la última gana y la
anterior suelta el GPS, para que el panel no vea dos vans idénticas.

---

## Cómo se mantiene el rastreo vivo

El navegador **corta el GPS cuando el teléfono se bloquea o cuando otra app pasa
al frente** — en iOS siempre, en Android casi siempre. Es una decisión de
Apple/Google, no hay truco de PWA que lo evite. MapDash trabaja con eso, no
contra eso:

- **Wake Lock** para que la pantalla no se apague sola, con aviso al chofer si el navegador lo rechaza (Safari lo hace en batería baja).
- **Aviso antes de salir**: al tocar "Google Maps" se reporta el estado `en_maps` con la última posición, para que el panel lo pinte en ámbar y no en gris.
- **Reanudación automática** al volver a la pestaña: recupera el Wake Lock, vuelve a `live` y vacía lo que quedó pendiente.
- **Buffer offline** en `localStorage` — hasta 300 posiciones, unos 25 minutos: se envían en orden cronológico al recuperar señal y el servidor descarta las que lleguen viejas.
- **Recuperación tras recarga**: iOS descarta pestañas inactivas cuando anda escaso de memoria; el estado vive en `localStorage` y el rastreo vuelve solo, sin pedirle nada al chofer.
- **Envío con filtro**: solo se manda si pasaron 3 s o si de verdad se movió 10 m, más un latido cada 5 s para detectar liberaciones del panel.

### Las dos formas de navegar

Ambas están disponibles y el chofer elige:

**Google Maps por voz.** Toca "Google Maps", arranca la navegación y **vuelve a
la pestaña**. Maps es app nativa y sigue dictando los giros desde el fondo; la
pestaña al frente mantiene el GPS enviando. Abre la app nativa por
`comgooglemaps://` y cae a la web si no está instalada.

**Navegación propia, dentro de la app.** Siempre activa. Proyecta la posición
sobre la polilínea de la ruta para saber en qué maniobra va, y **recalcula sola**
si el chofer se desvía más de 100 m durante 15 s seguidos —el margen evita que
un GPS nervioso dispare peticiones. La ruta se traza desde donde está el chofer,
no desde la parada anterior. No tiene tráfico en tiempo real.

---

## Arquitectura

```
src/
├─ pages/
│  ├─ Admin.tsx        Panel: paradas, equipos, rutas, semáforo
│  ├─ Driver.tsx       Vista del chofer + selector de equipo
│  ├─ Login.tsx        Usuario y contraseña (Supabase Auth)
│  └─ Home.tsx         Entrada a las dos vistas
├─ components/
│  ├─ Map.tsx          MapLibre: vans, paradas, rutas, encuadre
│  └─ EventLog.tsx     Bitácora en vivo por Realtime
├─ lib/
│  ├─ useTracking.ts   GPS, Wake Lock, buffer offline, estados
│  ├─ geo.ts           Haversine, proyección sobre ruta, tramos, buffer
│  ├─ deviceLock.ts    Un equipo por dispositivo y por pestaña
│  ├─ routing.ts       Cliente del proxy de rutas
│  └─ supabase.ts      Tipos y RPC
├─ api/route.ts        Proxy serverless a OpenRouteService
└─ supabase/migrations Esquema, RPC, políticas y triggers
```

**Convención de coordenadas:** siempre `[lng, lat]`, orden GeoJSON, igual que
MapLibre y ORS. Mezclar los dos órdenes es el bug clásico de estos proyectos.

### Seguridad

- El chofer (rol `anon`) **no tiene acceso a ninguna tabla**. Solo puede llamar seis RPC: `get_driver_context`, `list_teams`, `claim_team`, `register_tracking_start`, `report_position` y `manual_checkin`.
- El **check-in se decide en el servidor**, comparando contra el radio de la parada. El cliente no puede inventar llegadas.
- El panel exige sesión autenticada; RLS deja las tablas solo para `authenticated`.
- La key de OpenRouteService **no viaja al navegador**: vive en el proxy serverless, porque ORS no permite restringirla por dominio.
- El link general `/seleccion` es, de hecho, la credencial: quien lo tenga puede entrar como cualquier equipo libre. Decisión consciente para una dinámica de un día; se cierra quitando el `grant` de `list_teams` a `anon`, sin tocar nada más.

### Límites conocidos

- **Sin historial de recorrido.** Solo se guarda la posición actual, un renglón por equipo. Un replay post-evento habría que decidirlo antes: lo que no se guardó no se reconstruye.
- **Sin tráfico en tiempo real.** Se compensa con *Optimizar orden*.
- **Sin roles.** Un admin, creado a mano; un segundo se agrega desde el dashboard de Supabase sin tocar código.

---

## Stack

**React 19 + TypeScript + Vite** · **MapLibre GL JS** con teselas de MapTiler
(fallback a OpenFreeMap) · **Supabase** para Postgres, Realtime y Auth ·
**OpenRouteService** para rutas por calles, maniobras en español y optimización
de orden · **Vercel** para hosting y la función serverless. Todo dentro de los
planes gratuitos a esta escala.

<div align="center">

Desarrollado por [cactusdigital.mx](https://cactusdigital.mx)

</div>
