"use client";

import { useState } from "react";
import { GraduationCap, LogOut, Menu, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { SidebarNav } from "./sidebar";

export function Navbar({ email }: { email: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <button
          className="md:hidden text-slate-400"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle navigation"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <div className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5 text-indigo-400" />
          <span className="font-semibold text-slate-100">TestGenie</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <span className="hidden sm:block text-sm text-slate-400">{email}</span>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>

      {mobileOpen && (
        <div className="absolute left-0 top-full w-full border-b border-slate-800 bg-slate-950 md:hidden">
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </div>
      )}
    </header>
  );
}
