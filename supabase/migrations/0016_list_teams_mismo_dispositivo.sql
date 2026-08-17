-- El selector marcaba "En uso" el equipo que tiene este mismo teléfono.
--
-- Al volver al selector desde la pantalla de bienvenida ("No soy este equipo"),
-- o después de darle a Terminar, el vínculo del dispositivo sigue puesto: es lo
-- que permite reanudar el rastreo tras una recarga. Pero list_teams miraba solo
-- si había device_id, no cuál, así que el chofer se veía bloqueado por su
-- propio teléfono y tenía que esperar a que el vínculo caducara.
--
-- claim_team siempre aceptó al dispositivo que ya tiene el equipo. Aquí se
-- alinea el selector con esa regla: si claim_team se lo daría, el selector no
-- puede decir que está ocupado.

drop function if exists list_teams();

create or replace function list_teams(p_device text default null)
returns table (id uuid, name text, driver_name text, color text, token text, taken boolean)
language sql security definer set search_path = public, pg_temp as $$
  select id, name, driver_name, color, token,
         device_id is not null
         and device_id is distinct from nullif(p_device, '')
         and now() - coalesce(device_seen, 'epoch'::timestamptz) <= device_stale_after()
  from teams where active order by created_at;
$$;

revoke all on function list_teams(text) from public;
grant execute on function list_teams(text) to anon, authenticated;
