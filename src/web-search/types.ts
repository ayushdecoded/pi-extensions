export interface PageSection {
  index: number;
  level: number;
  heading: string;
  path: string;
  text: string;
  chars: number;
}

export interface FetchedPage {
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  mode?: string;
  text?: string;
  sections?: Array<Omit<PageSection, "text"> & { text?: string; truncated?: boolean }>;
  error?: string;
  truncated?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  page?: FetchedPage;
}

export interface WebSearchParams {
  query?: string;
  url?: string;
  mode?: string;
  section?: string;
}

export interface WebSearchConfig {
  maxResults?: number;
  maxChars?: number;
  timeoutMs?: number;
  fetchTopN?: number;
  region?: string;
}
