-- Tiempo de permanencia en cada parada.
--
-- Llegar ya no basta: el equipo tiene que quedarse un rato en la parada. El
-- cronómetro no vive en la base ni en el teléfono, se deriva de dos datos que
-- ya existen: visits.arrived_at (cuándo entró al radio) y points.dwell_min.
-- Así el chofer y el panel cuentan lo mismo, y recargar la página no reinicia
-- nada.
--
-- 0 = parada de paso, sin tiempo mínimo. Es el valor por defecto para no
-- cambiar el comportamiento de las paradas que ya existen.
alter table points
  add column dwell_min int not null default 0 check (dwell_min between 0 and 240);

-- get_driver_context tiene que mandar dwell_min: el chofer pinta la cuenta
-- regresiva con esto y con visited_at, sin una llamada extra.
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
