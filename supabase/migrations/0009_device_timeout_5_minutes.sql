-- Reduce el tiempo de liberacion automatica de 10 a 5 minutos.
create or replace function device_stale_after() returns interval
language sql immutable as $$ select interval '5 minutes' $$;
