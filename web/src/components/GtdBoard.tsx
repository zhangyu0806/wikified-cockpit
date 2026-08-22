import { useCallback, useEffect, useState } from "react";
import { api, type GtdTag } from "../api/client";

interface Props {
  onToast: (msg: string, err?: boolean) => void;
  onOpenPage: (path: string) => void;
}

interface LoopItem {
  line: number;
  raw: string;
  text: string;
  depth: number;
  done: boolean;
  tag: GtdTag | null;
  group: string;
}

const DONE_RE = /^\s*(?:[-*+]\s*)?(?:✅|✓|☑|\[x\]|\[X\]|~~)/;
const TAG_RE = /@(next|wait|someday|ref|project)\b/i;

interface Bucket {
  tag: GtdTag;
  label: string;
  desc: string;
  actionable: boolean;
}

const BUCKETS: Bucket[] = [
  { tag: "next", label: "下一步行动", desc: "能立刻动手的单步任务", actionable: true },
  { tag: "project", label: "项目", desc: "需要多步才能完成，得拆出下一步", actionable: true },
  { tag: "wait", label: "等待中", desc: "已交出去/等外部结果，定期查", actionable: false },
  { tag: "someday", label: "将来也许", desc: "现在不做，但不想忘", actionable: false },
  { tag: "ref", label: "参考资料", desc: "不是任务，是备查信息", actionable: false },
];

const BUCKET_BY_TAG = new Map(BUCKETS.map((b) => [b.tag, b]));

function parse(md: string): LoopItem[] {
  const items: LoopItem[] = [];
  let group = "";
  const lines = md.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const heading = /^##\s+(.*)/.exec(raw);
    if (heading) {
      group = (heading[1] ?? "").trim();
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)/.exec(raw);
    if (!bullet) continue;
    const indent = (bullet[1] ?? "").replace(/\t/g, "  ").length;
    const body = bullet[2] ?? "";
    const tagMatch = TAG_RE.exec(body);
    items.push({
      line: i,
      raw: raw.trimEnd(),
      text: body
        .replace(/^(?:✅|✓|☑|\[x\]|\[X\])\s*/, "")
        .replace(TAG_RE, "")
        .trim(),
      depth: Math.min(3, Math.floor(indent / 2)),
      done: DONE_RE.test(raw),
      tag: tagMatch ? (tagMatch[1]?.toLowerCase() as GtdTag) : null,
      group,
    });
  }
  return items;
}

function stripMd(text: string): string {
  return text.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
}

/**
 * 把条目文本里的可跳线索切成片段，让审核时能点开背景，而不是只盯一行字。
 * 三类线索：[[wikilink]]、反引号里的 wiki/ 路径、以及能对上 wiki 页名的项目名。
 */
function linkify(text: string, pages: string[]): { text: string; path?: string }[] {
  const byLeaf = new Map<string, string>();
  for (const p of pages) {
    const leaf = (p.split("/").pop() ?? p).replace(/\.md$/, "").toLowerCase();
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, p);
  }

  const pattern = /\[\[([^\]]+)\]\]|`([^`]*\.md)`|`([^`]+)`|([A-Za-z][A-Za-z0-9-]{2,})/g;
  const out: { text: string; path?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    const [whole, wikilink, mdPath, code, word] = m;
    const token = wikilink ?? mdPath ?? word;
    if (!token) continue;

    let resolved: string | undefined;
    if (mdPath) {
      resolved = pages.find((p) => p.endsWith(mdPath.replace(/^.*?(wiki\/)/, "$1"))) ?? undefined;
    } else if (wikilink) {
      resolved = byLeaf.get(wikilink.split("|")[0]?.trim().toLowerCase() ?? "");
    } else if (word) {
      resolved = byLeaf.get(word.toLowerCase());
    }
    if (!resolved) continue;

    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: wikilink ?? mdPath ?? code ?? word ?? whole, path: resolved });
    last = m.index + whole.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length > 0 ? out : [{ text }];
}

export function GtdBoard({ onToast, onOpenPage }: Props) {
  const [items, setItems] = useState<LoopItem[] | null>(null);
  const [exists, setExists] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [pages, setPages] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api.openLoops();
      setExists(r.exists);
      setItems(parse(r.content));
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .tree()
      .then((r) => setPages(r.pages))
      .catch(() => setPages([]));
  }, []);

  function renderText(text: string) {
    return linkify(stripMd(text), pages).map((seg, i) =>
      seg.path ? (
        <span
          key={i}
          className="loop-link"
          title={`打开 ${seg.path}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenPage(seg.path!);
          }}
        >
          {seg.text}
        </span>
      ) : (
        <span key={i}>{seg.text}</span>
      ),
    );
  }

  async function remove(item: LoopItem) {
    setBusy(item.line);
    try {
      const r = await api.removeLoop(item.line, item.raw);
      onToast(r.removed > 1 ? `已移出（含 ${r.removed - 1} 个子项）` : "已移出未闭环清单");
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function classify(item: LoopItem, tag: GtdTag | null) {
    setBusy(item.line);
    try {
      await api.classifyLoop(item.line, item.raw, tag);
      onToast(tag ? `归入「${BUCKET_BY_TAG.get(tag)?.label}」` : "已取消分类");
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(item: LoopItem) {
    setBusy(item.line);
    try {
      const r = await api.toggleLoop(item.line, item.raw);
      onToast(r.done ? "已完成" : "已取消完成");
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function submitAdd(group: string) {
    const text = draft.trim();
    if (!text) {
      setAdding(false);
      return;
    }
    try {
      await api.addLoop(group, text);
      onToast("已捕获到收集箱，记得厘清它");
      setDraft("");
      setAdding(false);
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    }
  }

  if (!items) return <div className="loading">加载中…</div>;
  if (!exists) return <div className="panel empty">open-loops.md 不存在。</div>;

  const live = showDone ? items : items.filter((i) => !i.done);
  const inbox = live.filter((i) => i.tag === null);
  const firstGroup = items.find((i) => i.group)?.group ?? "";

  return (
    <>
      <div className="panel gtd-head">
        <div>
          <h2>
            GTD 工作流{" "}
            <span className="count">
              收集箱 {inbox.length} · 已厘清 {live.length - inbox.length}
            </span>
          </h2>
          <p className="hint">
            捕获 → <strong>厘清</strong>（判定类型）→ 整理（自动归类）→ 回顾 → 执行。
            分类写回 open-loops.md 的 <code>@标记</code>，Obsidian 里照常可读。
          </p>
        </div>
        <label className="toggle-done">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          显示已完成
        </label>
      </div>

      <section className="panel">
        <h3 className="bucket-title">
          收集箱 <span className="count">{inbox.length} 待厘清</span>
        </h3>
        <p className="hint">
          GTD 的核心一步：这条<strong>是可执行的行动吗</strong>？选一个类型，它就离开收集箱。
        </p>
        {inbox.length === 0 ? (
          <p className="empty">收集箱已清空 —— 每条都厘清过了。</p>
        ) : (
          inbox.map((item) => (
            <div className={`clarify-card depth-${item.depth}`} key={item.line}>
              <div className="clarify-text">{renderText(item.text)}</div>
              {item.group && <div className="clarify-src">来自：{item.group}</div>}
              <div className="clarify-actions">
                {BUCKETS.map((b) => (
                  <button
                    key={b.tag}
                    className={`act tag-${b.tag}`}
                    disabled={busy === item.line}
                    title={b.desc}
                    onClick={() => void classify(item, b.tag)}
                  >
                    {b.label}
                  </button>
                ))}
                <button className="act reject" disabled={busy === item.line} onClick={() => void toggle(item)}>
                  完成/丢弃
                </button>
              </div>
            </div>
          ))
        )}

        {adding ? (
          <div className="add-row">
            <input
              autoFocus
              value={draft}
              placeholder="捕获一条新的（先不用想类型，回车提交）"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitAdd(firstGroup);
                if (e.key === "Escape") {
                  setAdding(false);
                  setDraft("");
                }
              }}
            />
            <button className="act" onClick={() => void submitAdd(firstGroup)}>
              捕获
            </button>
            <button
              className="act"
              onClick={() => {
                setAdding(false);
                setDraft("");
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <button className="act add-btn" onClick={() => setAdding(true)}>
            + 捕获一条
          </button>
        )}
      </section>

      {BUCKETS.map((b) => {
        const bucketItems = live.filter((i) => i.tag === b.tag);
        if (bucketItems.length === 0) return null;
        return (
          <section className={`panel bucket bucket-${b.tag}`} key={b.tag}>
            <h3 className="bucket-title">
              {b.label} <span className="count">{bucketItems.length}</span>
            </h3>
            <p className="hint">{b.desc}</p>
            {bucketItems.map((item) => (
              <div className={`loop-row depth-${item.depth} ${item.done ? "done" : ""}`} key={item.line}>
                {b.actionable ? (
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={busy === item.line}
                    onChange={() => void toggle(item)}
                    title="标记完成"
                  />
                ) : (
                  <span className="no-check" title="非行动项，没有完成态" />
                )}
                <span className="loop-text">{renderText(item.text)}</span>
                <span className="row-actions">
                  {b.tag === "wait" && (
                    <button
                      className="act tiny tag-next"
                      disabled={busy === item.line}
                      title="结果已到，转成可执行的下一步行动"
                      onClick={() => void classify(item, "next")}
                    >
                      结果已到
                    </button>
                  )}
                  {b.tag === "someday" && (
                    <button
                      className="act tiny tag-next"
                      disabled={busy === item.line}
                      title="现在要做了，转成下一步行动"
                      onClick={() => void classify(item, "next")}
                    >
                      现在做
                    </button>
                  )}
                  {b.tag === "project" && (
                    <button
                      className="act tiny tag-next"
                      disabled={busy === item.line}
                      title="已拆出单步任务，转成下一步行动"
                      onClick={() => void classify(item, "next")}
                    >
                      已拆解
                    </button>
                  )}
                  {b.tag === "ref" && (
                    <button
                      className="act tiny reject"
                      disabled={busy === item.line}
                      title="已归入 wiki 页，从未闭环清单移出"
                      onClick={() => void remove(item)}
                    >
                      已归档移出
                    </button>
                  )}
                  <button
                    className="act tiny"
                    disabled={busy === item.line}
                    title="重新厘清（放回收集箱）"
                    onClick={() => void classify(item, null)}
                  >
                    重分类
                  </button>
                </span>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
