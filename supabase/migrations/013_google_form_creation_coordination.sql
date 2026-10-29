-- Google Forms creation coordination and OAuth credential ACL hardening.
-- Apply only after reviewing the current live schema and migration history.
-- No credential values or test data are read or changed by this migration.
--
-- The creation-attempt row is a short lease that prevents concurrent requests
-- from creating multiple Forms for the same published test. A partial attempt
-- retains its Form ID so the next request can recover that Form.

begin;

-- OAuth tokens are read/written only by server code using service_role.
alter table public.google_credentials enable row level security;
drop policy if exists google_credentials_select_own on public.google_credentials;
revoke all privileges on table public.google_credentials
  from public, anon, authenticated;
do $$
declare v_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_columns
  from pg_attribute a
  where a.attrelid = 'public.google_credentials'::regclass
    and a.attnum > 0 and not a.attisdropped;
  if v_columns is null then
    raise exception 'No columns found for public.google_credentials';
  end if;
  execute format(
    'revoke all privileges (%s) on table public.google_credentials from public, anon, authenticated',
    v_columns
  );
end;
$$;
grant select, insert, update on public.google_credentials to service_role;

create table if not exists public.google_form_creation_attempts (
  test_id uuid primary key references public.tests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  form_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_form_creation_form_id_format
    check (form_id is null or form_id ~ '^[A-Za-z0-9_-]{10,200}$')
);

alter table public.google_form_creation_attempts enable row level security;
revoke all privileges on public.google_form_creation_attempts
  from public, anon, authenticated;

create or replace function public.claim_google_form_creation(
  p_test_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_form_id text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.tests t
    where t.id = p_test_id and t.user_id = auth.uid() and t.status = 'published'
  ) then
    raise exception 'Published test not found';
  end if;

  insert into public.google_form_creation_attempts as attempt (
    test_id, user_id, lease_token, lease_expires_at
  )
  select t.id, t.user_id, p_lease_token, statement_timestamp() + interval '10 minutes'
  from public.tests t
  where t.id = p_test_id and t.user_id = auth.uid() and t.status = 'published'
  on conflict (test_id) do update
    set lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = statement_timestamp()
    where attempt.lease_expires_at <= statement_timestamp()
  returning attempt.form_id into v_form_id;

  if found then
    return jsonb_build_object('acquired', true, 'formId', v_form_id);
  end if;
  return jsonb_build_object('acquired', false);
end;
$$;

create or replace function public.record_google_form_creation_form(
  p_test_id uuid,
  p_lease_token uuid,
  p_form_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_form_id is null or p_form_id !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception 'Invalid Google Form ID';
  end if;

  update public.google_form_creation_attempts
  set form_id = p_form_id, updated_at = statement_timestamp()
  where test_id = p_test_id and user_id = auth.uid() and lease_token = p_lease_token
    and lease_expires_at > statement_timestamp();
  return found;
end;
$$;

create or replace function public.release_google_form_creation(
  p_test_id uuid,
  p_lease_token uuid,
  p_keep_for_recovery boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_keep_for_recovery then
    update public.google_form_creation_attempts
    set lease_expires_at = statement_timestamp(), updated_at = statement_timestamp()
    where test_id = p_test_id and user_id = auth.uid() and lease_token = p_lease_token
      and form_id is not null;
  else
    delete from public.google_form_creation_attempts
    where test_id = p_test_id and user_id = auth.uid() and lease_token = p_lease_token;
  end if;
end;
$$;

revoke all on function public.claim_google_form_creation(uuid, uuid) from public, anon;
grant execute on function public.claim_google_form_creation(uuid, uuid) to authenticated;
revoke all on function public.record_google_form_creation_form(uuid, uuid, text) from public, anon;
grant execute on function public.record_google_form_creation_form(uuid, uuid, text) to authenticated;
revoke all on function public.release_google_form_creation(uuid, uuid, boolean) from public, anon;
grant execute on function public.release_google_form_creation(uuid, uuid, boolean) to authenticated;

-- Fail closed if browser roles can still reach stored OAuth tokens.
do $$
declare v_role text; v_privilege text; v_column text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if has_table_privilege(v_role, 'public.google_credentials', v_privilege) then
        raise exception 'OAuth table privilege % remains for %', v_privilege, v_role;
      end if;
    end loop;
    for v_column in
      select a.attname::text from pg_attribute a
      where a.attrelid = 'public.google_credentials'::regclass
        and a.attnum > 0 and not a.attisdropped
    loop
      foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        if has_column_privilege(v_role, 'public.google_credentials', v_column, v_privilege) then
          raise exception 'OAuth column privilege % on % remains for %',
            v_privilege, v_column, v_role;
        end if;
      end loop;
    end loop;
  end loop;
  if not has_table_privilege('service_role', 'public.google_credentials', 'SELECT')
     or not has_table_privilege('service_role', 'public.google_credentials', 'INSERT')
     or not has_table_privilege('service_role', 'public.google_credentials', 'UPDATE') then
    raise exception 'Server-side OAuth credential access is incomplete';
  end if;
end;
$$;

commit;
