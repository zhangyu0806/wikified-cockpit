// API 类型契约 —— 与后端 /api/* 及 llm-wiki-review --json 字段对齐。

export interface CorrectionItem {
  id: string;
  kind: string;
  text: string;
  age_days: number | null;
}

export interface PromoteSuggestion {
  note: string;
  title: string;
  category: string;
  suggested_target: string;
  confidence: string;
  reason: string;
  source: string;
}

export interface UncompiledRaw {
  path: string;
  category: string;
  age_days: number | null;
}

export interface ExpireCandidate {
  id: string;
  type: string;
  project: string | null;
  summary: string;
  age_days: number | null;
  decayed_confidence: number;
  half_lives_passed: number;
}

export interface ReviewReport {
  generated_at: string;
  last_review_days_ago: number | null;
  cadence_days: number;
  corrections_pending: CorrectionItem[];
  promote_suggestions: PromoteSuggestion[];
  uncompiled_raw: UncompiledRaw[];
  event_counts: Record<string, number>;
  event_total: number;
  expire_candidates: ExpireCandidate[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface ResolveResult {
  ok: boolean;
  id: string;
  status: string;
  message: string;
}

async function postResolveCorrection(
  id: string,
  status: "promoted" | "rejected",
): Promise<ResolveResult> {
  const res = await fetch("/api/corrections/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, status }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as ResolveResult;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  review: () => getJson<ReviewReport>("/api/review"),
  openLoops: () => getJson<{ exists: boolean; content: string }>("/api/open-loops"),
  page: (path: string) =>
    getJson<{ path: string; content: string }>(`/api/page?path=${encodeURIComponent(path)}`),
  tree: () => getJson<{ pages: string[] }>("/api/tree"),
  resolveCorrection: postResolveCorrection,
  toggleLoop: (line: number, expect: string) =>
    postJson<{ ok: boolean; line: number; text: string; done: boolean }>(
      "/api/open-loops/toggle",
      { line, expect },
    ),
  addLoop: (group: string, text: string) =>
    postJson<{ ok: boolean; inserted_at: number }>("/api/open-loops/add", { group, text }),
  setRawStatus: (path: string, status: "compiled" | "archived" | "rejected") =>
    postJson<{ ok: boolean; path: string; status: string }>("/api/raw/status", { path, status }),
  deprecateEvent: (id: string) =>
    postJson<{ ok: boolean; id: string; file: string }>("/api/events/deprecate", { id }),
};
