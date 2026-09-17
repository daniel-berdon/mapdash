-- Tiempo real de ruta: desde que el equipo empieza a compartir ubicación hasta
-- que registra su última parada.
--
-- No se deriva de la bitácora a propósito. Los eventos no se borran al
-- restablecer las visitas, así que el 'inicio' de la vuelta anterior daría un
-- tiempo inventado; y peor, el 'completada' viejo impedía que se registrara el
-- de la vuelta nueva (el trigger se saltaba el evento si ya existía uno). Dos
-- columnas en teams, que el restablecer sí limpia, dicen siempre de qué vuelta
-- se está hablando.

alter table teams
  add column if not exists route_started_at  timestamptz,
  add column if not exists route_finished_at timestamptz;

-- Las vueltas que ya ocurrieron sí se pueden reconstruir de la bitácora: es lo
-- único que hay de ellas.
update teams t set
  route_started_at  = (select min(e.at) from events e where e.team_id = t.id and e.kind = 'inicio'),
  route_finished_at = (select min(e.at) from events e where e.team_id = t.id and e.kind = 'completada')
where t.route_started_at is null and t.route_finished_at is null;

-- ---------------------------------------------------------------------------
-- Arranque: lo marca el conductor al empezar a compartir ubicación.
-- ---------------------------------------------------------------------------
create or replace function register_tracking_start(p_token text, p_device text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team_id uuid;
  v_device text;
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

  -- coalesce: reanudar tras una pausa no reinicia el cronómetro de la vuelta.
  update teams set route_started_at = coalesce(route_started_at, now())
  where id = v_team_id;

  -- Evita duplicados por doble toque o una reanudacion solapada.
  if not exists (
    select 1 from events
    where team_id = v_team_id
      and kind = 'inicio'
      and at > now() - interval '10 seconds'
  ) then
    insert into events (team_id, kind, at)
    values (v_team_id, 'inicio', now());
  end if;
end;
$$;

revoke all on function register_tracking_start(text, text) from public;
grant execute on function register_tracking_start(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cierre: la llegada que completa la ruta. El evento 'completada' pasa a
-- depender de route_finished_at en vez de su propio historial, así que una
-- segunda vuelta vuelve a registrarse en la bitácora.
-- ---------------------------------------------------------------------------
create or replace function log_visit_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into events (team_id, point_id, kind, detail, at)
  values (
    NEW.team_id,
    NEW.point_id,
    'llegada',
    case NEW.source
      when 'auto' then null
      when 'manual' then 'marcada por el conductor'
      else 'marcada por el admin'
    end,
    NEW.arrived_at
  );

  -- El equipo pudo no pasar por register_tracking_start (enlace reanudado, o un
  -- restablecimiento a mitad de jornada). Su primera llegada abre la vuelta.
  update teams set route_started_at = coalesce(route_started_at, NEW.arrived_at)
  where id = NEW.team_id;

  if exists (
       select 1 from route_stops rs where rs.team_id = NEW.team_id
     )
     and not exists (
       select 1
       from route_stops rs
       where rs.team_id = NEW.team_id
         and not exists (
           select 1 from visits v
           where v.team_id = rs.team_id and v.point_id = rs.point_id
         )
     )
     and exists (
       select 1 from teams t where t.id = NEW.team_id and t.route_finished_at is null
     ) then
    update teams set route_finished_at = NEW.arrived_at where id = NEW.team_id;

    insert into events (team_id, kind, at)
    values (NEW.team_id, 'completada', NEW.arrived_at);
  end if;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Una ruta deja de estar completa si el admin borra una llegada o le agrega una
-- parada. En ambos casos el cronómetro tiene que volver a correr.
-- ---------------------------------------------------------------------------
create or replace function clear_route_finish()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update teams set route_finished_at = null
  where id = case TG_OP when 'DELETE' then OLD.team_id else NEW.team_id end
    and route_finished_at is not null;
  return null;
end;
$$;

create trigger visits_unfinish
after delete on visits
for each row execute function clear_route_finish();

create trigger route_stops_unfinish
after insert on route_stops
for each row execute function clear_route_finish();

revoke all on function clear_route_finish() from public, anon, authenticated;
