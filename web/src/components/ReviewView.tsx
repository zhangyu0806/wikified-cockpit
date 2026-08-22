import { useState } from "react";
import { api, type ReviewReport } from "../api/client";

interface Props {
  report: ReviewReport;
  onResolved: () => void;
  onToast: (msg: string, err?: boolean) => void;
  onOpenPage: (path: string) => void;
}

function ageText(days: number | null): string {
  if (days === null) return "";
  if (days < 1) return "今天";
  return `${Math.floor(days)}天前`;
}

export function ReviewView({ report, onResolved, onToast, onOpenPage }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(id: string, status: "promoted" | "rejected") {
    setBusy(id);
    try {
      const r = await api.resolveCorrection(id, status);
      onToast(r.message || `已${status === "promoted" ? "晋升" : "拒绝"} ${id}`);
      onResolved();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  }

  const corr = report.corrections_pending;
  const promo = report.promote_suggestions;
  const raw = report.uncompiled_raw;
  const exp = report.expire_candidates;

  return (
    <>
      <section className="panel">
        <h2>
          待处理的纠正 / 偏好 <span className="count">{corr.length} 条 · 最高优先级</span>
        </h2>
        <p className="hint">你纠正过 AI 或表达过偏好，但还没进 CRITICAL_FACTS，AI 可能还在犯。</p>
        {corr.length === 0 ? (
          <p className="empty">队列为空。</p>
        ) : (
          corr.map((c) => (
            <div className="card" key={c.id}>
              <div className="card-head">
                <span className="badge">{c.id}</span>
                <span className="badge kind">{c.kind}</span>
                <span className="age">{ageText(c.age_days)}</span>
              </div>
              <div className="text">{c.text}</div>
              <div className="actions">
                <button
                  className="act promote"
                  disabled={busy === c.id}
                  onClick={() => resolve(c.id, "promoted")}
                >
                  晋升
                </button>
                <button
                  className="act reject"
                  disabled={busy === c.id}
                  onClick={() => resolve(c.id, "rejected")}
                >
                  丢弃
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2>
          晋升建议 <span className="count">{promo.length} 条 quick-note / auto-draft</span>
        </h2>
        {promo.length === 0 ? (
          <p className="empty">无。</p>
        ) : (
          promo.map((p, i) => (
            <div className="card" key={i}>
              <div className="card-head">
                <span className={`badge ${p.confidence}`}>{p.confidence}</span>
                <span className="text">{p.title || "(无标题)"}</span>
                <span className="age">{p.source}</span>
              </div>
              <div className="sub">→ {p.suggested_target}</div>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2>
          未编译的源材料 <span className="count">{raw.length} 个 raw 文件</span>
        </h2>
        {raw.length === 0 ? (
          <p className="empty">全部已编译或归档。</p>
        ) : (
          raw.slice(0, 12).map((r) => (
            <div className="card" key={r.path}>
              <div className="card-head">
                <span className="badge">{r.category}</span>
                <span className="age">{ageText(r.age_days)}</span>
              </div>
              <div className="sub">{r.path}</div>
            </div>
          ))
        )}
        {raw.length > 12 && <p className="empty">…还有 {raw.length - 12} 个</p>}
      </section>

      <section className="panel">
        <h2>
          Event 堆积与过期候选 <span className="count">共 {report.event_total} 条</span>
        </h2>
        <div className="event-months">
          {Object.entries(report.event_counts)
            .sort()
            .map(([m, c]) => (
              <span className="m" key={m}>
                {m} · {c}
              </span>
            ))}
        </div>
        {exp.length === 0 ? (
          <p className="empty">无明显陈旧 event（默认判据保守：已过 2 个半衰期才列出）。</p>
        ) : (
          exp.slice(0, 15).map((e) => (
            <div className="card" key={e.id}>
              <div className="card-head">
                <span className="badge">{e.id}</span>
                <span className="badge kind">{e.type}</span>
                {e.project && <span className="badge kind">{e.project}</span>}
                <span className="age">
                  {ageText(e.age_days)} · 置信→{e.decayed_confidence}
                </span>
              </div>
              <div className="text">{e.summary}</div>
            </div>
          ))
        )}
      </section>
    </>
  );
}
