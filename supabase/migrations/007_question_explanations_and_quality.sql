-- Add explanations while keeping legacy questions valid and nullable.
alter table public.questions add column if not exists explanation text;

-- Extend the existing atomic draft save without changing its transaction model.
create or replace function public.save_draft_test(
  p_syllabus_id uuid,
  p_generation_config jsonb,
  p_questions jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_test public.tests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_generation_config is null
     or p_generation_config ->> 'syllabusId' is distinct from p_syllabus_id::text
     or jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions) < 1 then
    raise exception 'Invalid draft payload';
  end if;

  if not exists (
    select 1 from public.syllabi s
    where s.id = p_syllabus_id
      and s.user_id = v_user_id
      and s.status = 'ready'
  ) then
    raise exception 'Syllabus not found or not ready';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_questions) as q(item)
    cross join lateral jsonb_array_elements_text(coalesce(q.item -> 'sourceChunkIds', '[]'::jsonb)) as source(chunk_id)
    where not exists (
      select 1 from public.syllabus_chunks c
      where c.id = source.chunk_id::uuid
        and c.syllabus_id = p_syllabus_id
        and (nullif(p_generation_config ->> 'unit', '') is null or c.unit = p_generation_config ->> 'unit')
        and (nullif(p_generation_config ->> 'topic', '') is null or c.topic = p_generation_config ->> 'topic')
        and (nullif(p_generation_config ->> 'subtopic', '') is null or c.subtopic = p_generation_config ->> 'subtopic')
        and c.metadata ->> 'embeddingProvider' = 'gemini'
        and not (coalesce(p_generation_config -> 'excludedTopics', '[]'::jsonb) ? coalesce(c.topic, ''))
    )
  ) then
    raise exception 'Source evidence is outside the requested syllabus scope';
  end if;

  insert into public.tests (
    user_id, title, subject, syllabus_text, difficulty, question_count,
    status, syllabus_id, generation_config
  ) values (
    v_user_id,
    p_generation_config ->> 'title',
    p_generation_config ->> 'subject',
    '',
    p_generation_config ->> 'difficulty',
    jsonb_array_length(p_questions),
    'draft',
    p_syllabus_id,
    p_generation_config
  ) returning * into v_test;

  insert into public.questions (
    test_id, topic, question, options, correct_answer_index, position,
    explanation, source_chunk_ids, grounding_status, validation_status, validation_metadata
  )
  select
    v_test.id,
    q.item ->> 'topic',
    q.item ->> 'question',
    q.item -> 'options',
    (q.item ->> 'correctAnswerIndex')::smallint,
    (q.ordinality - 1)::integer,
    q.item ->> 'explanation',
    coalesce(q.item -> 'sourceChunkIds', '[]'::jsonb),
    coalesce(q.item ->> 'groundingStatus', 'needs_review'),
    coalesce(q.item ->> 'validationStatus', 'not_applicable'),
    coalesce(q.item -> 'validationMetadata', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as q(item, ordinality);

  return to_jsonb(v_test);
end;
$$;

comment on column public.questions.explanation is
  'Optional answer rationale. Null for legacy questions created before explanations were collected.';
