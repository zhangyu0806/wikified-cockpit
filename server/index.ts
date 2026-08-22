/**
 * Wikified Cockpit —— 本机复盘 + GTD 驾驶舱后端。
 *
 * 设计原则:
 *   1. CLI 是唯一事实源。本 server 只是薄壳:审批走 llm-wiki-correct，复盘数据走
 *      llm-wiki-review --json。绝不在此重实现记忆逻辑。server 挂了 CLI 照常工作。
 *   2. 只绑 127.0.0.1。不暴露到 0.0.0.0。WSL2 下 Windows 经 localhost 转发访问。
 *   3. 白名单执行。只跑固定的 llm-wiki-* 子命令，参数用数组传给 execFile(不拼 shell)，
 *      从根上杜绝命令注入。
 *   4. 路径囚笼。MD 只读端点把路径 resolve 后必须仍在 ~/llm-wiki 内，且拒绝 secure-notes。
 *   5. 不碰 secret。沿用 CLI 自身的 redact；本 server 不读 ~/secure-notes。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve, sep, extname } from "node:path";
import { readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

const HOST = "127.0.0.1";
const PORT = Number(process.env.COCKPIT_PORT || 4177);
const WIKI_ROOT = resolve(process.env.LLM_WIKI_ROOT || join(homedir(), "llm-wiki"));
const BIN_DIR = process.env.LLM_WIKI_BIN_TARGET || join(homedir(), ".local", "bin");
const DIST_DIR = resolve(join(import.meta.dir, "..", "dist"));

// 白名单:命令名 -> 允许的绝对路径。参数在各 handler 内校验后以数组传入。
const CLI = {
  review: join(BIN_DIR, "llm-wiki-review"),
  correct: join(BIN_DIR, "llm-wiki-correct"),
  health: join(BIN_DIR, "llm-wiki-health"),
} as const;

const CLI_TIMEOUT_MS = 15_000;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** 执行白名单 CLI；args 必须是已校验的字符串数组，绝不经过 shell。 */
async function runCli(bin: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (!existsSync(bin)) {
    return { ok: false, stdout: "", stderr: `CLI not found: ${bin}` };
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LLM_WIKI_ROOT: WIKI_ROOT },
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "unknown error" };
  }
}

/** 12 位十六进制 correction id 校验。防止任意串被当参数传给 CLI。 */
function isValidCorrectionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{12}$/.test(id);
}

/**
 * 把用户给的相对路径 resolve 到 WIKI_ROOT 下，并确保:
 *   - 结果仍在 WIKI_ROOT 内(防 ../ 逃逸)
 *   - 是 .md 文件
 *   - 不在 secure-notes 或任何点目录下
 * 返回绝对路径,非法则返回 null。
 */
function safeWikiPath(relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.includes("\0")) return null;
  const abs = resolve(WIKI_ROOT, relPath);
  // 必须严格在 WIKI_ROOT 内(加 sep 防止 /foo 前缀匹配 /foobar)
  if (abs !== WIKI_ROOT && !abs.startsWith(WIKI_ROOT + sep)) return null;
  if (extname(abs).toLowerCase() !== ".md") return null;
  const lower = abs.toLowerCase();
  if (lower.includes("secure-notes") || lower.includes(`${sep}.`)) return null;
  return abs;
}

// ---------- API handlers ----------

async function handleReview(): Promise<Response> {
  const r = await runCli(CLI.review, ["--json", "--peek"]);
  if (!r.ok) return errorResponse(`review failed: ${r.stderr}`, 500);
  try {
    return jsonResponse(JSON.parse(r.stdout));
  } catch {
    return errorResponse("review 输出非合法 JSON", 500);
  }
}

async function handleResolve(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { id, status } = (body ?? {}) as { id?: unknown; status?: unknown };
  if (!isValidCorrectionId(id)) return errorResponse("非法 correction id");
  const st = status === "rejected" ? "rejected" : "promoted";
  const r = await runCli(CLI.correct, ["--resolve", id, "--status", st]);
  if (!r.ok) return errorResponse(`resolve 失败: ${r.stderr}`, 500);
  return jsonResponse({ ok: true, id, status: st, message: r.stdout.trim() });
}

function openLoopsPath(): string {
  return join(WIKI_ROOT, "wiki", "context", "open-loops.md");
}

async function handleOpenLoops(): Promise<Response> {
  const p = openLoopsPath();
  if (!existsSync(p)) return jsonResponse({ exists: false, content: "" });
  const content = await readFile(p, "utf-8");
  return jsonResponse({ exists: true, content });
}

/**
 * open-loops.md 是唯一可写文件（白名单硬编码，不接受调用方传路径）。
 * 每次写入前先备份到同目录 .open-loops.bak，配合 llm-wiki 自身的 git 兜底。
 */
async function writeOpenLoops(lines: string[]): Promise<void> {
  const p = openLoopsPath();
  if (existsSync(p)) {
    await copyFile(p, join(WIKI_ROOT, "wiki", "context", ".open-loops.bak"));
  }
  await writeFile(p, lines.join("\n"), "utf-8");
}

const DONE_MARK_RE = /^(\s*[-*+]\s*)(?:✅|✓|☑|\[x\]|\[X\])\s*/;

/**
 * 勾选/取消勾选某一行。用「行号 + 该行当前文本」双重校验：
 * 行号可能因并发编辑漂移，文本比对能在漂移时拒绝写入而不是改错行。
 */
async function handleToggleLoop(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { line, expect } = (body ?? {}) as { line?: unknown; expect?: unknown };
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
    return errorResponse("非法行号");
  }
  if (typeof expect !== "string") return errorResponse("缺少 expect（该行当前文本）");

  const p = openLoopsPath();
  if (!existsSync(p)) return errorResponse("open-loops.md 不存在", 404);
  const lines = (await readFile(p, "utf-8")).split("\n");
  const target = lines[line];
  if (target === undefined) return errorResponse("行号越界", 409);
  if (target.trimEnd() !== expect.trimEnd()) {
    return errorResponse("文件已变更（该行内容与预期不符），请刷新后重试", 409);
  }

  const marked = DONE_MARK_RE.exec(target);
  lines[line] = marked
    ? `${marked[1]}${target.slice(marked[0].length)}`
    : target.replace(/^(\s*[-*+]\s*)/, "$1✅ ");
  await writeOpenLoops(lines);
  return jsonResponse({ ok: true, line, text: lines[line], done: !marked });
}

const GTD_TAGS = ["next", "wait", "someday", "ref", "project"] as const;
const GTD_TAG_RE = /@(next|wait|someday|ref|project)\b\s*/gi;

/**
 * 给某行打 GTD 类型标记（@next/@wait/@someday/@ref/@project）。
 * 标记写在 bullet 正文开头，Obsidian 里照常可读，且不匹配注入侧的
 * strip_next_actions / drop_done_lines 正则，所以召回行为完全不变。
 * tag 传 null 表示清除分类。
 */
async function handleClassifyLoop(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { line, expect, tag } = (body ?? {}) as { line?: unknown; expect?: unknown; tag?: unknown };
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
    return errorResponse("非法行号");
  }
  if (typeof expect !== "string") return errorResponse("缺少 expect（该行当前文本）");
  if (tag !== null && (typeof tag !== "string" || !GTD_TAGS.includes(tag as (typeof GTD_TAGS)[number]))) {
    return errorResponse(`tag 必须是 ${GTD_TAGS.join(" / ")} 或 null`);
  }

  const p = openLoopsPath();
  if (!existsSync(p)) return errorResponse("open-loops.md 不存在", 404);
  const lines = (await readFile(p, "utf-8")).split("\n");
  const target = lines[line];
  if (target === undefined) return errorResponse("行号越界", 409);
  if (target.trimEnd() !== expect.trimEnd()) {
    return errorResponse("文件已变更（该行内容与预期不符），请刷新后重试", 409);
  }

  const bullet = /^(\s*[-*+]\s*)([\s\S]*)$/.exec(target);
  if (!bullet) return errorResponse("该行不是列表项", 409);
  const prefix = bullet[1] ?? "";
  const doneMark = /^((?:✅|✓|☑|\[x\]|\[X\])\s*)?/.exec(bullet[2] ?? "");
  const done = doneMark?.[1] ?? "";
  const bare = (bullet[2] ?? "").slice(done.length).replace(GTD_TAG_RE, "").trimStart();

  lines[line] = tag === null ? `${prefix}${done}${bare}` : `${prefix}${done}@${tag} ${bare}`;
  await writeOpenLoops(lines);
  return jsonResponse({ ok: true, line, text: lines[line], tag });
}

/**
 * 从 open-loops.md 删掉某一行（含其缩进子项）。
 * 用于「参考资料已移进 wiki 页」这类毕业场景 —— 它不该继续占着未闭环清单。
 * 同一套乐观锁；删除范围包含后续更深缩进的子行，避免留下孤儿子项。
 */
async function handleRemoveLoop(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { line, expect } = (body ?? {}) as { line?: unknown; expect?: unknown };
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
    return errorResponse("非法行号");
  }
  if (typeof expect !== "string") return errorResponse("缺少 expect（该行当前文本）");

  const p = openLoopsPath();
  if (!existsSync(p)) return errorResponse("open-loops.md 不存在", 404);
  const lines = (await readFile(p, "utf-8")).split("\n");
  const target = lines[line];
  if (target === undefined) return errorResponse("行号越界", 409);
  if (target.trimEnd() !== expect.trimEnd()) {
    return errorResponse("文件已变更（该行内容与预期不符），请刷新后重试", 409);
  }

  const indentOf = (s: string): number => (/^(\s*)/.exec(s)?.[1] ?? "").replace(/\t/g, "  ").length;
  const baseIndent = indentOf(target);
  let end = line + 1;
  while (end < lines.length) {
    const cur = lines[end] ?? "";
    if (!/^\s*[-*+]\s/.test(cur)) break;
    if (indentOf(cur) <= baseIndent) break;
    end += 1;
  }

  const removed = end - line;
  lines.splice(line, removed);
  await writeOpenLoops(lines);
  return jsonResponse({ ok: true, line, removed });
}

const RAW_STATUSES = new Set(["compiled", "archived", "rejected"]);

/**
 * 只改 raw/ 下 md 的 frontmatter status，正文一律不动。
 * 路径必须 resolve 在 WIKI_ROOT/raw 内（与只读端点同一套囚笼逻辑，额外收紧到 raw/）。
 */
async function handleRawStatus(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { path: rel, status } = (body ?? {}) as { path?: unknown; status?: unknown };
  if (typeof status !== "string" || !RAW_STATUSES.has(status)) {
    return errorResponse(`status 必须是 ${[...RAW_STATUSES].join(" / ")}`);
  }
  const abs = safeWikiPath(typeof rel === "string" ? rel : "");
  const rawDir = join(WIKI_ROOT, "raw");
  if (!abs || (abs !== rawDir && !abs.startsWith(rawDir + sep))) {
    return errorResponse("只能修改 raw/ 下的 md", 403);
  }
  if (!existsSync(abs)) return errorResponse("文件不存在", 404);

  const original = await readFile(abs, "utf-8");
  await writeFile(`${abs}.bak`, original, "utf-8");

  let updated: string;
  if (original.startsWith("---\n")) {
    const end = original.indexOf("\n---\n", 4);
    if (end === -1) return errorResponse("frontmatter 未闭合，拒绝改写", 409);
    const fm = original.slice(4, end);
    const rest = original.slice(end + 5);
    const lines = fm.split("\n");
    const idx = lines.findIndex((l) => /^status\s*:/i.test(l));
    if (idx >= 0) lines[idx] = `status: ${status}`;
    else lines.push(`status: ${status}`);
    updated = `---\n${lines.join("\n")}\n---\n${rest}`;
  } else {
    updated = `---\nstatus: ${status}\n---\n\n${original}`;
  }
  await writeFile(abs, updated, "utf-8");
  return jsonResponse({ ok: true, path: rel, status });
}

/**
 * 把某条 event 的 lifecycle 标为 deprecated —— 不删除、不改摘要，保留审计痕迹。
 * 逐行重写 JSONL：只有 id 命中的那行被替换，其余原样写回。
 */
async function handleDeprecateEvent(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { id } = (body ?? {}) as { id?: unknown };
  if (typeof id !== "string" || !/^[0-9a-f]{8,32}$/.test(id)) {
    return errorResponse("非法 event id");
  }

  const eventsDir = join(WIKI_ROOT, "memory", "events");
  if (!existsSync(eventsDir)) return errorResponse("events 目录不存在", 404);
  const files = (await readdir(eventsDir)).filter((f) => f.endsWith(".jsonl"));

  for (const f of files) {
    const abs = join(eventsDir, f);
    const text = await readFile(abs, "utf-8");
    const lines = text.split("\n");
    let hit = false;
    const out = lines.map((line) => {
      if (!line.trim() || hit) return line;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row["id"] !== id) return line;
        hit = true;
        row["lifecycle"] = "deprecated";
        row["deprecated_at"] = new Date().toISOString();
        return JSON.stringify(row);
      } catch {
        return line;
      }
    });
    if (hit) {
      await writeFile(`${abs}.bak`, text, "utf-8");
      await writeFile(abs, out.join("\n"), "utf-8");
      return jsonResponse({ ok: true, id, file: f });
    }
  }
  return errorResponse("未找到该 event", 404);
}

async function handleAddLoop(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const { group, text } = (body ?? {}) as { group?: unknown; text?: unknown };
  if (typeof text !== "string" || !text.trim()) return errorResponse("待办内容不能为空");
  if (text.includes("\n")) return errorResponse("待办内容不能含换行");
  if (typeof group !== "string") return errorResponse("缺少分组名");

  const p = openLoopsPath();
  if (!existsSync(p)) return errorResponse("open-loops.md 不存在", 404);
  const lines = (await readFile(p, "utf-8")).split("\n");

  let insertAt = -1;
  let inGroup = false;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^##\s+(.*)/.exec(lines[i] ?? "");
    if (heading) {
      if (inGroup) {
        insertAt = i;
        break;
      }
      if ((heading[1] ?? "").trim() === group.trim()) inGroup = true;
    }
  }
  if (!inGroup) return errorResponse(`未找到分组：${group}`, 404);
  if (insertAt === -1) insertAt = lines.length;
  while (insertAt > 0 && (lines[insertAt - 1] ?? "").trim() === "") insertAt -= 1;

  lines.splice(insertAt, 0, `- ${text.trim()}`);
  await writeOpenLoops(lines);
  return jsonResponse({ ok: true, inserted_at: insertAt });
}

/** 只读单页 MD。 */
async function handlePage(url: URL): Promise<Response> {
  const rel = url.searchParams.get("path") ?? "";
  const abs = safeWikiPath(rel);
  if (!abs) return errorResponse("非法或越界路径", 403);
  if (!existsSync(abs)) return errorResponse("页面不存在", 404);
  const content = await readFile(abs, "utf-8");
  return jsonResponse({ path: rel, content });
}

async function handleTree(): Promise<Response> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && extname(e.name).toLowerCase() === ".md") {
        out.push(full.slice(WIKI_ROOT.length + 1));
      }
    }
  }
  await walk(join(WIKI_ROOT, "wiki"));
  await walk(join(WIKI_ROOT, "raw"));
  out.sort();
  return jsonResponse({ pages: out });
}

// ---------- 静态托管(生产构建产物) ----------

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const abs = resolve(DIST_DIR, rel);
  if (abs !== DIST_DIR && !abs.startsWith(DIST_DIR + sep)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const info = await stat(abs);
    if (info.isFile()) {
      const file = Bun.file(abs);
      return new Response(file, { headers: { "content-type": STATIC_TYPES[extname(abs)] ?? "application/octet-stream" } });
    }
  } catch {
    // fallthrough to SPA index
  }
  // SPA 回退:未命中静态文件时返回 index.html(前端路由)
  const index = Bun.file(join(DIST_DIR, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("Cockpit 未构建。开发模式请用 `bun run dev:web`;或先 `bun run build`。", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------- 路由 ----------

if (!existsSync(WIKI_ROOT)) {
  console.error(`\n  找不到 Wikified 数据目录：${WIKI_ROOT}\n`);
  console.error(`  本应用是 Wikified 记忆系统的界面，需要先有一个数据库。`);
  console.error(`  · 已装 Wikified：用 LLM_WIKI_ROOT=/你的/路径 指过去`);
  console.error(`  · 还没装：见 https://github.com/zhangyu0806/wikified\n`);
  process.exit(1);
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/review" && req.method === "GET") return handleReview();
      if (pathname === "/api/corrections/resolve" && req.method === "POST") return handleResolve(req);
      if (pathname === "/api/open-loops" && req.method === "GET") return handleOpenLoops();
      if (pathname === "/api/open-loops/toggle" && req.method === "POST") return handleToggleLoop(req);
      if (pathname === "/api/open-loops/add" && req.method === "POST") return handleAddLoop(req);
      if (pathname === "/api/open-loops/classify" && req.method === "POST") return handleClassifyLoop(req);
      if (pathname === "/api/open-loops/remove" && req.method === "POST") return handleRemoveLoop(req);
      if (pathname === "/api/raw/status" && req.method === "POST") return handleRawStatus(req);
      if (pathname === "/api/events/deprecate" && req.method === "POST") return handleDeprecateEvent(req);
      if (pathname === "/api/page" && req.method === "GET") return handlePage(url);
      if (pathname === "/api/tree" && req.method === "GET") return handleTree();
      return errorResponse("未知 API", 404);
    }

    return serveStatic(pathname);
  },
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/port|EADDRINUSE/i.test(msg)) {
    console.error(`\n  端口 ${PORT} 已被占用。\n`);
    console.error(`  · 换端口：COCKPIT_PORT=4188 再启动`);
    console.error(`  · 或看谁占着：ss -tlnp | grep ${PORT}`);
    console.error(`  · 若是本应用的旧实例：systemctl --user restart wikified-cockpit\n`);
  } else {
    console.error(`\n  启动失败：${msg}\n`);
  }
  process.exit(1);
}

console.log(`\n  Wikified Cockpit`);
console.log(`  ├─ 后端      http://${HOST}:${server.port}`);
console.log(`  ├─ 数据根    ${WIKI_ROOT}`);
console.log(`  ├─ CLI 目录  ${BIN_DIR}`);
console.log(`  └─ Windows 浏览器访问 http://localhost:${server.port} (WSL2 localhost 转发)\n`);
