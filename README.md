# MapDash

Seguimiento en vivo de 9 vans durante una dinámica urbana.
Panel admin con las vans en tiempo real, y una vista por chofer que comparte
ubicación, muestra su ruta y navega — sin app nativa.

- Panel admin: `/admin` (usuario + contraseña)
- Vista chofer: `/d/<token>` (link individual) o `/d` (elige su equipo de una lista)

---

## Puesta en marcha

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com) (plan gratuito).
2. SQL Editor → ejecuta las migraciones de `supabase/migrations/` **en orden**:
   `0001_init.sql` y después `0002_events.sql`.
3. Authentication → Users → **Add user**. Supabase exige un correo, pero el
   login pide solo usuario: escribe el correo como `<usuario>@mapdash.local`.
   Para entrar como `admin`, crea `admin@mapdash.local` con su contraseña.
   Desactiva "Confirm email" o confírmalo a mano.
4. Project Settings → API → copia `URL` y `anon public`.

### 2. Logo

Pon el logo del evento en `public/logo.svg` o `public/logo.png`. Aparece en el
login, en el panel y en la pantalla de bienvenida del chofer. Si el archivo no
existe se muestra solo el nombre “MapDash”, sin imagen rota.

Mejor SVG si lo tienes: el logo se pinta a 40 px en el panel y a 96 px en las
pantallas grandes, y un PNG pequeño se vería borroso en ese segundo caso.

### 3. Keys de mapas y rutas

- **MapTiler** ([maptiler.com](https://www.maptiler.com), gratis 100k tiles/mes):
  crea una API key y **restríngela a tu dominio**.
  Sin key la app cae a OpenFreeMap, que funciona pero no tiene garantías.
- **OpenRouteService** ([openrouteservice.org/dev](https://openrouteservice.org/dev),
  gratis 2,000 req/día): crea una key. Esta **no** lleva prefijo `VITE_`: se queda
  en el servidor porque ORS no permite restringirla por dominio.

### 4. Local

```bash
cp .env.example .env   # y llena los 4 valores
npm install
npm run dev
```

### 5. Deploy (Vercel)

```bash
npx vercel
```

Carga las 4 variables en Vercel → Settings → Environment Variables.
`ORS_API_KEY` va **sin** prefijo `VITE_`.

> HTTPS es obligatorio: sin él el navegador no da geolocalización.
> Vercel ya lo trae; si despliegas en otro lado, asegúralo.

---

## Uso el día del evento

1. En **Paradas**, toca "Agregar parada" y haz clic en el mapa. Ajusta nombre,
   color, icono y radio de llegada. Arrastra el marcador para reubicarlo.
2. En **Equipos**, crea las 9 vans. A cada una:
   - agrega sus paradas y ordénalas con ▲▼, o toca **Optimizar orden**;
   - copia el link y mándalo al chofer por WhatsApp.

   Alternativa: manda a todos el mismo link `/d` y que cada quien elija su
   equipo de la lista. Más cómodo (un mensaje al grupo en vez de nueve), pero
   quien tenga ese link puede entrar como cualquier equipo. Los links
   individuales siguen funcionando igual y saltan el selector.
3. Durante la dinámica el panel muestra el semáforo por equipo:

   | Estado | Significa | Qué hacer |
   |---|---|---|
   | **En vivo** (rojo, con punto) | Datos frescos (<30 s) | Nada |
   | En Google Maps (ámbar) | El chofer salió a Maps | Nada, es normal; se ve su última posición |
   | Sin datos hace X (triángulo rojo) | >30 s callado | Llamarlo: teléfono bloqueado, sin señal o app cerrada |
   | No ha iniciado (gris) | Nunca abrió el link | Recordarle abrir el link |

Los check-ins son automáticos al entrar en el radio de la parada. Si el geofence
falla, el admin puede marcarlos a mano con ✓.

Abajo del panel, **Últimos eventos** lleva la bitácora: quién inició, quién
llegó a qué parada, quién salió a Google Maps y quién estuvo sin reportar. Se
genera con triggers en la base, así que queda registrado aunque el panel esté
cerrado y sobrevive a recargar la página.

---

## Cómo navegan los choferes

Hay dos formas y el chofer elige. Existen las dos porque **el navegador corta el
GPS cuando el teléfono se bloquea o cuando otra app pasa al frente** — en iOS
siempre, en Android casi siempre. Es una decisión de Apple/Google; no hay truco
de PWA que lo evite.

**Google Maps por voz (recomendado).** El chofer toca "Google Maps", arranca la
navegación y **vuelve a la pestaña del navegador**. Google Maps es app nativa y
sigue dictando los giros desde el fondo; la pestaña al frente mantiene el GPS
enviando. Oye a Google y ve su mapa aquí.
Requiere permiso de ubicación **"Siempre"** para Google Maps y volumen encendido.

**Navegación dentro de la app.** Siempre activa: instrucciones de giro y voz en
español, mapa que sigue y rota con el rumbo, y recálculo automático si se desvía
más de 100 m. Nunca sale del navegador. No tiene tráfico en tiempo real.

La cámara se suelta si el chofer mueve el mapa con el dedo, para poder mirar
alrededor sin que cada lectura de GPS se lo arranque de las manos; el botón
**Centrar** la vuelve a enganchar.

Si el chofer se queda dentro de Google Maps, la app ya avisó al panel antes de
salir (ámbar, con su última posición y su destino), y al volver a la pestaña se
reanuda solo: recupera el Wake Lock y sube las posiciones que guardó sin señal.

---

## Verificación

```bash
npm test
```

```bash
npm run build
```

Antes del evento, en dos ventanas: `/admin` y `/d/<token>`. Mueve la posición
con Chrome DevTools → Sensors → Custom location y comprueba que el marcador del
admin se mueve en menos de 2 s y que el check-in se dispara dentro del radio.

### Prueba de campo — obligatoria

En coche, con un iPhone y un Android reales, soporte y cargador:

1. **Que Google Maps siga hablando con el navegador al frente.** Es el supuesto
   crítico de todo el diseño. Si falla en los teléfonos del cliente, hay que
   confiar en la navegación propia de la app y decírselo antes del evento.
2. Que el rastreo no se interrumpa mientras Maps habla desde el fondo.
3. Que las instrucciones propias lleguen con tiempo y se oigan sobre el ruido.
4. Que la batería aguante: GPS + pantalla encendida consume más de lo que
   repone un cargador flojo.

### Checklist de logística

- Soporte de teléfono y cargador **por van**.
- Datos móviles en los 9 teléfonos.
- Permiso de ubicación en **"Preciso"** (iOS puede quedar en aproximado, ~1 km).
- **Modo de bajo consumo apagado**: degrada el GPS.
- Batería llena al salir.
- Un teléfono de repuesto y la lista de paradas impresa como plan B.
- Internet por cable para la pantalla del panel, no wifi de hotel.

---

## Decisiones y límites

- **Sin historial.** Solo se guarda la posición actual (un renglón por equipo).
  Si el cliente quiere replay post-evento, hay que decidirlo **antes**: es una
  tabla de solo inserción, y lo que no se guardó no se puede reconstruir.
- **Sin tráfico en tiempo real.** Se compensa ordenando bien las rutas con
  "Optimizar orden".
- **Sin roles.** Un admin, creado a mano. Un segundo admin se crea en el
  dashboard de Supabase en 30 segundos, sin tocar código.
- **Seguridad**: el chofer (rol `anon`) no tiene acceso a ninguna tabla. Solo
  puede llamar `get_driver_context`, `list_teams` y `report_position`. El
  check-in se decide en el servidor: el cliente no puede falsear llegadas.
- El link general `/d` es, de hecho, la credencial: quien lo tenga puede entrar
  como cualquier equipo. Decisión consciente para una dinámica de un día. Si
  algún día importa, se quita el `grant` de `list_teams` a `anon` y solo quedan
  los links individuales — sin tocar nada más.
- Si un link individual se filtra, **Regenerar** en el panel lo invalida al
  instante.

## Stack

React + Vite · MapLibre GL JS + MapTiler · Supabase (Postgres, Realtime, Auth) ·
OpenRouteService · Vercel. Todo dentro de los planes gratuitos a esta escala.
