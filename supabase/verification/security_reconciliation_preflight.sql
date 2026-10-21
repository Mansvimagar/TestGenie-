-- READ-ONLY preflight for the standalone Google credential ACL hotfix and the
-- later 007-011 reconciliation. Every statement in this file is a SELECT.
-- No credential values or row contents are selected.

-- 1. Confirm the target table and expected helper columns exist.
select
  to_regclass('public.google_credentials') as google_credentials_table,
  to_regclass('public.tests') as tests_table,
  to_regclass('public.questions') as questions_table,
  to_regclass('supabase_migrations.schema_migrations') as conventional_migration_ledger;

select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('google_credentials', 'tests', 'questions')
  and (
    (table_name = 'google_credentials' and column_name in
      ('user_id', 'access_token', 'refresh_token', 'scope', 'expiry_date', 'created_at', 'updated_at'))
    or (table_name = 'tests' and column_name in
      ('status', 'syllabus_id', 'generation_config', 'google_form_id', 'google_form_url'))
    or (table_name = 'questions' and column_name in
      ('test_id', 'explanation', 'source_chunk_ids', 'grounding_status', 'validation_status', 'validation_metadata'))
  )
order by table_name, ordinal_position;

-- 2. Exact function signatures relevant to the application and local migrations.
-- A NULL result means that exact signature was not found.
select
  to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') as save_draft_test,
  to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') as update_test_questions,
  to_regprocedure('public.publish_test(uuid)') as publish_test,
  to_regprocedure('public.match_syllabus_chunks(extensions.vector,uuid,text,text,integer)') as match_syllabus_chunks,
  to_regprocedure('public.validate_question_provenance()') as validate_question_provenance;

-- 3. Current effective table and sensitive-column access. These checks include
-- inherited privileges, unlike a simple listing of direct grants.
select role_name, privilege,
  has_table_privilege(role_name, 'public.google_credentials', privilege) as effective_privilege
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as privileges(privilege)
order by role_name, privilege;

select role_name, column_name, privilege,
  has_column_privilege(role_name, 'public.google_credentials', column_name, privilege) as effective_privilege
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
cross join (values ('access_token'), ('refresh_token')) as columns(column_name)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as privileges(privilege)
order by role_name, column_name, privilege;

-- Direct ACL entries help explain effective privilege results. No values are read.
select grantee, privilege_type, is_grantable
from information_schema.table_privileges
where table_schema = 'public' and table_name = 'google_credentials'
order by grantee, privilege_type;

select grantee, column_name, privilege_type, is_grantable
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'google_credentials'
  and column_name in ('access_token', 'refresh_token')
order by grantee, column_name, privilege_type;

-- 4. Existing policies, triggers, and routine security metadata.
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('google_credentials', 'tests', 'questions')
order by tablename, policyname;

select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name,
  t.tgenabled, pg_get_triggerdef(t.oid, true) as trigger_definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and n.nspname = 'public'
  and c.relname in ('google_credentials', 'tests', 'questions')
order by c.relname, t.tgname;

select n.nspname as schema_name, p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  r.rolname as owner, p.prosecdef as security_definer,
  p.proconfig as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where n.nspname = 'public'
  and p.proname in ('save_draft_test', 'update_test_questions', 'publish_test',
    'match_syllabus_chunks', 'validate_question_provenance')
order by p.proname, identity_arguments;

-- 5. Role membership that can affect inherited access. Review any returned row.
select granted.rolname as granted_role, member.rolname as member_role,
  m.admin_option
from pg_auth_members m
join pg_roles granted on granted.oid = m.roleid
join pg_roles member on member.oid = m.member
where granted.rolname in ('anon', 'authenticated', 'service_role')
   or member.rolname in ('anon', 'authenticated', 'service_role')
order by granted_role, member_role;

-- 6. Explicit preflight prerequisites. FAIL means stop and reconcile before
-- considering the standalone hotfix; the earlier result sets provide detail.
with preflight_checks(check_name, passed, detail) as (
  values
    ('Target credential table exists', to_regclass('public.google_credentials') is not null,
      'Required by the hotfix and server helper'),
    ('All expected credential columns exist', (
      select count(*) = 7
      from information_schema.columns
      where table_schema = 'public' and table_name = 'google_credentials'
        and column_name in ('user_id', 'access_token', 'refresh_token', 'scope',
          'expiry_date', 'created_at', 'updated_at')
    ), 'Hotfix column-level REVOKE expects the seven listed columns'),
    ('Supabase application roles exist',
      to_regrole('anon') is not null and to_regrole('authenticated') is not null
        and to_regrole('service_role') is not null,
      'Required roles for effective privilege checks and the server helper')
)
select case when passed then 'PASS' else 'FAIL' end as result,
  check_name, detail
from preflight_checks
order by passed, check_name;

-- Migration history is not inferred from local filenames. Inspect the Supabase
-- migration history in the authorized dashboard/CLI metadata separately; the
-- relation check above only reports whether the conventional ledger exists.
