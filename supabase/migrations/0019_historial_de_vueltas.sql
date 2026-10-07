-- Historial de vueltas.
--
-- Las rutas ahora se repiten por día: la del lunes se vuelve a hacer el lunes
-- siguiente. Restablecer borraba las visitas y con ellas la vuelta anterior,
-- así que el reporte solo podía mostrar la última. Ahora, antes de borrar, la
-- vuelta se copia a route_runs y el reporte lee de ahí.
--
-- Se guarda una foto, no referencias: nombre de ruta, chofer y nombre de cada
-- parada tal como estaban ese día. Si después se edita la ruta o se borra una
-- parada, el reporte del lunes pasado no cambia.

create table route_runs (
  id          bigint generated always as identity primary key,
  -- set null: borrar la ruta no se lleva su historial.
  team_id     uuid references teams(id) on delete set null,
  route_name  text not null,
  driver_name text,
  phone       text,
  started_at  timestamptz,
  finished_at timestamptz,
  reset_at    timestamptz not null default now(),
  -- [{seq, name, arrived_at, left_at}] en el orden de la ruta
  stops       jsonb not null default '[]'::jsonb
);

alter table route_runs enable row level security;
create policy admin_all on route_runs for all to authenticated using (true) with check (true);
revoke all on route_runs from anon;

-- ---------------------------------------------------------------------------
-- Restablecer una ruta (o todas, con null): archiva la vuelta y deja la ruta
-- como recién creada. Sin visitas, sin lunch, sin cronómetro, sin teléfono y
-- sin ubicación. El teléfono que la tenía recibe 55007 en su siguiente
-- reporte y vuelve al selector.
--
-- Una sola función para que archivar y borrar vayan en la misma transacción:
-- si algo falla a la mitad, no se pierde la vuelta ni queda archivada dos
-- veces.
-- ---------------------------------------------------------------------------
create or replace function reset_route(p_team_id uuid default null)
returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  -- Una ruta que ni arrancó ni tiene llegadas no es una vuelta: no se archiva.
  insert into route_runs (team_id, route_name, driver_name, phone, started_at, finished_at, stops)
  select t.id, t.name, t.driver_name, t.phone, t.route_started_at, t.route_finished_at,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'seq', rs.seq, 'name', p.name,
                    'arrived_at', v.arrived_at, 'left_at', v.left_at
                  ) order by rs.seq)
           from route_stops rs
           join points p on p.id = rs.point_id
           left join visits v on v.team_id = t.id and v.point_id = rs.point_id
           where rs.team_id = t.id
         ), '[]'::jsonb)
  from teams t
  where (p_team_id is null or t.id = p_team_id)
    and (t.route_started_at is not null
         or exists (select 1 from visits v where v.team_id = t.id));

  delete from visits where p_team_id is null or team_id = p_team_id;

  -- Después de borrar las visitas: su trigger vuelve a tocar teams.
  update teams set
    lunch_started_at = null, lunch_ended_at = null,
    route_started_at = null, route_finished_at = null,
    device_id = null, device_seen = null
  where p_team_id is null or id = p_team_id;

  delete from positions where p_team_id is null or team_id = p_team_id;
end;
$$;

revoke all on function reset_route(uuid) from public, anon;
grant execute on function reset_route(uuid) to authenticated;
