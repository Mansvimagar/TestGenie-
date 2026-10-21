import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "danger" | "muted";

const variantClasses: Record<Variant, string> = {
  default: "bg-primary/15 text-indigo-300 border-primary/30",
  success: "bg-emerald-600/15 text-emerald-400 border-emerald-600/30",
  danger: "bg-red-600/15 text-red-400 border-red-600/30",
  muted: "bg-slate-800 text-slate-400 border-slate-700",
};

export function Badge({
  variant = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}
