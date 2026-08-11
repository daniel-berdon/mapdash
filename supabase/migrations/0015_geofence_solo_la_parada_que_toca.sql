-- El geofence solo mira la parada que toca, no todas las pendientes.
--
-- Hasta ahora report_position comparaba la posición contra CADA parada sin
-- visitar del equipo. Si la ruta pasa cerca de una parada posterior — al
-- chofer le toca la A y el trayecto bordea la F — se registraba la llegada a
-- la F y arrancaba su cronómetro de permanencia sin que nadie bajara del
-- coche. Peor: si dos paradas caían dentro del radio en el mismo fix, se
-- marcaban las dos de golpe.
--
-- Ahora solo entra en juego la de menor `seq` sin visitar. Las demás no
-- existen para el geofence hasta que les llegue el turno.
--
-- Lo que NO cambia: manual_checkin sigue aceptando cualquier parada de la ruta
-- (es la salida de emergencia cuando el GPS no dispara, y el chofer solo ve el
-- botón de la siguiente), y el corte por `accuracy > 200` sigue delante de
-- todo esto.

create or replace function report_position(
  p_token    text,
  p_lat      float8,
  p_lng      float8,
  p_accuracy float8 default null,
  p_heading  float8 default null,
  p_speed    float8 default null,
  p_status   text   default 'live',
  p_at       timestamptz default null,
  p_device   text   default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team_id uuid;
  v_device  text;
  v_arrived uuid[];
begin
  select id, device_id into v_team_id, v_device
  from teams where token = p_token and active;
  if not found then
    raise exception 'token invalido' using errcode = '28000';
  end if;

  if v_device is null then
    raise exception 'enlace liberado por el administrador' using errcode = '55007';
  end if;
  if v_device is distinct from p_device then
    raise exception 'equipo en uso en otro dispositivo' using errcode = '55006';
  end if;

  update teams set device_seen = now() where id = v_team_id;

  insert into positions as pos (team_id, lat, lng, accuracy, heading, speed, status, updated_at)
  values (v_team_id, p_lat, p_lng, p_accuracy, p_heading, p_speed,
          coalesce(p_status, 'live'), coalesce(p_at, now()))
  on conflict (team_id) do update
    set lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
        heading = excluded.heading, speed = excluded.speed,
        status = excluded.status, updated_at = excluded.updated_at
    where excluded.updated_at >= pos.updated_at;

  if coalesce(p_accuracy, 0) > 200 then
    return jsonb_build_object('arrived', '[]'::jsonb);
  end if;

  with siguiente as (
    -- La parada activa de la secuencia: la primera que queda por visitar.
    select rs.point_id
    from route_stops rs
    where rs.team_id = v_team_id
      and not exists (
        select 1 from visits v where v.team_id = v_team_id and v.point_id = rs.point_id
      )
    order by rs.seq
    limit 1
  ), pending as (
    select p.id
    from siguiente s
    join points p on p.id = s.point_id
    where dist_m(p_lat, p_lng, p.lat, p.lng) <= p.radius_m
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
