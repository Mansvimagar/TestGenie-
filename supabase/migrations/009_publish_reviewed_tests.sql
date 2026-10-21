-- Publish a reviewed draft through an authenticated, owner-checked RPC.
-- Also freeze assessment content after publication so its database definition
-- cannot drift away from the published Google Form.

create or replace function public.prevent_published_test_changes()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_question_count integer;
begin
  if old.status = 'published' and (
    new.title is distinct from old.title
    or new.subject is distinct from old.subject
    or new.syllabus_text is distinct from old.syllabus_text
    or new.difficulty is distinct from old.difficulty
    or new.question_count is distinct from old.question_count
    or new.syllabus_id is distinct from old.syllabus_id
    or new.generation_config is distinct from old.generation_config
  ) then
    raise exception 'Published test content is locked';
  end if;

  if new.status = 'published' and old.status is distinct from 'published' then
    select count(*) into v_question_count
    from public.questions q where q.test_id = old.id;

    if v_question_count < 1 or v_question_count <> new.question_count then
      raise exception 'Published test must contain its configured number of questions';
    end if;

    if exists (
      select 1
      from public.questions q
      where q.test_id = old.id
        and (
          nullif(btrim(q.topic), '') is null
          or nullif(btrim(q.question), '') is null
          or jsonb_array_length(q.options) <> 4
          or (select count(distinct lower(btrim(option_values.value)))
              from jsonb_array_elements_text(q.options) as option_values(value)) <> 4
          or q.correct_answer_index not between 0 and 3
          or nullif(btrim(q.explanation), '') is null
          or q.validation_status = 'duplicate'
        )
    ) then
      raise exception 'Published test contains questions that need review';
    end if;

    if exists (
      select 1
      from public.questions first_question
      join public.questions second_question
        on second_question.test_id = first_question.test_id
       and second_question.id > first_question.id
      where first_question.test_id = old.id
        and regexp_replace(lower(first_question.question), '[^[:alnum:]]+', '', 'g')
          = regexp_replace(lower(second_question.question), '[^[:alnum:]]+', '', 'g')
    ) then
      raise exception 'Published test contains duplicate questions';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tests_protect_published_content on public.tests;
create trigger tests_protect_published_content
  before update on public.tests
  for each row execute function public.prevent_published_test_changes();

create or replace function public.publish_test(p_test_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test public.tests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_test
  from public.tests t
  where t.id = p_test_id and t.user_id = auth.uid()
  for update;

  if not found then
    raise exception 'Test not found';
  end if;
  if v_test.status <> 'draft' then
    raise exception 'Only drafts can be published';
  end if;

  -- The trigger validates the persisted questions and the configured count in
  -- this same transaction before allowing the state change.
  update public.tests
  set status = 'published'
  where id = p_test_id and user_id = auth.uid() and status = 'draft';
end;
$$;

revoke all on function public.publish_test(uuid) from public;
grant execute on function public.publish_test(uuid) to authenticated;

-- Keep authenticated clients from changing the status column directly. The
-- narrow publish RPC checks ownership explicitly; existing app writes retain
-- only the columns they already need.
revoke update on public.tests from authenticated;
grant update (title, subject, difficulty, question_count, google_form_id, google_form_url)
  on public.tests to authenticated;

-- Direct authenticated writes and the update_test_questions RPC must obey the
-- same draft-only editing rule as the application route.
drop policy if exists questions_insert_own on public.questions;
create policy questions_insert_own on public.questions
  for insert with check (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  );

drop policy if exists questions_update_own on public.questions;
create policy questions_update_own on public.questions
  for update using (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  ) with check (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  );

drop policy if exists questions_delete_own on public.questions;
create policy questions_delete_own on public.questions
  for delete using (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  );
