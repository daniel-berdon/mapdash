-- Tres cosas que ya pasaban y no dejaban rastro en la bitácora.
--
-- El criterio sigue siendo el de 0002: los eventos los generan triggers, no el
-- cliente, para que queden aunque el panel esté cerrado y aunque el cambio lo
-- haga el propio admin.

alter table events drop constraint if exists events_kind_check;
alter table events add constraint events_kind_check
  check (kind in (
    'inicio', 'pausa', 'maps', 'regreso', 'reconexion',
    'llegada', 'senal', 'completada',
    -- nuevos
    'estancia',    -- cerró el tiempo de visita de una parada
    'liberado',    -- el admin soltó el enlace del equipo
    'dispositivo'  -- otro teléfono se quedó con el equipo
  ));

-- ---------------------------------------------------------------------------
-- Fin de la estancia en una parada.
--
-- Interesa sobre todo cuando se van antes: el organizador quiere saber qué
-- equipo cortó la actividad y cuánto tiempo le quedaba.
-- ---------------------------------------------------------------------------
create or replace function log_dwell_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dwell int;
  v_left  interval;
begin
  if OLD.left_at is not null or NEW.left_at is null then
    return NEW;
  end if;

  select dwell_min into v_dwell from points where id = NEW.point_id;
  v_left := (NEW.arrived_at + make_interval(mins => coalesce(v_dwell, 0))) - NEW.left_at;

  insert into events (team_id, point_id, kind, detail, at)
  values (NEW.team_id, NEW.point_id, 'estancia',
          case when v_left > interval '1 minute'
               then 'se fue con ' || trim(to_char(extract(epoch from v_left) / 60, '9990'))
                    || ' min por delante'
               else null
          end,
          NEW.left_at);
  return NEW;
end;
$$;

create trigger visits_dwell_events
after update on visits
for each row execute function log_dwell_event();

-- ---------------------------------------------------------------------------
-- Cambios de dueño del enlace.
--
-- El primer reclamo (null -> teléfono) NO se registra: coincide siempre con el
-- 'inicio' que ya emite positions_events y duplicaría la línea.
-- ---------------------------------------------------------------------------
create or replace function log_device_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if NEW.device_id is not distinct from OLD.device_id then
    return NEW;
  end if;

  if OLD.device_id is not null and NEW.device_id is null then
    insert into events (team_id, kind, detail)
    values (NEW.id, 'liberado', 'el enlace quedó libre');
  elsif OLD.device_id is not null and NEW.device_id is not null then
    insert into events (team_id, kind, detail)
    values (NEW.id, 'dispositivo', 'otro teléfono tomó el equipo');
  end if;

  return NEW;
end;
$$;

create trigger teams_device_events
after update on teams
for each row execute function log_device_event();
