-- Keep authenticated draft writes within their saved syllabus scope and make
-- faculty question edits atomic. Apply after migrations 001-007.

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
     or jsonb_array_length(p_questions) < 1
     or jsonb_array_length(p_questions) > 50 then
    raise exception 'Invalid draft payload';
  end if;

  if (p_generation_config ? 'includedTopics'
      and jsonb_typeof(p_generation_config -> 'includedTopics') is distinct from 'array')
     or (p_generation_config ? 'excludedTopics'
      and jsonb_typeof(p_generation_config -> 'excludedTopics') is distinct from 'array') then
    raise exception 'Invalid draft scope';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_questions) as q(item)
    where nullif(btrim(q.item ->> 'explanation'), '') is null
       or (q.item ? 'sourceChunkIds'
           and jsonb_typeof(q.item -> 'sourceChunkIds') is distinct from 'array')
  ) then
    raise exception 'Invalid question payload';
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
      where c.id::text = source.chunk_id
        and c.syllabus_id = p_syllabus_id
        and (nullif(p_generation_config ->> 'unit', '') is null or c.unit = p_generation_config ->> 'unit')
        and (nullif(p_generation_config ->> 'topic', '') is null or c.topic = p_generation_config ->> 'topic')
        and (nullif(p_generation_config ->> 'subtopic', '') is null or c.subtopic = p_generation_config ->> 'subtopic')
        and (not (p_generation_config ? 'includedTopics') or (p_generation_config -> 'includedTopics' ? coalesce(c.topic, '')))
        and not (coalesce(p_generation_config -> 'excludedTopics', '[]'::jsonb) ? coalesce(c.topic, ''))
        and c.metadata ->> 'embeddingProvider' = 'gemini'
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
    'needs_review',
    coalesce(q.item ->> 'validationStatus', 'not_applicable'),
    coalesce(q.item -> 'validationMetadata', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as q(item, ordinality);

  return to_jsonb(v_test);
end;
$$;

create or replace function public.update_test_questions(
  p_test_id uuid,
  p_title text,
  p_subject text,
  p_difficulty text,
  p_questions jsonb
)
returns void
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
  if jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions) < 1
     or jsonb_array_length(p_questions) > 50 then
    raise exception 'Invalid question payload';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_questions) as q(item)
    where (q.item ? 'sourceChunkIds'
           and jsonb_typeof(q.item -> 'sourceChunkIds') is distinct from 'array')
  ) then
    raise exception 'Invalid question payload';
  end if;

  select * into v_test
  from public.tests t
  where t.id = p_test_id and t.user_id = v_user_id
  for update;
  if not found then
    raise exception 'Test not found';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_questions) as q(item)
    cross join lateral jsonb_array_elements_text(coalesce(q.item -> 'sourceChunkIds', '[]'::jsonb)) as source(chunk_id)
    where v_test.syllabus_id is null or not exists (
      select 1 from public.syllabus_chunks c
      where c.id::text = source.chunk_id
        and c.syllabus_id = v_test.syllabus_id
        and (nullif(v_test.generation_config ->> 'unit', '') is null or c.unit = v_test.generation_config ->> 'unit')
        and (nullif(v_test.generation_config ->> 'topic', '') is null or c.topic = v_test.generation_config ->> 'topic')
        and (nullif(v_test.generation_config ->> 'subtopic', '') is null or c.subtopic = v_test.generation_config ->> 'subtopic')
        and (not (v_test.generation_config ? 'includedTopics') or (v_test.generation_config -> 'includedTopics' ? coalesce(c.topic, '')))
        and not (coalesce(v_test.generation_config -> 'excludedTopics', '[]'::jsonb) ? coalesce(c.topic, ''))
        and c.metadata ->> 'embeddingProvider' = 'gemini'
    )
  ) then
    raise exception 'Source evidence is outside the requested syllabus scope';
  end if;

  update public.tests
  set title = p_title,
      subject = p_subject,
      difficulty = p_difficulty,
      question_count = jsonb_array_length(p_questions)
  where id = p_test_id and user_id = v_user_id;

  delete from public.questions where test_id = p_test_id;

  insert into public.questions (
    test_id, topic, question, options, correct_answer_index, position,
    explanation, source_chunk_ids, grounding_status, validation_status, validation_metadata
  )
  select
    p_test_id,
    q.item ->> 'topic',
    q.item ->> 'question',
    q.item -> 'options',
    (q.item ->> 'correctAnswerIndex')::smallint,
    (q.ordinality - 1)::integer,
    q.item ->> 'explanation',
    coalesce(q.item -> 'sourceChunkIds', '[]'::jsonb),
    'needs_review',
    coalesce(q.item ->> 'validationStatus', 'not_applicable'),
    coalesce(q.item -> 'validationMetadata', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as q(item, ordinality);
end;
$$;

revoke all on function public.update_test_questions(uuid, text, text, text, jsonb) from public;
grant execute on function public.update_test_questions(uuid, text, text, text, jsonb) to authenticated;
