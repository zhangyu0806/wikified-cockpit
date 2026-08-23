import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import MarkdownIt from "markdown-it";
import { api } from "../api/client";

interface Props {
  initialPath: string | null;
  onNavigate: (path: string) => void;
  onBack: () => void;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function slugToPath(target: string, pages: string[]): string | null {
  const needle = target.trim().toLowerCase();
  for (const p of pages) {
    const base = p.replace(/^wiki\//, "").replace(/\.md$/, "");
    if (base.toLowerCase() === needle) return p;
    const leaf = base.split("/").pop() ?? base;
    if (leaf.toLowerCase() === needle) return p;
  }
  return null;
}

function renderMarkdown(content: string, pages: string[]): string {
  const withLinks = content.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const parts = inner.split("|");
    const target = parts[0] ?? inner;
    const label = parts[1] ?? target;
    const resolved = slugToPath(target, pages);
    const cls = resolved ? "wikilink" : "wikilink missing";
    return `<a class="${cls}" data-wikipath="${resolved ?? ""}">${label}</a>`;
  });
  return md.render(withLinks);
}

function groupOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "raw") return `raw/${parts[1] ?? ""}`;
  return parts.length > 2 ? (parts[1] ?? "wiki") : "wiki";
}

function leafOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function Reader({ initialPath, onNavigate, onBack }: Props) {
  const [pages, setPages] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(initialPath);
  const [content, setContent] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    api
      .tree()
      .then((r) => setPages(r.pages))
      .catch(() => setPages([]));
  }, []);

  useEffect(() => {
    setPath(initialPath);
    if (initialPath) {
      const grp = groupOf(initialPath);
      setCollapsed((prev) => {
        if (!prev.has(grp)) return prev;
        const next = new Set(prev);
        next.delete(grp);
        return next;
      });
    }
  }, [initialPath]);

  // 文件树有 270+ 条，选中项常在滚动区外；跳转后把它滚进视野。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [path, collapsed, filter]);

  useEffect(() => {
    if (!path) {
      setContent("");
      setErr(null);
      return;
    }
    api
      .page(path)
      .then((r) => {
        setContent(r.content);
        setErr(null);
      })
      .catch((e) => {
        setContent("");
        setErr(e instanceof Error ? e.message : String(e));
      });
  }, [path]);

  const html = useMemo(() => (content ? renderMarkdown(content, pages) : ""), [content, pages]);

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const g = new Map<string, string[]>();
    for (const p of pages) {
      if (needle && !p.toLowerCase().includes(needle)) continue;
      const key = groupOf(p);
      const list = g.get(key);
      if (list) list.push(p);
      else g.set(key, [p]);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pages, filter]);

  function open(p: string) {
    setPath(p);
    onNavigate(p);
  }

  function toggleGroup(grp: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(grp)) next.delete(grp);
      else next.add(grp);
      return next;
    });
  }

  function onContentClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    if (el.tagName === "A" && el.classList.contains("wikilink")) {
      e.preventDefault();
      const target = el.getAttribute("data-wikipath");
      if (target) open(target);
    }
  }

  return (
    <div className="reader">
      <nav className="filetree">
        <input
          className="tree-filter"
          value={filter}
          placeholder="过滤文件名…"
          onChange={(e) => setFilter(e.target.value)}
        />
        {grouped.length === 0 ? (
          <p className="empty">无匹配文件。</p>
        ) : (
          grouped.map(([grp, ps]) => {
            const isCollapsed = collapsed.has(grp) && !filter.trim();
            const hasActive = path !== null && ps.includes(path);
            return (
              <div key={grp}>
                <button className={`grp ${hasActive ? "has-active" : ""}`} onClick={() => toggleGroup(grp)}>
                  <span className="grp-caret">{isCollapsed ? "▸" : "▾"}</span>
                  {grp} <span className="grp-count">{ps.length}</span>
                </button>
                {!isCollapsed &&
                  ps.map((p) => (
                    <a
                      key={p}
                      ref={p === path ? activeRef : null}
                      className={p === path ? "active" : ""}
                      onClick={() => open(p)}
                      title={p}
                    >
                      {leafOf(p)}
                    </a>
                  ))}
              </div>
            );
          })
        )}
      </nav>

      <div className="markdown" onClick={onContentClick}>
        {path && (
          <div className="reader-head">
            <button className="act back-btn" onClick={onBack}>
              ← 返回
            </button>
            <span className="crumb">{path}</span>
          </div>
        )}
        {err && (
          <div className="state-box error-box">
            <div className="state-title">打不开这个页面</div>
            <div className="state-msg">{err}</div>
            <div className="state-hint">路径：{path}</div>
          </div>
        )}
        {!path && (
          <div className="state-box">
            <div className="state-title">选一页开始</div>
            <div className="state-msg">从左侧文件树选择，或在「复盘」里点条目跳过来。</div>
          </div>
        )}
        {path && !err && <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  );
}
