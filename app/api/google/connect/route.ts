import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildConsentUrl, isGoogleConfigured } from "@/lib/google/auth";

export async function GET() {
  if (!isGoogleConfigured()) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/generate?google_error=not_configured`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login`);
  }

  const url = buildConsentUrl(user.id);
  return NextResponse.redirect(url);
}
