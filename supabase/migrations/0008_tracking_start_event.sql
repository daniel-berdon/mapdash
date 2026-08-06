-- El inicio del tracking es una accion del conductor, no se debe inferir de un
-- cambio de posicion: si el estado anterior seguia en live, ese cambio no existe.

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

-- Inicio se registra arriba. El trigger conserva Maps, pausa y regreso a la app,
-- pero ya no intenta inferir un inicio a partir de la primera posicion.
create or replace function log_position_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gap interval;
  v_gap_text text;
begin
  if TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status then
    if NEW.status = 'en_maps' then
      insert into events (team_id, kind, at) values (NEW.team_id, 'maps', NEW.updated_at);
    elsif NEW.status = 'pausado' then
      insert into events (team_id, kind, at) values (NEW.team_id, 'pausa', NEW.updated_at);
    elsif NEW.status = 'live' and OLD.status = 'en_maps' then
      insert into events (team_id, kind, at) values (NEW.team_id, 'regreso', NEW.updated_at);
    end if;
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
