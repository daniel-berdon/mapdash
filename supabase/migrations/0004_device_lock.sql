-- Un enlace de equipo = un dispositivo.
--
-- Si dos personas abren el link del mismo equipo, las dos reportan y el
-- marcador salta entre ambas. Esto no se puede resolver en el navegador: el
-- teléfono de la segunda persona no sabe nada del de la primera.
--
-- El equipo queda vinculado al primer dispositivo que lo reclama. Los demás
-- reciben "en uso" y no pueden reportar.

alter table teams
  add column device_id   text,
  add column device_seen timestamptz;

-- ---------------------------------------------------------------------------
-- Si el teléfono que tiene el equipo se queda sin batería o el chofer borra los
-- datos del navegador, ese equipo quedaría bloqueado para siempre. Pasado este
-- tiempo sin reportar, otro dispositivo puede tomarlo.
--
-- 10 minutos: bastante más que cualquier túnel o semáforo, bastante menos que
-- lo que tardaría alguien en darse cuenta y llamar al organizador.
-- ---------------------------------------------------------------------------
create or replace function device_stale_after() returns interval
language sql immutable as $$ select interval '10 minutes' $$;

-- ---------------------------------------------------------------------------
-- Reclamar el equipo para un dispositivo.
-- Devuelve {ok:true} o {ok:false, minutes:N} con lo que lleva activo el otro.
-- ---------------------------------------------------------------------------
create or replace function claim_team(p_token text, p_device text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team teams;
  v_idle interval;
begin
  if coalesce(p_device, '') = '' then
    raise exception 'dispositivo no identificado' using errcode = '22023';
  end if;

  -- FOR UPDATE: dos choferes tocando "Iniciar" a la vez no pueden reclamar los
  -- dos. El segundo espera y ve el equipo ya ocupado.
  select * into v_team from teams where token = p_token and active for update;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  v_idle := now() - coalesce(v_team.device_seen, 'epoch'::timestamptz);

  if v_team.device_id is null
     or v_team.device_id = p_device
     or v_idle > device_stale_after() then
    update teams set device_id = p_device, device_seen = now() where id = v_team.id;
    return jsonb_build_object('ok', true);
  end if;

  return jsonb_build_object('ok', false, 'minutes', floor(extract(epoch from v_idle) / 60));
end;
$$;

-- ---------------------------------------------------------------------------
-- report_position ahora exige que el dispositivo sea el vinculado.
-- ---------------------------------------------------------------------------
drop function if exists report_position(text, float8, float8, float8, float8, float8, text, timestamptz);

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
    raise exception 'token inválido' using errcode = '28000';
  end if;

  -- El equipo está tomado por otro teléfono. Se rechaza en vez de aceptar
  -- posiciones de dos sitios: el cliente muestra "en uso" y suelta el GPS.
  if v_device is not null and v_device is distinct from p_device then
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

-- ---------------------------------------------------------------------------
-- El check-in manual también tiene que respetar el vínculo: si no, el segundo
-- dispositivo no podría reportar posición pero sí marcar paradas ajenas.
-- ---------------------------------------------------------------------------
drop function if exists manual_checkin(text, uuid);

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
    raise exception 'token inválido' using errcode = '28000';
  end if;

  if v_device is not null and v_device is distinct from p_device then
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
    raise exception 'parada no válida o ya registrada' using errcode = '22023';
  end if;

  insert into visits (team_id, point_id, arrived_at, source)
  values (v_team_id, p_point_id, now(), 'manual')
  on conflict do nothing;

  return jsonb_build_object('arrived', jsonb_build_array(p_point_id), 'name', v_name);
end;
$$;

revoke all on function manual_checkin(text, uuid, text) from public;
grant execute on function manual_checkin(text, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- El selector del link general marca los equipos ya tomados.
-- ---------------------------------------------------------------------------
drop function if exists list_teams();

create or replace function list_teams()
returns table (id uuid, name text, driver_name text, color text, token text, taken boolean)
language sql security definer set search_path = public, pg_temp as $$
  select id, name, driver_name, color, token,
         device_id is not null and now() - coalesce(device_seen, 'epoch'::timestamptz) <= device_stale_after()
  from teams where active order by created_at;
$$;

revoke all on function claim_team(text, text) from public;
revoke all on function list_teams() from public;
revoke all on function report_position(text, float8, float8, float8, float8, float8, text, timestamptz, text) from public;
grant execute on function claim_team(text, text) to anon, authenticated;
grant execute on function list_teams() to anon, authenticated;
grant execute on function report_position(text, float8, float8, float8, float8, float8, text, timestamptz, text) to anon, authenticated;
