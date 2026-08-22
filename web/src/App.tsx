import { useCallback, useEffect, useState } from "react";
import { api, type ReviewReport } from "./api/client";
import { ReviewView } from "./components/ReviewView";
import { GtdBoard } from "./components/GtdBoard";
import { Reader } from "./components/Reader";

type Tab = "review" | "gtd" | "reader";

export function App() {
  const [tab, setTab] = useState<Tab>("review");
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);
  const [readerPath, setReaderPath] = useState<string | null>(null);

  const loadReview = useCallback(async () => {
    try {
      setReport(await api.review());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = useCallback((msg: string, err = false) => setToast({ msg, err }), []);

  const openPage = useCallback((path: string) => {
    setReaderPath(path);
    setTab("reader");
  }, []);

  const last = report?.last_review_days_ago ?? null;
  const cadence = report?.cadence_days ?? 7;
  const cadenceWarn = last === null || last >= cadence;
  const cadenceText =
    last === null ? "从未复盘" : last < 1 ? "今天已复盘" : `距上次复盘 ${Math.floor(last)} 天`;

  return (
    <div className="app">
      <div className="topbar">
        <h1>Wikified 驾驶舱</h1>
        <nav className="tabs">
          <button className={`tab ${tab === "review" ? "active" : ""}`} onClick={() => setTab("review")}>
            复盘
          </button>
          <button className={`tab ${tab === "gtd" ? "active" : ""}`} onClick={() => setTab("gtd")}>
            GTD
          </button>
          <button className={`tab ${tab === "reader" ? "active" : ""}`} onClick={() => setTab("reader")}>
            阅读
          </button>
        </nav>
        <span className={`cadence ${cadenceWarn ? "warn" : ""}`}>{cadenceText}</span>
      </div>

      {error && <div className="error">加载失败：{error}</div>}

      {tab === "review" &&
        (report ? (
          <ReviewView report={report} onResolved={loadReview} onToast={showToast} onOpenPage={openPage} />
        ) : (
          !error && <div className="loading">加载中…</div>
        ))}

      {tab === "gtd" && <GtdBoard onToast={showToast} />}

      {tab === "reader" && <Reader initialPath={readerPath} onNavigate={setReaderPath} />}

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
