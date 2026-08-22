import { useEffect, useState } from "react";
import { api } from "../api/client";

interface Props {
  onToast: (msg: string, err?: boolean) => void;
}

interface LoopGroup {
  title: string;
  items: { text: string; done: boolean }[];
}

const DONE_RE = /^\s*(?:[-*+]\s*)?(?:✅|✓|☑|\[x\]|\[X\]|~~)/;

function parseOpenLoops(md: string): LoopGroup[] {
  const groups: LoopGroup[] = [];
  let current: LoopGroup | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const heading = line.match(/^##\s+(.*)/);
    if (heading) {
      current = { title: heading[1] ?? "", items: [] };
      groups.push(current);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)/);
    if (bullet && current) {
      const text = bullet[1] ?? "";
      current.items.push({ text, done: DONE_RE.test(line) });
    }
  }
  return groups.filter((g) => g.items.length > 0);
}

export function GtdBoard({ onToast }: Props) {
  const [groups, setGroups] = useState<LoopGroup[] | null>(null);
  const [exists, setExists] = useState(true);

  useEffect(() => {
    api
      .openLoops()
      .then((r) => {
        setExists(r.exists);
        setGroups(parseOpenLoops(r.content));
      })
      .catch((e) => onToast(e instanceof Error ? e.message : String(e), true));
  }, [onToast]);

  if (!groups) return <div className="loading">加载中…</div>;
  if (!exists) return <div className="panel empty">open-loops.md 不存在。</div>;

  return (
    <>
      <div className="panel">
        <h2>Open Loops 看板</h2>
        <p className="hint">
          按 open-loops.md 的 `##` 分组展示；✅/[x] 标记为完成。编辑仍回到文件本身（Obsidian / CLI），
          这里是只读总览。
        </p>
      </div>
      <div className="board">
        {groups.map((g, i) => (
          <div className="board-col" key={i}>
            <h3>{g.title}</h3>
            {g.items.map((it, j) => (
              <div className="loop-item" key={j} style={it.done ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                {it.text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
