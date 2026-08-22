import { useState, type ReactNode } from "react";
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

interface SectionProps {
  title: string;
  count: number;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

function Section({ title, count, hint, children, defaultOpen = true }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen && count > 0);
  return (
    <section className={`panel ${count === 0 ? "muted" : ""}`}>
      <button className="section-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <h2>
          {title} <span className="count">{count}</span>
        </h2>
      </button>
      {open && (
        <>
          {hint && <p className="hint">{hint}</p>}
          {children}
        </>
      )}
    </section>
  );
}

const RAW_ACTION_LABEL: Record<string, string> = {
  compiled: "已编译",
  archived: "归档",
  rejected: "不要",
};

export function ReviewView({ report, onResolved, onToast, onOpenPage }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rawLimit, setRawLimit] = useState(12);
  const [expLimit, setExpLimit] = useState(10);

  async function resolve(id: string, status: "promoted" | "rejected") {
    setBusy(id);
    try {
      const r = await api.resolveCorrection(id, status);
      onToast(r.message || `已${status === "promoted" ? "晋升" : "丢弃"} ${id}`);
      onResolved();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function markRaw(path: string, status: "compiled" | "archived" | "rejected") {
    setBusy(path);
    try {
      await api.setRawStatus(`raw/${path}`, status);
      onToast(`已标记「${RAW_ACTION_LABEL[status]}」：${path.split("/").pop()}`);
      onResolved();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function deprecateEvent(id: string) {
    setBusy(id);
    try {
      await api.deprecateEvent(id);
      onToast(`已废弃 event ${id}（保留记录，不删除）`);
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
      <Section
        title="待处理的纠正 / 偏好"
        count={corr.length}
        hint="你纠正过 AI 或表达过偏好，但还没进 CRITICAL_FACTS，AI 可能还在犯。"
      >
        {corr.length === 0 ? (
          <p className="empty">队列已清空。</p>
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
                <button className="act promote" disabled={busy === c.id} onClick={() => resolve(c.id, "promoted")}>
                  晋升
                </button>
                <button className="act reject" disabled={busy === c.id} onClick={() => resolve(c.id, "rejected")}>
                  丢弃
                </button>
              </div>
            </div>
          ))
        )}
      </Section>

      <Section
        title="未编译的源材料"
        count={raw.length}
        hint="raw/ 里还没编译进 wiki、也没标 status: compiled 的文件。点条目可直接打开查看。"
      >
        {raw.length === 0 ? (
          <p className="empty">全部已编译或归档。</p>
        ) : (
          <>
            {raw.slice(0, rawLimit).map((r) => (
              <div className="card" key={r.path}>
                <div className="card-head">
                  <span className="badge">{r.category}</span>
                  <span className="age">{ageText(r.age_days)}</span>
                </div>
                <div className="sub link" onClick={() => onOpenPage(`raw/${r.path}`)}>
                  {r.path}
                </div>
                <div className="actions">
                  <button className="act" disabled={busy === r.path} onClick={() => onOpenPage(`raw/${r.path}`)}>
                    查看
                  </button>
                  <button
                    className="act promote"
                    disabled={busy === r.path}
                    onClick={() => markRaw(r.path, "compiled")}
                  >
                    已编译
                  </button>
                  <button className="act" disabled={busy === r.path} onClick={() => markRaw(r.path, "archived")}>
                    归档
                  </button>
                  <button
                    className="act reject"
                    disabled={busy === r.path}
                    onClick={() => markRaw(r.path, "rejected")}
                  >
                    不要
                  </button>
                </div>
              </div>
            ))}
            {rawLimit < raw.length && (
              <button className="act more" onClick={() => setRawLimit(raw.length)}>
                展开剩余 {raw.length - rawLimit} 个
              </button>
            )}
            {rawLimit >= raw.length && raw.length > 12 && (
              <button className="act more" onClick={() => setRawLimit(12)}>
                收起
              </button>
            )}
          </>
        )}
      </Section>

      <Section title="晋升建议" count={promo.length} hint="promote-notes 对 quick-note / auto-draft 的分类打分。">
        {promo.length === 0 ? (
          <p className="empty">无建议。跑 llm-wiki-govern --force 可刷新。</p>
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
      </Section>

      <Section
        title="Event 过期候选"
        count={exp.length}
        hint={`共 ${report.event_total} 条 event。已过 ≥2 个半衰期（置信衰减到 1/4 以下）的列为候选。`}
        defaultOpen={false}
      >
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
          <p className="empty">无明显陈旧 event。</p>
        ) : (
          <>
            {exp.slice(0, expLimit).map((e) => (
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
                <div className="actions">
                  <button className="act reject" disabled={busy === e.id} onClick={() => deprecateEvent(e.id)}>
                    废弃
                  </button>
                  <span className="act-note">不删除，只标 deprecated 停止召回</span>
                </div>
              </div>
            ))}
            {expLimit < exp.length && (
              <button className="act more" onClick={() => setExpLimit(exp.length)}>
                展开剩余 {exp.length - expLimit} 条
              </button>
            )}
          </>
        )}
      </Section>
    </>
  );
}
