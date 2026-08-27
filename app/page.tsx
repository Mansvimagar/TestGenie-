import Link from "next/link";
import { GraduationCap, Upload, Sparkles, FileCheck2, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const FEATURES = [
  {
    icon: Upload,
    title: "Upload a syllabus",
    description: "Drop in a PDF, or paste the syllabus text directly.",
  },
  {
    icon: Sparkles,
    title: "AI-generated MCQs",
    description: "Gemini reads the syllabus and drafts multiple-choice questions by topic.",
  },
  {
    icon: FileCheck2,
    title: "Review and publish",
    description: "Edit any question, then publish straight to a self-grading Google Form.",
  },
  {
    icon: BarChart3,
    title: "See scores instantly",
    description: "Google Forms auto-grades responses; scores land back in your dashboard.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between px-6 py-5 md:px-12">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-6 w-6 text-indigo-400" />
          <span className="text-lg font-semibold">TestGenie</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-slate-300 hover:text-white">
            Log in
          </Link>
          <Link href="/signup">
            <Button>Get Started</Button>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-16 text-center md:py-24">
        <h1 className="text-4xl font-bold tracking-tight text-slate-50 md:text-5xl">
          Turn a syllabus into a graded test in minutes.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-slate-400">
          TestGenie reads your syllabus, drafts multiple-choice questions with AI, and publishes
          a self-grading Google Form -- so you spend less time writing tests and more time
          teaching.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link href="/signup">
            <Button className="px-6 py-3 text-base">Get Started</Button>
          </Link>
        </div>
      </main>

      <section className="mx-auto max-w-5xl px-6 pb-24">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <f.icon className="h-6 w-6 text-indigo-400" />
              <h3 className="mt-3 text-sm font-semibold text-slate-100">{f.title}</h3>
              <p className="mt-1 text-sm text-slate-400">{f.description}</p>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
