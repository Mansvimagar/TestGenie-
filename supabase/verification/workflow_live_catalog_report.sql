-- TestGenie live workflow catalog report. READ ONLY; one result row.
-- Confirm the Supabase Dashboard project reference before running this file.
-- The report includes catalog metadata and aggregate-only compatibility counts.
-- It never returns application row values, OAuth credentials, tokens, secrets,
-- embeddings, or function bodies. No migration state is inferred from a missing
-- ledger candidate. It does not prove runtime behavior or authorize a repair.

with
expected_relations(schema_name,relation_name) as (
  values ('public','tests'),('public','questions'),('public','syllabi'),
         ('public','syllabus_chunks'),('public','scores'),
         ('public','google_credentials'),('public','google_form_creation_attempts'),
         ('auth','users')
),
relevant_relations as (
  select n.nspname as schema_name,c.relname as relation_name,c.oid,c.relkind,
         c.relowner,c.relrowsecurity,c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where (n.nspname='public' and c.relname in
         ('tests','questions','syllabi','syllabus_chunks','scores',
          'google_credentials','google_form_creation_attempts'))
     or (n.nspname='auth' and c.relname='users')
),
ledger_relations as (
  select c.oid,n.nspname as schema_name,c.relname as relation_name,c.relkind,
         c.relowner,c.relrowsecurity,c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p','v','m')
    and (c.relname ~* '(migration|schema_version)'
         or n.nspname ~* 'migration')
),
workflow_functions as (
  select p.*,n.nspname as schema_name
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in (
    'match_syllabus_chunks','save_draft_test','update_test_questions',
    'replace_test_question','attest_test_review','assert_test_publishable',
    'publish_test','validate_question_provenance',
    'testgenie_question_write_guard','testgenie_invalidate_test_review',
    'prevent_published_test_changes','prevent_published_test_delete',
    'testgenie_guard_test_insert','set_updated_at',
    'claim_google_form_creation','record_google_form_creation_form',
    'release_google_form_creation'
  )
),
expected_columns(schema_name,table_name,column_name,expected_type,requirement) as (
  values ('public','questions','explanation','text','nullable question explanation'),
         ('public','questions','source_chunk_ids','jsonb','syllabus provenance'),
         ('public','questions','grounding_status','text','grounding review state'),
         ('public','questions','validation_status','text','question validation state'),
         ('public','questions','validation_metadata','jsonb','validation metadata'),
         ('public','tests','reviewed_by','uuid','nullable faculty reviewer'),
         ('public','tests','reviewed_at','timestamp with time zone','nullable review timestamp'),
         ('public','scores','google_response_id','text','nullable Google response idempotency key')
),
expected_rpc_names(function_name) as (
  values ('save_draft_test'),('update_test_questions'),('replace_test_question'),
         ('attest_test_review'),('assert_test_publishable'),('publish_test')
),
data_counts as (
  select
    (select jsonb_build_object(
       'test_rows',count(*),
       'unexpected_status_rows',count(*) filter
         (where status is distinct from 'draft' and status is distinct from 'published'),
       'invalid_generation_scope_rows',count(*) filter
         (where jsonb_typeof(to_jsonb(t)->'generation_config') is distinct from 'object'
           or to_jsonb(t)->'generation_config'->>'syllabusId'
                is distinct from to_jsonb(t)->>'syllabus_id'
           or (to_jsonb(t)->'generation_config' ? 'includedTopics'
               and jsonb_typeof(to_jsonb(t)->'generation_config'->'includedTopics') is distinct from 'array')
           or (to_jsonb(t)->'generation_config' ? 'excludedTopics'
               and jsonb_typeof(to_jsonb(t)->'generation_config'->'excludedTopics') is distinct from 'array')),
       'tests_with_missing_or_unready_owned_syllabus',count(*) filter
         (where t.syllabus_id is null or not exists (
           select 1 from public.syllabi s where s.id=t.syllabus_id
             and s.user_id=t.user_id and s.status='ready'))
     ) from public.tests t) as tests,
    (select jsonb_build_object(
       'question_rows',count(*),
       'rows_with_null_or_missing_explanation',count(*) filter
         (where not (to_jsonb(q) ? 'explanation')
            or to_jsonb(q)->'explanation'='null'::jsonb
            or nullif(btrim(to_jsonb(q)->>'explanation'),'') is null),
       'rows_with_missing_or_empty_source_ids',count(*) filter
         (where not (to_jsonb(q) ? 'source_chunk_ids')
            or jsonb_typeof(to_jsonb(q)->'source_chunk_ids') is distinct from 'array'
            or jsonb_array_length(case
                 when jsonb_typeof(to_jsonb(q)->'source_chunk_ids')='array'
                   then to_jsonb(q)->'source_chunk_ids' else '[]'::jsonb end)=0),
       'rows_with_missing_provenance_metadata',count(*) filter
         (where not (to_jsonb(q) ? 'grounding_status')
            or not (to_jsonb(q) ? 'validation_status')
            or not (to_jsonb(q) ? 'validation_metadata'))
     ) from public.questions q) as questions,
    (select jsonb_build_object(
       'score_rows',count(*),
       'duplicate_nonnull_test_response_key_groups',(
         select count(*) from (
           select to_jsonb(s)->>'test_id',to_jsonb(s)->>'google_response_id'
           from public.scores s
           where to_jsonb(s) ? 'google_response_id'
             and nullif(to_jsonb(s)->>'google_response_id','') is not null
           group by to_jsonb(s)->>'test_id',to_jsonb(s)->>'google_response_id'
           having count(*)>1
         ) d
       ),
       'largest_duplicate_group',coalesce((
         select max(duplicate_count) from (
           select count(*) as duplicate_count
           from public.scores s
           where to_jsonb(s) ? 'google_response_id'
             and nullif(to_jsonb(s)->>'google_response_id','') is not null
           group by to_jsonb(s)->>'test_id',to_jsonb(s)->>'google_response_id'
           having count(*)>1
         ) d
       ),0)
     ) from public.scores) as scores,
    (select jsonb_build_object(
       'rows_with_reviewer_value',count(*) filter
         (where to_jsonb(t) ? 'reviewed_by'
            and nullif(to_jsonb(t)->>'reviewed_by','') is not null),
       'orphan_reviewer_rows',count(*) filter
         (where to_jsonb(t) ? 'reviewed_by'
            and nullif(to_jsonb(t)->>'reviewed_by','') is not null and u.id is null)
     ) from public.tests t
       left join auth.users u on u.id::text=to_jsonb(t)->>'reviewed_by') as reviewers,
    (with refs as (
       select t.syllabus_id,t.generation_config,src.chunk_id
       from public.tests t join public.questions q on q.test_id=t.id
       cross join lateral jsonb_array_elements_text(case
         when jsonb_typeof(to_jsonb(q)->'source_chunk_ids')='array'
           then to_jsonb(q)->'source_chunk_ids' else '[]'::jsonb end) src(chunk_id)
     ), invalid as (
       select r.chunk_id from refs r
       where not exists (
         select 1 from public.syllabus_chunks c
         where c.id::text=r.chunk_id and c.syllabus_id=r.syllabus_id
           and c.metadata->>'embeddingProvider'='gemini'
           and (nullif(r.generation_config->>'unit','') is null or c.unit=r.generation_config->>'unit')
           and (nullif(r.generation_config->>'topic','') is null or c.topic=r.generation_config->>'topic')
           and (nullif(r.generation_config->>'subtopic','') is null or c.subtopic=r.generation_config->>'subtopic')
           and (jsonb_array_length(case when jsonb_typeof(r.generation_config->'includedTopics')='array'
                    then r.generation_config->'includedTopics' else '[]'::jsonb end)=0
             or exists(select 1 from jsonb_array_elements_text(case
                    when jsonb_typeof(r.generation_config->'includedTopics')='array'
                      then r.generation_config->'includedTopics' else '[]'::jsonb end) i(value)
               where lower(btrim(i.value))=lower(btrim(coalesce(c.topic,'')))))
           and not exists(select 1 from jsonb_array_elements_text(case
                  when jsonb_typeof(r.generation_config->'excludedTopics')='array'
                    then r.generation_config->'excludedTopics' else '[]'::jsonb end) e(value)
             where lower(btrim(e.value))=lower(btrim(coalesce(c.topic,''))))
       )
     ) select jsonb_build_object(
       'source_references_outside_syllabus_scope_or_not_gemini',count(*)
     ) from invalid) as provenance
),
report as (
  select jsonb_build_object(
    'identity',jsonb_build_object(
      'database',current_database(),'session_role',current_user,
      'login_role',session_user,'server_version',current_setting('server_version'),
      'server_version_num',current_setting('server_version_num')::integer,
      'server_address',inet_server_addr(),'server_port',inet_server_port(),
      'project_ref_if_exposed',current_setting('app.settings.project_ref',true),
      'search_path',current_setting('search_path'),
      'project_ref_warning','Verify the Dashboard URL independently; local config and SQL settings do not establish intended project identity.'
    ),
    'migration_ledger_candidates',coalesce((
      select jsonb_agg(jsonb_build_object(
        'schema',l.schema_name,'relation',l.relation_name,'kind',l.relkind,
        'owner',pg_get_userbyid(l.relowner),'rls',l.relrowsecurity,'force_rls',l.relforcerowsecurity,
        'columns',coalesce((select jsonb_agg(jsonb_build_object(
          'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
          'nullable',not a.attnotnull
        ) order by a.attnum)
          from pg_attribute a
          where a.attrelid=l.oid and a.attnum>0 and not a.attisdropped),'[]'::jsonb)
      ) order by l.schema_name,l.relation_name) from ledger_relations l
    ),'[]'::jsonb),
    'ledger_warning','No candidate found is not evidence that migrations were never applied; confirm the project migration history through its authoritative ledger/tooling.',
    'relations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'schema',e.schema_name,'name',e.relation_name,
        'state',case when r.oid is null then 'MISSING' else 'present' end,
        'kind',r.relkind,'owner',case when r.oid is null then null else pg_get_userbyid(r.relowner) end,
        'rls',r.relrowsecurity,'force_rls',r.relforcerowsecurity
      ) order by e.schema_name,e.relation_name)
      from expected_relations e left join relevant_relations r
        on r.schema_name=e.schema_name and r.relation_name=e.relation_name
    ),'[]'::jsonb),
    'columns',coalesce((
      select jsonb_agg(jsonb_build_object(
        'schema',r.schema_name,'table',r.relation_name,'name',a.attname,
        'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,
        'default',case when r.relation_name='google_credentials' then null
          else pg_get_expr(ad.adbin,ad.adrelid) end,
        'identity',a.attidentity,'generated',a.attgenerated
      ) order by r.schema_name,r.relation_name,a.attnum)
      from relevant_relations r join pg_attribute a on a.attrelid=r.oid
        and a.attnum>0 and not a.attisdropped
      left join pg_attrdef ad on ad.adrelid=r.oid and ad.adnum=a.attnum
    ),'[]'::jsonb),
    'required_workflow_columns',(
      select jsonb_agg(jsonb_build_object(
        'schema',e.schema_name,'table',e.table_name,'column',e.column_name,
        'expected_type',e.expected_type,'requirement',e.requirement,
        'present',a.attname is not null,
        'actual_type',case when a.attname is null then null else format_type(a.atttypid,a.atttypmod) end,
        'nullable',case when a.attname is null then null else not a.attnotnull end
      ) order by e.schema_name,e.table_name,e.column_name)
      from expected_columns e left join pg_namespace n on n.nspname=e.schema_name
      left join pg_class c on c.relnamespace=n.oid and c.relname=e.table_name
      left join pg_attribute a on a.attrelid=c.oid and a.attname=e.column_name
        and a.attnum>0 and not a.attisdropped
    ),
    'constraints_and_foreign_keys',coalesce((
      select jsonb_agg(jsonb_build_object(
        'schema',n.nspname,'table',r.relname,'name',c.conname,'type',c.contype,
        'validated',c.convalidated,'deferrable',c.condeferrable,'initially_deferred',c.condeferred,
        'definition',pg_get_constraintdef(c.oid,true),
        'fk_mapping',case when c.contype='f' then (
          select string_agg(format('%I -> %I.%I.%I',src.attname,rn.nspname,rr.relname,dst.attname),', ' order by k.ord)
          from unnest(c.conkey,c.confkey) with ordinality k(src_attnum,dst_attnum,ord)
          join pg_attribute src on src.attrelid=c.conrelid and src.attnum=k.src_attnum
          join pg_attribute dst on dst.attrelid=c.confrelid and dst.attnum=k.dst_attnum
          join pg_class rr on rr.oid=c.confrelid join pg_namespace rn on rn.oid=rr.relnamespace
        ) end
      ) order by n.nspname,r.relname,c.conname)
      from pg_constraint c join pg_class r on r.oid=c.conrelid
      join pg_namespace n on n.oid=r.relnamespace
      where (n.nspname='public' and r.relname in
        ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts'))
        or (n.nspname='auth' and r.relname='users')
    ),'[]'::jsonb),
    'indexes',coalesce((
      select jsonb_agg(jsonb_build_object(
        'schema',n.nspname,'table',t.relname,'name',i.relname,
        'unique',x.indisunique,'primary',x.indisprimary,'valid',x.indisvalid,'ready',x.indisready,
        'definition',pg_get_indexdef(i.oid)
      ) order by n.nspname,t.relname,i.relname)
      from pg_index x join pg_class t on t.oid=x.indrelid
      join pg_namespace n on n.oid=t.relnamespace join pg_class i on i.oid=x.indexrelid
      where (n.nspname='public' and (t.relname in ('tests','questions','scores')
        or t.relname ~* '(score|submission|response|grade)'))
    ),'[]'::jsonb),
    'score_response_unique_index',jsonb_build_object(
      'name','scores_test_google_response_id_uidx',
      'present',exists(select 1 from pg_class i join pg_namespace ni on ni.oid=i.relnamespace
        where ni.nspname='public' and i.relname='scores_test_google_response_id_uidx'
          and i.relkind='i'),
      'definition',(select pg_get_indexdef(i.oid) from pg_class i
        join pg_namespace ni on ni.oid=i.relnamespace
        where ni.nspname='public' and i.relname='scores_test_google_response_id_uidx'
          and i.relkind='i' limit 1)
    ),
    'data_compatibility_aggregates',jsonb_build_object(
      'tests',data_counts.tests,'questions',data_counts.questions,
      'scores',data_counts.scores,'reviewers',data_counts.reviewers,
      'question_provenance',data_counts.provenance,
      'warning','Counts are aggregate-only. These checks scan the expected public.tests/questions/scores and syllabus tables; if an expected relation is absent or inaccessible, this report may stop before returning. No row identifiers or values are returned.'
    ),
    'rpc_catalog',coalesce((
      select jsonb_agg(jsonb_build_object(
        'name',p.proname,'schema',p.schema_name,'signature',p.oid::regprocedure::text,
        'identity_arguments',pg_get_function_identity_arguments(p.oid),
        'argument_and_output_names',p.proargnames,'argument_modes',p.proargmodes,
        'return_type',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),
        'security_mode',case when p.prosecdef then 'DEFINER' else 'INVOKER' end,
        'fixed_settings',p.proconfig,'acl',p.proacl,
        'execute',jsonb_build_object(
          'anon',case when exists(select 1 from pg_roles where rolname='anon')
            then has_function_privilege('anon',p.oid,'EXECUTE') end,
          'authenticated',case when exists(select 1 from pg_roles where rolname='authenticated')
            then has_function_privilege('authenticated',p.oid,'EXECUTE') end,
          'service_role',case when exists(select 1 from pg_roles where rolname='service_role')
            then has_function_privilege('service_role',p.oid,'EXECUTE') end,
          'report_session',has_function_privilege(current_user,p.oid,'EXECUTE'))
      ) order by p.proname,pg_get_function_identity_arguments(p.oid))
      from workflow_functions p
    ),'[]'::jsonb),
    'expected_workflow_rpc_names',(
      select jsonb_agg(jsonb_build_object(
        'name',e.function_name,
        'present',exists(select 1 from workflow_functions p where p.proname=e.function_name),
        'signatures',coalesce((select jsonb_agg(p.oid::regprocedure::text
          order by pg_get_function_identity_arguments(p.oid))
          from workflow_functions p where p.proname=e.function_name),'[]'::jsonb)
      ) order by e.function_name)
      from expected_rpc_names e
    ),
    'dependencies',coalesce((
      select jsonb_agg(jsonb_build_object(
        'function',p.oid::regprocedure::text,
        'referenced_object',pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid),
        'dependency_type',d.deptype
      ) order by p.proname,pg_get_function_identity_arguments(p.oid),
           pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid))
      from workflow_functions p join pg_depend d
        on d.classid='pg_proc'::regclass and d.objid=p.oid
    ),'[]'::jsonb),
    'rls_and_policies',jsonb_build_object(
      'relations',coalesce((select jsonb_agg(jsonb_build_object(
        'schema',schema_name,'table',relation_name,'rls',relrowsecurity,'force_rls',relforcerowsecurity
      ) order by schema_name,relation_name) from relevant_relations),'[]'::jsonb),
      'policies',coalesce((select jsonb_agg(jsonb_build_object(
        'schema',schemaname,'table',tablename,'name',policyname,'mode',permissive,
        'roles',roles,'command',cmd,'using',qual,'with_check',with_check
      ) order by schemaname,tablename,policyname) from pg_policies
        where (schemaname='public' and tablename in
          ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts'))
           or (schemaname='auth' and tablename='users')),'[]'::jsonb)
    ),
    'triggers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'schema',n.nspname,'table',c.relname,'name',t.tgname,'enabled',t.tgenabled,
        'function',p.oid::regprocedure::text,'definition',pg_get_triggerdef(t.oid,true)
      ) order by n.nspname,c.relname,t.tgname)
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      join pg_proc p on p.oid=t.tgfoid
      where not t.tgisinternal and
        ((n.nspname='public' and c.relname in
          ('tests','questions','syllabi','syllabus_chunks','scores','google_credentials','google_form_creation_attempts'))
         or (n.nspname='auth' and c.relname='users'))
    ),'[]'::jsonb),
    'role_memberships',coalesce((
      select jsonb_agg(jsonb_build_object(
        'member',m.rolname,'granted_role',p.rolname,'admin_option',am.admin_option
      ) order by m.rolname,p.rolname)
      from pg_auth_members am join pg_roles m on m.oid=am.member
      join pg_roles p on p.oid=am.roleid
    ),'[]'::jsonb),
    'privileges',jsonb_build_object(
      'tables',coalesce((
        select jsonb_agg(jsonb_build_object(
          'role',r.rolname,'superuser',r.rolsuper,'bypass_rls',r.rolbypassrls,
          'schema',rel.schema_name,'table',rel.relation_name,
          'select',has_table_privilege(r.rolname,rel.oid,'SELECT'),
          'insert',has_table_privilege(r.rolname,rel.oid,'INSERT'),
          'update',has_table_privilege(r.rolname,rel.oid,'UPDATE'),
          'delete',has_table_privilege(r.rolname,rel.oid,'DELETE'),
          'truncate',has_table_privilege(r.rolname,rel.oid,'TRUNCATE'),
          'references',has_table_privilege(r.rolname,rel.oid,'REFERENCES'),
          'trigger',has_table_privilege(r.rolname,rel.oid,'TRIGGER'),
          'maintain',case when current_setting('server_version_num')::integer>=170000
            then has_table_privilege(r.rolname,rel.oid,'MAINTAIN') end
        ) order by rel.schema_name,rel.relation_name,r.rolname)
        from relevant_relations rel cross join pg_roles r
      ),'[]'::jsonb),
      'columns',coalesce((
        select jsonb_agg(jsonb_build_object(
          'schema',rel.schema_name,'table',rel.relation_name,'column',a.attname,'role',r.rolname,
          'select',has_column_privilege(r.rolname,rel.oid,a.attnum,'SELECT'),
          'insert',has_column_privilege(r.rolname,rel.oid,a.attnum,'INSERT'),
          'update',has_column_privilege(r.rolname,rel.oid,a.attnum,'UPDATE'),
          'references',has_column_privilege(r.rolname,rel.oid,a.attnum,'REFERENCES')
        ) order by rel.schema_name,rel.relation_name,a.attnum,r.rolname)
        from relevant_relations rel join pg_attribute a on a.attrelid=rel.oid
          and a.attnum>0 and not a.attisdropped cross join pg_roles r
      ),'[]'::jsonb),
      'sequences',coalesce((
        select jsonb_agg(jsonb_build_object(
          'schema',n.nspname,'sequence',c.relname,'owner',pg_get_userbyid(c.relowner),
          'role',r.rolname,'usage',has_sequence_privilege(r.rolname,c.oid,'USAGE'),
          'select',has_sequence_privilege(r.rolname,c.oid,'SELECT'),
          'update',has_sequence_privilege(r.rolname,c.oid,'UPDATE')
        ) order by n.nspname,c.relname,r.rolname)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
          cross join pg_roles r where c.relkind='S' and n.nspname in ('public','auth')
      ),'[]'::jsonb)
    ),
    'warnings',jsonb_build_array(
      'Confirm intended Supabase project against the Dashboard URL; a local project-ref file is not proof.',
      'Migration-ledger candidates are discovered by name/schema patterns only. Absence is inconclusive; use the project migration tooling or a verified ledger.',
      'Check whether anon, authenticated, and service_role exist in the role_memberships section; missing roles are not silently treated as verified grants.',
      'Catalog visibility and effective privilege checks depend on the SQL Editor role; an empty/partial result is not proof of absence.',
      'Dependency catalogs may omit dependencies embedded in procedural function source. Function bodies are intentionally not returned.',
      'Aggregate checks require read access to expected workflow tables and auth.users. If unavailable, obtain only the missing safe evidence under an authorized read-only role.',
      'This report cannot verify semantic question quality, runtime PostgREST behavior, OAuth operation, Google Forms creation, or end-to-end score ingestion.'
    )
  ) as report
  from data_counts
)
select report from report;
