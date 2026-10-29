-- TestGenie live workflow catalog review. READ ONLY.
-- Run in the SQL Editor only after confirming the Dashboard project reference.
-- This reports catalog metadata and aggregate compatibility counts only. It
-- never returns function bodies, table row values, tokens, secrets, or vectors.
-- It does not establish that any migration has or has not been applied.

-- 1. Session identity. Compare the project reference with the Dashboard URL.
select current_database() as database_name,
       current_user as session_role,
       session_user as login_role,
       current_setting('server_version') as server_version,
       current_setting('server_version_num')::integer as server_version_num,
       inet_server_addr() as server_address,
       inet_server_port() as server_port,
       current_setting('app.settings.project_ref', true) as project_ref_if_exposed,
       current_setting('search_path') as search_path;

-- 2. Migration-ledger candidates: relation names, owners and column names only.
--    If a ledger is found, use its actual schema/table and inspect version/name
--    rows separately with a read-only query. Do not infer state from absence.
select n.nspname as schema_name,
       c.relname as relation_name,
       c.relkind as relation_kind,
       pg_get_userbyid(c.relowner) as relation_owner,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as force_rls
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','p','v','m')
  and (c.relname ~* '(migration|schema_version)'
       or n.nspname ~* 'migration')
order by n.nspname,c.relname;

select table_schema,table_name,ordinal_position,column_name,data_type,
       udt_schema,udt_name,is_nullable,column_default
from information_schema.columns
where table_name ~* '(migration|schema_version)'
   or table_schema ~* 'migration'
order by table_schema,table_name,ordinal_position;

-- 3. Expected relations, owners, relation kinds, and RLS modes.
with expected(schema_name,relation_name) as (
  values ('public','tests'),('public','questions'),('public','syllabi'),
         ('public','syllabus_chunks'),('public','scores'),
         ('public','google_credentials'),
         ('public','google_form_creation_attempts'),('auth','users')
)
select e.schema_name,e.relation_name,
       c.oid::regclass as relation,
       case when c.oid is null then 'MISSING' else 'present' end as relation_state,
       c.relkind,
       pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as force_rls
from expected e
left join pg_namespace n on n.nspname=e.schema_name
left join pg_class c on c.relnamespace=n.oid and c.relname=e.relation_name
order by e.schema_name,e.relation_name;

-- 4. Relevant column metadata, including provenance, explanation, review and
--    score-idempotency fields. No row values are selected.
select n.nspname as schema_name,c.relname as table_name,a.attnum as ordinal_position,
       a.attname as column_name,format_type(a.atttypid,a.atttypmod) as formatted_type,
       t.typname as internal_type,not a.attnotnull as is_nullable,
       pg_get_expr(ad.adbin,ad.adrelid) as column_default,
       a.attidentity as identity_kind,a.attgenerated as generated_kind
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
join pg_type t on t.oid=a.atttypid
left join pg_attrdef ad on ad.adrelid=c.oid and ad.adnum=a.attnum
where (n.nspname='public' and c.relname in
       ('tests','questions','syllabi','syllabus_chunks','scores',
        'google_credentials','google_form_creation_attempts'))
   or (n.nspname='auth' and c.relname='users')
order by n.nspname,c.relname,a.attnum;

with expected(schema_name,table_name,column_name,expected_type,expected_nullability) as (
  values
    ('public','tests','syllabus_id','uuid','required by current workflow'),
    ('public','tests','generation_config','jsonb','required by current workflow'),
    ('public','tests','reviewed_by','uuid','nullable reviewer attestation'),
    ('public','tests','reviewed_at','timestamp with time zone','nullable reviewer attestation'),
    ('public','questions','source_chunk_ids','jsonb','required provenance'),
    ('public','questions','grounding_status','text','required provenance'),
    ('public','questions','validation_status','text','required review metadata'),
    ('public','questions','validation_metadata','jsonb','required review metadata'),
    ('public','questions','explanation','text','nullable for legacy questions'),
    ('public','syllabus_chunks','embedding','vector','vector column; dimension separately reported'),
    ('public','scores','google_response_id','text','nullable score idempotency key')
)
select e.schema_name,e.table_name,e.column_name,e.expected_type,e.expected_nullability,
       a.attname is not null as present,
       case when a.attname is null then 'MISSING' else format_type(a.atttypid,a.atttypmod) end as actual_type,
       case when a.attname is null then null else not a.attnotnull end as is_nullable,
       case when a.attname is null then 'MISSING PREREQUISITE' else 'present' end as state
from expected e
left join pg_namespace n on n.nspname=e.schema_name
left join pg_class c on c.relnamespace=n.oid and c.relname=e.table_name
left join pg_attribute a on a.attrelid=c.oid and a.attname=e.column_name
  and a.attnum>0 and not a.attisdropped
order by e.schema_name,e.table_name,e.column_name;

-- 5. Constraints and exact FK mappings on workflow/score/OAuth relations.
select n.nspname as schema_name,r.relname as table_name,con.conname as constraint_name,
       con.contype as constraint_type,con.convalidated as validated,
       con.condeferrable as deferrable,con.condeferred as initially_deferred,
       case when con.contype='f' then
         (select string_agg(format('%I -> %I.%I.%I',src.attname,
                    rn.nspname,rr.relname,dst.attname),', ' order by k.ord)
          from unnest(con.conkey,con.confkey) with ordinality k(src_attnum,dst_attnum,ord)
          join pg_attribute src on src.attrelid=con.conrelid and src.attnum=k.src_attnum
          join pg_attribute dst on dst.attrelid=con.confrelid and dst.attnum=k.dst_attnum
          join pg_class rr on rr.oid=con.confrelid
          join pg_namespace rn on rn.oid=rr.relnamespace)
       end as foreign_key_column_mapping,
       case when con.contype='f' then
         format('ON UPDATE %s / ON DELETE %s',
           case con.confupdtype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end,
           case con.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end)
       end as foreign_key_actions,
       pg_get_constraintdef(con.oid,true) as definition
from pg_constraint con
join pg_class r on r.oid=con.conrelid
join pg_namespace n on n.oid=r.relnamespace
where (n.nspname='public' and r.relname in
       ('tests','questions','syllabi','syllabus_chunks','scores',
        'google_credentials','google_form_creation_attempts'))
   or (n.nspname='auth' and r.relname='users')
order by n.nspname,r.relname,con.contype,con.conname;

-- 6. Index metadata for tests/questions/scores and score-like relations.
--    Includes exact index definition but no table contents.
select n.nspname as schema_name,t.relname as table_name,i.relname as index_name,
       x.indisprimary as is_primary,x.indisunique as is_unique,
       x.indisvalid as is_valid,x.indisready as is_ready,
       pg_get_userbyid(i.relowner) as index_owner,
       pg_get_indexdef(i.oid) as index_definition
from pg_index x
join pg_class t on t.oid=x.indrelid
join pg_namespace n on n.oid=t.relnamespace
join pg_class i on i.oid=x.indexrelid
where n.nspname='public'
  and (t.relname in ('tests','questions','scores')
       or t.relname ~* '(score|submission|response|grade)')
order by t.relname,i.relname;

-- Aggregate-only compatibility checks. These return counts, never identifiers.
-- They help assess an existing reviewer FK and score unique-index creation.
select count(*) filter (where to_jsonb(t) ? 'reviewed_by') as rows_with_reviewer_field,
       count(*) filter (where to_jsonb(t) ? 'reviewed_by'
          and nullif(to_jsonb(t)->>'reviewed_by','') is not null) as nonnull_reviewer_rows,
       count(*) filter (where to_jsonb(t) ? 'reviewed_by'
          and nullif(to_jsonb(t)->>'reviewed_by','') is not null and u.id is null) as orphan_reviewer_rows
from public.tests t
left join auth.users u on u.id::text=to_jsonb(t)->>'reviewed_by';

with duplicates as (
  select to_jsonb(s)->>'test_id' as test_key,
         to_jsonb(s)->>'google_response_id' as response_key,
         count(*) as row_count
  from public.scores s
  where to_jsonb(s) ? 'google_response_id'
    and nullif(to_jsonb(s)->>'google_response_id','') is not null
  group by to_jsonb(s)->>'test_id',to_jsonb(s)->>'google_response_id'
  having count(*)>1
)
select count(*) as duplicate_nonnull_score_key_groups,
       coalesce(max(row_count),0) as largest_duplicate_group
from duplicates;

select count(*) filter (where to_jsonb(q) ? 'explanation') as rows_with_explanation_column,
       count(*) filter (where to_jsonb(q) ? 'explanation'
         and to_jsonb(q)->'explanation'='null'::jsonb) as rows_with_null_explanation,
       count(*) filter (where not (to_jsonb(q) ? 'explanation')) as rows_missing_explanation_field,
       count(*) filter (where not (to_jsonb(q) ? 'source_chunk_ids')
         or jsonb_typeof(to_jsonb(q)->'source_chunk_ids') is distinct from 'array'
         or jsonb_array_length(case when jsonb_typeof(to_jsonb(q)->'source_chunk_ids')='array'
               then to_jsonb(q)->'source_chunk_ids' else '[]'::jsonb end)=0) as rows_with_missing_or_empty_sources
from public.questions q;

select count(*) as test_rows,
       count(*) filter (where status is distinct from 'draft'
         and status is distinct from 'published') as rows_with_unexpected_status,
       count(*) filter (where jsonb_typeof(to_jsonb(t)->'generation_config') is distinct from 'object'
         or to_jsonb(t)->'generation_config'->>'syllabusId'
              is distinct from to_jsonb(t)->>'syllabus_id'
         or (to_jsonb(t)->'generation_config' ? 'includedTopics'
             and jsonb_typeof(to_jsonb(t)->'generation_config'->'includedTopics') is distinct from 'array')
         or (to_jsonb(t)->'generation_config' ? 'excludedTopics'
             and jsonb_typeof(to_jsonb(t)->'generation_config'->'excludedTopics') is distinct from 'array'))
         as rows_with_invalid_saved_scope
from public.tests t;

select count(*) as tests_with_missing_or_unavailable_owned_syllabus
from public.tests t
where t.syllabus_id is null
   or not exists(select 1 from public.syllabi s
     where s.id=t.syllabus_id and s.user_id=t.user_id and s.status='ready');

with question_sources as (
  select t.syllabus_id,t.generation_config,
         src.chunk_id
  from public.tests t
  join public.questions q on q.test_id=t.id
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(to_jsonb(q)->'source_chunk_ids')='array'
      then to_jsonb(q)->'source_chunk_ids' else '[]'::jsonb end
  ) src(chunk_id)
), invalid_sources as (
  select s.chunk_id
  from question_sources s
  where not exists (
    select 1 from public.syllabus_chunks c
    where c.id::text=s.chunk_id and c.syllabus_id=s.syllabus_id
      and c.metadata->>'embeddingProvider'='gemini'
      and (nullif(s.generation_config->>'unit','') is null or c.unit=s.generation_config->>'unit')
      and (nullif(s.generation_config->>'topic','') is null or c.topic=s.generation_config->>'topic')
      and (nullif(s.generation_config->>'subtopic','') is null or c.subtopic=s.generation_config->>'subtopic')
      and (jsonb_array_length(case
             when jsonb_typeof(s.generation_config->'includedTopics')='array'
               then s.generation_config->'includedTopics' else '[]'::jsonb end)=0
           or exists(select 1 from jsonb_array_elements_text(case
               when jsonb_typeof(s.generation_config->'includedTopics')='array'
                 then s.generation_config->'includedTopics' else '[]'::jsonb end) i(value)
             where lower(btrim(i.value))=lower(btrim(coalesce(c.topic,'')))))
      and not exists(select 1 from jsonb_array_elements_text(case
           when jsonb_typeof(s.generation_config->'excludedTopics')='array'
             then s.generation_config->'excludedTopics' else '[]'::jsonb end) e(value)
         where lower(btrim(e.value))=lower(btrim(coalesce(c.topic,''))))
  )
)
select count(*) as source_references_outside_syllabus_scope_or_not_gemini
from invalid_sources;

-- 7. Vector extension/type metadata only. No embedding values are queried.
select e.extname,e.extversion,en.nspname as extension_schema
from pg_extension e join pg_namespace en on en.oid=e.extnamespace
where e.extname in ('vector','pgvector')
order by e.extname;

select n.nspname as schema_name,c.relname as table_name,a.attname as column_name,
       format_type(a.atttypid,a.atttypmod) as declared_type,
       t.typname as base_type,tn.nspname as type_schema,a.atttypmod as type_modifier
from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attname='embedding'
  and a.attnum>0 and not a.attisdropped
join pg_type t on t.oid=a.atttypid join pg_namespace tn on tn.oid=t.typnamespace
where n.nspname='public' and c.relname='syllabus_chunks';

-- 8. Relevant policy inventory, including expressions and target roles.
select schemaname,tablename,policyname,permissive,roles,cmd,
       qual as using_expression,with_check as with_check_expression
from pg_policies
where (schemaname='public' and tablename in
       ('tests','questions','syllabi','syllabus_chunks','scores',
        'google_credentials','google_form_creation_attempts'))
   or (schemaname='auth' and tablename='users')
order by schemaname,tablename,policyname;

-- 9. All non-internal triggers on relevant relations. Trigger definitions are
--    catalog metadata; function source is intentionally not returned.
select n.nspname as schema_name,c.relname as table_name,t.tgname as trigger_name,
       case when (t.tgtype::integer & 2)<>0 then 'ROW' else 'STATEMENT' end as granularity,
       case when (t.tgtype::integer & 64)<>0 then 'INSTEAD OF'
            when (t.tgtype::integer & 2)<>0 then 'BEFORE' else 'AFTER' end as timing,
       concat_ws(', ',case when (t.tgtype::integer & 4)<>0 then 'INSERT' end,
         case when (t.tgtype::integer & 8)<>0 then 'DELETE' end,
         case when (t.tgtype::integer & 16)<>0 then 'UPDATE' end,
         case when (t.tgtype::integer & 32)<>0 then 'TRUNCATE' end) as events,
       case t.tgenabled when 'O' then 'enabled' when 'D' then 'disabled'
         when 'R' then 'replica' when 'A' then 'always' else t.tgenabled::text end as enabled_state,
       fn_ns.nspname as function_schema,p.oid::regprocedure as trigger_function,
       pg_get_triggerdef(t.oid,true) as trigger_definition
from pg_trigger t
join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
join pg_proc p on p.oid=t.tgfoid join pg_namespace fn_ns on fn_ns.oid=p.pronamespace
where not t.tgisinternal
  and ((n.nspname='public' and c.relname in
       ('tests','questions','syllabi','syllabus_chunks','scores',
        'google_credentials','google_form_creation_attempts'))
       or (n.nspname='auth' and c.relname='users'))
order by n.nspname,c.relname,t.tgname;

-- 10. All overloads and catalog metadata for workflow, retrieval, and Form RPCs.
--     Function source is not selected or inspected by this report.
with expected(function_name) as (
  values ('match_syllabus_chunks'),('save_draft_test'),('update_test_questions'),
         ('replace_test_question'),('attest_test_review'),('assert_test_publishable'),
         ('publish_test'),('validate_question_provenance'),
         ('testgenie_question_write_guard'),('testgenie_invalidate_test_review'),
         ('prevent_published_test_changes'),('prevent_published_test_delete'),
         ('testgenie_guard_test_insert'),('set_updated_at'),
         ('claim_google_form_creation'),('record_google_form_creation_form'),
         ('release_google_form_creation')
)
select e.function_name,
       case when p.oid is null then 'MISSING' else 'present' end as function_state,
       pn.nspname as function_schema,
       p.oid::regprocedure as exact_signature,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       p.proargnames as argument_and_output_names,p.proargmodes as argument_modes,
       pg_get_function_result(p.oid) as result_type,
       pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,
       p.proconfig as fixed_settings,p.proacl as function_acl,
       case when p.oid is null then null else has_function_privilege('anon',p.oid,'EXECUTE') end as anon_execute,
       case when p.oid is null then null else has_function_privilege('authenticated',p.oid,'EXECUTE') end as authenticated_execute,
       case when p.oid is null then null else has_function_privilege('service_role',p.oid,'EXECUTE') end as service_role_execute,
       case when p.oid is null then null else has_function_privilege(current_user,p.oid,'EXECUTE') end as current_user_execute
from expected e
left join pg_proc p on p.proname=e.function_name and p.pronamespace='public'::regnamespace
left join pg_namespace pn on pn.oid=p.pronamespace
order by e.function_name,pg_get_function_identity_arguments(p.oid);

-- Dependencies recorded in PostgreSQL catalogs for the targeted routines.
select p.oid::regprocedure as function_signature,
       pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) as referenced_object,
       d.deptype as dependency_type
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid
where n.nspname='public'
  and p.proname in ('save_draft_test','update_test_questions','replace_test_question',
    'attest_test_review','assert_test_publishable','publish_test',
    'validate_question_provenance','testgenie_question_write_guard',
    'testgenie_invalidate_test_review','prevent_published_test_changes',
    'prevent_published_test_delete','testgenie_guard_test_insert',
    'claim_google_form_creation','record_google_form_creation_form',
    'release_google_form_creation')
order by p.proname,pg_get_function_identity_arguments(p.oid),referenced_object;

-- 11. Effective table privileges for every database role on relevant tables.
--     Effective predicates include inherited membership and PUBLIC grants.
with rels as (
  select c.oid,c.relname,n.nspname
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where (n.nspname='public' and c.relname in
       ('tests','questions','syllabi','syllabus_chunks','scores',
        'google_credentials','google_form_creation_attempts'))
     or (n.nspname='auth' and c.relname='users')
), privs(privilege_name) as (
  values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
)
select r.rolname as role_name,r.rolsuper as is_superuser,r.rolbypassrls as bypass_rls,
       x.nspname as schema_name,x.relname as table_name,p.privilege_name,
       has_table_privilege(r.rolname,x.oid,p.privilege_name) as effective_privilege,
       case when current_setting('server_version_num')::integer>=170000
         then has_table_privilege(r.rolname,x.oid,'MAINTAIN') else null end as effective_maintain
from pg_roles r cross join rels x cross join privs p
order by x.nspname,x.relname,r.rolname,p.privilege_name;

-- Effective per-column grants, including SELECT, on relevant relations.
with roles as (select rolname from pg_roles)
select n.nspname as schema_name,c.relname as table_name,a.attname as column_name,
       r.rolname as role_name,
       has_column_privilege(r.rolname,c.oid,a.attnum,'SELECT') as select_allowed,
       has_column_privilege(r.rolname,c.oid,a.attnum,'INSERT') as insert_allowed,
       has_column_privilege(r.rolname,c.oid,a.attnum,'UPDATE') as update_allowed,
       has_column_privilege(r.rolname,c.oid,a.attnum,'REFERENCES') as references_allowed
from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
cross join roles r
where (n.nspname='public' and c.relname in
       ('tests','questions','syllabi','syllabus_chunks','scores',
        'google_credentials','google_form_creation_attempts'))
   or (n.nspname='auth' and c.relname='users')
order by n.nspname,c.relname,a.attnum,r.rolname;

-- All role memberships (effective privileges above include inherited grants).
select member.rolname as member_role,parent.rolname as granted_role,
       m.admin_option
from pg_auth_members m
join pg_roles member on member.oid=m.member
join pg_roles parent on parent.oid=m.roleid
order by member.rolname,parent.rolname;

-- Public-schema privileges relevant to RPC replacement and browser safety.
select rolname,has_schema_privilege(rolname,'public','USAGE') as public_usage,
       has_schema_privilege(rolname,'public','CREATE') as public_create
from pg_roles
order by rolname;

-- Sequence inventory and effective rights; metadata only.
select n.nspname as schema_name,c.relname as sequence_name,
       pg_get_userbyid(c.relowner) as owner,
       r.rolname as role_name,
       has_sequence_privilege(r.rolname,c.oid,'USAGE') as usage_allowed,
       has_sequence_privilege(r.rolname,c.oid,'SELECT') as select_allowed,
       has_sequence_privilege(r.rolname,c.oid,'UPDATE') as update_allowed
from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join pg_roles r
where c.relkind='S' and n.nspname in ('public','auth')
order by n.nspname,c.relname,r.rolname;

-- End of SELECT-only catalog and aggregate report. Confirm the project ref
-- independently; catalog evidence does not prove runtime behavior or recovery.
