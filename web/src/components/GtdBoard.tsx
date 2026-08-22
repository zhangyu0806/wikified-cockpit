import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

interface Props {
  onToast: (msg: string, err?: boolean) => void;
}

interface LoopItem {
  line: number;
  raw: string;
  text: string;
  depth: number;
  done: boolean;
}

interface LoopGroup {
  title: string;
  items: LoopItem[];
}

const DONE_RE = /^\s*(?:[-*+]\s*)?(?:✅|✓|☑|\[x\]|\[X\]|~~)/;

function parse(md: string): LoopGroup[] {
  const groups: LoopGroup[] = [];
  let current: LoopGroup | null = null;
  const lines = md.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const heading = /^##\s+(.*)/.exec(raw);
    if (heading) {
      current = { title: (heading[1] ?? "").trim(), items: [] };
      groups.push(current);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)/.exec(raw);
    if (bullet && current) {
      const indent = (bullet[1] ?? "").replace(/\t/g, "  ").length;
      current.items.push({
        line: i,
        raw: raw.trimEnd(),
        text: (bullet[2] ?? "").replace(/^(?:✅|✓|☑|\[x\]|\[X\])\s*/, ""),
        depth: Math.min(3, Math.floor(indent / 2)),
        done: DONE_RE.test(raw),
      });
    }
  }
  return groups.filter((g) => g.items.length > 0);
}

function stripMd(text: string): string {
  return text.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
}

export function GtdBoard({ onToast }: Props) {
  const [groups, setGroups] = useState<LoopGroup[] | null>(null);
  const [exists, setExists] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.openLoops();
      setExists(r.exists);
      setGroups(parse(r.content));
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(item: LoopItem) {
    setBusy(item.line);
    try {
      const r = await api.toggleLoop(item.line, item.raw);
      onToast(r.done ? "已标记完成" : "已取消完成");
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
      setAdding(null);
      return;
    }
    try {
      await api.addLoop(group, text);
      onToast("已添加");
      setDraft("");
      setAdding(null);
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), true);
    }
  }

  if (!groups) return <div className="loading">加载中…</div>;
  if (!exists) return <div className="panel empty">open-loops.md 不存在。</div>;

  const totalOpen = groups.reduce((n, g) => n + g.items.filter((i) => !i.done).length, 0);
  const totalDone = groups.reduce((n, g) => n + g.items.filter((i) => i.done).length, 0);

  return (
    <>
      <div className="panel gtd-head">
        <div>
          <h2>
            Open Loops{" "}
            <span className="count">
              {totalOpen} 未闭环 · {totalDone} 已完成
            </span>
          </h2>
          <p className="hint">勾选即写回 open-loops.md（写前自动备份）。闭环后建议删除或移到对应 wiki 页。</p>
        </div>
        <label className="toggle-done">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          显示已完成
        </label>
      </div>

      {groups.map((g) => {
        const visible = showDone ? g.items : g.items.filter((i) => !i.done);
        return (
          <section className="panel loop-group" key={g.title}>
            <h3>
              {g.title}
              <span className="count">{g.items.filter((i) => !i.done).length} 未闭环</span>
            </h3>

            {visible.length === 0 ? (
              <p className="empty">本组已全部闭环。</p>
            ) : (
              visible.map((item) => (
                <div className={`loop-row depth-${item.depth} ${item.done ? "done" : ""}`} key={item.line}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={busy === item.line}
                    onChange={() => void toggle(item)}
                  />
                  <span className="loop-text">{stripMd(item.text)}</span>
                </div>
              ))
            )}

            {adding === g.title ? (
              <div className="add-row">
                <input
                  autoFocus
                  value={draft}
                  placeholder="新待办内容，回车提交"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitAdd(g.title);
                    if (e.key === "Escape") {
                      setAdding(null);
                      setDraft("");
                    }
                  }}
                />
                <button className="act" onClick={() => void submitAdd(g.title)}>
                  添加
                </button>
                <button
                  className="act"
                  onClick={() => {
                    setAdding(null);
                    setDraft("");
                  }}
                >
                  取消
                </button>
              </div>
            ) : (
              <button className="act add-btn" onClick={() => setAdding(g.title)}>
                + 加一条
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}
