-- El panel debe enterarse cuando un enlace se reclama o se libera sin recargar.
alter publication supabase_realtime add table teams;

-- Evento explícito para distinguir la reconexión del periodo sin reportar.
alter table events drop constraint if exists events_kind_check;
alter table events add constraint events_kind_check
  check (kind in (
    'inicio', 'pausa', 'maps', 'regreso', 'reconexion',
    'llegada', 'senal', 'completada'
  ));

create or replace function log_position_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gap interval;
  v_gap_text text;
begin
  if TG_OP = 'INSERT' or NEW.status is distinct from OLD.status then
    insert into events (team_id, kind, at)
    select NEW.team_id,
           case NEW.status
             when 'en_maps' then 'maps'
             when 'pausado' then 'pausa'
             else case when TG_OP = 'UPDATE' and OLD.status is distinct from 'live'
                       then 'regreso' else 'inicio' end
           end,
           NEW.updated_at;
  end if;

  if TG_OP = 'UPDATE' and OLD.status = 'live' and NEW.status = 'live' then
    v_gap := NEW.updated_at - OLD.updated_at;
    if v_gap > interval '60 seconds' then
      v_gap_text := trim(to_char(extract(epoch from v_gap) / 60, '9990')) || ' min';

      insert into events (team_id, kind, detail, at)
      values (NEW.team_id, 'senal', v_gap_text, NEW.updated_at);

      insert into events (team_id, kind, detail, at)
      values (NEW.team_id, 'reconexion', 'tras ' || v_gap_text || ' sin reportar', NEW.updated_at);
    end if;
  end if;

  return NEW;
end;
$$;
