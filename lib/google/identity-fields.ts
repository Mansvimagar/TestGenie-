import type { forms_v1 } from "googleapis";
import { buildIdentityRequests, identityFieldState } from "./form-structure";

export type IdentityFieldsState = "present" | "missing_no_responses" | "missing_has_responses" | "partial";

export class IdentityFieldsError extends Error {
  constructor(readonly code: "has_responses" | "partial", message: string) {
    super(message);
    this.name = "IdentityFieldsError";
  }
}

/** The only Forms operations this module needs; lets tests run without Google. */
export interface IdentityFormsClient {
  getForm(formId: string): Promise<forms_v1.Schema$Form>;
  hasAnyResponse(formId: string): Promise<boolean>;
  batchUpdate(formId: string, body: forms_v1.Schema$BatchUpdateFormRequest): Promise<void>;
}

export async function inspectIdentityFields(client: IdentityFormsClient, formId: string) {
  const form = await client.getForm(formId);
  const shape = identityFieldState(form);
  if (shape === "present") return { state: "present" as IdentityFieldsState, form };
  if (shape === "partial") return { state: "partial" as IdentityFieldsState, form };
  const hasResponses = await client.hasAnyResponse(formId);
  return { state: (hasResponses ? "missing_has_responses" : "missing_no_responses") as IdentityFieldsState, form };
}

/**
 * Inserts the four identity items at positions 0-3 of a form that has none and no
 * responses. Idempotent, and it only ever issues createItem requests, so graded
 * questions and answer keys are never modified.
 */
export async function addIdentityFields(client: IdentityFormsClient, formId: string): Promise<"added" | "already_present"> {
  const { state, form } = await inspectIdentityFields(client, formId);
  if (state === "present") return "already_present";
  if (state === "partial") {
    throw new IdentityFieldsError("partial", "This form already has some student detail fields in an unexpected arrangement. It was left unchanged; create a new test instead.");
  }
  if (state === "missing_has_responses") {
    throw new IdentityFieldsError("has_responses", "This form already has responses, so student detail fields cannot be added without breaking existing results. Create a new test instead.");
  }
  await client.batchUpdate(formId, {
    requests: buildIdentityRequests(),
    // Fails instead of overwriting if the form was edited since we read it.
    ...(form.revisionId ? { writeControl: { requiredRevisionId: form.revisionId } } : {}),
  });
  return "added";
}
