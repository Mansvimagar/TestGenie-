import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { buildConsentUrl, isGoogleConfigured } from "@/lib/google/auth";

export async function GET(request: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const url = new URL(request.url);
  const rawReturnTo = url.searchParams.get("returnTo");
  const returnTo = rawReturnTo && rawReturnTo.startsWith("/dashboard") ? rawReturnTo : null;

  if (!isGoogleConfigured()) {
    const errorTarget = returnTo ?? "/dashboard/generate";
    return NextResponse.redirect(
      `${appUrl}${errorTarget}${errorTarget.includes("?") ? "&" : "?"}google_error=not_configured`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${appUrl}/login`);
  }

  const nonce = randomBytes(32).toString("base64url");
  const response = NextResponse.redirect(buildConsentUrl(`${user.id}:${nonce}`));
  response.cookies.set("testgenie_google_oauth_state", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/google/callback",
    maxAge: 10 * 60,
  });
  if (returnTo) {
    response.cookies.set("testgenie_google_oauth_return_to", returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/google/callback",
      maxAge: 10 * 60,
    });
  }
  return response;
}
