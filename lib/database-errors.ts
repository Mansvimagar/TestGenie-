export function isUndefinedColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703";
}
