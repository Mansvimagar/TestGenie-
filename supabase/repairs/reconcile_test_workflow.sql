-- TestGenie manual repair proposal for draft save, question review and publish.
-- Do not run until a recovery point is confirmed, live preflight is complete,
-- the project ref is verified, and all app/PostgREST/RPC writes are frozen.
-- This is not a migration-ledger entry. It does not replay migrations 001-011
-- and does not modify google_credentials or its grants/policies.
--
-- One transaction: any failed precondition or postcondition rolls back the file.
-- Review every assumption against the intended live project before execution.

begin;

do $preflight$
declare
  v_missing text[];
  v_bad text[];
  v_col text;
  v_role text;
  v_priv text;
  v_policy text;
begin
  if to_regclass('public.tests') is null or to_regclass('public.questions') is null
     or to_regclass('public.syllabi') is null or to_regclass('public.syllabus_chunks') is null then
    raise exception 'Preflight failed: expected TestGenie tables are missing';
  end if;

  select array_agg(r.table_name || '.' || r.column_name order by r.table_name,r.column_name)
    into v_missing
  from (values
    ('tests','id'),('tests','user_id'),('tests','title'),('tests','subject'),('tests','syllabus_text'),
    ('tests','difficulty'),('tests','question_count'),('tests','status'),('tests','syllabus_id'),
    ('tests','generation_config'),('tests','google_form_id'),('tests','google_form_url'),
    ('questions','id'),('questions','test_id'),('questions','topic'),('questions','question'),
    ('questions','options'),('questions','correct_answer_index'),('questions','position'),
    ('questions','source_chunk_ids'),('questions','grounding_status'),('questions','validation_status'),
    ('questions','validation_metadata'),('syllabi','id'),('syllabi','user_id'),('syllabi','status'),
    ('syllabus_chunks','id'),('syllabus_chunks','syllabus_id'),('syllabus_chunks','unit'),
    ('syllabus_chunks','topic'),('syllabus_chunks','subtopic'),('syllabus_chunks','metadata')
  ) r(table_name,column_name)
  where not exists(select 1 from information_schema.columns c where c.table_schema='public'
    and c.table_name=r.table_name and c.column_name=r.column_name);
  if v_missing is not null then
    raise exception 'Preflight failed: missing required columns: %',array_to_string(v_missing,', ');
  end if;

  select array_agg(r.table_name || '.' || r.column_name order by r.table_name,r.column_name)
    into v_bad
  from (values
    ('tests','id','uuid'),('tests','user_id','uuid'),('tests','status','text'),
    ('tests','syllabus_id','uuid'),('tests','generation_config','jsonb'),
    ('tests','reviewed_by','uuid'),('tests','reviewed_at','timestamp with time zone'),
    ('questions','id','uuid'),('questions','test_id','uuid'),('questions','options','jsonb'),
    ('questions','correct_answer_index','smallint'),('questions','source_chunk_ids','jsonb'),
    ('questions','validation_metadata','jsonb'),('syllabi','id','uuid'),('syllabi','user_id','uuid'),
    ('syllabus_chunks','id','uuid'),('syllabus_chunks','syllabus_id','uuid'),('syllabus_chunks','metadata','jsonb')
  ) r(table_name,column_name,data_type)
  join information_schema.columns c on c.table_schema='public' and c.table_name=r.table_name
    and c.column_name=r.column_name where c.data_type<>r.data_type;
  if v_bad is not null then
    raise exception 'Preflight failed: incompatible column types: %',array_to_string(v_bad,', ');
  end if;

  if exists(select 1 from pg_attribute a where a.attrelid='public.questions'::regclass
      and a.attname='explanation' and a.attnum>0 and not a.attisdropped
      and (a.atttypid<>'text'::regtype or a.attnotnull)) then
    raise exception 'Preflight failed: existing questions.explanation must be nullable text';
  end if;
  if exists(select 1 from pg_attribute a where a.attrelid='public.tests'::regclass
      and a.attnum>0 and not a.attisdropped
      and ((a.attname='reviewed_by' and a.atttypid<>'uuid'::regtype)
        or (a.attname='reviewed_at' and a.atttypid<>'timestamptz'::regtype)
        or (a.attname in ('reviewed_by','reviewed_at') and a.attnotnull))) then
    raise exception 'Preflight failed: existing review-attestation columns must be nullable uuid/timestamptz';
  end if;
  if not exists(select 1 from pg_constraint c where c.conrelid='public.tests'::regclass
      and c.contype='c' and pg_get_constraintdef(c.oid) ilike '%status%draft%published%') then
    raise exception 'Preflight failed: expected draft/published tests status constraint is missing';
  end if;
  if not exists(select 1 from pg_constraint c where c.conrelid='public.questions'::regclass
      and c.contype='f' and c.confrelid='public.tests'::regclass
      and pg_get_constraintdef(c.oid) ilike '%test_id%tests%') then
    raise exception 'Preflight failed: questions.test_id foreign key to tests is missing';
  end if;
  if not exists(select 1 from pg_constraint c where c.conrelid='public.tests'::regclass
      and c.contype='f' and c.confrelid='public.syllabi'::regclass
      and pg_get_constraintdef(c.oid) ilike '%syllabus_id%syllabi%') then
    raise exception 'Preflight failed: tests.syllabus_id foreign key to syllabi is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.syllabi'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.syllabus_chunks'::regclass)
     or not has_table_privilege('authenticated','public.syllabi','SELECT')
     or not has_table_privilege('authenticated','public.syllabus_chunks','SELECT') then
    raise exception 'Preflight failed: authenticated RLS-protected syllabus/chunk reads are required';
  end if;
  if exists(select 1 from pg_class where oid in ('public.tests'::regclass,'public.questions'::regclass)
      and relforcerowsecurity)
     and not (select rolsuper or rolbypassrls from pg_roles where rolname=current_user) then
    raise exception 'Preflight failed: FORCE ROW LEVEL SECURITY requires a verified BYPASSRLS repair owner';
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='syllabi'
      and policyname='syllabi_select_own' and cmd='SELECT'
      and coalesce(qual,'') like '%auth.uid%' and coalesce(qual,'') like '%user_id%')
     or not exists(select 1 from pg_policies where schemaname='public' and tablename='syllabus_chunks'
      and policyname='syllabus_chunks_select_own' and cmd='SELECT'
      and coalesce(qual,'') like '%auth.uid%' and coalesce(qual,'') like '%syllabi%') then
    raise exception 'Preflight failed: expected owner-scoped syllabus/chunk SELECT policies are missing';
  end if;
  if exists(select 1 from pg_policies where schemaname='public' and tablename in ('tests','questions')
      and permissive='RESTRICTIVE'
      and policyname not in ('tests_insert_draft_only','tests_delete_draft_only',
        'questions_insert_draft_only','questions_update_draft_only','questions_delete_draft_only',
        'tg_tests_select_restrict','tg_tests_insert_restrict','tg_tests_update_restrict','tg_tests_delete_restrict',
        'tg_questions_select_restrict','tg_questions_insert_restrict','tg_questions_update_restrict','tg_questions_delete_restrict')) then
    raise exception 'Preflight failed: unexpected restrictive policies require manual review before reconciliation';
  end if;
  -- Refuse to drop a same-named policy unless it is marked as owned by this repair.
  foreach v_policy in array array[
    'tg_tests_select_owner','tg_tests_insert_owner','tg_tests_update_owner','tg_tests_delete_owner',
    'tg_questions_select_owner','tg_questions_insert_owner','tg_questions_update_owner','tg_questions_delete_owner',
    'tg_tests_select_restrict','tg_tests_insert_restrict','tg_tests_update_restrict','tg_tests_delete_restrict',
    'tg_questions_select_restrict','tg_questions_insert_restrict','tg_questions_update_restrict','tg_questions_delete_restrict'
  ] loop
    if exists(select 1 from pg_policy p join pg_class c on c.oid=p.polrelid
        join pg_namespace n on n.oid=c.relnamespace
        left join pg_description d on d.classoid='pg_policy'::regclass and d.objoid=p.oid and d.objsubid=0
        where n.nspname='public' and c.relname in ('tests','questions') and p.polname=v_policy
          and coalesce(d.description,'')<>'TestGenie reconcile_test_workflow policy v2') then
      raise exception 'Preflight failed: policy % exists without this repair marker; inspect it manually',v_policy;
    end if;
  end loop;
  -- Resolve the vector type from pg_type rather than assuming its extension
  -- schema is on search_path.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    join pg_type vt on vt.oid=p.proargtypes[0]
    where n.nspname='public' and p.proname='match_syllabus_chunks' and p.pronargs=5
      and vt.typname='vector' and p.proargtypes[1]='uuid'::regtype
      and p.proargtypes[0]=(select a.atttypid from pg_attribute a where a.attrelid='public.syllabus_chunks'::regclass
        and a.attname='embedding' and a.attnum>0 and not a.attisdropped)
      and p.proargtypes[2]='text'::regtype and p.proargtypes[3]='text'::regtype
      and p.proargtypes[4]='integer'::regtype
  ) then
    raise exception 'Preflight failed: expected match_syllabus_chunks signature is missing';
  end if;
  if not exists(select 1 from pg_attribute a where a.attrelid='public.syllabus_chunks'::regclass
      and a.attname='embedding' and a.attnum>0 and not a.attisdropped
      and format_type(a.atttypid,a.atttypmod) like '%vector(768)') then
    raise exception 'Preflight failed: syllabus_chunks.embedding is not confirmed as vector(768)';
  end if;
  if to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is not null
     and (select p.prorettype<>'jsonb'::regtype
                 or p.proargnames is distinct from array['p_syllabus_id','p_generation_config','p_questions']::text[]
          from pg_proc p
          where p.oid=to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)')) then
    raise exception 'Preflight failed: save_draft_test return type or PostgREST argument names differ';
  end if;
  if to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is not null
     and (select p.prorettype<>'void'::regtype
                 or p.proargnames is distinct from array['p_test_id','p_title','p_subject','p_difficulty','p_questions']::text[]
          from pg_proc p where p.oid=to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)')) then
    raise exception 'Preflight failed: update_test_questions interface conflicts with the application';
  end if;
  if to_regprocedure('public.publish_test(uuid)') is not null
     and (select p.prorettype<>'void'::regtype or p.proargnames is distinct from array['p_test_id']::text[]
          from pg_proc p where p.oid=to_regprocedure('public.publish_test(uuid)')) then
    raise exception 'Preflight failed: publish_test interface conflicts with the application';
  end if;
  if to_regprocedure('public.attest_test_review(uuid)') is not null
     and (select p.prorettype<>'void'::regtype or p.proargnames is distinct from array['p_test_id']::text[]
          from pg_proc p where p.oid=to_regprocedure('public.attest_test_review(uuid)')) then
    raise exception 'Preflight failed: attest_test_review interface conflicts with the application';
  end if;
  if current_user in ('anon','authenticated')
     or not (select rolsuper from pg_roles where rolname=current_user)
        and (select count(*) from pg_class c join pg_roles r on r.oid=c.relowner
          where c.oid in ('public.tests'::regclass,'public.questions'::regclass)
            and r.rolname=current_user)<>2 then
    raise exception 'Preflight failed: execute as a trusted database admin or owner of both tests and questions';
  end if;
  if not (select rolsuper from pg_roles where rolname=current_user)
     and not has_schema_privilege(current_user,'public','CREATE') then
    raise exception 'Preflight failed: repair executor cannot create or replace functions in public';
  end if;
  if not (select rolsuper from pg_roles where rolname=current_user)
     and not has_table_privilege(current_user,'auth.users','REFERENCES') then
    raise exception 'Preflight failed: repair executor lacks REFERENCES privilege on auth.users for reviewer integrity';
  end if;
  if exists(select 1 from pg_constraint c where c.conrelid='public.tests'::regclass
      and c.conname='tests_reviewed_by_fkey'
      and (c.contype<>'f' or c.confrelid<>'auth.users'::regclass or c.confdeltype<>'n')) then
    raise exception 'Preflight failed: tests_reviewed_by_fkey exists with an unexpected definition';
  end if;
  if exists(select 1 from pg_constraint c where c.conrelid='public.tests'::regclass
      and c.contype='f' and c.conname<>'tests_reviewed_by_fkey'
      and c.conkey @> array[(select attnum::smallint from pg_attribute
        where attrelid='public.tests'::regclass and attname='reviewed_by' and not attisdropped)]::smallint[]) then
    raise exception 'Preflight failed: reviewed_by already has a differently named foreign key; inspect before repair';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('save_draft_test','update_test_questions','publish_test',
        'validate_question_provenance','prevent_published_test_changes','attest_test_review',
        'assert_test_publishable','testgenie_question_write_guard','prevent_published_test_delete',
        'testgenie_guard_test_insert','testgenie_invalidate_test_review')
        and p.proowner<>(select oid from pg_roles where rolname=current_user)) then
    raise exception 'Preflight failed: an existing target function is owned by another role; inspect ownership before replacement';
  end if;
  if (to_regprocedure('public.assert_test_publishable(uuid)') is not null and
      (select prorettype<>'void'::regtype from pg_proc where oid=to_regprocedure('public.assert_test_publishable(uuid)')))
     or (to_regprocedure('public.validate_question_provenance()') is not null and
      (select prorettype<>'trigger'::regtype from pg_proc where oid=to_regprocedure('public.validate_question_provenance()')))
     or (to_regprocedure('public.prevent_published_test_changes()') is not null and
      (select prorettype<>'trigger'::regtype from pg_proc where oid=to_regprocedure('public.prevent_published_test_changes()')))
     or (to_regprocedure('public.prevent_published_test_delete()') is not null and
      (select prorettype<>'trigger'::regtype from pg_proc where oid=to_regprocedure('public.prevent_published_test_delete()')))
     or (to_regprocedure('public.testgenie_question_write_guard()') is not null and
      (select prorettype<>'trigger'::regtype from pg_proc where oid=to_regprocedure('public.testgenie_question_write_guard()')))
     or (to_regprocedure('public.testgenie_invalidate_test_review()') is not null and
      (select prorettype<>'trigger'::regtype from pg_proc where oid=to_regprocedure('public.testgenie_invalidate_test_review()')))
     or (to_regprocedure('public.testgenie_guard_test_insert()') is not null and
      (select prorettype<>'trigger'::regtype from pg_proc where oid=to_regprocedure('public.testgenie_guard_test_insert()'))) then
    raise exception 'Preflight failed: an existing function has an incompatible return type';
  end if;
  if has_schema_privilege('anon','public','CREATE') or has_schema_privilege('authenticated','public','CREATE') then
    raise exception 'Preflight failed: browser roles must not have CREATE on public';
  end if;
  if not has_table_privilege('service_role','public.tests','SELECT')
     or not has_table_privilege('service_role','public.tests','INSERT')
     or not has_table_privilege('service_role','public.tests','UPDATE')
     or not has_table_privilege('service_role','public.questions','SELECT')
     or not has_table_privilege('service_role','public.questions','INSERT')
     or not has_table_privilege('service_role','public.questions','UPDATE') then
    raise exception 'Preflight failed: service_role privileges differ from application prerequisites';
  end if;
  if not has_table_privilege(current_user,'public.questions','SELECT')
     or not has_column_privilege(current_user,'public.tests','status','UPDATE') then
    raise exception 'Preflight failed: repair owner needs question reads and test status update rights';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege(v_role,'public.google_credentials',v_priv) then
        raise exception 'Preflight failed: browser role % has OAuth table privilege %',v_role,v_priv;
      end if;
    end loop;
    for v_col in select a.attname::text from pg_attribute a
      where a.attrelid='public.google_credentials'::regclass and a.attnum>0 and not a.attisdropped loop
      foreach v_priv in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        if has_column_privilege(v_role,'public.google_credentials',v_col,v_priv) then
          raise exception 'Preflight failed: browser role % has OAuth column privilege on %',v_role,v_col;
        end if;
      end loop;
    end loop;
  end loop;
  if not has_table_privilege('service_role','public.google_credentials','SELECT')
     or not has_table_privilege('service_role','public.google_credentials','INSERT')
     or not has_table_privilege('service_role','public.google_credentials','UPDATE') then
    raise exception 'Preflight failed: required server-side OAuth credential operations are not available';
  end if;
  if exists(select 1 from pg_trigger t where t.tgrelid='public.questions'::regclass
      and t.tgname='testgenie_validate_provenance' and not t.tgisinternal
      and t.tgfoid<>coalesce(to_regprocedure('public.validate_question_provenance()')::oid,0))
     or exists(select 1 from pg_trigger t where t.tgrelid='public.questions'::regclass
       and t.tgname='testgenie_question_write_guard' and not t.tgisinternal
       and t.tgfoid<>coalesce(to_regprocedure('public.testgenie_question_write_guard()')::oid,0))
     or exists(select 1 from pg_trigger t where t.tgrelid='public.questions'::regclass
       and t.tgname='testgenie_invalidate_test_review' and not t.tgisinternal
       and t.tgfoid<>coalesce(to_regprocedure('public.testgenie_invalidate_test_review()')::oid,0))
     or exists(select 1 from pg_trigger t where t.tgrelid='public.tests'::regclass
      and t.tgname='testgenie_protect_published' and not t.tgisinternal
      and t.tgfoid<>coalesce(to_regprocedure('public.prevent_published_test_changes()')::oid,0))
     or exists(select 1 from pg_trigger t where t.tgrelid='public.tests'::regclass
       and t.tgname='testgenie_prevent_published_delete' and not t.tgisinternal
       and t.tgfoid<>coalesce(to_regprocedure('public.prevent_published_test_delete()')::oid,0))
     or exists(select 1 from pg_trigger t where t.tgrelid='public.tests'::regclass
       and t.tgname='testgenie_guard_test_insert' and not t.tgisinternal
       and t.tgfoid<>coalesce(to_regprocedure('public.testgenie_guard_test_insert()')::oid,0)) then
    raise exception 'Preflight failed: a repair trigger name is already used by another function';
  end if;
end;
$preflight$;

-- Nullable for old questions; current draft-save requests require an explanation.
alter table public.questions add column if not exists explanation text;
alter table public.tests add column if not exists reviewed_by uuid;
alter table public.tests add column if not exists reviewed_at timestamptz;
do $review_fk$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.tests'::regclass
      and conname='tests_reviewed_by_fkey') then
    alter table public.tests add constraint tests_reviewed_by_fkey
      foreign key (reviewed_by) references auth.users(id) on delete set null;
  end if;
end;
$review_fk$;

create or replace function public.validate_question_provenance()
returns trigger language plpgsql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
declare v_syllabus_id uuid; v_config jsonb;
begin
  if auth.uid() is null and current_user not in ('service_role','postgres','supabase_admin') then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(new.source_chunk_ids) is distinct from 'array' then
    raise exception 'Question source IDs must be an array';
  end if;
  if jsonb_array_length(new.source_chunk_ids)=0 then
    raise exception 'Each saved question requires at least one syllabus source chunk';
  end if;
  select t.syllabus_id,t.generation_config into v_syllabus_id,v_config from public.tests t
    where t.id=new.test_id and t.status='draft'
      and (t.user_id=auth.uid() or (auth.uid() is null and current_user in ('service_role','postgres','supabase_admin')))
    for update;
  if not found then raise exception 'Draft test not found or not owned by the authenticated user'; end if;
  if jsonb_typeof(coalesce(v_config,'{}'::jsonb)) is distinct from 'object'
     or v_config->>'syllabusId' is distinct from v_syllabus_id::text
     or (v_config ? 'includedTopics' and jsonb_typeof(v_config->'includedTopics') is distinct from 'array')
     or (v_config ? 'excludedTopics' and jsonb_typeof(v_config->'excludedTopics') is distinct from 'array') then
    raise exception 'Saved test scope is invalid';
  end if;
  if v_syllabus_id is null or not exists(select 1 from public.syllabi s
      where s.id=v_syllabus_id and s.user_id=(select t.user_id from public.tests t where t.id=new.test_id)
        and s.status='ready') then
    raise exception 'Question source IDs require a linked syllabus';
  end if;
  if exists(select 1 from jsonb_array_elements_text(new.source_chunk_ids) s(chunk_id)
    where not exists(select 1 from public.syllabus_chunks c where c.id::text=s.chunk_id
      and c.syllabus_id=v_syllabus_id
      and (nullif(v_config->>'unit','') is null or c.unit=v_config->>'unit')
      and (nullif(v_config->>'topic','') is null or c.topic=v_config->>'topic')
      and (nullif(v_config->>'subtopic','') is null or c.subtopic=v_config->>'subtopic')
      and (jsonb_array_length(coalesce(v_config->'includedTopics','[]'::jsonb))=0 or exists(
        select 1 from jsonb_array_elements_text(coalesce(v_config->'includedTopics','[]'::jsonb)) i(value)
        where lower(btrim(i.value))=lower(btrim(coalesce(c.topic,'')))))
      and not exists(select 1 from jsonb_array_elements_text(coalesce(v_config->'excludedTopics','[]'::jsonb)) e(value)
        where lower(btrim(e.value))=lower(btrim(coalesce(c.topic,''))))
      and c.metadata->>'embeddingProvider'='gemini')) then
    raise exception 'Question source IDs must match Gemini chunks in the saved syllabus scope';
  end if;
  if jsonb_typeof(coalesce(new.validation_metadata,'{}'::jsonb)) is distinct from 'object' then
    raise exception 'Question validation metadata must be an object';
  end if;
  new.grounding_status := 'needs_review';
  new.validation_metadata := (coalesce(new.validation_metadata,'{}'::jsonb)
    - 'supportAssessment' - 'supportReviewNote' - 'groundingSimilarity' - 'groundingStatus' - 'isGrounded' - 'verified')
    || jsonb_build_object('supportAssessment','uncertain','supportReviewNote','Faculty verification required.');
  return new;
end;
$$;

create or replace function public.save_draft_test(p_syllabus_id uuid,p_generation_config jsonb,p_questions jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public
as $$
declare v_user_id uuid:=auth.uid(); v_test public.tests%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_generation_config) is distinct from 'object'
     or p_generation_config->>'syllabusId' is distinct from p_syllabus_id::text
     or jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions)<1 or jsonb_array_length(p_questions)>50 then
    raise exception 'Invalid draft payload';
  end if;
  if (p_generation_config ? 'includedTopics' and jsonb_typeof(p_generation_config->'includedTopics') is distinct from 'array')
     or (p_generation_config ? 'excludedTopics' and jsonb_typeof(p_generation_config->'excludedTopics') is distinct from 'array') then
    raise exception 'Invalid draft scope';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item) where
      jsonb_typeof(q.item) is distinct from 'object' or nullif(btrim(q.item->>'topic'),'') is null
      or nullif(btrim(q.item->>'question'),'') is null or jsonb_typeof(q.item->'options') is distinct from 'array'
      or case when jsonb_typeof(q.item->'options')='array' then jsonb_array_length(q.item->'options')<>4 else true end
      or jsonb_typeof(q.item->'correctAnswerIndex') is distinct from 'number'
      or case when jsonb_typeof(q.item->'correctAnswerIndex')='number' then (q.item->>'correctAnswerIndex')::numeric not in (0,1,2,3) else true end
      or nullif(btrim(q.item->>'explanation'),'') is null
      or case when jsonb_typeof(q.item->'sourceChunkIds')='array' then jsonb_array_length(q.item->'sourceChunkIds')=0 else true end
      or (q.item ? 'validationMetadata' and jsonb_typeof(q.item->'validationMetadata') is distinct from 'object')) then
    raise exception 'Invalid question payload';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item) where
      (select count(distinct lower(btrim(o.value))) from jsonb_array_elements_text(q.item->'options') o(value))<>4) then
    raise exception 'Question options must be distinct';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item)
      cross join lateral jsonb_array_elements(q.item->'options') o(value)
      where jsonb_typeof(o.value) is distinct from 'string') then
    raise exception 'Question options must be strings';
  end if;
  if not exists(select 1 from public.syllabi s where s.id=p_syllabus_id and s.user_id=v_user_id and s.status='ready') then
    raise exception 'Syllabus not found or not ready';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item)
    cross join lateral jsonb_array_elements_text(coalesce(q.item->'sourceChunkIds','[]'::jsonb)) src(chunk_id)
    where not exists(select 1 from public.syllabus_chunks c where c.id::text=src.chunk_id
      and c.syllabus_id=p_syllabus_id
      and (nullif(p_generation_config->>'unit','') is null or c.unit=p_generation_config->>'unit')
      and (nullif(p_generation_config->>'topic','') is null or c.topic=p_generation_config->>'topic')
      and (nullif(p_generation_config->>'subtopic','') is null or c.subtopic=p_generation_config->>'subtopic')
      and (jsonb_array_length(coalesce(p_generation_config->'includedTopics','[]'::jsonb))=0 or exists(
        select 1 from jsonb_array_elements_text(coalesce(p_generation_config->'includedTopics','[]'::jsonb)) i(value)
        where lower(btrim(i.value))=lower(btrim(coalesce(c.topic,'')))))
      and not exists(select 1 from jsonb_array_elements_text(coalesce(p_generation_config->'excludedTopics','[]'::jsonb)) e(value)
        where lower(btrim(e.value))=lower(btrim(coalesce(c.topic,''))))
      and c.metadata->>'embeddingProvider'='gemini')) then
    raise exception 'Source evidence is outside the requested syllabus scope';
  end if;
  insert into public.tests(user_id,title,subject,syllabus_text,difficulty,question_count,status,syllabus_id,generation_config)
    values(v_user_id,p_generation_config->>'title',p_generation_config->>'subject','',p_generation_config->>'difficulty',
      jsonb_array_length(p_questions),'draft',p_syllabus_id,p_generation_config) returning * into v_test;
  insert into public.questions(test_id,topic,question,options,correct_answer_index,position,explanation,source_chunk_ids,
    grounding_status,validation_status,validation_metadata)
  select v_test.id,q.item->>'topic',q.item->>'question',q.item->'options',(q.item->>'correctAnswerIndex')::smallint,
    (q.ordinality-1)::integer,q.item->>'explanation',coalesce(q.item->'sourceChunkIds','[]'::jsonb),'needs_review',
    case when q.item->>'validationStatus' in ('unique','duplicate','not_applicable') then q.item->>'validationStatus' else 'not_applicable' end,
    coalesce(q.item->'validationMetadata','{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality q(item,ordinality);
  return to_jsonb(v_test);
end;
$$;

create or replace function public.update_test_questions(p_test_id uuid,p_title text,p_subject text,p_difficulty text,p_questions jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public
as $$
declare v_user_id uuid:=auth.uid(); v_test public.tests%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions)<1 or jsonb_array_length(p_questions)>50 then
    raise exception 'Invalid question payload';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item) where
      jsonb_typeof(q.item) is distinct from 'object' or nullif(btrim(q.item->>'topic'),'') is null
      or nullif(btrim(q.item->>'question'),'') is null or jsonb_typeof(q.item->'options') is distinct from 'array'
      or case when jsonb_typeof(q.item->'options')='array' then jsonb_array_length(q.item->'options')<>4 else true end
      or jsonb_typeof(q.item->'correctAnswerIndex') is distinct from 'number'
      or case when jsonb_typeof(q.item->'correctAnswerIndex')='number' then (q.item->>'correctAnswerIndex')::numeric not in (0,1,2,3) else true end
      or case when jsonb_typeof(q.item->'sourceChunkIds')='array' then jsonb_array_length(q.item->'sourceChunkIds')=0 else true end) then
    raise exception 'Invalid question payload';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item) where
      (select count(distinct lower(btrim(o.value))) from jsonb_array_elements_text(q.item->'options') o(value))<>4) then
    raise exception 'Question options must be distinct';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item)
      cross join lateral jsonb_array_elements(q.item->'options') o(value)
      where jsonb_typeof(o.value) is distinct from 'string') then
    raise exception 'Question options must be strings';
  end if;
  select * into v_test from public.tests t where t.id=p_test_id and t.user_id=v_user_id for update;
  if not found then raise exception 'Test not found'; end if;
  if v_test.status<>'draft' then raise exception 'Only draft tests can be edited'; end if;
  if jsonb_typeof(coalesce(v_test.generation_config,'{}'::jsonb)) is distinct from 'object'
     or v_test.generation_config->>'syllabusId' is distinct from v_test.syllabus_id::text
     or (v_test.generation_config ? 'includedTopics' and jsonb_typeof(v_test.generation_config->'includedTopics') is distinct from 'array')
     or (v_test.generation_config ? 'excludedTopics' and jsonb_typeof(v_test.generation_config->'excludedTopics') is distinct from 'array') then
    raise exception 'Saved test scope is invalid';
  end if;
  if not exists(select 1 from public.syllabi s where s.id=v_test.syllabus_id
      and s.user_id=v_user_id and s.status='ready') then
    raise exception 'Test syllabus not found or not ready';
  end if;
  if exists(select 1 from jsonb_array_elements(p_questions) q(item)
    cross join lateral jsonb_array_elements_text(coalesce(q.item->'sourceChunkIds','[]'::jsonb)) src(chunk_id)
    where v_test.syllabus_id is null or not exists(select 1 from public.syllabus_chunks c where c.id::text=src.chunk_id
      and c.syllabus_id=v_test.syllabus_id
      and (nullif(v_test.generation_config->>'unit','') is null or c.unit=v_test.generation_config->>'unit')
      and (nullif(v_test.generation_config->>'topic','') is null or c.topic=v_test.generation_config->>'topic')
      and (nullif(v_test.generation_config->>'subtopic','') is null or c.subtopic=v_test.generation_config->>'subtopic')
      and (jsonb_array_length(coalesce(v_test.generation_config->'includedTopics','[]'::jsonb))=0 or exists(
        select 1 from jsonb_array_elements_text(coalesce(v_test.generation_config->'includedTopics','[]'::jsonb)) i(value)
        where lower(btrim(i.value))=lower(btrim(coalesce(c.topic,'')))))
      and not exists(select 1 from jsonb_array_elements_text(coalesce(v_test.generation_config->'excludedTopics','[]'::jsonb)) e(value)
        where lower(btrim(e.value))=lower(btrim(coalesce(c.topic,''))))
      and c.metadata->>'embeddingProvider'='gemini')) then
    raise exception 'Source evidence is outside the saved syllabus scope';
  end if;
  update public.tests set title=p_title,subject=p_subject,difficulty=p_difficulty,question_count=jsonb_array_length(p_questions)
    where id=p_test_id and user_id=v_user_id and status='draft';
  delete from public.questions where test_id=p_test_id;
  insert into public.questions(test_id,topic,question,options,correct_answer_index,position,explanation,source_chunk_ids,
    grounding_status,validation_status,validation_metadata)
  select p_test_id,q.item->>'topic',q.item->>'question',q.item->'options',(q.item->>'correctAnswerIndex')::smallint,
    (q.ordinality-1)::integer,q.item->>'explanation',coalesce(q.item->'sourceChunkIds','[]'::jsonb),'needs_review',
    case when q.item->>'validationStatus' in ('unique','duplicate','not_applicable') then q.item->>'validationStatus' else 'not_applicable' end,
    coalesce(q.item->'validationMetadata','{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality q(item,ordinality);
end;
$$;

-- Shared database-side publish gate. Source IDs prove reference integrity only;
-- they do not prove that a question is semantically supported. Faculty
-- attestation is recorded separately and never upgrades grounding_status.
create or replace function public.assert_test_publishable(p_test_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public,pg_temp
as $$
declare v_test public.tests%rowtype; v_count integer;
begin
  select * into v_test from public.tests where id=p_test_id for update;
  if not found then raise exception 'Test not found'; end if;
  if v_test.syllabus_id is null
     or jsonb_typeof(coalesce(v_test.generation_config,'{}'::jsonb)) is distinct from 'object'
     or v_test.generation_config->>'syllabusId' is distinct from v_test.syllabus_id::text then
    raise exception 'Test has no valid syllabus scope';
  end if;
  if (v_test.generation_config ? 'includedTopics' and jsonb_typeof(v_test.generation_config->'includedTopics') is distinct from 'array')
     or (v_test.generation_config ? 'excludedTopics' and jsonb_typeof(v_test.generation_config->'excludedTopics') is distinct from 'array') then
    raise exception 'Test syllabus scope is malformed';
  end if;
  if not exists(select 1 from public.syllabi s where s.id=v_test.syllabus_id
      and s.user_id=v_test.user_id and s.status='ready') then
    raise exception 'Test syllabus is not owned, ready, or available';
  end if;
  select count(*) into v_count from public.questions q where q.test_id=p_test_id;
  if v_count<1 or v_count<>v_test.question_count then
    raise exception 'Published test question count is invalid';
  end if;
  if exists(select 1 from public.questions q where q.test_id=p_test_id and
      (nullif(btrim(q.topic),'') is null or nullif(btrim(q.question),'') is null
       or jsonb_typeof(q.options) is distinct from 'array'
       or case when jsonb_typeof(q.options)='array' then jsonb_array_length(q.options)<>4 else true end
       or q.correct_answer_index is null or q.correct_answer_index not between 0 and 3
       or nullif(btrim(q.explanation),'') is null
       or q.validation_status is distinct from 'unique')) then
    raise exception 'Published test contains questions that need review';
  end if;
  if exists(select 1 from public.questions q where q.test_id=p_test_id
      and exists(select 1 from jsonb_array_elements(q.options) o(value)
        where jsonb_typeof(o.value) is distinct from 'string')) then
    raise exception 'Published test options must all be strings';
  end if;
  if exists(select 1 from public.questions q where q.test_id=p_test_id and
      (select count(distinct lower(btrim(o.value))) from jsonb_array_elements_text(q.options) o(value))<>4) then
    raise exception 'Published test contains duplicate answer options';
  end if;
  if exists(select 1 from public.questions a join public.questions b on b.test_id=a.test_id and b.id>a.id
      where a.test_id=p_test_id and regexp_replace(lower(a.question),'[^[:alnum:]]+','','g')=
        regexp_replace(lower(b.question),'[^[:alnum:]]+','','g')) then
    raise exception 'Published test contains duplicate questions';
  end if;
  if exists(select 1 from public.questions q where q.test_id=p_test_id
      and (jsonb_typeof(q.source_chunk_ids) is distinct from 'array'
        or case when jsonb_typeof(q.source_chunk_ids)='array' then jsonb_array_length(q.source_chunk_ids)=0 else true end)) then
    raise exception 'Every question needs at least one syllabus source chunk before publication';
  end if;
  if exists(select 1 from public.questions q
      cross join lateral jsonb_array_elements_text(q.source_chunk_ids) src(chunk_id)
      where q.test_id=p_test_id and not exists(
        select 1 from public.syllabus_chunks c where c.id::text=src.chunk_id
          and c.syllabus_id=v_test.syllabus_id
          and (nullif(v_test.generation_config->>'unit','') is null or c.unit=v_test.generation_config->>'unit')
          and (nullif(v_test.generation_config->>'topic','') is null or c.topic=v_test.generation_config->>'topic')
          and (nullif(v_test.generation_config->>'subtopic','') is null or c.subtopic=v_test.generation_config->>'subtopic')
          and (jsonb_array_length(coalesce(v_test.generation_config->'includedTopics','[]'::jsonb))=0 or exists(
            select 1 from jsonb_array_elements_text(coalesce(v_test.generation_config->'includedTopics','[]'::jsonb)) i(value)
            where lower(btrim(i.value))=lower(btrim(coalesce(c.topic,'')))))
          and not exists(select 1 from jsonb_array_elements_text(coalesce(v_test.generation_config->'excludedTopics','[]'::jsonb)) e(value)
            where lower(btrim(e.value))=lower(btrim(coalesce(c.topic,''))))
          and c.metadata->>'embeddingProvider'='gemini')) then
    raise exception 'Question source evidence is missing, foreign, out of scope, or not Gemini-derived';
  end if;
end;
$$;

create or replace function public.attest_test_review(p_test_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_test public.tests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_test from public.tests where id=p_test_id and user_id=auth.uid() for update;
  if not found then raise exception 'Test not found'; end if;
  if v_test.status<>'draft' then raise exception 'Only draft tests can be reviewed'; end if;
  perform public.assert_test_publishable(p_test_id);
  update public.tests set reviewed_by=auth.uid(), reviewed_at=statement_timestamp()
    where id=p_test_id and user_id=auth.uid() and status='draft';
end;
$$;

-- This narrow definer trigger serializes question changes with publication and
-- invalidates a prior attestation. It can only clear review fields on a draft;
-- authenticated callers must own the test, while trusted service-role writes
-- are permitted and also clear the attestation.
create or replace function public.testgenie_question_write_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_test_id uuid; v_owner uuid; v_status text; v_uid uuid:=auth.uid();
begin
  if tg_op='UPDATE' and new.test_id is distinct from old.test_id then
    raise exception 'Questions cannot be moved between tests';
  end if;
  v_test_id:=case when tg_op='DELETE' then old.test_id else new.test_id end;
  if v_uid is null and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Authentication required';
  end if;
  select t.user_id,t.status into v_owner,v_status from public.tests t where t.id=v_test_id for update;
  if not found then
    if tg_op='DELETE' then return old; end if;
    raise exception 'Test not found';
  end if;
  if v_status<>'draft' then raise exception 'Only draft questions can be changed'; end if;
  if v_uid is not null and v_owner<>v_uid then raise exception 'Forbidden'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.testgenie_invalidate_test_review()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_test_id uuid; v_owner uuid; v_status text; v_uid uuid:=auth.uid();
begin
  v_test_id:=case when tg_op='DELETE' then old.test_id else new.test_id end;
  -- Parent-test ON DELETE CASCADE must not try to update the row being deleted.
  if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  select t.user_id,t.status into v_owner,v_status from public.tests t where t.id=v_test_id for update;
  if not found then
    if tg_op='DELETE' then return old; end if;
    raise exception 'Test not found';
  end if;
  if v_status<>'draft' then raise exception 'Only draft questions can be changed'; end if;
  if v_uid is not null and v_owner<>v_uid then raise exception 'Forbidden'; end if;
  update public.tests set reviewed_by=null,reviewed_at=null where id=v_test_id and status='draft';
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.prevent_published_test_changes()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp
as $$
begin
  if old.status='published' then
    if new.status is distinct from old.status or new.title is distinct from old.title
      or new.subject is distinct from old.subject or new.syllabus_text is distinct from old.syllabus_text
      or new.difficulty is distinct from old.difficulty or new.question_count is distinct from old.question_count
      or new.syllabus_id is distinct from old.syllabus_id or new.generation_config is distinct from old.generation_config
      or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at then
      raise exception 'Published test content is locked';
    end if;
    return new;
  end if;
  if new.status='published' and old.status is distinct from 'published' then
    if new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at
       or new.reviewed_by is distinct from auth.uid()
       or new.reviewed_at is null then raise exception 'Faculty review attestation is required'; end if;
    perform public.assert_test_publishable(old.id);
  end if;
  if old.status='draft' and new.status='draft' and (
       new.title is distinct from old.title or new.subject is distinct from old.subject
       or new.syllabus_text is distinct from old.syllabus_text or new.difficulty is distinct from old.difficulty
       or new.question_count is distinct from old.question_count or new.syllabus_id is distinct from old.syllabus_id
       or new.generation_config is distinct from old.generation_config) then
    new.reviewed_by:=null; new.reviewed_at:=null;
  end if;
  return new;
end;
$$;

create or replace function public.testgenie_guard_test_insert()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp
as $$
begin
  if new.status is distinct from 'draft' then raise exception 'Tests must be created as drafts'; end if;
  if auth.uid() is null and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Authentication required';
  end if;
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    raise exception 'Test owner must match the authenticated user';
  end if;
  if new.syllabus_id is null or jsonb_typeof(new.generation_config) is distinct from 'object'
     or new.generation_config->>'syllabusId' is distinct from new.syllabus_id::text
     or (new.generation_config ? 'includedTopics' and jsonb_typeof(new.generation_config->'includedTopics') is distinct from 'array')
     or (new.generation_config ? 'excludedTopics' and jsonb_typeof(new.generation_config->'excludedTopics') is distinct from 'array')
     or not exists(select 1 from public.syllabi s where s.id=new.syllabus_id
       and s.user_id=new.user_id and s.status='ready') then
    raise exception 'Test must reference its owner''s ready syllabus and matching generation scope';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_published_test_delete()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp
as $$
begin
  if old.status='published' then raise exception 'Published tests cannot be deleted'; end if;
  return old;
end;
$$;

create or replace function public.publish_test(p_test_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_test public.tests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_test from public.tests t where t.id=p_test_id and t.user_id=auth.uid() for update;
  if not found then raise exception 'Test not found'; end if;
  if v_test.status<>'draft' then raise exception 'Only drafts can be published'; end if;
  if v_test.reviewed_by is distinct from auth.uid() or v_test.reviewed_at is null then
    raise exception 'Faculty review attestation is required';
  end if;
  perform public.assert_test_publishable(p_test_id);
  update public.tests set status='published' where id=p_test_id and user_id=auth.uid() and status='draft';
end;
$$;

drop trigger if exists testgenie_validate_provenance on public.questions;
create trigger testgenie_validate_provenance before insert or update on public.questions
  for each row execute function public.validate_question_provenance();
drop trigger if exists testgenie_question_write_guard on public.questions;
create trigger testgenie_question_write_guard before insert or update or delete on public.questions
  for each row execute function public.testgenie_question_write_guard();
drop trigger if exists testgenie_invalidate_test_review on public.questions;
create trigger testgenie_invalidate_test_review after insert or update or delete on public.questions
  for each row execute function public.testgenie_invalidate_test_review();
drop trigger if exists testgenie_protect_published on public.tests;
create trigger testgenie_protect_published before update on public.tests
  for each row execute function public.prevent_published_test_changes();
drop trigger if exists testgenie_prevent_published_delete on public.tests;
create trigger testgenie_prevent_published_delete before delete on public.tests
  for each row execute function public.prevent_published_test_delete();
drop trigger if exists testgenie_guard_test_insert on public.tests;
create trigger testgenie_guard_test_insert before insert on public.tests
  for each row execute function public.testgenie_guard_test_insert();

alter table public.tests enable row level security;
alter table public.questions enable row level security;

-- Owner permissive policies provide app operations. Restrictive policies AND
-- owner/draft checks with every permissive policy.
drop policy if exists tg_tests_select_owner on public.tests;
create policy tg_tests_select_owner on public.tests as permissive for select to authenticated using(auth.uid()=user_id);
drop policy if exists tg_tests_insert_owner on public.tests;
create policy tg_tests_insert_owner on public.tests as permissive for insert to authenticated with check(auth.uid()=user_id and status='draft'
  and exists(select 1 from public.syllabi s where s.id=syllabus_id and s.user_id=auth.uid() and s.status='ready'
    and generation_config->>'syllabusId'=syllabus_id::text));
drop policy if exists tg_tests_update_owner on public.tests;
create policy tg_tests_update_owner on public.tests as permissive for update to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists tg_tests_delete_owner on public.tests;
create policy tg_tests_delete_owner on public.tests as permissive for delete to authenticated using(auth.uid()=user_id);
drop policy if exists tg_questions_select_owner on public.questions;
create policy tg_questions_select_owner on public.questions as permissive for select to authenticated
  using(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid()));
drop policy if exists tg_questions_insert_owner on public.questions;
create policy tg_questions_insert_owner on public.questions as permissive for insert to authenticated
  with check(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid()));
drop policy if exists tg_questions_update_owner on public.questions;
create policy tg_questions_update_owner on public.questions as permissive for update to authenticated
  using(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid()))
  with check(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid()));
drop policy if exists tg_questions_delete_owner on public.questions;
create policy tg_questions_delete_owner on public.questions as permissive for delete to authenticated
  using(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid()));

drop policy if exists tg_tests_select_restrict on public.tests;
create policy tg_tests_select_restrict on public.tests as restrictive for select to authenticated using(auth.uid()=user_id);
drop policy if exists tg_tests_insert_restrict on public.tests;
create policy tg_tests_insert_restrict on public.tests as restrictive for insert to authenticated with check(auth.uid()=user_id and status='draft'
  and exists(select 1 from public.syllabi s where s.id=syllabus_id and s.user_id=auth.uid() and s.status='ready'
    and generation_config->>'syllabusId'=syllabus_id::text));
drop policy if exists tg_tests_update_restrict on public.tests;
create policy tg_tests_update_restrict on public.tests as restrictive for update to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists tg_tests_delete_restrict on public.tests;
create policy tg_tests_delete_restrict on public.tests as restrictive for delete to authenticated using(auth.uid()=user_id and status='draft');
drop policy if exists tg_questions_select_restrict on public.questions;
create policy tg_questions_select_restrict on public.questions as restrictive for select to authenticated
  using(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid()));
drop policy if exists tg_questions_insert_restrict on public.questions;
create policy tg_questions_insert_restrict on public.questions as restrictive for insert to authenticated
  with check(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid() and t.status='draft'));
drop policy if exists tg_questions_update_restrict on public.questions;
create policy tg_questions_update_restrict on public.questions as restrictive for update to authenticated
  using(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid() and t.status='draft'))
  with check(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid() and t.status='draft'));
drop policy if exists tg_questions_delete_restrict on public.questions;
create policy tg_questions_delete_restrict on public.questions as restrictive for delete to authenticated
  using(exists(select 1 from public.tests t where t.id=test_id and t.user_id=auth.uid() and t.status='draft'));

-- Mark policies owned by this repair so a rerun refuses to replace unrelated
-- same-named policies and remains repeatable after a successful application.
do $policy_comments$
declare v_policy text; v_table text;
begin
  foreach v_policy in array array[
    'tg_tests_select_owner','tg_tests_insert_owner','tg_tests_update_owner','tg_tests_delete_owner',
    'tg_questions_select_owner','tg_questions_insert_owner','tg_questions_update_owner','tg_questions_delete_owner',
    'tg_tests_select_restrict','tg_tests_insert_restrict','tg_tests_update_restrict','tg_tests_delete_restrict',
    'tg_questions_select_restrict','tg_questions_insert_restrict','tg_questions_update_restrict','tg_questions_delete_restrict'
  ] loop
    v_table:=case when v_policy like 'tg_tests_%' then 'tests' else 'questions' end;
    execute format('comment on policy %I on public.%I is %L',v_policy,v_table,
      'TestGenie reconcile_test_workflow policy v2');
  end loop;
end;
$policy_comments$;

-- Remove browser ACLs, including column grants, then restore the app contract.
-- service_role grants are left unchanged and asserted above/below.
revoke all privileges on table public.tests,public.questions from public,anon,authenticated;
do $$
declare v_rel regclass; v_cols text;
begin
  foreach v_rel in array array['public.tests'::regclass,'public.questions'::regclass] loop
    select string_agg(format('%I',a.attname),',' order by a.attnum) into v_cols
      from pg_attribute a where a.attrelid=v_rel and a.attnum>0 and not a.attisdropped;
    if v_cols is null then raise exception 'Could not enumerate columns for %',v_rel; end if;
    execute format('revoke all privileges (%s) on table %s from public,anon,authenticated',v_cols,v_rel);
  end loop;
end;
$$;
grant select,delete on public.tests to authenticated;
grant insert(user_id,title,subject,syllabus_text,difficulty,question_count,status,syllabus_id,generation_config)
  on public.tests to authenticated;
grant update(title,subject,difficulty,question_count,google_form_id,google_form_url) on public.tests to authenticated;
grant select,delete on public.questions to authenticated;
grant insert(test_id,topic,question,options,correct_answer_index,position,explanation,source_chunk_ids,grounding_status,validation_status,validation_metadata)
  on public.questions to authenticated;
grant update(topic,question,options,correct_answer_index,explanation,source_chunk_ids,grounding_status,validation_status,validation_metadata)
  on public.questions to authenticated;

revoke all on function public.save_draft_test(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.save_draft_test(uuid,jsonb,jsonb) to authenticated;
revoke all on function public.update_test_questions(uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.update_test_questions(uuid,text,text,text,jsonb) to authenticated;
revoke all on function public.publish_test(uuid) from public,anon;
grant execute on function public.publish_test(uuid) to authenticated;
revoke all on function public.attest_test_review(uuid) from public,anon;
grant execute on function public.attest_test_review(uuid) to authenticated;
revoke all on function public.assert_test_publishable(uuid) from public,anon,authenticated;
revoke all on function public.testgenie_question_write_guard() from public,anon,authenticated;
revoke all on function public.testgenie_invalidate_test_review() from public,anon,authenticated;
revoke all on function public.validate_question_provenance() from public,anon,authenticated;
revoke all on function public.prevent_published_test_changes() from public,anon,authenticated;
revoke all on function public.prevent_published_test_delete() from public,anon,authenticated;
revoke all on function public.testgenie_guard_test_insert() from public,anon,authenticated;

do $postflight$
declare v_owner oid; v_role text; v_rel regclass; v_col text; v_priv text; v_allowed boolean; v_policy_count integer;
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='questions'
      and column_name='explanation' and data_type='text' and is_nullable='YES') then
    raise exception 'Postflight failed: nullable text questions.explanation is missing';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tests'
       and column_name='reviewed_by' and data_type='uuid' and is_nullable='YES')
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tests'
       and column_name='reviewed_at' and data_type='timestamp with time zone' and is_nullable='YES')
     or not exists(select 1 from pg_constraint where conrelid='public.tests'::regclass
       and conname='tests_reviewed_by_fkey' and contype='f' and confrelid='auth.users'::regclass and confdeltype='n') then
    raise exception 'Postflight failed: review-attestation columns or reviewer FK are missing';
  end if;
  if to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is null
     or to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is null
     or to_regprocedure('public.publish_test(uuid)') is null
     or to_regprocedure('public.validate_question_provenance()') is null
     or to_regprocedure('public.attest_test_review(uuid)') is null
     or to_regprocedure('public.assert_test_publishable(uuid)') is null
     or to_regprocedure('public.testgenie_question_write_guard()') is null
     or to_regprocedure('public.testgenie_invalidate_test_review()') is null
     or to_regprocedure('public.prevent_published_test_delete()') is null
     or to_regprocedure('public.testgenie_guard_test_insert()') is null then
    raise exception 'Postflight failed: required TestGenie functions are missing';
  end if;
  if (select proargnames is distinct from array['p_syllabus_id','p_generation_config','p_questions']::text[]
      from pg_proc where oid=to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)'))
     or (select proargnames is distinct from array['p_test_id','p_title','p_subject','p_difficulty','p_questions']::text[]
      from pg_proc where oid=to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)'))
     or (select proargnames is distinct from array['p_test_id']::text[]
      from pg_proc where oid=to_regprocedure('public.publish_test(uuid)'))
     or (select proargnames is distinct from array['p_test_id']::text[]
      from pg_proc where oid=to_regprocedure('public.attest_test_review(uuid)')) then
    raise exception 'Postflight failed: RPC argument names do not match the application';
  end if;
  if (select prosecdef from pg_proc where oid=to_regprocedure('public.publish_test(uuid)')) is not true
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.attest_test_review(uuid)')) is not true
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.testgenie_question_write_guard()')) is not true
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.testgenie_invalidate_test_review()')) is not true
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.prevent_published_test_delete()')) is not false
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.testgenie_guard_test_insert()')) is not false
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.assert_test_publishable(uuid)')) is not false
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.validate_question_provenance()')) is not false
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.prevent_published_test_changes()')) is not false
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)')) is not false
     or (select prosecdef from pg_proc where oid=to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)')) is not false then
    raise exception 'Postflight failed: function security modes are incorrect';
  end if;
  if not has_function_privilege('authenticated','public.save_draft_test(uuid,jsonb,jsonb)','EXECUTE')
     or not has_function_privilege('authenticated','public.update_test_questions(uuid,text,text,text,jsonb)','EXECUTE')
     or not has_function_privilege('authenticated','public.publish_test(uuid)','EXECUTE')
     or not has_function_privilege('authenticated','public.attest_test_review(uuid)','EXECUTE')
     or has_function_privilege('anon','public.save_draft_test(uuid,jsonb,jsonb)','EXECUTE')
     or has_function_privilege('anon','public.update_test_questions(uuid,text,text,text,jsonb)','EXECUTE')
     or has_function_privilege('anon','public.publish_test(uuid)','EXECUTE')
     or has_function_privilege('anon','public.attest_test_review(uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.assert_test_publishable(uuid)','EXECUTE')
     or has_function_privilege('anon','public.assert_test_publishable(uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.validate_question_provenance()','EXECUTE')
     or has_function_privilege('authenticated','public.testgenie_question_write_guard()','EXECUTE')
     or has_function_privilege('authenticated','public.testgenie_invalidate_test_review()','EXECUTE')
     or has_function_privilege('authenticated','public.prevent_published_test_changes()','EXECUTE')
     or has_function_privilege('authenticated','public.prevent_published_test_delete()','EXECUTE')
     or has_function_privilege('authenticated','public.testgenie_guard_test_insert()','EXECUTE') then
    raise exception 'Postflight failed: RPC privileges are incorrect';
  end if;
  if not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.publish_test(uuid)') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') and s.setting='search_path=pg_catalog, public')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') and s.setting='search_path=pg_catalog, public') then
    raise exception 'Postflight failed: fixed function search_path is missing';
  end if;
  if not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.validate_question_provenance()') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.prevent_published_test_changes()') and s.setting='search_path=pg_catalog, public, pg_temp') then
    raise exception 'Postflight failed: trigger function search_path is missing';
  end if;
  if not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.attest_test_review(uuid)') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.testgenie_question_write_guard()') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.testgenie_invalidate_test_review()') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.prevent_published_test_delete()') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.testgenie_guard_test_insert()') and s.setting='search_path=pg_catalog, public, pg_temp')
     or not exists(select 1 from pg_proc p, unnest(p.proconfig) s(setting)
      where p.oid=to_regprocedure('public.assert_test_publishable(uuid)') and s.setting='search_path=pg_catalog, public, pg_temp') then
    raise exception 'Postflight failed: review/publish helper search_path is missing';
  end if;
  if has_table_privilege('anon','public.tests','SELECT') or has_table_privilege('anon','public.tests','INSERT')
     or has_table_privilege('anon','public.tests','UPDATE') or has_table_privilege('anon','public.tests','DELETE')
     or has_table_privilege('anon','public.questions','SELECT') or has_table_privilege('anon','public.questions','INSERT')
     or has_table_privilege('anon','public.questions','UPDATE') or has_table_privilege('anon','public.questions','DELETE') then
    raise exception 'Postflight failed: anon retains test/question access';
  end if;
  if not has_table_privilege('authenticated','public.tests','SELECT')
     or not has_table_privilege('authenticated','public.tests','DELETE')
     or not has_column_privilege('authenticated','public.tests','status','INSERT')
     or has_column_privilege('authenticated','public.tests','status','UPDATE')
     or not has_column_privilege('authenticated','public.tests','google_form_url','UPDATE')
     or not has_table_privilege('authenticated','public.questions','SELECT')
     or not has_table_privilege('authenticated','public.questions','DELETE')
     or not has_column_privilege('authenticated','public.questions','source_chunk_ids','INSERT')
     or not has_column_privilege('authenticated','public.questions','explanation','UPDATE') then
    raise exception 'Postflight failed: authenticated grants are incomplete or too broad';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.tests'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.questions'::regclass) then
    raise exception 'Postflight failed: tests/questions RLS is disabled';
  end if;
  if exists(select 1 from pg_class where oid in ('public.tests'::regclass,'public.questions'::regclass)
       and relforcerowsecurity)
     and exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
       where p.oid in (to_regprocedure('public.publish_test(uuid)'),to_regprocedure('public.attest_test_review(uuid)'),
         to_regprocedure('public.testgenie_question_write_guard()'),to_regprocedure('public.testgenie_invalidate_test_review()'))
         and not (r.rolsuper or r.rolbypassrls)) then
    raise exception 'Postflight failed: FORCE RLS would prevent a definer function from enforcing the workflow';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.questions'::regclass and tgname='testgenie_validate_provenance'
       and tgfoid=to_regprocedure('public.validate_question_provenance()')::oid and tgenabled<>'D')
     or not exists(select 1 from pg_trigger where tgrelid='public.questions'::regclass and tgname='testgenie_question_write_guard'
       and tgfoid=to_regprocedure('public.testgenie_question_write_guard()')::oid and tgenabled<>'D')
     or not exists(select 1 from pg_trigger where tgrelid='public.questions'::regclass and tgname='testgenie_invalidate_test_review'
       and tgfoid=to_regprocedure('public.testgenie_invalidate_test_review()')::oid and tgenabled<>'D')
     or not exists(select 1 from pg_trigger where tgrelid='public.tests'::regclass and tgname='testgenie_protect_published'
       and tgfoid=to_regprocedure('public.prevent_published_test_changes()')::oid and tgenabled<>'D')
     or not exists(select 1 from pg_trigger where tgrelid='public.tests'::regclass and tgname='testgenie_prevent_published_delete'
       and tgfoid=to_regprocedure('public.prevent_published_test_delete()')::oid and tgenabled<>'D')
     or not exists(select 1 from pg_trigger where tgrelid='public.tests'::regclass and tgname='testgenie_guard_test_insert'
       and tgfoid=to_regprocedure('public.testgenie_guard_test_insert()')::oid and tgenabled<>'D') then
    raise exception 'Postflight failed: required provenance/review/publication trigger is missing or disabled';
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='tests' and policyname='tg_tests_insert_restrict' and permissive='RESTRICTIVE' and cmd='INSERT')
     or not exists(select 1 from pg_policies where schemaname='public' and tablename='tests' and policyname='tg_tests_delete_restrict' and permissive='RESTRICTIVE' and cmd='DELETE')
     or not exists(select 1 from pg_policies where schemaname='public' and tablename='tests' and policyname='tg_tests_insert_restrict'
       and coalesce(with_check,'') like '%auth.uid%' and coalesce(with_check,'') like '%user_id%' and coalesce(with_check,'') like '%draft%'
       and coalesce(with_check,'') like '%syllabi%' and coalesce(with_check,'') like '%ready%')
     or not exists(select 1 from pg_policies where schemaname='public' and tablename='questions' and policyname='tg_questions_update_restrict' and permissive='RESTRICTIVE' and cmd='UPDATE')
     or not exists(select 1 from pg_policies where schemaname='public' and tablename='questions' and policyname='tg_questions_delete_restrict' and permissive='RESTRICTIVE' and cmd='DELETE') then
    raise exception 'Postflight failed: owner/draft restrictive policies are missing';
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='questions'
      and policyname='tg_questions_update_restrict' and coalesce(qual,'') like '%auth.uid%'
      and coalesce(qual,'') like '%draft%' and coalesce(with_check,'') like '%draft%')
     or not exists(select 1 from pg_policies where schemaname='public' and tablename='tests'
      and policyname='tg_tests_delete_restrict' and coalesce(qual,'') like '%auth.uid%'
      and coalesce(qual,'') like '%draft%') then
    raise exception 'Postflight failed: restrictive policy expressions are not owner/draft scoped';
  end if;
  if exists(select 1 from pg_policy p join pg_class c on c.oid=p.polrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_description d on d.classoid='pg_policy'::regclass and d.objoid=p.oid and d.objsubid=0
      where n.nspname='public' and c.relname in ('tests','questions')
        and p.polname like 'tg\_%' escape '\'
        and coalesce(d.description,'')<>'TestGenie reconcile_test_workflow policy v2') then
    raise exception 'Postflight failed: an unowned tg_* policy remains';
  end if;
  select count(*) into v_policy_count from pg_policy p join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_description d on d.classoid='pg_policy'::regclass and d.objoid=p.oid and d.objsubid=0
    where n.nspname='public' and c.relname in ('tests','questions')
      and p.polname=any(array['tg_tests_select_owner','tg_tests_insert_owner','tg_tests_update_owner','tg_tests_delete_owner',
        'tg_questions_select_owner','tg_questions_insert_owner','tg_questions_update_owner','tg_questions_delete_owner',
        'tg_tests_select_restrict','tg_tests_insert_restrict','tg_tests_update_restrict','tg_tests_delete_restrict',
        'tg_questions_select_restrict','tg_questions_insert_restrict','tg_questions_update_restrict','tg_questions_delete_restrict'])
      and d.description='TestGenie reconcile_test_workflow policy v2';
  if v_policy_count<>16 then raise exception 'Postflight failed: one or more owned RLS policies are missing'; end if;
  -- Check effective table and column ACLs, including PUBLIC grants and role
  -- memberships. Authenticated gets only the explicit app columns below.
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_rel in array array['public.tests'::regclass,'public.questions'::regclass] loop
      foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        if has_table_privilege(v_role,v_rel,v_priv) then
          if v_role='anon' or v_priv not in ('SELECT','DELETE') then
            raise exception 'Postflight failed: unexpected effective table privilege % on % for %',v_priv,v_rel,v_role;
          end if;
        end if;
      end loop;
      for v_col in select a.attname::text from pg_attribute a
        where a.attrelid=v_rel and a.attnum>0 and not a.attisdropped loop
        foreach v_priv in array array['INSERT','UPDATE','REFERENCES'] loop
          if has_column_privilege(v_role,v_rel,v_col,v_priv) then
            v_allowed := v_role='authenticated' and v_priv='INSERT' and (
              (v_rel='public.tests'::regclass and v_col=any(array['user_id','title','subject','syllabus_text','difficulty','question_count','status','syllabus_id','generation_config']))
              or (v_rel='public.questions'::regclass and v_col=any(array['test_id','topic','question','options','correct_answer_index','position','explanation','source_chunk_ids','grounding_status','validation_status','validation_metadata']))
            );
            if v_role='authenticated' and v_priv='UPDATE' then
              v_allowed := (v_rel='public.tests'::regclass and v_col=any(array['title','subject','difficulty','question_count','google_form_id','google_form_url']))
                or (v_rel='public.questions'::regclass and v_col=any(array['topic','question','options','correct_answer_index','explanation','source_chunk_ids','grounding_status','validation_status','validation_metadata']));
            end if;
            if not v_allowed then
              raise exception 'Postflight failed: unexpected effective column privilege % on %.% for %',v_priv,v_rel,v_col,v_role;
            end if;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  select proowner into v_owner from pg_proc where oid=to_regprocedure('public.publish_test(uuid)');
  if not (select rolsuper or rolbypassrls or exists(select 1 from pg_class c where c.oid='public.tests'::regclass and c.relowner=r.oid)
          from pg_roles r where r.oid=v_owner)
     or not has_column_privilege(v_owner,'public.tests','status','UPDATE')
     or not has_column_privilege(v_owner,'public.tests','reviewed_by','UPDATE')
     or not has_column_privilege(v_owner,'public.tests','reviewed_at','UPDATE')
     or not has_table_privilege(v_owner,'public.questions','SELECT') then
    raise exception 'Postflight failed: publish_test owner is not trusted or cannot update status';
  end if;
  if exists(select 1 from pg_proc p where p.oid in (to_regprocedure('public.publish_test(uuid)'),
      to_regprocedure('public.attest_test_review(uuid)'),to_regprocedure('public.testgenie_question_write_guard()'),
      to_regprocedure('public.testgenie_invalidate_test_review()'))
      and not exists(select 1 from pg_roles r where r.oid=p.proowner and
        (r.rolsuper or r.rolbypassrls or exists(select 1 from pg_class c where c.oid='public.tests'::regclass and c.relowner=r.oid))
        and has_column_privilege(p.proowner,'public.tests','reviewed_by','UPDATE')
        and has_column_privilege(p.proowner,'public.tests','reviewed_at','UPDATE'))) then
    raise exception 'Postflight failed: a SECURITY DEFINER owner is not trusted';
  end if;
  if not has_table_privilege('service_role','public.tests','SELECT')
     or not has_table_privilege('service_role','public.tests','INSERT')
     or not has_table_privilege('service_role','public.tests','UPDATE')
     or not has_table_privilege('service_role','public.questions','SELECT')
     or not has_table_privilege('service_role','public.questions','INSERT')
     or not has_table_privilege('service_role','public.questions','UPDATE') then
    raise exception 'Postflight failed: service_role privileges changed or are incomplete';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege(v_role,'public.google_credentials',v_priv) then
        raise exception 'Postflight failed: OAuth table privilege % reappeared for %',v_priv,v_role;
      end if;
    end loop;
    for v_col in select a.attname::text from pg_attribute a
      where a.attrelid='public.google_credentials'::regclass and a.attnum>0 and not a.attisdropped loop
      foreach v_priv in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        if has_column_privilege(v_role,'public.google_credentials',v_col,v_priv) then
          raise exception 'Postflight failed: OAuth column privilege % on % reappeared for %',v_priv,v_col,v_role;
        end if;
      end loop;
    end loop;
  end loop;
  if not has_table_privilege('service_role','public.google_credentials','SELECT')
     or not has_table_privilege('service_role','public.google_credentials','INSERT')
     or not has_table_privilege('service_role','public.google_credentials','UPDATE') then
    raise exception 'Postflight failed: server-side OAuth credential access was not preserved';
  end if;
end;
$postflight$;

commit;

