import "server-only";
import { google, type forms_v1 } from "googleapis";
import { getAuthorizedClientForUser, RESPONSES_SCOPE } from "./auth";
import { mapFormResponses, ResponseMappingError, type MappedResponses } from "./response-mapper";

export type ResponsesErrorCode = "not_connected" | "scope_missing" | "token_expired" | "form_unavailable" | "google_error";

export class GoogleResponsesError extends Error {
  constructor(readonly code: ResponsesErrorCode, message: string) {
    super(message);
    this.name = "GoogleResponsesError";
  }
}

const MAX_PAGES = 20;

/** Reads every response of a form with forms.responses.list and maps it to score rows. */
export async function fetchFormScores(params: {
  userId: string;
  formId: string;
  questionCount: number;
}): Promise<MappedResponses> {
  const auth = await getAuthorizedClientForUser(params.userId);
  if (!auth) {
    throw new GoogleResponsesError("not_connected", "Google account not connected. Connect Google, then sync scores again.");
  }
  const granted = (auth.credentials.scope ?? "").split(/\s+/);
  if (!granted.includes(RESPONSES_SCOPE)) {
    throw new GoogleResponsesError(
      "scope_missing",
      "TestGenie needs permission to read Google Form responses. Reconnect Google and accept all permissions."
    );
  }

  const forms = google.forms({ version: "v1", auth });
  try {
    const form = await forms.forms.get({ formId: params.formId });
    const responses: forms_v1.Schema$FormResponse[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await forms.forms.responses.list({ formId: params.formId, pageToken, pageSize: 500 });
      responses.push(...(result.data.responses ?? []));
      pageToken = result.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return mapFormResponses(form.data, responses, params.questionCount);
  } catch (err) {
    if (err instanceof ResponseMappingError) throw new GoogleResponsesError("form_unavailable", err.message);
    throw classifyGoogleError(err);
  }
}

function classifyGoogleError(err: unknown): GoogleResponsesError {
  const text = err instanceof Error ? err.message : "";
  const status = (err as { code?: number | string; status?: number } | null)?.code;
  if (/invalid_grant|invalid_token|unauthorized_client/i.test(text) || status === 401) {
    return new GoogleResponsesError("token_expired", "Your Google connection expired or was revoked. Reconnect Google and try again.");
  }
  if (/insufficient.*(scope|permission)/i.test(text) || status === 403) {
    return new GoogleResponsesError(
      "scope_missing",
      "Google refused access to the responses. Reconnect Google, accept all permissions, and make sure you own this form."
    );
  }
  if (status === 404) {
    return new GoogleResponsesError("form_unavailable", "The Google Form could not be found. It may have been deleted.");
  }
  return new GoogleResponsesError("google_error", "Google could not return the form responses. Please try again.");
}
