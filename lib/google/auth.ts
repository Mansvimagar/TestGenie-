import "server-only";
import { google } from "googleapis";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/forms.responses.readonly",
];
export const RESPONSES_SCOPE = "https://www.googleapis.com/auth/forms.responses.readonly";

export function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI
  );
}

function newOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function buildConsentUrl(state: string): string {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
  });
}

export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token || !tokens.access_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke TestGenie's access at " +
        "https://myaccount.google.com/permissions and reconnect to try again."
    );
  }
  if (tokens.scope) {
    const grantedScopes = new Set(tokens.scope.split(/\s+/));
    if (GOOGLE_SCOPES.some((scope) => !grantedScopes.has(scope))) {
      throw new Error("Google did not grant the Forms and Drive permissions required by TestGenie (Forms, Drive and Forms responses). Reconnect and accept every permission.");
    }
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("google_credentials").upsert({
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope ?? GOOGLE_SCOPES.join(" "),
    expiry_date: tokens.expiry_date ?? Date.now() + 3600_000,
  });

  if (error) throw new Error(`Failed to store Google credentials: ${error.message}`);
}

// Returns an authenticated OAuth2 client for this user, refreshing the access
// token if expired and persisting the refreshed token.
export async function getAuthorizedClientForUser(userId: string) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("google_credentials")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return null;

  const client = newOAuthClient();
  client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    expiry_date: data.expiry_date,
  });

  client.on("tokens", async (tokens) => {
    if (!tokens.access_token) return;
    await supabase
      .from("google_credentials")
      .update({
        access_token: tokens.access_token,
        expiry_date: tokens.expiry_date ?? data.expiry_date,
      })
      .eq("user_id", userId);
  });

  return client;
}
