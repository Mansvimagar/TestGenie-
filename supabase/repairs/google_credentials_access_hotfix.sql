-- Standalone, repeatable hotfix for browser access to Google OAuth credentials.
-- Review and execute manually only after the prerequisites in README.md pass.
-- This file is intentionally outside supabase/migrations because live migration
-- history is not established. It changes ACLs and one RLS policy, not row data.

begin;

revoke all privileges on table public.google_credentials
  from public, anon, authenticated;

-- Remove every column-level grant too; these are independent of table grants.
-- Read the live column names from the catalog so a newly-added column cannot
-- retain an ACL merely because it was absent from this reviewed file.
do $$
declare
  v_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_columns
  from pg_attribute a
  where a.attrelid = 'public.google_credentials'::regclass
    and a.attnum > 0
    and not a.attisdropped;

  if v_columns is null then
    raise exception 'No columns found for public.google_credentials';
  end if;

  execute format(
    'revoke all privileges (%s) on table public.google_credentials from public, anon, authenticated',
    v_columns
  );
end;
$$;

drop policy if exists google_credentials_select_own
  on public.google_credentials;

-- lib/google/auth.ts uses the server-only service-role client for credential
-- reads, inserts, and token refresh updates. It does not delete credentials.
grant select, insert, update on table public.google_credentials to service_role;

-- Fail closed and roll the transaction back if effective browser-role access
-- remains through inherited or column-level grants.
do $$
declare
  v_role text;
  v_access_role text;
  v_column text;
  v_privilege text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    -- Include direct, inherited, and SET ROLE-reachable memberships. PUBLIC
    -- grants are also visible through the effective privilege functions.
    for v_access_role in
      select r.rolname::text
      from pg_roles r
      where r.rolname = v_role or pg_has_role(v_role, r.oid, 'MEMBER')
    loop
      foreach v_privilege in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(v_access_role, 'public.google_credentials', v_privilege) then
          raise exception 'OAuth credential table privilege remains for role % through role %',
            v_role, v_access_role;
        end if;
      end loop;

      for v_column in
        select a.attname::text
        from pg_attribute a
        where a.attrelid = 'public.google_credentials'::regclass
          and a.attnum > 0
          and not a.attisdropped
      loop
        foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
          if has_column_privilege(
            v_access_role, 'public.google_credentials', v_column, v_privilege
          ) then
            raise exception 'OAuth credential column privilege remains for role % through role %',
              v_role, v_access_role;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;

  if not has_table_privilege(
    'service_role', 'public.google_credentials', 'SELECT'
  ) or not has_table_privilege(
    'service_role', 'public.google_credentials', 'INSERT'
  ) or not has_table_privilege(
    'service_role', 'public.google_credentials', 'UPDATE'
  ) then
    raise exception 'Required server-side service_role privileges are missing';
  end if;
end;
$$;

commit;
