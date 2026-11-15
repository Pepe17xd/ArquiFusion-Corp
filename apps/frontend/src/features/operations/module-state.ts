export type ModuleLoadState = "loading" | "error" | "empty" | "ready";

export function moduleLoadState(input: { loading: boolean; error: string; recordCount: number }): ModuleLoadState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.recordCount === 0 ? "empty" : "ready";
}

export function moduleUnavailable(error: string) {
  const value = error.toLowerCase();
  return value.includes("404") || value.includes("not found") || value.includes("no encontrado");
}
