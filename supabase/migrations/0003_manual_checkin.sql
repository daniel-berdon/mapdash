-- Check-in manual del chofer: si el GPS falla y no dispara el geofence,
-- puede marcar la parada a mano. Solo puntos de SU ruta y aún no visitados.
-- El token es la credencial (igual que el resto de RPCs del chofer).

create or replace function manual_checkin(p_token text, p_point_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_team_id uuid;
  v_name text;
begin
  select id into v_team_id from teams where token = p_token and active;
  if not found then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  select p.name into v_name
  from route_stops rs
  join points p on p.id = rs.point_id
  where rs.team_id = v_team_id
    and rs.point_id = p_point_id
    and not exists (
      select 1 from visits v
      where v.team_id = v_team_id and v.point_id = p_point_id
    );

  if not found then
    raise exception 'parada no válida o ya registrada' using errcode = '22023';
  end if;

  insert into visits (team_id, point_id, arrived_at, source)
  values (v_team_id, p_point_id, now(), 'manual')
  on conflict do nothing;

  return jsonb_build_object('arrived', jsonb_build_array(p_point_id), 'name', v_name);
end;
$$;

revoke all on function manual_checkin(text, uuid) from public;
grant execute on function manual_checkin(text, uuid) to anon, authenticated;
