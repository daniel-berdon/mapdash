-- Cierra los avisos del linter de Supabase que sí corresponden.
--
-- Lo que NO se toca, y por qué, para que la próxima corrida del linter no
-- invite a "arreglarlo":
--
--   * Las RPC del chofer (get_driver_context, report_position, claim_team,
--     manual_checkin, register_tracking_start, finish_dwell, set_lunch,
--     list_teams) tienen que ser ejecutables por anon: el chofer entra por un
--     link con token y no tiene sesión. Son SECURITY DEFINER justamente para
--     que anon no necesite acceso a ninguna tabla. Ese es el diseño, no un
--     descuido.
--
--   * Las políticas admin_all con using(true) son deliberadas: el único rol
--     authenticated de este proyecto es el organizador. Lo que sostiene esa
--     premisa no es SQL sino tener el alta de usuarios cerrada en el panel de
--     Auth. Si algún día se habilita el registro público, estas políticas
--     dejan de ser seguras y hay que acotarlas por auth.uid().

-- ---------------------------------------------------------------------------
-- 1. search_path fijo en las dos funciones que no lo tenían.
--
-- Sin esto, quien pueda crear objetos en un esquema del search_path del que
-- llama podría anteponer sus propias versiones de las funciones que usan.
-- Ambas son puras y solo tocan built-ins, así que ni siquiera necesitan public.
-- ---------------------------------------------------------------------------
create or replace function dist_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable parallel safe
set search_path = pg_catalog, pg_temp as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- Ojo: 5 minutos, el valor de la migración 0009. No revertir a los 10 de 0004.
create or replace function device_stale_after() returns interval
language sql immutable
set search_path = pg_catalog, pg_temp as $$ select interval '5 minutes' $$;

-- ---------------------------------------------------------------------------
-- 2. Las funciones de trigger no son API.
--
-- Postgres concede EXECUTE a public por defecto en toda función nueva, así que
-- estas quedaron con permiso para anon y authenticated. PostgREST no expone las
-- que devuelven `trigger`, o sea que no eran alcanzables por HTTP, pero el
-- permiso sobra igual.
--
-- Los triggers siguen disparando: Postgres verifica EXECUTE sobre la función
-- al CREAR el trigger, no cada vez que se dispara. Aun así conviene probarlo
-- después de aplicar esto — editar el nombre de un equipo en el panel toca
-- log_device_event y log_lunch_event como `authenticated`, que es el camino
-- más expuesto. Si algo fallara, el rollback es una línea:
--   grant execute on function log_device_event() to authenticated;
-- ---------------------------------------------------------------------------
revoke all on function log_position_event() from public, anon, authenticated;
revoke all on function log_visit_event() from public, anon, authenticated;
revoke all on function log_device_event() from public, anon, authenticated;
revoke all on function log_dwell_event() from public, anon, authenticated;
revoke all on function log_lunch_event() from public, anon, authenticated;
revoke all on function schedule_lunch() from public, anon, authenticated;

-- Las dos de arriba tampoco son API: dist_m la usa report_position por dentro y
-- device_stale_after la usan claim_team y list_teams. Nadie las llama por HTTP.
revoke all on function dist_m(float8, float8, float8, float8) from public, anon, authenticated;
revoke all on function device_stale_after() from public, anon, authenticated;
