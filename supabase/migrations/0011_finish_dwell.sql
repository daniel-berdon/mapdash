-- El chofer puede dar por terminada la estancia antes de que se agote.
--
-- Hasta ahora la permanencia solo se calculaba: arrived_at + dwell_min. Si el
-- equipo termina la actividad antes, no había dónde anotarlo y el cronómetro
-- reaparecía al recargar. left_at es ese dato: puesto, la parada deja de
-- contar tiempo para siempre.
alter table visits add column left_at timestamptz;

-- ---------------------------------------------------------------------------
-- Cerrar la estancia. Mismo control de dispositivo que manual_checkin: si no,
-- un segundo teléfono podría cortarle el tiempo al equipo desde fuera.
-- ---------------------------------------------------------------------------
create or replace function finish_dwell(p_token text, p_point_id uuid, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team_id uuid;
  v_device  text;
begin
  select id, device_id into v_team_id, v_device
  from teams where token = p_token and active;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  if v_device is not null and v_device is distinct from p_device then
    raise exception 'equipo en uso en otro dispositivo' using errcode = '55006';
  end if;

  -- left_at is null: cerrar dos veces no debe mover la hora ya registrada.
  update visits set left_at = now()
  where team_id = v_team_id and point_id = p_point_id and left_at is null;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function finish_dwell(text, uuid, text) from public;
grant execute on function finish_dwell(text, uuid, text) to anon, authenticated;

-- get_driver_context tiene que mandar left_at: es lo que apaga el cronómetro
-- en el teléfono después de recargar.
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
               'dwell_min', p.dwell_min,
               'visited_at', v.arrived_at,
               'left_at', v.left_at
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
