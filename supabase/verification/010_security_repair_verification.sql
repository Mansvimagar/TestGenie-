-- Read-only verification for the 007-011 security repair sequence.
-- Every statement is SELECT-only. Run after migrations; no migration history
-- is inferred from filenames. Inspect every result before re-enabling writes.
-- This is an evidence report, not an automated proof of policy behavior.
-- Safe rollout: inspect the live catalog first; block both application routes
-- and direct authenticated PostgREST table/RPC writes; apply only missing
-- prerequisites in order 007, 008, 009, 010, 011; keep writes blocked through
-- this verification and manual policy/owner review. These are separate
-- migrations and must not be assumed atomic as a group.

-- 1. Required application columns. Missing rows indicate an unmet prerequisite.
with expected(table_name, column_name) as (
  values
    ('tests', 'id'), ('tests', 'user_id'), ('tests', 'title'), ('tests', 'subject'),
    ('tests', 'syllabus_text'), ('tests', 'difficulty'), ('tests', 'question_count'),
    ('tests', 'status'), ('tests', 'syllabus_id'), ('tests', 'generation_config'),
    ('tests', 'google_form_id'), ('tests', 'google_form_url'),
    ('questions', 'id'), ('questions', 'test_id'), ('questions', 'topic'),
    ('questions', 'question'), ('questions', 'options'),
    ('questions', 'correct_answer_index'), ('questions', 'position'),
    ('questions', 'explanation'), ('questions', 'source_chunk_ids'),
    ('questions', 'grounding_status'), ('questions', 'validation_status'),
    ('questions', 'validation_metadata'),
    ('syllabus_chunks', 'id'), ('syllabus_chunks', 'syllabus_id'),
    ('syllabus_chunks', 'unit'), ('syllabus_chunks', 'topic'),
    ('syllabus_chunks', 'subtopic'), ('syllabus_chunks', 'metadata')
)
select e.table_name, e.column_name,
       (c.column_name is not null) as present,
       c.data_type, c.is_nullable, c.column_default
from expected e
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name = e.table_name
 and c.column_name = e.column_name
order by e.table_name, e.column_name;

-- 2. Function identity, owner, SECURITY DEFINER flag, fixed path and effective
-- privileges. The owner must be a trusted database role, never anon/authenticated.
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as security_definer,
  pg_get_userbyid(p.proowner) as owner,
  owner_role.rolsuper as owner_is_superuser,
  owner_role.rolbypassrls as owner_bypasses_rls,
  (owner_role.rolname in ('anon', 'authenticated')) as owner_is_application_role,
  p.proconfig as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles owner_role on owner_role.oid = p.proowner
where n.nspname = 'public'
  and p.proname in (
    'save_draft_test', 'update_test_questions', 'publish_test',
    'prevent_published_test_changes', 'validate_question_provenance'
  )
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 2c. The public schema must not be writable by browser API roles because the
-- definer function's trusted path includes public.
select role_name,
       has_schema_privilege(role_name, 'public', 'USAGE') as public_schema_usage,
       has_schema_privilege(role_name, 'public', 'CREATE') as public_schema_create
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
order by role_name;

-- 2a. Direct function ACL entries, including PUBLIC (grantee_oid = 0).
-- Effective anon/authenticated access is shown above and includes inherited ACLs.
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  case when acl.grantee = 0 then 'PUBLIC' else coalesce(r.rolname, acl.grantee::text) end as grantee,
  acl.privilege_type,
  acl.is_grantable
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
left join pg_roles r on r.oid = acl.grantee
where n.nspname = 'public'
  and p.proname in (
    'save_draft_test', 'update_test_questions', 'publish_test',
    'prevent_published_test_changes', 'validate_question_provenance'
  )
order by p.proname, grantee, acl.privilege_type;

-- 2b. Direct and transitive role memberships that may contribute inherited rights.
-- has_*_privilege checks above are the effective privilege result for these roles.
with recursive membership_paths(app_role_oid, inherited_role_oid, depth, path) as (
  select app.oid, m.roleid, 1, array[app.oid, m.roleid]::oid[]
  from pg_roles app
  join pg_auth_members m on m.member = app.oid
  where app.rolname in ('anon', 'authenticated', 'service_role')
  union all
  select mp.app_role_oid, m.roleid, mp.depth + 1, mp.path || m.roleid
  from membership_paths mp
  join pg_auth_members m on m.member = mp.inherited_role_oid
  where not m.roleid = any(mp.path)
)
select app.rolname as application_role,
       inherited.rolname as member_of_role,
       mp.depth
from membership_paths mp
join pg_roles app on app.oid = mp.app_role_oid
join pg_roles inherited on inherited.oid = mp.inherited_role_oid
order by application_role, depth, member_of_role;

-- 3. Required protection triggers, their enabled state and full definitions.
select
  c.relname as table_name,
  t.tgname as trigger_name,
  t.tgenabled as enabled,
  p.proname as function_name,
  pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public'
  and c.relname in ('tests', 'questions')
  and not t.tgisinternal
order by c.relname, t.tgname;

-- 4. RLS enabled/forced state and policy expressions. Review that restrictive
-- draft policies are ANDed with permissive owner policies; policy names alone
-- do not prove their predicates are correct.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  p.policyname,
  p.permissive,
  p.roles,
  p.cmd,
  p.qual as using_expression,
  p.with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
where n.nspname = 'public'
  and c.relname in ('tests', 'questions')
order by c.relname, p.policyname;

-- 5. Effective application privileges. Expected: anon has no table access;
-- authenticated has the listed application operations, no status update or
-- TRUNCATE/TRIGGER/REFERENCES. Question provenance writes remain available to
-- the existing routes but are checked/sanitized by questions_validate_provenance.
with expected(role_name, table_name, privilege, column_name, should_have) as (
  values
    ('anon', 'tests', 'SELECT', null, false),
    ('anon', 'tests', 'INSERT', null, false),
    ('anon', 'tests', 'UPDATE', null, false),
    ('anon', 'tests', 'DELETE', null, false),
    ('anon', 'questions', 'SELECT', null, false),
    ('anon', 'questions', 'INSERT', null, false),
    ('anon', 'questions', 'UPDATE', null, false),
    ('anon', 'questions', 'DELETE', null, false),
    ('authenticated', 'tests', 'SELECT', null, true),
    ('authenticated', 'tests', 'DELETE', null, true),
    ('authenticated', 'tests', 'TRUNCATE', null, false),
    ('authenticated', 'tests', 'TRIGGER', null, false),
    ('authenticated', 'tests', 'REFERENCES', null, false),
    ('authenticated', 'tests', 'INSERT', 'user_id', true),
    ('authenticated', 'tests', 'INSERT', 'id', false),
    ('authenticated', 'tests', 'INSERT', 'title', true),
    ('authenticated', 'tests', 'INSERT', 'subject', true),
    ('authenticated', 'tests', 'INSERT', 'syllabus_text', true),
    ('authenticated', 'tests', 'INSERT', 'difficulty', true),
    ('authenticated', 'tests', 'INSERT', 'question_count', true),
    ('authenticated', 'tests', 'INSERT', 'status', true),
    ('authenticated', 'tests', 'INSERT', 'syllabus_id', true),
    ('authenticated', 'tests', 'INSERT', 'generation_config', true),
    ('authenticated', 'tests', 'UPDATE', 'title', true),
    ('authenticated', 'tests', 'UPDATE', 'subject', true),
    ('authenticated', 'tests', 'UPDATE', 'difficulty', true),
    ('authenticated', 'tests', 'UPDATE', 'question_count', true),
    ('authenticated', 'tests', 'UPDATE', 'google_form_id', true),
    ('authenticated', 'tests', 'UPDATE', 'google_form_url', true),
    ('authenticated', 'tests', 'UPDATE', 'status', false),
    ('authenticated', 'tests', 'UPDATE', 'user_id', false),
    ('authenticated', 'tests', 'UPDATE', 'syllabus_text', false),
    ('authenticated', 'tests', 'UPDATE', 'syllabus_id', false),
    ('authenticated', 'tests', 'UPDATE', 'generation_config', false),
    ('authenticated', 'questions', 'SELECT', null, true),
    ('authenticated', 'questions', 'DELETE', null, true),
    ('authenticated', 'questions', 'TRUNCATE', null, false),
    ('authenticated', 'questions', 'TRIGGER', null, false),
    ('authenticated', 'questions', 'REFERENCES', null, false),
    ('authenticated', 'questions', 'INSERT', 'test_id', true),
    ('authenticated', 'questions', 'INSERT', 'id', false),
    ('authenticated', 'questions', 'INSERT', 'topic', true),
    ('authenticated', 'questions', 'INSERT', 'question', true),
    ('authenticated', 'questions', 'INSERT', 'options', true),
    ('authenticated', 'questions', 'INSERT', 'correct_answer_index', true),
    ('authenticated', 'questions', 'INSERT', 'position', true),
    ('authenticated', 'questions', 'INSERT', 'explanation', true),
    ('authenticated', 'questions', 'INSERT', 'source_chunk_ids', true),
    ('authenticated', 'questions', 'INSERT', 'grounding_status', true),
    ('authenticated', 'questions', 'INSERT', 'validation_status', true),
    ('authenticated', 'questions', 'INSERT', 'validation_metadata', true),
    ('authenticated', 'questions', 'UPDATE', 'topic', true),
    ('authenticated', 'questions', 'UPDATE', 'id', false),
    ('authenticated', 'questions', 'UPDATE', 'test_id', false),
    ('authenticated', 'questions', 'UPDATE', 'question', true),
    ('authenticated', 'questions', 'UPDATE', 'options', true),
    ('authenticated', 'questions', 'UPDATE', 'correct_answer_index', true),
    ('authenticated', 'questions', 'UPDATE', 'explanation', true),
    ('authenticated', 'questions', 'UPDATE', 'source_chunk_ids', true),
    ('authenticated', 'questions', 'UPDATE', 'grounding_status', true),
    ('authenticated', 'questions', 'UPDATE', 'validation_status', true),
    ('authenticated', 'questions', 'UPDATE', 'validation_metadata', true)
)
select e.role_name, e.table_name, e.privilege, e.column_name,
       e.should_have,
       case when e.column_name is null
         then has_table_privilege(e.role_name, 'public.' || e.table_name, e.privilege)
         else has_column_privilege(e.role_name, 'public.' || e.table_name, e.column_name, e.privilege)
       end as effective_privilege,
       (case when e.column_name is null
         then has_table_privilege(e.role_name, 'public.' || e.table_name, e.privilege)
         else has_column_privilege(e.role_name, 'public.' || e.table_name, e.column_name, e.privilege)
       end = e.should_have) as matches_expectation
from expected e
order by e.role_name, e.table_name, e.privilege, e.column_name nulls first;

-- 5b. Confirm anon has no residual column-level rights, including grants
-- inherited from PUBLIC or another role.
select c.table_name, c.column_name,
       has_column_privilege('anon', 'public.' || c.table_name, c.column_name, 'SELECT') as anon_select,
       has_column_privilege('anon', 'public.' || c.table_name, c.column_name, 'INSERT') as anon_insert,
       has_column_privilege('anon', 'public.' || c.table_name, c.column_name, 'UPDATE') as anon_update,
       has_column_privilege('anon', 'public.' || c.table_name, c.column_name, 'REFERENCES') as anon_references
from information_schema.columns c
where c.table_schema = 'public' and c.table_name in ('tests', 'questions')
order by c.table_name, c.ordinal_position;

-- 5a. service_role is intentionally unchanged by migration 010; report its
-- current effective table rights for audit without assuming a specific ACL.
select
  has_table_privilege('service_role', 'public.tests', 'SELECT') as service_tests_select,
  has_table_privilege('service_role', 'public.tests', 'INSERT') as service_tests_insert,
  has_table_privilege('service_role', 'public.tests', 'UPDATE') as service_tests_update,
  has_table_privilege('service_role', 'public.tests', 'DELETE') as service_tests_delete,
  has_table_privilege('service_role', 'public.questions', 'SELECT') as service_questions_select,
  has_table_privilege('service_role', 'public.questions', 'INSERT') as service_questions_insert,
  has_table_privilege('service_role', 'public.questions', 'UPDATE') as service_questions_update,
  has_table_privilege('service_role', 'public.questions', 'DELETE') as service_questions_delete;

-- 6. Direct ACL entries on the protected tables. This reveals grant sources;
-- compare with effective privileges above, which also include role inheritance.
select table_name, grantee, privilege_type, is_grantable
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('tests', 'questions')
order by table_name, grantee, privilege_type;

select table_name, column_name, grantee, privilege_type, is_grantable
from information_schema.role_column_grants
where table_schema = 'public' and table_name in ('tests', 'questions')
order by table_name, column_name, grantee, privilege_type;

-- Catalog ACL detail, including PUBLIC even when information_schema omits it.
select c.relname as table_name,
       case when acl.grantee = 0 then 'PUBLIC' else coalesce(r.rolname, acl.grantee::text) end as grantee,
       acl.privilege_type,
       acl.is_grantable
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
left join pg_roles r on r.oid = acl.grantee
where n.nspname = 'public' and c.relname in ('tests', 'questions')
order by c.relname, grantee, acl.privilege_type;

select c.relname as table_name,
       a.attname as column_name,
       case when acl.grantee = 0 then 'PUBLIC' else coalesce(r.rolname, acl.grantee::text) end as grantee,
       acl.privilege_type,
       acl.is_grantable
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(a.attacl) as acl
left join pg_roles r on r.oid = acl.grantee
where n.nspname = 'public'
  and c.relname in ('tests', 'questions')
  and a.attnum > 0 and not a.attisdropped and a.attacl is not null
order by c.relname, a.attname, grantee, acl.privilege_type;

-- 7. Provenance integrity: report only question/test IDs and status, never text.
-- Every non-empty source ID must resolve to a Gemini chunk in the test's saved
-- syllabus and exact configured unit/topic/subtopic/included/excluded scope.
with question_checks as (
  select
    q.id as question_id,
    q.test_id,
    t.status as test_status,
    q.grounding_status,
    case
      when jsonb_typeof(q.source_chunk_ids) is distinct from 'array' then false
      when jsonb_array_length(q.source_chunk_ids) = 0 then true
      when t.syllabus_id is null then false
      else not exists (
        select 1
        from jsonb_array_elements_text(q.source_chunk_ids) as source(chunk_id)
        where not exists (
          select 1
          from public.syllabus_chunks c
          where c.id::text = source.chunk_id
            and c.syllabus_id = t.syllabus_id
            and (nullif(t.generation_config ->> 'unit', '') is null
                 or c.unit = t.generation_config ->> 'unit')
            and (nullif(t.generation_config ->> 'topic', '') is null
                 or c.topic = t.generation_config ->> 'topic')
            and (nullif(t.generation_config ->> 'subtopic', '') is null
                 or c.subtopic = t.generation_config ->> 'subtopic')
            and (not (t.generation_config ? 'includedTopics')
                 or (t.generation_config -> 'includedTopics' ? coalesce(c.topic, '')))
            and not (coalesce(t.generation_config -> 'excludedTopics', '[]'::jsonb)
                     ? coalesce(c.topic, ''))
            and c.metadata ->> 'embeddingProvider' = 'gemini'
        )
      )
    end as source_ids_match_scope
  from public.questions q
  join public.tests t on t.id = q.test_id
)
select question_id, test_id, test_status, grounding_status, source_ids_match_scope
from question_checks
where not source_ids_match_scope
   or grounding_status is distinct from 'needs_review'
order by test_status, test_id, question_id;

-- 8. Aggregate data-quality counts. Empty provenance is expected for legacy
-- questions. Existing rows are reported, never rewritten by this verification.
select
  t.status,
  count(q.id) as questions,
  count(q.id) filter (where nullif(btrim(q.explanation), '') is not null) as with_explanation,
  count(q.id) filter (
    where case
      when jsonb_typeof(q.source_chunk_ids) = 'array'
        then jsonb_array_length(q.source_chunk_ids) > 0
      else false
    end
  ) as with_source_chunk_ids,
  count(q.id) filter (where q.grounding_status = 'grounded') as marked_grounded,
  count(q.id) filter (where q.grounding_status = 'unsupported') as marked_unsupported
from public.tests t
left join public.questions q on q.test_id = t.id
group by t.status
order by t.status;
