-- Enforce question provenance at the database boundary.
-- Apply after 007-010. This is forward-only; it does not rewrite legacy rows.
--
-- The API routes continue to save drafts through save_draft_test and to edit
-- questions through update_test_questions / the authenticated regenerate route.
-- This trigger validates every supplied chunk ID against the test's saved
-- syllabus and scope, and forces the grounding state to needs_review. A valid
-- chunk ID is not proof that the chunk was the exact retrieval result; the
-- application must continue to derive IDs from its server-side retrieval.
--
-- Keep question/test write endpoints unavailable while applying missing
-- migrations 007-011. Block direct authenticated PostgREST table/RPC writes as
-- well as the Next.js routes; hiding UI controls alone is not a write freeze.
-- These migration files are ordered, but are not an atomic group.

create or replace function public.validate_question_provenance()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_syllabus_id uuid;
  v_generation_config jsonb;
begin
  if auth.uid() is null
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Authentication required';
  end if;

  if jsonb_typeof(new.source_chunk_ids) is distinct from 'array' then
    raise exception 'Question source IDs must be an array';
  end if;

  select t.syllabus_id, t.generation_config
    into v_syllabus_id, v_generation_config
  from public.tests t
  where t.id = new.test_id
    and t.status = 'draft'
    and (
      t.user_id = auth.uid()
      or (auth.uid() is null and current_user in ('service_role', 'postgres', 'supabase_admin'))
    );

  if not found then
    raise exception 'Draft test not found or not owned by the authenticated user';
  end if;

  if (v_generation_config ? 'includedTopics'
      and jsonb_typeof(v_generation_config -> 'includedTopics') is distinct from 'array')
     or (v_generation_config ? 'excludedTopics'
      and jsonb_typeof(v_generation_config -> 'excludedTopics') is distinct from 'array') then
    raise exception 'Saved test scope is invalid';
  end if;

  if jsonb_array_length(new.source_chunk_ids) > 0
     and (v_syllabus_id is null or jsonb_typeof(v_generation_config) is distinct from 'object') then
    raise exception 'Question source IDs require a linked syllabus and saved scope';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(new.source_chunk_ids) as source(chunk_id)
    where not exists (
      select 1
      from public.syllabus_chunks c
      where c.id::text = source.chunk_id
        and c.syllabus_id = v_syllabus_id
        and (nullif(v_generation_config ->> 'unit', '') is null
             or c.unit = v_generation_config ->> 'unit')
        and (nullif(v_generation_config ->> 'topic', '') is null
             or c.topic = v_generation_config ->> 'topic')
        and (nullif(v_generation_config ->> 'subtopic', '') is null
             or c.subtopic = v_generation_config ->> 'subtopic')
        and (not (v_generation_config ? 'includedTopics')
             or (v_generation_config -> 'includedTopics' ? coalesce(c.topic, '')))
        and not (coalesce(v_generation_config -> 'excludedTopics', '[]'::jsonb)
                 ? coalesce(c.topic, ''))
        and c.metadata ->> 'embeddingProvider' = 'gemini'
    )
  ) then
    raise exception 'Question source IDs must match Gemini chunks in the saved syllabus scope';
  end if;

  if jsonb_typeof(coalesce(new.validation_metadata, '{}'::jsonb)) is distinct from 'object' then
    raise exception 'Question validation metadata must be an object';
  end if;

  -- A caller cannot persist a model or client assertion as verified grounding.
  -- Preserve quality issue details, but keep support status explicitly advisory.
  new.grounding_status := 'needs_review';
  new.validation_metadata :=
    (coalesce(new.validation_metadata, '{}'::jsonb)
      - 'supportAssessment' - 'supportReviewNote' - 'groundingSimilarity'
      - 'groundingStatus' - 'isGrounded' - 'verified')
    || jsonb_build_object(
      'supportAssessment', 'uncertain',
      'supportReviewNote', 'Faculty verification required.'
    );

  return new;
end;
$$;

revoke all on function public.validate_question_provenance() from public, anon;
grant execute on function public.validate_question_provenance() to authenticated;

drop trigger if exists questions_validate_provenance on public.questions;
create trigger questions_validate_provenance
  before insert or update
  on public.questions
  for each row execute function public.validate_question_provenance();

comment on function public.validate_question_provenance() is
  'Validates question source chunk IDs against the linked draft syllabus scope and forces grounding status to needs_review. Runs SECURITY INVOKER under caller RLS; trusted database owners/service_role may bypass RLS and must not be exposed to browsers.';

-- Publication policy: the current application requires an explicit faculty
-- confirmation before calling publish_test. needs_review remains a truthful
-- status and is not treated as verified; the existing publish trigger rejects
-- malformed/duplicate questions. Do not reject needs_review here because the
-- application has no persisted faculty-reviewed status. Direct invocation of
-- publish_test by an authenticated owner bypasses the route's checkbox. This
-- migration does not claim database-enforced faculty review or reject
-- unsupported/needs_review status values. Enforcing that requires a follow-up
-- API/RPC contract that persists an owner review attestation and applies the
-- same policy in the API route, RPC, and publication trigger.

alter function public.publish_test(uuid)
  set search_path = pg_catalog, public, pg_temp;

alter function public.prevent_published_test_changes()
  set search_path = pg_catalog, public, pg_temp;

-- Fail closed if the definer is owned by a browser role, lacks the narrow
-- privilege needed for the status transition, or uses a public schema writable
-- by browser roles. The function owner is intentionally not reassigned here.
do $$
declare
  v_owner oid;
  v_owner_name name;
  v_owner_trusted boolean;
begin
  select p.proowner, r.rolname,
         (r.rolsuper or r.rolbypassrls
          or exists (
            select 1 from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relname = 'tests'
              and c.relowner = p.proowner
          ))
    into v_owner, v_owner_name, v_owner_trusted
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.oid = to_regprocedure('public.publish_test(uuid)');

  if not found then
    raise exception 'Expected public.publish_test(uuid) was not found';
  end if;
  if v_owner_name in ('anon', 'authenticated')
     or not v_owner_trusted
     or not has_column_privilege(v_owner, 'public.tests', 'status', 'UPDATE') then
    raise exception 'publish_test must be owned by a trusted role able to update tests.status';
  end if;
  if has_schema_privilege('anon', 'public', 'CREATE')
     or has_schema_privilege('authenticated', 'public', 'CREATE') then
    raise exception 'Browser roles must not have CREATE privilege on public';
  end if;
end;
$$;

comment on function public.publish_test(uuid) is
  'SECURITY DEFINER publisher. Must be owned by a trusted database migration owner (never anon/authenticated); checks auth.uid(), test ownership, and draft status. Fixed search_path is pg_catalog, public, pg_temp. The application route requires faculty confirmation; direct authenticated RPC invocation bypasses that UI check.';
