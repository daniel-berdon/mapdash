-- Bitácora de eventos para el panel.
--
-- Se genera con triggers y no desde el cliente a propósito: así queda registro
-- aunque el panel esté cerrado, aunque haya varios admins mirando, y aunque el
-- cambio lo haga el propio admin (marcar una llegada a mano).

create table events (
  id       bigint generated always as identity primary key,
  team_id  uuid not null references teams(id) on delete cascade,
  point_id uuid references points(id) on delete set null,
  kind     text not null check (kind in ('inicio', 'pausa', 'maps', 'regreso', 'llegada', 'senal')),
  detail   text,
  at       timestamptz not null default now()
);

-- El panel siempre pide los últimos N; el índice descendente es el que usa.
create index events_at_desc on events (at desc);

alter table events enable row level security;
create policy admin_read on events for select to authenticated using (true);
revoke all on events from anon;

-- ---------------------------------------------------------------------------
-- Cambios de estado del chofer.
-- ---------------------------------------------------------------------------
create or replace function log_position_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gap interval;
begin
  if TG_OP = 'INSERT' or NEW.status is distinct from OLD.status then
    insert into events (team_id, kind, at)
    select NEW.team_id,
           case NEW.status
             when 'en_maps' then 'maps'
             when 'pausado' then 'pausa'
             -- volver a 'live' desde otro estado es un regreso, no un inicio
             else case when TG_OP = 'UPDATE' and OLD.status is distinct from 'live'
                       then 'regreso' else 'inicio' end
           end,
           NEW.updated_at;
  end if;

  -- Silencio largo entre dos reportes: el chofer estuvo sin señal o con el
  -- teléfono bloqueado. Se registra al volver, que es cuando se puede saber.
  if TG_OP = 'UPDATE' and OLD.status = 'live' and NEW.status = 'live' then
    v_gap := NEW.updated_at - OLD.updated_at;
    if v_gap > interval '60 seconds' then
      insert into events (team_id, kind, detail, at)
      values (NEW.team_id, 'senal', trim(to_char(extract(epoch from v_gap) / 60, '9990')) || ' min',
              NEW.updated_at);
    end if;
  end if;

  return NEW;
end;
$$;

create trigger positions_events
after insert or update on positions
for each row execute function log_position_event();

-- ---------------------------------------------------------------------------
-- Llegadas a parada (automáticas por geofence y forzadas por el admin).
-- ---------------------------------------------------------------------------
create or replace function log_visit_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into events (team_id, point_id, kind, detail, at)
  values (NEW.team_id, NEW.point_id, 'llegada',
          case when NEW.source = 'auto' then null else 'marcada por el admin' end,
          NEW.arrived_at);
  return NEW;
end;
$$;

create trigger visits_events
after insert on visits
for each row execute function log_visit_event();

alter publication supabase_realtime add table events;
