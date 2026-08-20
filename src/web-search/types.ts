import type Parallel from "parallel-web";

export type ParallelSearchClient = Pick<Parallel, "search">;
export type ParallelSearchResponse = Awaited<ReturnType<Parallel["search"]>>;

export interface WebSearchParams {
  objective: string;
  search_queries: string[];
}

export interface WebSearchDetails {
  provider: "parallel";
  product: "search";
  searchId?: string;
  sessionId?: string;
  resultCount: number;
  warnings?: unknown;
  usage?: unknown;
}

export interface WebSearchSettings {
  parallelApiKey?: string;
}

export interface WebSearchSettingsStore {
  load(): WebSearchSettings;
  save(settings: WebSearchSettings): void;
}
