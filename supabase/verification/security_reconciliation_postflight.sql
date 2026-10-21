-- READ-ONLY postflight report. Each check returns an explicit PASS or FAIL.
-- Run after the changes being reviewed; a FAIL may indicate that broader
-- migrations 007-011 are still pending, not that the OAuth hotfix failed.
-- This script never selects access-token values or other application data.

with checks(check_name, passed, detail) as (
  values
    ('Google credential table exists', to_regclass('public.google_credentials') is not null,
      'Expected public.google_credentials'),
    ('Draft-save RPC exists',
      to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is not null,
      'save_draft_test exact signature'),
    ('Question explanation column exists', exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'questions' and column_name = 'explanation'
    ), 'questions.explanation is supplied by the reconciliation'),
    ('update_test_questions exact signature exists',
      to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is not null,
      'Expected local migration signature'),
    ('publish_test exact signature exists',
      to_regprocedure('public.publish_test(uuid)') is not null,
      'Expected authenticated owner-checked RPC'),
    ('match_syllabus_chunks remains available',
      to_regprocedure('public.match_syllabus_chunks(extensions.vector,uuid,text,text,integer)') is not null,
      'Existing retrieval RPC signature must be preserved'),
    ('Authenticated can read tests',
      has_table_privilege('authenticated', 'public.tests', 'SELECT'), 'Required by test management UI'),
    ('Authenticated can delete owned tests',
      has_table_privilege('authenticated', 'public.tests', 'DELETE'), 'Draft deletion route'),
    ('Authenticated cannot directly update test status',
      not has_column_privilege('authenticated', 'public.tests', 'status', 'UPDATE'),
      'Status transitions must use publish_test'),
    ('Authenticated can read questions',
      has_table_privilege('authenticated', 'public.questions', 'SELECT'), 'Required by review UI'),
    ('Authenticated can delete draft questions',
      has_table_privilege('authenticated', 'public.questions', 'DELETE'), 'Draft editing workflow'),
    ('Authenticated can read owned syllabi',
      has_table_privilege('authenticated', 'public.syllabi', 'SELECT'), 'Generation and draft ownership checks'),
    ('Authenticated can create syllabus records',
      has_table_privilege('authenticated', 'public.syllabi', 'INSERT'), 'Session-scoped syllabus ingestion'),
    ('Authenticated can update syllabus records',
      has_table_privilege('authenticated', 'public.syllabi', 'UPDATE'), 'Ingestion status transitions'),
    ('Authenticated can read syllabus chunks',
      has_table_privilege('authenticated', 'public.syllabus_chunks', 'SELECT'), 'RLS-scoped retrieval'),
    ('Authenticated can insert syllabus chunks',
      has_table_privilege('authenticated', 'public.syllabus_chunks', 'INSERT'), 'Session-scoped ingestion storage'),
    ('Authenticated can read scores',
      has_table_privilege('authenticated', 'public.scores', 'SELECT'), 'Faculty results dashboard'),
    ('Authenticated can execute save_draft_test', coalesce(
      has_function_privilege('authenticated', to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)'), 'EXECUTE'), false
    ), 'Draft creation RPC'),
    ('Authenticated can execute update_test_questions', coalesce(
      has_function_privilege('authenticated', to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)'), 'EXECUTE'), false
    ), 'Draft edit/regeneration RPC'),
    ('Authenticated can execute publish_test', coalesce(
      has_function_privilege('authenticated', to_regprocedure('public.publish_test(uuid)'), 'EXECUTE'), false
    ), 'Draft publication RPC'),
    ('Authenticated can execute match_syllabus_chunks', coalesce(
      has_function_privilege('authenticated', to_regprocedure('public.match_syllabus_chunks(extensions.vector,uuid,text,text,integer)'), 'EXECUTE'), false
    ), 'RAG retrieval RPC'),
    ('Anonymous cannot execute save_draft_test', not coalesce(
      has_function_privilege('anon', to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)'), 'EXECUTE'), false
    ), 'No browser-anonymous draft creation'),
    ('Anonymous cannot execute publish_test', not coalesce(
      has_function_privilege('anon', to_regprocedure('public.publish_test(uuid)'), 'EXECUTE'), false
    ), 'No browser-anonymous publication'),
    ('Anonymous cannot execute match_syllabus_chunks', not coalesce(
      has_function_privilege('anon', to_regprocedure('public.match_syllabus_chunks(extensions.vector,uuid,text,text,integer)'), 'EXECUTE'), false
    ), 'Expected least privilege; existing function ACL may need a separate forward fix'),
    ('Anonymous has no tests/questions table privileges',
      not has_table_privilege('anon', 'public.tests', 'SELECT')
      and not has_table_privilege('anon', 'public.tests', 'INSERT')
      and not has_table_privilege('anon', 'public.tests', 'UPDATE')
      and not has_table_privilege('anon', 'public.tests', 'DELETE')
      and not has_table_privilege('anon', 'public.questions', 'SELECT')
      and not has_table_privilege('anon', 'public.questions', 'INSERT')
      and not has_table_privilege('anon', 'public.questions', 'UPDATE')
      and not has_table_privilege('anon', 'public.questions', 'DELETE'),
      'Migration 010 intended to revoke anonymous table access'),
    ('Service role can read OAuth credentials',
      has_table_privilege('service_role', 'public.google_credentials', 'SELECT'), 'Google credential helper read'),
    ('Service role can insert OAuth credentials',
      has_table_privilege('service_role', 'public.google_credentials', 'INSERT'), 'Google OAuth callback upsert'),
    ('Service role can update OAuth credentials',
      has_table_privilege('service_role', 'public.google_credentials', 'UPDATE'), 'Token refresh persistence')
), browser_roles(role_name) as (
  values ('anon'), ('authenticated')
), browser_table_privileges(privilege) as (
  values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
), credential_access_checks as (
  select 'Browser roles have no effective Google credential table privileges'::text as check_name,
    not exists (
      select 1 from browser_roles r cross join browser_table_privileges p
      where has_table_privilege(r.role_name, 'public.google_credentials', p.privilege)
    ) as passed,
    'Checks inherited effective ACLs for anon and authenticated'::text as detail
  union all
  select 'Browser roles have no effective token-column privileges', not exists (
    select 1
    from browser_roles r
    cross join (values ('access_token'), ('refresh_token')) as cols(column_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as privs(privilege)
    where has_column_privilege(r.role_name, 'public.google_credentials', cols.column_name, privs.privilege)
  ), 'Checks independent column grants and inherited privileges'
  union all
  select 'Owner-select Google credential policy is absent', not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'google_credentials'
      and policyname = 'google_credentials_select_own'
  ), 'Browser access is removed at ACL and policy layers'
), policy_checks(check_name, passed, detail) as (
  values
    ('Tests insert policy is restrictive and draft-only', exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = 'tests'
        and policyname = 'tests_insert_draft_only' and permissive = 'RESTRICTIVE'
        and cmd = 'INSERT' and roles::text[] @> array['authenticated']::text[]
        and coalesce(with_check, '') ilike '%auth.uid()%'
        and coalesce(with_check, '') ilike '%draft%'
    ), 'Restrictive policies combine with permissive policies using AND'),
    ('Tests delete policy is restrictive and draft-only', exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = 'tests'
        and policyname = 'tests_delete_draft_only' and permissive = 'RESTRICTIVE'
        and cmd = 'DELETE' and roles::text[] @> array['authenticated']::text[]
        and coalesce(qual, '') ilike '%auth.uid()%'
        and coalesce(qual, '') ilike '%draft%'
    ), 'Published test deletion is blocked at RLS'),
    ('Question insert policy is restrictive and draft-only', exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = 'questions'
        and policyname = 'questions_insert_draft_only' and permissive = 'RESTRICTIVE'
        and cmd = 'INSERT' and roles::text[] @> array['authenticated']::text[]
        and coalesce(with_check, '') ilike '%auth.uid()%'
        and coalesce(with_check, '') ilike '%draft%'
    ), 'Direct question insertion is draft-only'),
    ('Question update policy is restrictive and draft-only', exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = 'questions'
        and policyname = 'questions_update_draft_only' and permissive = 'RESTRICTIVE'
        and cmd = 'UPDATE' and roles::text[] @> array['authenticated']::text[]
        and coalesce(qual, '') ilike '%auth.uid()%'
        and coalesce(qual, '') ilike '%draft%'
        and coalesce(with_check, '') ilike '%draft%'
    ), 'Direct question edits are draft-only'),
    ('Question delete policy is restrictive and draft-only', exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = 'questions'
        and policyname = 'questions_delete_draft_only' and permissive = 'RESTRICTIVE'
        and cmd = 'DELETE' and roles::text[] @> array['authenticated']::text[]
        and coalesce(qual, '') ilike '%auth.uid()%'
        and coalesce(qual, '') ilike '%draft%'
    ), 'Direct question deletion is draft-only')
), function_checks(check_name, passed, detail) as (
  select 'publish_test is SECURITY DEFINER with fixed search_path', exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'publish_test'
      and pg_get_function_identity_arguments(p.oid) = 'p_test_id uuid'
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']
  ), 'Local 011 expects trusted fixed path; confirm exact owner in the owner check')
  union all
  select 'publish_test owner is trusted and can update tests.status', exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles owner_role on owner_role.oid = p.proowner
    where n.nspname = 'public' and p.proname = 'publish_test'
      and pg_get_function_identity_arguments(p.oid) = 'p_test_id uuid'
      and owner_role.rolname not in ('anon', 'authenticated', 'public')
      and (
        owner_role.rolsuper or owner_role.rolbypassrls
        or exists (
          select 1 from pg_class tests_table
          join pg_namespace tests_schema on tests_schema.oid = tests_table.relnamespace
          where tests_schema.nspname = 'public' and tests_table.relname = 'tests'
            and tests_table.relowner = p.proowner
        )
      )
      and has_column_privilege(owner_role.oid, 'public.tests', 'status', 'UPDATE')
  ), 'SECURITY DEFINER owner must be reviewed as a trusted role'
  union all
  select 'Published-test protection trigger is enabled', exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'tests'
      and t.tgname = 'tests_protect_published_content' and not t.tgisinternal and t.tgenabled <> 'D'
  ), 'Protects persisted assessment content after publication'
  union all
  select 'Question provenance trigger is enabled', exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'questions'
      and t.tgname = 'questions_validate_provenance' and not t.tgisinternal and t.tgenabled <> 'D'
  ), 'Migration 011 trusted chunk/scope validation trigger'
), function_body_checks(check_name, passed, detail) as (
  select 'publish_test definition checks authenticated ownership and draft status', exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'publish_test'
      and pg_get_function_identity_arguments(p.oid) = 'p_test_id uuid'
      and pg_get_functiondef(p.oid) ilike '%auth.uid()%'
      and pg_get_functiondef(p.oid) ilike '%status%draft%'
      and pg_get_functiondef(p.oid) ilike '%user_id%'
  ), 'Catalog definition inspection; does not exercise the function')
), column_grant_expectations(role_name, table_name, column_name, privilege) as (
  values
    ('authenticated', 'tests', 'user_id', 'INSERT'),
    ('authenticated', 'tests', 'title', 'INSERT'),
    ('authenticated', 'tests', 'subject', 'INSERT'),
    ('authenticated', 'tests', 'syllabus_text', 'INSERT'),
    ('authenticated', 'tests', 'difficulty', 'INSERT'),
    ('authenticated', 'tests', 'question_count', 'INSERT'),
    ('authenticated', 'tests', 'status', 'INSERT'),
    ('authenticated', 'tests', 'syllabus_id', 'INSERT'),
    ('authenticated', 'tests', 'generation_config', 'INSERT'),
    ('authenticated', 'tests', 'title', 'UPDATE'),
    ('authenticated', 'tests', 'subject', 'UPDATE'),
    ('authenticated', 'tests', 'difficulty', 'UPDATE'),
    ('authenticated', 'tests', 'question_count', 'UPDATE'),
    ('authenticated', 'tests', 'google_form_id', 'UPDATE'),
    ('authenticated', 'tests', 'google_form_url', 'UPDATE'),
    ('authenticated', 'questions', 'test_id', 'INSERT'),
    ('authenticated', 'questions', 'topic', 'INSERT'),
    ('authenticated', 'questions', 'question', 'INSERT'),
    ('authenticated', 'questions', 'options', 'INSERT'),
    ('authenticated', 'questions', 'correct_answer_index', 'INSERT'),
    ('authenticated', 'questions', 'position', 'INSERT'),
    ('authenticated', 'questions', 'explanation', 'INSERT'),
    ('authenticated', 'questions', 'source_chunk_ids', 'INSERT'),
    ('authenticated', 'questions', 'grounding_status', 'INSERT'),
    ('authenticated', 'questions', 'validation_status', 'INSERT'),
    ('authenticated', 'questions', 'validation_metadata', 'INSERT'),
    ('authenticated', 'questions', 'topic', 'UPDATE'),
    ('authenticated', 'questions', 'question', 'UPDATE'),
    ('authenticated', 'questions', 'options', 'UPDATE'),
    ('authenticated', 'questions', 'correct_answer_index', 'UPDATE'),
    ('authenticated', 'questions', 'explanation', 'UPDATE'),
    ('authenticated', 'questions', 'source_chunk_ids', 'UPDATE'),
    ('authenticated', 'questions', 'grounding_status', 'UPDATE'),
    ('authenticated', 'questions', 'validation_status', 'UPDATE'),
    ('authenticated', 'questions', 'validation_metadata', 'UPDATE')
), checked_column_grants as (
  select e.*, c.column_name is not null as column_exists,
    case when c.column_name is not null then
      has_column_privilege(e.role_name, format('public.%I', e.table_name), e.column_name, e.privilege)
    else false end as effective_grant
  from column_grant_expectations e
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = e.table_name and c.column_name = e.column_name
), application_grant_checks as (
  select 'All required authenticated application column grants exist'::text as check_name,
    coalesce(bool_and(column_exists and effective_grant), false) as passed,
    format('%s/%s expected column grants effective',
      count(*) filter (where column_exists and effective_grant), count(*)) as detail
  from checked_column_grants
), all_checks as (
  select * from checks
  union all select * from credential_access_checks
  union all select * from policy_checks
  union all select * from function_checks
  union all select * from function_body_checks
  union all select * from application_grant_checks
)
select case when passed then 'PASS' else 'FAIL' end as result,
  check_name, detail
from all_checks
order by passed, check_name;

-- Separate provenance integrity result: empty IDs are allowed for legacy
-- questions needing review; every non-empty ID must resolve to a Gemini chunk
-- from the same syllabus and saved unit/topic scope. No IDs or content emitted.
with malformed as (
  select q.id
  from public.questions q
  where jsonb_typeof(q.source_chunk_ids) is distinct from 'array'
), unresolved as (
  select q.id
  from public.questions q
  join public.tests t on t.id = q.test_id
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(q.source_chunk_ids) = 'array'
      then q.source_chunk_ids else '[]'::jsonb end
  ) as source(chunk_id)
  where not exists (
    select 1
    from public.syllabus_chunks c
    where c.id::text = source.chunk_id
      and c.syllabus_id = t.syllabus_id
      and c.metadata ->> 'embeddingProvider' = 'gemini'
      and (
        nullif(t.generation_config ->> 'unit', '') is null
        or c.unit = t.generation_config ->> 'unit'
      )
      and (
        nullif(t.generation_config ->> 'topic', '') is null
        or c.topic = t.generation_config ->> 'topic'
      )
      and (
        nullif(t.generation_config ->> 'subtopic', '') is null
        or c.subtopic = t.generation_config ->> 'subtopic'
      )
      and (
        not (t.generation_config ? 'includedTopics')
        or (t.generation_config -> 'includedTopics' ? coalesce(c.topic, ''))
      )
      and not (
        coalesce(t.generation_config -> 'excludedTopics', '[]'::jsonb)
        ? coalesce(c.topic, '')
      )
  )
), invalid_questions as (
  select id from malformed union select id from unresolved
)
select case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'Non-empty question provenance resolves to same-syllabus Gemini chunks and selected scope' as check_name,
  count(*)::text || ' question(s) have malformed or unresolved provenance' as detail
from invalid_questions;
