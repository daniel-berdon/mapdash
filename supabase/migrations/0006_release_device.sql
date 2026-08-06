-- Liberar desde el admin debe expulsar al telefono que estaba reportando.
-- Un device_id nulo ya no acepta posiciones: el siguiente reporte recibe
-- 55007 y el cliente vuelve al selector de equipos.

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

  with pending as (
    select p.id
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

create or replace function manual_checkin(p_token text, p_point_id uuid, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team_id uuid;
  v_device  text;
  v_name    text;
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

  select p.name into v_name
  from route_stops rs
  join points p on p.id = rs.point_id
  where rs.team_id = v_team_id
    and rs.point_id = p_point_id
    and not exists (
      select 1 from visits v
      where v.team_id = v_team_id and v.point_id = p_point_id
    );

  if not found then
    raise exception 'parada no valida o ya registrada' using errcode = '22023';
  end if;

  insert into visits (team_id, point_id, arrived_at, source)
  values (v_team_id, p_point_id, now(), 'manual')
  on conflict do nothing;

  return jsonb_build_object('arrived', jsonb_build_array(p_point_id), 'name', v_name);
end;
$$;
