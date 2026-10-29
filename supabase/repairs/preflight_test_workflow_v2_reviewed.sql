-- Separate reviewed copy of preflight_test_workflow_v2.sql.
-- TestGenie repair v2: read-only live-schema preflight review candidate.
-- Run only in the SQL Editor of the intended Supabase project. This file is
-- SELECT-only: it does not create objects, alter ACLs, mutate data, or invoke
-- application RPCs. Review every result set before considering the repair.
--
-- PostgreSQL/Supabase caveats:
-- * MAINTAIN is available starting in PostgreSQL 17. The privilege query
--   reports NULL when the server version does not support it.
-- * Column typmod reports a vector(n) dimension constraint. If the column is
--   an unconstrained vector, use the discovered vector_dims function in a
--   separate read-only query; this script never reads/prints embedding values.
-- * Project ref is not exposed consistently by SQL Editor sessions. The
--   identity result includes safe database/server identifiers where available;
--   verify project ref against the Dashboard URL before any write.

-- 1. Connection identity, version, and safe Supabase project setting if present.
select current_database() as database_name,
       current_user as session_role,
       session_user as login_role,
       current_setting('server_version') as server_version,
       current_setting('server_version_num')::integer as server_version_num,
       inet_server_addr() as server_address,
       inet_server_port() as server_port,
       current_setting('app.settings.project_ref', true) as project_ref_if_exposed,
       current_setting('search_path') as session_search_path;

-- 2. Expected application and score/OAuth tables: existence, owner, RLS and FORCE RLS.
select n.nspname as schema_name, c.relname as possible_score_relation,
       c.relkind, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p','v','m','f')
  and c.relname ~* '(score|submission|response|grade)'
order by c.relname;

with expected(table_name) as (
  values ('tests'),('questions'),('syllabi'),('syllabus_chunks'),('scores'),
         ('google_credentials'),('google_form_creation_attempts')
)
select e.table_name,
       c.oid::regclass as relation,
       case when c.oid is null then 'MISSING' else 'present' end as relation_state,
       pg_get_userbyid(c.relowner) as owner,
       c.relkind,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as force_rls
from expected e
left join pg_class c on c.relnamespace='public'::regnamespace and c.relname=e.table_name
order by e.table_name;

-- 3. Exact columns/types/nullability/defaults for all relevant tables.
select n.nspname as schema_name, c.relname as table_name, a.attnum as ordinal_position,
       a.attname as column_name, format_type(a.atttypid,a.atttypmod) as formatted_type,
       t.typname as internal_type, a.atttypmod as type_modifier,
       not a.attnotnull as is_nullable,
       pg_get_expr(ad.adbin,ad.adrelid) as column_default,
       a.attidentity as identity_kind, a.attgenerated as generated_kind,
       col_description(c.oid,a.attnum) as column_comment
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
join pg_type t on t.oid=a.atttypid
left join pg_attrdef ad on ad.adrelid=c.oid and ad.adnum=a.attnum
where n.nspname='public'
  and (c.relname in ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts')
       or c.relname ~* '(score|submission|response|grade)')
order by c.relname,a.attnum;

-- 4. Constraints and exact FK column mapping (including reviewer FK if present).
select n.nspname as schema_name, r.relname as table_name, con.conname as constraint_name,
       con.contype as constraint_type,
       case con.contype when 'p' then 'PRIMARY KEY' when 'f' then 'FOREIGN KEY'
         when 'u' then 'UNIQUE' when 'c' then 'CHECK' when 'x' then 'EXCLUSION'
         else con.contype::text end as constraint_kind,
       con.convalidated as validated,
       con.condeferrable as deferrable,
       con.condeferred as initially_deferred,
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
where n.nspname='public'
  and (r.relname in ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts')
       or r.relname ~* '(score|submission|response|grade)')
order by r.relname,con.contype,con.conname;

-- 5. Vector extension, vector type, embedding typmod/dimension, and available
--    vector_dims function location. This reports metadata only, not embeddings.
select e.extname, e.extversion, en.nspname as extension_schema
from pg_extension e join pg_namespace en on en.oid=e.extnamespace
where e.extname in ('vector','pgvector')
order by e.extname;

select n.nspname as schema_name, c.relname as table_name, a.attname as column_name,
       format_type(a.atttypid,a.atttypmod) as declared_type,
       t.typname as base_type, tn.nspname as type_schema,
       a.atttypmod as vector_typmod,
       case when t.typname='vector' and a.atttypmod>0 then a.atttypmod::text
            when t.typname='vector' then 'unconstrained; inspect vector_dims(embedding)'
            else 'not a pgvector vector column' end as declared_vector_dimensions
from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attname='embedding' and a.attnum>0 and not a.attisdropped
join pg_type t on t.oid=a.atttypid join pg_namespace tn on tn.oid=t.typnamespace
where n.nspname='public' and c.relname='syllabus_chunks';

select pn.nspname as function_schema, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       pg_get_function_result(p.oid) as result_type,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as security_mode,
       p.proconfig as function_settings
from pg_proc p join pg_namespace pn on pn.oid=p.pronamespace
where p.proname='vector_dims'
order by pn.nspname,pg_get_function_identity_arguments(p.oid);

-- 6. Every RLS policy on application, score and Google credential tables.
--    pg_policies provides parsed expressions and target roles. No secret values.
select schemaname, tablename, policyname, permissive, roles, cmd,
       qual as using_expression, with_check as with_check_expression
from pg_policies
where schemaname='public'
  and (tablename in ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts')
       or tablename ~* '(score|submission|response|grade)')
order by tablename,policyname;

-- 7. Every non-internal trigger on the same tables, with decoded event bits,
--    timing, enabled state, function identity and complete trigger definition.
select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name,
       case when (t.tgtype::integer & 2)<>0 then 'ROW' else 'STATEMENT' end as granularity,
       case when (t.tgtype::integer & 64)<>0 then 'INSTEAD OF'
            when (t.tgtype::integer & 2)<>0 then 'BEFORE' else 'AFTER' end as timing,
       concat_ws(', ',
         case when (t.tgtype::integer & 4)<>0 then 'INSERT' end,
         case when (t.tgtype::integer & 8)<>0 then 'DELETE' end,
         case when (t.tgtype::integer & 16)<>0 then 'UPDATE' end,
         case when (t.tgtype::integer & 32)<>0 then 'TRUNCATE' end) as events,
       case t.tgenabled when 'O' then 'enabled' when 'D' then 'disabled'
         when 'R' then 'replica' when 'A' then 'always' else t.tgenabled::text end as enabled_state,
       fn_ns.nspname as function_schema, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as function_arguments,
       pg_get_triggerdef(t.oid,true) as trigger_definition
from pg_trigger t
join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
join pg_proc p on p.oid=t.tgfoid join pg_namespace fn_ns on fn_ns.oid=p.pronamespace
where not t.tgisinternal and n.nspname='public'
  and (c.relname in ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts')
       or c.relname ~* '(score|submission|response|grade)')
order by c.relname,t.tgname;

-- 8. Repair/app RPCs and same-named overloads: exact identity, names, defaults,
--    result type, owner, security mode, fixed settings, and effective EXECUTE.
with expected(function_name) as (
  values ('match_syllabus_chunks'),('save_draft_test'),('update_test_questions'),
         ('replace_test_question'),('attest_test_review'),('publish_test'),
         ('assert_test_publishable'),('validate_question_provenance'),
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
       p.proargnames as argument_and_output_names,
       pg_get_function_result(p.oid) as result_type,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as security_mode,
       p.proconfig as fixed_settings,
       pg_get_functiondef(p.oid) as function_definition,
       p.proacl as function_acl,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,
       has_function_privilege(current_user,p.oid,'EXECUTE') as current_user_execute
from expected e
left join pg_proc p on p.proname=e.function_name and p.pronamespace='public'::regnamespace
left join pg_namespace pn on pn.oid=p.pronamespace
order by e.function_name,pg_get_function_identity_arguments(p.oid);

-- 9. Exact effective table privileges. MAINTAIN is queried only on PostgreSQL
--    17+, otherwise the result is NULL with an explicit unsupported label.
with roles(role_name) as (values ('anon'),('authenticated'),('service_role'),(current_user)),
     rels(rel_name) as (
       select unnest(array['tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts']::text[])
       union
       select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and c.relname ~* '(score|submission|response|grade)'
     ),
     privs(privilege_name) as (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
       ('TRUNCATE'),('REFERENCES'),('TRIGGER'))
select r.role_name, x.rel_name,
       to_regclass('public.'||x.rel_name) as relation,
       p.privilege_name,
       case when to_regclass('public.'||x.rel_name) is null then null
            else has_table_privilege(r.role_name,to_regclass('public.'||x.rel_name),p.privilege_name) end as effective_privilege,
       current_setting('server_version_num')::integer>=170000 as maintain_supported,
       case when current_setting('server_version_num')::integer>=170000
              and to_regclass('public.'||x.rel_name) is not null
            then has_table_privilege(r.role_name,to_regclass('public.'||x.rel_name),'MAINTAIN')
            else null end as effective_maintain
from roles r cross join rels x cross join privs p
order by x.rel_name,r.role_name,p.privilege_name;

-- 10. Report required and optional TestGenie columns before any column ACL
--     inspection. The reviewed_by/reviewed_at columns are optional in the
--     current baseline and required prerequisites for the review repair.
with expected(table_name,column_name,requirement) as (
  values ('tests','google_form_id','required for Form association'),
         ('tests','google_form_url','required for Form association'),
         ('tests','reviewed_by','repair prerequisite'),
         ('tests','reviewed_at','repair prerequisite'),
         ('questions','explanation','required for question review and publication')
)
select e.table_name,e.column_name,e.requirement,
       (a.attname is not null) as present,
       case when a.attname is null then 'MISSING PREREQUISITE' else 'present' end as column_state,
       case when a.attname is not null then format_type(a.atttypid,a.atttypmod) end as formatted_type,
       case when a.attname is not null then not a.attnotnull end as is_nullable
from expected e
left join pg_class c on c.relnamespace='public'::regnamespace and c.relname=e.table_name
left join pg_attribute a on a.attrelid=c.oid and a.attname=e.column_name
  and a.attnum>0 and not a.attisdropped
order by e.table_name,e.column_name;

-- Effective column INSERT/UPDATE/REFERENCES privileges for existing columns.
-- No missing column is referenced as a SQL identifier and no row contents are
-- selected; absent optional columns simply have no ACL row to inspect.
with roles(role_name) as (values ('anon'),('authenticated'),('service_role'),(current_user))
select n.nspname as schema_name, c.relname as table_name, a.attname as column_name,
       r.role_name,
       has_column_privilege(r.role_name,c.oid,a.attnum,'INSERT') as insert_allowed,
       has_column_privilege(r.role_name,c.oid,a.attnum,'UPDATE') as update_allowed,
       has_column_privilege(r.role_name,c.oid,a.attnum,'REFERENCES') as references_allowed
from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
cross join roles r
where n.nspname='public'
  and (c.relname in ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts')
       or c.relname ~* '(score|submission|response|grade)')
  and (c.relname<>'tests' or a.attname in ('google_form_id','google_form_url','status','reviewed_by','reviewed_at'))
order by c.relname,a.attnum,r.role_name;

-- 11. Effective schema CREATE and role membership. This query does not report
--     sequence ACLs; no sequence ACL result should be inferred from it.
--     This helps explain inherited grants and security-definer ownership.
select r.rolname as role_name, r.rolsuper as is_superuser, r.rolbypassrls as bypass_rls,
       has_schema_privilege(r.rolname,'public','USAGE') as public_schema_usage,
       has_schema_privilege(r.rolname,'public','CREATE') as public_schema_create
from pg_roles r
where r.rolname in ('anon','authenticated','service_role',current_user)
order by r.rolname;

select member.rolname as member_role, parent.rolname as granted_role,
       m.admin_option
from pg_auth_members m
join pg_roles member on member.oid=m.member
join pg_roles parent on parent.oid=m.roleid
where member.rolname in ('anon','authenticated','service_role',current_user)
   or parent.rolname in ('anon','authenticated','service_role')
order by member.rolname,parent.rolname;

-- Repair prerequisite: the workflow reconciliation adds a reviewer FK to
-- auth.users(id). Report only relation metadata and effective REFERENCES;
-- never select auth.users rows.
select to_regclass('auth.users') as auth_users_relation,
       case when to_regclass('auth.users') is not null
         then has_table_privilege(current_user,'auth.users','REFERENCES')
         else null end as executor_can_reference_auth_users;

-- 12. Google credential access posture only. These queries expose schema,
--     policy expressions and ACLs, never credential rows or secret values.
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as force_rls, pg_get_userbyid(c.relowner) as owner
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='google_credentials'
order by c.relname;

select schemaname,tablename,policyname,permissive,roles,cmd,
       qual as using_expression,with_check as with_check_expression
from pg_policies where schemaname='public' and tablename='google_credentials'
order by policyname;

select r.role_name,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','SELECT') end as table_select,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','INSERT') end as table_insert,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','UPDATE') end as table_update,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','DELETE') end as table_delete,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','TRUNCATE') end as table_truncate,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','REFERENCES') end as table_references,
       case when to_regclass('public.google_credentials') is not null then has_table_privilege(r.role_name,'public.google_credentials','TRIGGER') end as table_trigger
from (values ('anon'),('authenticated'),('service_role'),(current_user)) r(role_name)
order by r.role_name;

-- 13. Repair-v2-specific presence/shape summary. Compare these results with
--     reconcile_test_workflow_v2.sql; NULL/missing is a finding, not success.
select name, to_regclass('public.'||name) is not null as present
from (values ('tests'),('questions'),('syllabi'),('syllabus_chunks'),('scores'),('google_credentials'),
             ('google_form_creation_attempts')) v(name)
order by name;

select name, to_regprocedure(signature) as exact_function
from (values
  ('save_draft_test','public.save_draft_test(uuid,jsonb,jsonb)'),
  ('update_test_questions','public.update_test_questions(uuid,text,text,text,jsonb)'),
  ('replace_test_question','public.replace_test_question(uuid,uuid,jsonb)'),
  ('attest_test_review','public.attest_test_review(uuid)'),
  ('publish_test','public.publish_test(uuid)'),
  ('assert_test_publishable','public.assert_test_publishable(uuid)'),
  ('claim_google_form_creation','public.claim_google_form_creation(uuid,uuid)'),
  ('record_google_form_creation_form','public.record_google_form_creation_form(uuid,uuid,text)'),
  ('release_google_form_creation','public.release_google_form_creation(uuid,uuid,boolean)')
) v(name,signature)
order by name;

-- Migration 012's response-idempotency index is essential to the score
-- ingestion upsert target. Report exact catalog definition, if present.
with expected(index_name,table_name) as (
  values ('scores_test_google_response_id_uidx','scores')
)
select e.table_name,e.index_name,
       case when i.indexname is null then 'MISSING' else 'present' end as index_state,
       i.indexdef as index_definition
from expected e
left join pg_indexes i on i.schemaname='public' and i.tablename=e.table_name
  and i.indexname=e.index_name;

-- End of read-only preflight. Do not infer semantic question correctness,
-- successful Forms creation/persistence, or score ingestion from catalog data.
