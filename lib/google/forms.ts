import "server-only";
import { google } from "googleapis";
import type { Question } from "@/types/question";
import { getAuthorizedClientForUser } from "./auth";
import { buildFormRequests, formMatchesQuestions } from "./form-structure";
import {
  addIdentityFields,
  inspectIdentityFields,
  type IdentityFieldsState,
  type IdentityFormsClient,
} from "./identity-fields";

export class GoogleFormsError extends Error {
  constructor(message: string, readonly formId?: string, readonly recoveryRequired = Boolean(formId)) {
    super(message);
    this.name = "GoogleFormsError";
  }
}

export interface CreatedForm {
  formId: string;
  formUrl: string;
}

// Creates a self-grading Google Form quiz for the given test. Isolated here
// so the rest of the app never talks to the Forms API directly.
export async function createGoogleForm(params: {
  userId: string;
  title: string;
  subject: string;
  questions: Question[];
  existingFormId?: string;
  onFormCreated?: (formId: string) => Promise<void>;
}): Promise<CreatedForm> {
  const auth = await getAuthorizedClientForUser(params.userId);
  if (!auth) {
    throw new GoogleFormsError(
      "Google account not connected. Connect Google from the Generate page before creating a form."
    );
  }

  const forms = google.forms({ version: "v1", auth });

  const formId = params.existingFormId ?? await createEmptyForm(forms, params.title);
  if (params.questions.length === 0) throw new GoogleFormsError("A form needs at least one question.", formId);
  if (!params.existingFormId && params.onFormCreated) {
    try {
      await params.onFormCreated(formId);
    } catch {
      throw new GoogleFormsError("The Google Form was created, but its recovery reference could not be recorded.", formId);
    }
  }

  if (params.existingFormId) {
    let existing;
    try {
      existing = await forms.forms.get({ formId });
    } catch (err) {
      throw new GoogleFormsError(describeGoogleError(err, "recover the existing form"), formId);
    }
    if (existing.data.items?.length) {
      if (!formMatchesQuestions(existing.data, params.questions)) {
        throw new GoogleFormsError(
          "The existing Google Form has different questions. It was left unchanged; contact support before retrying.",
          formId,
          false
        );
      }
      if (!existing.data.responderUri) {
        throw new GoogleFormsError("Google did not return a responder URL for the existing form.", formId);
      }
      return { formId, formUrl: existing.data.responderUri };
    }
  }

  const requests = buildFormRequests(params.subject, params.questions);
  // Counts and positions only: no question text, tokens or IDs.
  console.info("Sending Google Form batchUpdate", {
    requestCount: requests.length,
    requestTypes: requests.map((request) => Object.keys(request)[0]),
    createItemLocations: requests.flatMap((request) => request.createItem ? [request.createItem.location?.index] : []),
  });

  try {
    await forms.forms.batchUpdate({ formId, requestBody: { requests } });
  } catch (err) {
    throw new GoogleFormsError(describeGoogleError(err, "add questions to the form"), formId);
  }

  let formUrl: string;
  try {
    const fetched = await forms.forms.get({ formId });
    if (!fetched.data.responderUri) {
      throw new GoogleFormsError("Google did not return a responder URL.", formId);
    }
    formUrl = fetched.data.responderUri;
  } catch (err) {
    throw new GoogleFormsError(describeGoogleError(err, "read back the form URL"), formId);
  }

  return { formId, formUrl };
}

async function createEmptyForm(
  forms: ReturnType<typeof google.forms>,
  title: string
): Promise<string> {
  try {
    const created = await forms.forms.create({
      requestBody: { info: { title, documentTitle: title } },
    });
    if (!created.data.formId) throw new GoogleFormsError("Google did not return a form ID.");
    return created.data.formId;
  } catch (err) {
    if (err instanceof GoogleFormsError) throw err;
    throw new GoogleFormsError(describeGoogleError(err, "create the form"));
  }
}

function describeGoogleError(err: unknown, action: string): string {
  const message = (err instanceof Error ? err.message : String(err))
    .replace(/AIza[\w-]{20,}/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*[^\s&,]+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return `Unable to ${action}: ${message}`;
}

async function identityClientForUser(userId: string): Promise<IdentityFormsClient> {
  const auth = await getAuthorizedClientForUser(userId);
  if (!auth) {
    throw new GoogleFormsError("Google account not connected. Connect Google, then try again.", undefined, false);
  }
  const forms = google.forms({ version: "v1", auth });
  return {
    getForm: async (formId) => (await forms.forms.get({ formId })).data,
    hasAnyResponse: async (formId) => {
      const result = await forms.forms.responses.list({ formId, pageSize: 1 });
      return (result.data.responses?.length ?? 0) > 0;
    },
    batchUpdate: async (formId, body) => {
      await forms.forms.batchUpdate({ formId, requestBody: body });
    },
  };
}

export async function getIdentityFieldsState(userId: string, formId: string): Promise<IdentityFieldsState> {
  const client = await identityClientForUser(userId);
  try {
    return (await inspectIdentityFields(client, formId)).state;
  } catch (err) {
    throw new GoogleFormsError(describeGoogleError(err, "inspect the form"), undefined, false);
  }
}

export async function addIdentityFieldsForUser(userId: string, formId: string): Promise<"added" | "already_present"> {
  const client = await identityClientForUser(userId);
  try {
    return await addIdentityFields(client, formId);
  } catch (err) {
    if (err instanceof Error && err.name === "IdentityFieldsError") throw err;
    throw new GoogleFormsError(describeGoogleError(err, "add student detail fields"), undefined, false);
  }
}
