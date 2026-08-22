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
import { readFile, readdir, stat } from "node:fs/promises";
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

/** GTD 看板数据源:直接读 open-loops.md 原文(前端负责解析成看板列)。 */
async function handleOpenLoops(): Promise<Response> {
  const p = join(WIKI_ROOT, "wiki", "context", "open-loops.md");
  if (!existsSync(p)) return jsonResponse({ exists: false, content: "" });
  const content = await readFile(p, "utf-8");
  return jsonResponse({ exists: true, content });
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

/** 列出 wiki/ 下所有 md 供 wikilink 解析与文件树(相对路径)。 */
async function handleTree(): Promise<Response> {
  const wikiDir = join(WIKI_ROOT, "wiki");
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
  await walk(wikiDir);
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

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/review" && req.method === "GET") return handleReview();
      if (pathname === "/api/corrections/resolve" && req.method === "POST") return handleResolve(req);
      if (pathname === "/api/open-loops" && req.method === "GET") return handleOpenLoops();
      if (pathname === "/api/page" && req.method === "GET") return handlePage(url);
      if (pathname === "/api/tree" && req.method === "GET") return handleTree();
      return errorResponse("未知 API", 404);
    }

    return serveStatic(pathname);
  },
});

console.log(`\n  Wikified Cockpit`);
console.log(`  ├─ 后端      http://${HOST}:${server.port}`);
console.log(`  ├─ 数据根    ${WIKI_ROOT}`);
console.log(`  ├─ CLI 目录  ${BIN_DIR}`);
console.log(`  └─ Windows 浏览器访问 http://localhost:${server.port} (WSL2 localhost 转发)\n`);
