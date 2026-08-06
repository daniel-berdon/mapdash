-- mapdash — schema inicial
-- Modelo: 9 equipos (vans), cada uno con una ruta ordenada de puntos.
-- El chofer entra por link con token y NO tiene acceso directo a ninguna tabla:
-- todo pasa por dos funciones SECURITY DEFINER. El admin entra con Supabase Auth.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Utilidad: distancia en metros entre dos coordenadas (haversine).
-- Sin PostGIS a propósito: una función de 5 líneas evita una extensión entera.
-- ---------------------------------------------------------------------------
create or replace function dist_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable parallel safe as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table points (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  lat        float8 not null,
  lng        float8 not null,
  color      text not null default '#e11d48',
  icon       text not null default 'pin',
  radius_m   int  not null default 50 check (radius_m between 10 and 1000),
  created_at timestamptz not null default now()
);

create table teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  driver_name text,
  phone       text,
  color       text not null default '#2563eb',
  -- hex, no base64: el token viaja en la URL y '+' y '/' la romperían
  token       text not null unique default substr(encode(gen_random_bytes(8), 'hex'), 1, 12),
  active      bool not null default true,
  created_at  timestamptz not null default now()
);

-- Ruta = qué puntos visita el equipo y en qué orden.
create table route_stops (
  team_id  uuid not null references teams(id) on delete cascade,
  point_id uuid not null references points(id) on delete cascade,
  seq      int  not null,
  primary key (team_id, seq)
);
create index on route_stops (team_id);

-- Geometría y maniobras precalculadas por OpenRouteService.
create table routes (
  team_id      uuid primary key references teams(id) on delete cascade,
  geometry     jsonb,  -- GeoJSON LineString
  steps        jsonb,  -- [{instruction, distance, duration, way_points:[i,j]}]
  distance_m   float8,
  duration_s   float8,
  updated_at   timestamptz not null default now()
);

-- Posición ACTUAL: una fila por equipo, siempre UPSERT.
-- El historial no se guarda (ver README si el cliente lo pide).
create table positions (
  team_id    uuid primary key references teams(id) on delete cascade,
  lat        float8 not null,
  lng        float8 not null,
  accuracy   float8,
  heading    float8,
  speed      float8,
  status     text not null default 'live' check (status in ('live', 'en_maps', 'pausado')),
  updated_at timestamptz not null default now()
);

create table visits (
  team_id    uuid not null references teams(id) on delete cascade,
  point_id   uuid not null references points(id) on delete cascade,
  arrived_at timestamptz not null default now(),
  source     text not null default 'auto' check (source in ('auto', 'manual', 'admin')),
  primary key (team_id, point_id)
);

-- ---------------------------------------------------------------------------
-- RLS: por defecto nadie toca nada. El admin autenticado tiene acceso total;
-- el chofer (rol anon) NO tiene acceso a tablas, solo a las dos RPC de abajo.
-- ---------------------------------------------------------------------------

alter table points      enable row level security;
alter table teams       enable row level security;
alter table route_stops enable row level security;
alter table routes      enable row level security;
alter table positions   enable row level security;
alter table visits      enable row level security;

create policy admin_all on points      for all to authenticated using (true) with check (true);
create policy admin_all on teams       for all to authenticated using (true) with check (true);
create policy admin_all on route_stops for all to authenticated using (true) with check (true);
create policy admin_all on routes      for all to authenticated using (true) with check (true);
create policy admin_all on positions   for all to authenticated using (true) with check (true);
create policy admin_all on visits      for all to authenticated using (true) with check (true);

revoke all on points, teams, route_stops, routes, positions, visits from anon;

-- ---------------------------------------------------------------------------
-- RPC 1: contexto del chofer. Una sola llamada devuelve todo lo que su
-- pantalla necesita. Nunca expone otros equipos ni el token de nadie.
-- ---------------------------------------------------------------------------
create or replace function get_driver_context(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team teams;
  v_result jsonb;
begin
  select * into v_team from teams where token = p_token and active;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  select jsonb_build_object(
    'team', jsonb_build_object(
      'id', v_team.id, 'name', v_team.name,
      'driver_name', v_team.driver_name, 'color', v_team.color
    ),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
               'seq', rs.seq, 'id', p.id, 'name', p.name,
               'lat', p.lat, 'lng', p.lng, 'color', p.color,
               'icon', p.icon, 'radius_m', p.radius_m,
               'visited_at', v.arrived_at
             ) order by rs.seq)
      from route_stops rs
      join points p on p.id = rs.point_id
      left join visits v on v.team_id = v_team.id and v.point_id = p.id
      where rs.team_id = v_team.id
    ), '[]'::jsonb),
    'route', (
      select jsonb_build_object('geometry', r.geometry, 'steps', r.steps,
                                'distance_m', r.distance_m, 'duration_s', r.duration_s)
      from routes r where r.team_id = v_team.id
    )
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 2: lista de equipos para el link general /d, donde el chofer elige el
-- suyo. Devuelve el token porque es justo lo que el selector necesita.
--
-- Esto hace que el link general sea, de hecho, la credencial: quien lo tenga
-- puede entrar como cualquier equipo. Decisión consciente para una dinámica de
-- un día. Los links individuales /d/<token> siguen existiendo y no dependen de
-- esta función; si algún día importa, basta con dejar de exponerla.
-- ---------------------------------------------------------------------------
create or replace function list_teams()
returns table (id uuid, name text, driver_name text, color text, token text)
language sql security definer set search_path = public, pg_temp as $$
  select id, name, driver_name, color, token
  from teams where active order by created_at;
$$;

-- ---------------------------------------------------------------------------
-- RPC 3: el chofer reporta posición. En la misma llamada se evalúa el geofence
-- de TODOS sus puntos pendientes (no solo el siguiente: pueden llegar fuera de
-- orden) y se registran las llegadas. El cliente no puede falsear un check-in.
-- ---------------------------------------------------------------------------
create or replace function report_position(
  p_token    text,
  p_lat      float8,
  p_lng      float8,
  p_accuracy float8 default null,
  p_heading  float8 default null,
  p_speed    float8 default null,
  p_status   text   default 'live',
  p_at       timestamptz default null   -- para vaciar el buffer offline con su hora real
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team_id uuid;
  v_arrived uuid[];
begin
  select id into v_team_id from teams where token = p_token and active;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  -- Una lectura con precisión de más de 200 m no sirve para el geofence y
  -- mueve el marcador a saltos: se guarda igual, pero no dispara check-ins.
  insert into positions as pos (team_id, lat, lng, accuracy, heading, speed, status, updated_at)
  values (v_team_id, p_lat, p_lng, p_accuracy, p_heading, p_speed,
          coalesce(p_status, 'live'), coalesce(p_at, now()))
  on conflict (team_id) do update
    set lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
        heading = excluded.heading, speed = excluded.speed,
        status = excluded.status, updated_at = excluded.updated_at
    -- nunca retroceder en el tiempo al vaciar un buffer atrasado
    where excluded.updated_at >= pos.updated_at;

  if coalesce(p_accuracy, 0) > 200 then
    return jsonb_build_object('arrived', '[]'::jsonb);
  end if;

  with pending as (
    select p.id, p.name
    from route_stops rs
    join points p on p.id = rs.point_id
    where rs.team_id = v_team_id
      and not exists (select 1 from visits v where v.team_id = v_team_id and v.point_id = p.id)
      and dist_m(p_lat, p_lng, p.lat, p.lng) <= p.radius_m
  ), ins as (
    insert into visits (team_id, point_id, arrived_at, source)
    select v_team_id, id, coalesce(p_at, now()), 'auto' from pending
    on conflict do nothing
    returning point_id
  )
  select array_agg(point_id) into v_arrived from ins;

  return jsonb_build_object('arrived', to_jsonb(coalesce(v_arrived, '{}'::uuid[])));
end;
$$;

-- El chofer solo puede llamar estas tres funciones. Nada más.
revoke all on function get_driver_context(text) from public;
revoke all on function list_teams() from public;
revoke all on function report_position(text, float8, float8, float8, float8, float8, text, timestamptz) from public;
grant execute on function get_driver_context(text) to anon, authenticated;
grant execute on function list_teams() to anon, authenticated;
grant execute on function report_position(text, float8, float8, float8, float8, float8, text, timestamptz) to anon, authenticated;

-- Realtime para el panel admin.
alter publication supabase_realtime add table positions;
alter publication supabase_realtime add table visits;
