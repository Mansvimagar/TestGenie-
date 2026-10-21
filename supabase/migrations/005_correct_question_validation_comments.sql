-- Keep database column documentation aligned with the current generation flow.
-- Questions are marked for faculty review; no automated grounding or duplicate
-- validator currently runs.
comment on column public.questions.grounding_status is
  'Current grounded generation marks generated questions as needs_review. No automated factual grounding validator currently runs.';

comment on column public.questions.validation_status is
  'Current grounded generation sets not_applicable. Duplicate detection is not currently implemented.';
