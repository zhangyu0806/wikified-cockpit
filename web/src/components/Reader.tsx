import { useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { api } from "../api/client";

interface Props {
  initialPath: string | null;
  onNavigate: (path: string) => void;
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
    const label = inner.includes("|") ? inner.split("|")[1] : inner;
    const target = inner.split("|")[0] ?? inner;
    const resolved = slugToPath(target ?? "", pages);
    const cls = resolved ? "wikilink" : "wikilink missing";
    const dataPath = resolved ?? "";
    return `<a class="${cls}" data-wikipath="${dataPath}">${label}</a>`;
  });
  return md.render(withLinks);
}

export function Reader({ initialPath, onNavigate }: Props) {
  const [pages, setPages] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(initialPath);
  const [content, setContent] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.tree().then((r) => setPages(r.pages)).catch(() => setPages([]));
  }, []);

  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);

  useEffect(() => {
    if (!path) {
      setContent("");
      return;
    }
    api
      .page(path)
      .then((r) => {
        setContent(r.content);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [path]);

  const html = useMemo(() => (content ? renderMarkdown(content, pages) : ""), [content, pages]);

  const grouped = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const p of pages) {
      const parts = p.replace(/^wiki\//, "").split("/");
      const grp = parts.length > 1 ? parts[0]! : "root";
      (g[grp] ??= []).push(p);
    }
    return g;
  }, [pages]);

  function onContentClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    if (el.tagName === "A" && el.classList.contains("wikilink")) {
      const target = el.getAttribute("data-wikipath");
      if (target) {
        setPath(target);
        onNavigate(target);
      }
      e.preventDefault();
    }
  }

  return (
    <div className="reader">
      <nav className="filetree">
        {Object.entries(grouped)
          .sort()
          .map(([grp, ps]) => (
            <div key={grp}>
              <div className="grp">{grp}</div>
              {ps.map((p) => (
                <a
                  key={p}
                  className={p === path ? "active" : ""}
                  onClick={() => {
                    setPath(p);
                    onNavigate(p);
                  }}
                >
                  {p.replace(/^wiki\//, "").replace(/\.md$/, "").split("/").pop()}
                </a>
              ))}
            </div>
          ))}
      </nav>
      <div className="markdown" onClick={onContentClick}>
        {err && <div className="error">{err}</div>}
        {!path && <p className="empty">从左侧选一页，或在复盘/GTD 里点开链接。</p>}
        {path && !err && <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  );
}
