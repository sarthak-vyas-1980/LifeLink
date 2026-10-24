export type FacilitySearchState = "idle" | "loading" | "error" | "empty" | "results";

export function getFacilitySearchState(input: {
  loading: boolean;
  error: string;
  searched: boolean;
  resultCount: number;
}): FacilitySearchState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (!input.searched) return "idle";
  return input.resultCount > 0 ? "results" : "empty";
}
