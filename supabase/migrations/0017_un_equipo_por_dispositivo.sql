-- Cambiar de equipo suelta el anterior en el acto.
--
-- Antes, el equipo viejo se quedaba con el vínculo puesto y solo se liberaba
-- por inactividad: cinco minutos en los que nadie más podía tomarlo aunque el
-- teléfono ya estuviera llevando otro. Si el chofer se equivocó de equipo y
-- alguien más necesitaba ese, había que esperar o liberarlo desde el panel.
--
-- Un dispositivo lleva un solo equipo, que es la regla que ya aplicaba el
-- navegador (deviceLock) para las pestañas. Aquí se aplica igual en la base.

create or replace function claim_team(p_token text, p_device text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team teams;
  v_idle interval;
begin
  if coalesce(p_device, '') = '' then
    raise exception 'dispositivo no identificado' using errcode = '22023';
  end if;

  -- FOR UPDATE: dos choferes tocando "Iniciar" a la vez no pueden reclamar los
  -- dos. El segundo espera y ve el equipo ya ocupado.
  select * into v_team from teams where token = p_token and active for update;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  v_idle := now() - coalesce(v_team.device_seen, 'epoch'::timestamptz);

  if v_team.device_id is null
     or v_team.device_id = p_device
     or v_idle > device_stale_after() then
    -- El equipo anterior de este mismo teléfono queda libre ya, sin esperar a
    -- que caduque. Va antes de tomar el nuevo para no soltarlo a él mismo
    -- cuando se reclama dos veces seguidas el que ya se tenía.
    --
    -- Solo cuando el reclamo prospera: si el equipo pedido lo tiene otro
    -- teléfono, el chofer se queda con el suyo en vez de perder los dos.
    update teams set device_id = null
    where device_id = p_device and id is distinct from v_team.id;

    update teams set device_id = p_device, device_seen = now() where id = v_team.id;
    return jsonb_build_object('ok', true);
  end if;

  return jsonb_build_object('ok', false, 'minutes', floor(extract(epoch from v_idle) / 60));
end;
$$;
