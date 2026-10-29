import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { exchangeCodeAndStore } from "@/lib/google/auth";

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const stateCookie = request.cookies.get("testgenie_google_oauth_state")?.value;
  const returnToCookie = request.cookies.get("testgenie_google_oauth_return_to")?.value;
  const targetPath = returnToCookie && returnToCookie.startsWith("/dashboard")
    ? returnToCookie
    : "/dashboard/generate";
  const separator = targetPath.includes("?") ? "&" : "?";

  if (!code || !state || !stateCookie) {
    return redirectAndClearState(`${appUrl}${targetPath}${separator}google_error=denied`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const stateSeparator = state.indexOf(":");
  const stateUserId = stateSeparator >= 0 ? state.slice(0, stateSeparator) : "";
  const stateNonce = stateSeparator >= 0 ? state.slice(stateSeparator + 1) : "";
  if (!user || user.id !== stateUserId || stateNonce !== stateCookie) {
    return redirectAndClearState(`${appUrl}/login`);
  }

  try {
    await exchangeCodeAndStore(user.id, code);
  } catch {
    return redirectAndClearState(`${appUrl}${targetPath}${separator}google_error=exchange_failed`);
  }

  return redirectAndClearState(`${appUrl}${targetPath}${separator}google_connected=1`);
}

function redirectAndClearState(url: string) {
  const response = NextResponse.redirect(url);
  response.cookies.set("testgenie_google_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/google/callback",
    maxAge: 0,
  });
  response.cookies.set("testgenie_google_oauth_return_to", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/google/callback",
    maxAge: 0,
  });
  return response;
}
