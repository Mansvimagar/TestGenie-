import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { exchangeCodeAndStore } from "@/lib/google/auth";

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/dashboard/generate?google_error=denied`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.id !== state) {
    return NextResponse.redirect(`${appUrl}/login`);
  }

  try {
    await exchangeCodeAndStore(user.id, code);
  } catch {
    return NextResponse.redirect(`${appUrl}/dashboard/generate?google_error=exchange_failed`);
  }

  return NextResponse.redirect(`${appUrl}/dashboard/generate?google_connected=1`);
}
