-- Lunch break.
--
-- Es una pausa de la ruta, no una parada: no tiene lugar ni geofence. Se
-- coloca en el orden de la ruta ("después de la parada N") y arranca solo
-- cuando ese punto termina, o a mano con el botón del chofer.
--
-- Como en la permanencia, no hay temporizador corriendo en ningún lado: se
-- guarda la hora de inicio y la duración sale de la configuración global.

-- ---------------------------------------------------------------------------
-- Configuración global. Una sola fila, forzada por el check en la PK.
-- ---------------------------------------------------------------------------
create table app_settings (
  id        bool primary key default true check (id),
  lunch_min int not null default 45 check (lunch_min between 5 and 240)
);
insert into app_settings (id) values (true) on conflict do nothing;

alter table app_settings enable row level security;
create policy admin_all on app_settings for all to authenticated using (true) with check (true);
revoke all on app_settings from anon;

alter table teams
  -- seq de route_stops tras la cual toca el lunch. null = este equipo no tiene.
  add column lunch_after_seq  int,
  -- hora en que empieza (puede estar en el futuro: se programa al llegar a la
  -- parada anterior, y corre recién cuando esa parada termina).
  add column lunch_started_at timestamptz,
  add column lunch_ended_at   timestamptz;

-- ---------------------------------------------------------------------------
-- Programar el lunch al terminar la parada anterior.
--
-- "Terminar" no es "llegar": si la parada exige permanencia, el lunch empieza
-- cuando esa permanencia se cumple. Por eso se calcula arrived_at + dwell_min
-- en vez de esperar a un evento que la base nunca emite (el vencimiento de un
-- plazo no dispara nada por sí solo).
-- ---------------------------------------------------------------------------
create or replace function schedule_lunch()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seq   int;
  v_after int;
  v_dwell int;
begin
  select lunch_after_seq into v_after from teams where id = NEW.team_id;
  if v_after is null then
    return NEW;
  end if;

  select seq into v_seq
  from route_stops where team_id = NEW.team_id and point_id = NEW.point_id;
  if v_seq is distinct from v_after then
    return NEW;
  end if;

  select dwell_min into v_dwell from points where id = NEW.point_id;

  -- lunch_started_at > now(): solo se pisa un horario que todavía no llegó. Sin
  -- esta condición, un equipo que comió antes de tiempo veía su lunch en curso
  -- reiniciarse al registrar la llegada a esta parada.
  update teams set lunch_started_at =
           coalesce(NEW.left_at, NEW.arrived_at + make_interval(mins => coalesce(v_dwell, 0)))
  where id = NEW.team_id
    and lunch_ended_at is null
    and (lunch_started_at is null or lunch_started_at > now());

  return NEW;
end;
$$;

create trigger visits_schedule_lunch
after insert or update on visits
for each row execute function schedule_lunch();

-- ---------------------------------------------------------------------------
-- El chofer arranca o cierra el lunch a mano.
-- ---------------------------------------------------------------------------
create or replace function set_lunch(p_token text, p_device text, p_start bool)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team teams;
begin
  select * into v_team from teams where token = p_token and active;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  if v_team.device_id is not null and v_team.device_id is distinct from p_device then
    raise exception 'equipo en uso en otro dispositivo' using errcode = '55006';
  end if;

  if p_start then
    -- Empezar ahora pisa el horario programado: el equipo decide cuándo come.
    update teams set lunch_started_at = now(), lunch_ended_at = null where id = v_team.id;
  else
    update teams set lunch_ended_at = now()
    where id = v_team.id and lunch_started_at is not null and lunch_ended_at is null;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function set_lunch(text, text, bool) from public;
grant execute on function set_lunch(text, text, bool) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- El chofer necesita la duración global y el estado de su lunch.
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
      'driver_name', v_team.driver_name, 'color', v_team.color,
      'lunch_after_seq', v_team.lunch_after_seq,
      'lunch_started_at', v_team.lunch_started_at,
      'lunch_ended_at', v_team.lunch_ended_at
    ),
    'lunch_min', (select lunch_min from app_settings where id),
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

-- ---------------------------------------------------------------------------
-- Bitácora.
-- ---------------------------------------------------------------------------
alter table events drop constraint if exists events_kind_check;
alter table events add constraint events_kind_check
  check (kind in (
    'inicio', 'pausa', 'maps', 'regreso', 'reconexion',
    'llegada', 'senal', 'completada',
    'estancia', 'liberado', 'dispositivo',
    'lunch', 'lunch_fin'
  ));

create or replace function log_lunch_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Programado a futuro: se anota ahora, con la hora prevista en el detalle.
  -- Fecharlo en el futuro lo dejaría flotando arriba de la bitácora un rato.
  if NEW.lunch_started_at is distinct from OLD.lunch_started_at
     and NEW.lunch_started_at is not null then
    insert into events (team_id, kind, detail, at)
    values (NEW.id, 'lunch',
            case when NEW.lunch_started_at > now() + interval '10 seconds'
                 then 'programado para las ' || to_char(NEW.lunch_started_at, 'HH24:MI')
                 else null end,
            least(NEW.lunch_started_at, now()));
  end if;

  if NEW.lunch_ended_at is distinct from OLD.lunch_ended_at
     and NEW.lunch_ended_at is not null then
    insert into events (team_id, kind, at) values (NEW.id, 'lunch_fin', NEW.lunch_ended_at);
  end if;

  return NEW;
end;
$$;

create trigger teams_lunch_events
after update on teams
for each row execute function log_lunch_event();
