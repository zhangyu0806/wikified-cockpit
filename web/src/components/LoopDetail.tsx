import { useEffect, useState } from "react";
import { api, type GtdTag, type LoopContext } from "../api/client";

export interface DetailTarget {
  line: number;
  raw: string;
  text: string;
  tag: GtdTag | null;
  done: boolean;
}

interface Props {
  target: DetailTarget;
  onBack: () => void;
  onOpenPage: (path: string) => void;
  onToast: (msg: string, err?: boolean) => void;
  onChanged: () => void;
}

const TAG_LABEL: Record<GtdTag, string> = {
  next: "下一步行动",
  project: "项目",
  wait: "等待中",
  someday: "将来也许",
  ref: "参考资料",
};

const ALL_TAGS: GtdTag[] = ["next", "project", "wait", "someday", "ref"];

function stripMd(text: string): string {
  return text.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
}

export function LoopDetail({ target, onBack, onOpenPage, onToast, onChanged }: Props) {
  const [ctx, setCtx] = useState<LoopContext | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .loopContext(target.line)
      .then(setCtx)
      .catch((e) => onToast(e instanceof Error ? e.message : String(e), true));
  }, [target.line, onToast]);

  async function act(fn: () => Promise<unknown>, msg: string, back: boolean) {
    setBusy(true);
    try {
      await fn();
      onToast(msg);
      onChanged();
      if (back) onBack();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  const actionable = target.tag === "next" || target.tag === "project" || target.tag === null;

  return (
    <>
      <div className="panel detail-head">
        <button className="act back-btn" onClick={onBack}>
          ← 返回列表
        </button>
        <span className="detail-crumb">
          GTD{ctx?.group ? ` / ${ctx.group}` : ""} / 第 {target.line + 1} 行
        </span>
      </div>

      <section className="panel">
        <h2 className="detail-title">{stripMd(target.text)}</h2>
        <div className="detail-badges">
          {target.tag ? (
            <span className={`badge tag-badge-${target.tag}`}>{TAG_LABEL[target.tag]}</span>
          ) : (
            <span className="badge">未厘清</span>
          )}
          {target.done && <span className="badge">已完成</span>}
        </div>

        <div className="detail-actions">
          {actionable && (
            <button
              className={`act ${target.done ? "" : "promote"}`}
              disabled={busy}
              onClick={() =>
                act(
                  () => api.toggleLoop(target.line, target.raw),
                  target.done ? "已取消完成" : "已标记完成",
                  true,
                )
              }
            >
              {target.done ? "取消完成" : "标记完成"}
            </button>
          )}
          {target.tag === "wait" && (
            <button
              className="act promote"
              disabled={busy}
              onClick={() => act(() => api.classifyLoop(target.line, target.raw, "next"), "结果已到，转为下一步行动", true)}
            >
              结果已到
            </button>
          )}
          {target.tag === "someday" && (
            <button
              className="act promote"
              disabled={busy}
              onClick={() => act(() => api.classifyLoop(target.line, target.raw, "next"), "转为下一步行动", true)}
            >
              现在做
            </button>
          )}
          {target.tag === "ref" && (
            <button
              className="act reject"
              disabled={busy}
              onClick={() => act(() => api.removeLoop(target.line, target.raw), "已移出未闭环清单", true)}
            >
              已归档移出
            </button>
          )}
        </div>

        <div className="detail-block">
          <div className="detail-label">改为其他类型</div>
          <div className="detail-actions">
            {ALL_TAGS.filter((t) => t !== target.tag).map((t) => (
              <button
                key={t}
                className={`act tag-${t}`}
                disabled={busy}
                onClick={() => act(() => api.classifyLoop(target.line, target.raw, t), `归入「${TAG_LABEL[t]}」`, true)}
              >
                {TAG_LABEL[t]}
              </button>
            ))}
            {target.tag && (
              <button
                className="act"
                disabled={busy}
                onClick={() => act(() => api.classifyLoop(target.line, target.raw, null), "已放回收集箱", true)}
              >
                放回收集箱
              </button>
            )}
          </div>
        </div>
      </section>

      {ctx && (
        <>
          {ctx.parent && (
            <section className="panel">
              <div className="detail-label">所属父项</div>
              <div className="detail-text">{stripMd(ctx.parent.replace(/^[-*+]\s*/, ""))}</div>
            </section>
          )}

          {ctx.children.length > 0 && (
            <section className="panel">
              <div className="detail-label">子项（{ctx.children.length}）</div>
              {ctx.children.map((c, i) => (
                <div className="detail-text" key={i}>
                  · {stripMd(c.replace(/^[-*+]\s*/, ""))}
                </div>
              ))}
            </section>
          )}

          <section className="panel">
            <div className="detail-label">相关知识页</div>
            {ctx.related.length === 0 ? (
              <p className="empty">没找到相关页。</p>
            ) : (
              ctx.related.map((r) => (
                <div key={r.title} className="related-row">
                  {r.path ? (
                    <span className="loop-link" onClick={() => onOpenPage(r.path!)}>
                      {r.title}
                    </span>
                  ) : (
                    <span className="detail-text">{r.title}</span>
                  )}
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <div className="detail-label">原文（open-loops.md）</div>
            <code className="detail-raw">{ctx.self}</code>
          </section>
        </>
      )}
    </>
  );
}
