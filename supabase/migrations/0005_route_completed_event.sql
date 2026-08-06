-- Registra en la bitacora cuando un equipo visita todas las paradas de su ruta.

alter table events drop constraint if exists events_kind_check;
alter table events add constraint events_kind_check
  check (kind in ('inicio', 'pausa', 'maps', 'regreso', 'llegada', 'senal', 'completada'));

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
     and not exists (
       select 1 from events e
       where e.team_id = NEW.team_id and e.kind = 'completada'
     ) then
    insert into events (team_id, kind, at)
    values (NEW.team_id, 'completada', NEW.arrived_at);
  end if;

  return NEW;
end;
$$;

-- Incluye rutas que ya estaban terminadas antes de instalar esta migracion.
insert into events (team_id, kind, at)
select distinct
  rs.team_id,
  'completada',
  coalesce((select max(v.arrived_at) from visits v where v.team_id = rs.team_id), now())
from route_stops rs
where not exists (
  select 1
  from route_stops pending
  where pending.team_id = rs.team_id
    and not exists (
      select 1 from visits v
      where v.team_id = pending.team_id and v.point_id = pending.point_id
    )
)
and not exists (
  select 1 from events e
  where e.team_id = rs.team_id and e.kind = 'completada'
);
