-- READ-ONLY TestGenie workflow postflight report.
-- Run only after an authorized operator has applied an independently reviewed
-- repair. This reports catalog state; it does not prove application behavior.

with checks(check_name, passed, detail) as (
  values
    ('questions.explanation is nullable text', exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='questions'
        and column_name='explanation' and data_type='text' and is_nullable='YES'
    ), 'Legacy questions may remain NULL'),
    ('tests.reviewed_by is nullable uuid', exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='tests'
        and column_name='reviewed_by' and data_type='uuid' and is_nullable='YES'
    ), 'Required for faculty review metadata'),
    ('tests.reviewed_at is nullable timestamptz', exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='tests'
        and column_name='reviewed_at' and data_type='timestamp with time zone' and is_nullable='YES'
    ), 'Required for faculty review metadata'),
    ('reviewer FK exists', exists (
      select 1 from pg_constraint c
      where c.conrelid=to_regclass('public.tests') and c.conname='tests_reviewed_by_fkey'
        and c.contype='f' and c.confrelid=to_regclass('auth.users') and c.confdeltype='n'
        and c.conkey=array[(select attnum::smallint from pg_attribute
          where attrelid=to_regclass('public.tests') and attname='reviewed_by' and not attisdropped)]::smallint[]
        and c.confkey=array[(select attnum::smallint from pg_attribute
          where attrelid=to_regclass('auth.users') and attname='id' and not attisdropped)]::smallint[]
    ), 'tests.reviewed_by references auth.users with ON DELETE SET NULL'),
    ('tests RLS is enabled', coalesce((
      select relrowsecurity from pg_class where oid=to_regclass('public.tests')
    ),false), 'public.tests'),
    ('questions RLS is enabled', coalesce((
      select relrowsecurity from pg_class where oid=to_regclass('public.questions')
    ),false), 'public.questions'),
    ('six workflow triggers exist with expected functions/events and enabled state', not exists (
      select 1 from (values
        ('questions','testgenie_validate_provenance','public.validate_question_provenance()',23),
        ('questions','testgenie_question_write_guard','public.testgenie_question_write_guard()',31),
        ('questions','testgenie_invalidate_test_review','public.testgenie_invalidate_test_review()',29),
        ('tests','testgenie_protect_published','public.prevent_published_test_changes()',19),
        ('tests','testgenie_prevent_published_delete','public.prevent_published_test_delete()',11),
        ('tests','testgenie_guard_test_insert','public.testgenie_guard_test_insert()',7)
      ) expected(table_name,trigger_name,function_signature,event_bits)
      left join pg_trigger t on t.tgrelid=to_regclass('public.'||expected.table_name)
        and t.tgname=expected.trigger_name and not t.tgisinternal
      where t.oid is null or t.tgenabled<>'O' or t.tgtype<>expected.event_bits
        or t.tgfoid is distinct from to_regprocedure(expected.function_signature)::oid
    ), 'The existing tests_set_updated_at trigger is retained separately'),
    ('all 16 repair policies carry the v3 ownership marker', (
      select count(*)=16
      from pg_policy p join pg_class c on c.oid=p.polrelid
      join pg_namespace n on n.oid=c.relnamespace
      join pg_description d on d.classoid='pg_policy'::regclass and d.objoid=p.oid and d.objsubid=0
      where n.nspname='public' and c.relname in ('tests','questions')
        and p.polname=any(array[
          'tg_tests_select_owner','tg_tests_insert_owner','tg_tests_update_owner','tg_tests_delete_owner',
          'tg_questions_select_owner','tg_questions_insert_owner','tg_questions_update_owner','tg_questions_delete_owner',
          'tg_tests_select_restrict','tg_tests_insert_restrict','tg_tests_update_restrict','tg_tests_delete_restrict',
          'tg_questions_select_restrict','tg_questions_insert_restrict','tg_questions_update_restrict','tg_questions_delete_restrict'
        ]) and d.description='TestGenie reconcile_test_workflow policy v3'
    ), 'Review the policy listing below for expressions and any legacy policies'),
    ('effective table grants match the browser contract', not exists (
      select 1 from (values
        ('anon','public.tests'::regclass,'SELECT',false),('anon','public.tests'::regclass,'INSERT',false),
        ('anon','public.tests'::regclass,'UPDATE',false),('anon','public.tests'::regclass,'DELETE',false),
        ('anon','public.tests'::regclass,'TRUNCATE',false),('anon','public.tests'::regclass,'REFERENCES',false),
        ('anon','public.tests'::regclass,'TRIGGER',false),('anon','public.questions'::regclass,'SELECT',false),
        ('anon','public.questions'::regclass,'INSERT',false),('anon','public.questions'::regclass,'UPDATE',false),
        ('anon','public.questions'::regclass,'DELETE',false),('anon','public.questions'::regclass,'TRUNCATE',false),
        ('anon','public.questions'::regclass,'REFERENCES',false),('anon','public.questions'::regclass,'TRIGGER',false),
        ('authenticated','public.tests'::regclass,'SELECT',true),('authenticated','public.tests'::regclass,'INSERT',false),
        ('authenticated','public.tests'::regclass,'UPDATE',false),('authenticated','public.tests'::regclass,'DELETE',true),
        ('authenticated','public.tests'::regclass,'TRUNCATE',false),('authenticated','public.tests'::regclass,'REFERENCES',false),
        ('authenticated','public.tests'::regclass,'TRIGGER',false),('authenticated','public.questions'::regclass,'SELECT',true),
        ('authenticated','public.questions'::regclass,'INSERT',false),('authenticated','public.questions'::regclass,'UPDATE',false),
        ('authenticated','public.questions'::regclass,'DELETE',false),('authenticated','public.questions'::regclass,'TRUNCATE',false),
        ('authenticated','public.questions'::regclass,'REFERENCES',false),('authenticated','public.questions'::regclass,'TRIGGER',false)
      ) expected(role_name,relation,privilege_name,allowed)
      where has_table_privilege(expected.role_name,expected.relation,expected.privilege_name)
        is distinct from expected.allowed
    ), 'RLS does not protect TRUNCATE; browser roles must not have it'),
    ('authenticated column grants are limited to Google Form metadata updates', not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      cross join (values ('anon'),('authenticated')) roles(role_name)
      where n.nspname='public' and c.relname in ('tests','questions')
        and ((roles.role_name='anon' and (
              has_column_privilege(roles.role_name,c.oid,a.attnum,'INSERT')
              or has_column_privilege(roles.role_name,c.oid,a.attnum,'UPDATE')
              or has_column_privilege(roles.role_name,c.oid,a.attnum,'REFERENCES')))
          or (roles.role_name='authenticated' and (
              has_column_privilege(roles.role_name,c.oid,a.attnum,'INSERT')
              or has_column_privilege(roles.role_name,c.oid,a.attnum,'REFERENCES')
              or (has_column_privilege(roles.role_name,c.oid,a.attnum,'UPDATE')
                and not (c.relname='tests' and a.attname in ('google_form_id','google_form_url'))))))
    ), 'Authenticated RPCs own workflow writes; only Form metadata has direct UPDATE'),
    ('save_draft_test exact signature exists', to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is not null,
      'Expected (uuid,jsonb,jsonb) returning jsonb'),
    ('update_test_questions exact signature exists', to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is not null,
      'Expected (uuid,text,text,text,jsonb) returning void'),
    ('replace_test_question exact signature exists', to_regprocedure('public.replace_test_question(uuid,uuid,jsonb)') is not null,
      'Expected (uuid,uuid,jsonb) returning void'),
    ('attest_test_review exact signature exists', to_regprocedure('public.attest_test_review(uuid)') is not null,
      'Expected (uuid) returning void'),
    ('assert_test_publishable exact signature exists', to_regprocedure('public.assert_test_publishable(uuid)') is not null,
      'Expected internal (uuid) returning void'),
    ('publish_test exact signature exists', to_regprocedure('public.publish_test(uuid)') is not null,
      'Expected (uuid) returning void'),
    ('workflow RPC argument names, return types, and security modes match candidate', not exists (
      select 1 from (values
        ('save_draft_test','public.save_draft_test(uuid,jsonb,jsonb)',array['p_syllabus_id','p_generation_config','p_questions']::text[],'jsonb'::regtype,true),
        ('update_test_questions','public.update_test_questions(uuid,text,text,text,jsonb)',array['p_test_id','p_title','p_subject','p_difficulty','p_questions']::text[],'void'::regtype,true),
        ('replace_test_question','public.replace_test_question(uuid,uuid,jsonb)',array['p_test_id','p_question_id','p_question']::text[],'void'::regtype,true),
        ('attest_test_review','public.attest_test_review(uuid)',array['p_test_id']::text[],'void'::regtype,true),
        ('assert_test_publishable','public.assert_test_publishable(uuid)',array['p_test_id']::text[],'void'::regtype,false),
        ('publish_test','public.publish_test(uuid)',array['p_test_id']::text[],'void'::regtype,true)
      ) expected(name,signature,arg_names,result_type,security_definer)
      left join pg_proc p on p.oid=to_regprocedure(expected.signature)
      where p.oid is null or p.proargnames is distinct from expected.arg_names
        or p.prorettype<>expected.result_type or p.prosecdef<>expected.security_definer
    ), 'Inspect ownership and fixed search_path in the detailed function report'),
    ('authenticated can execute save_draft_test', case when to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is null then false else has_function_privilege('authenticated','public.save_draft_test(uuid,jsonb,jsonb)','EXECUTE') end,
      'Application RPC'),
    ('authenticated can execute update_test_questions', case when to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is null then false else has_function_privilege('authenticated','public.update_test_questions(uuid,text,text,text,jsonb)','EXECUTE') end,
      'Application RPC'),
    ('authenticated can execute replace_test_question', case when to_regprocedure('public.replace_test_question(uuid,uuid,jsonb)') is null then false else has_function_privilege('authenticated','public.replace_test_question(uuid,uuid,jsonb)','EXECUTE') end,
      'Application RPC'),
    ('authenticated can execute attest_test_review', case when to_regprocedure('public.attest_test_review(uuid)') is null then false else has_function_privilege('authenticated','public.attest_test_review(uuid)','EXECUTE') end,
      'Application RPC'),
    ('authenticated can execute publish_test', case when to_regprocedure('public.publish_test(uuid)') is null then false else has_function_privilege('authenticated','public.publish_test(uuid)','EXECUTE') end,
      'Application RPC'),
    ('browser roles cannot execute assert_test_publishable',
      case when to_regprocedure('public.assert_test_publishable(uuid)') is null then false
        else not has_function_privilege('authenticated','public.assert_test_publishable(uuid)','EXECUTE')
          and not has_function_privilege('anon','public.assert_test_publishable(uuid)','EXECUTE') end,
      'Internal publication helper'),
    ('anon cannot execute workflow RPCs',
      not (case when to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is null then false else has_function_privilege('anon','public.save_draft_test(uuid,jsonb,jsonb)','EXECUTE') end
        or case when to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is null then false else has_function_privilege('anon','public.update_test_questions(uuid,text,text,text,jsonb)','EXECUTE') end
        or case when to_regprocedure('public.replace_test_question(uuid,uuid,jsonb)') is null then false else has_function_privilege('anon','public.replace_test_question(uuid,uuid,jsonb)','EXECUTE') end
        or case when to_regprocedure('public.attest_test_review(uuid)') is null then false else has_function_privilege('anon','public.attest_test_review(uuid)','EXECUTE') end
        or case when to_regprocedure('public.publish_test(uuid)') is null then false else has_function_privilege('anon','public.publish_test(uuid)','EXECUTE') end),
      'Anonymous role must not execute authenticated workflow RPCs'),
    ('public schema CREATE is denied to browser roles',
      not has_schema_privilege('anon','public','CREATE')
        and not has_schema_privilege('authenticated','public','CREATE'),
      'Browser roles must not replace public functions or relations')
)
select check_name, case when passed then 'PASS' else 'FAIL' end as status, detail
from checks
order by check_name;

-- Inspect exact function interface/security settings after the summary above.
select p.oid::regprocedure as signature,
       p.proargnames as argument_names,
       pg_get_function_result(p.oid) as result_type,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       p.proconfig as fixed_settings
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('save_draft_test','update_test_questions','replace_test_question',
    'attest_test_review','assert_test_publishable','publish_test')
order by p.proname,pg_get_function_identity_arguments(p.oid);

-- Trigger and policy listings are metadata only. Review for enabled workflow
-- guards, owner/draft scoping, and unexpected overlapping policy definitions.
select c.relname as table_name, t.tgname as trigger_name, t.tgenabled,
       p.oid::regprocedure as trigger_function, pg_get_triggerdef(t.oid,true) as definition
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_proc p on p.oid=t.tgfoid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
  and c.relname in ('tests','questions')
order by c.relname,t.tgname;

select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies
where schemaname='public' and tablename in ('tests','questions')
order by tablename,policyname;
