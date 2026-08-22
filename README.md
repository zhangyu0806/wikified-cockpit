# Wikified Cockpit

本机 **复盘 + GTD 驾驶舱**，配合 [Wikified](https://github.com/zhangyu0806/wikified)
记忆系统使用。从 Windows 浏览器访问跑在 WSL2 里的本机服务，读 `~/llm-wiki` 的 Markdown，
把复盘/审批/GTD 变成点一下就完成的界面。

## 定位：和 Obsidian 分工，不重造

- **Obsidian** 管深度阅读、图谱、编辑 —— 它几年打磨的能力不重写。
- **Cockpit** 管行动 —— 复盘待审队列、corrections 一键晋升/丢弃、GTD 看板、过期候选。

两者读同一份 `~/llm-wiki`，各干各擅长的。

## 核心原则：CLI 是唯一事实源

Cockpit 是 `llm-wiki-*` CLI 的**薄壳**，不重实现记忆逻辑：

- 复盘数据来自 `llm-wiki-review --json`
- 审批走 `llm-wiki-correct --resolve`
- 过期依据 event 的半衰期模型

所以 Cockpit 挂了或不用了，你的记忆系统照常从命令行工作，**零锁定**。

## 安全

这个 app 会读整个 `~/llm-wiki` 并执行本机 CLI，是敏感面。硬性设计：

- **只绑 `127.0.0.1`**，绝不 `0.0.0.0`。WSL2 下 Windows 经 localhost 转发访问。
- **白名单执行**：只跑固定的 `llm-wiki-review`/`llm-wiki-correct`，参数以数组传给
  `execFile`（不经 shell），从根上杜绝命令注入。
- **路径囚笼**：MD 只读端点把路径 resolve 后必须仍在 `~/llm-wiki` 内，且拒绝 `secure-notes`、
  点目录、非 `.md`。
- **不碰 secret**：不读 `~/secure-notes`；沿用 CLI 自身的脱敏。

上述边界由 `tests/test-server.sh` 锁定（路径逃逸、非 md、注入型 id 均须被拒）。

## 用法

```bash
./start.sh              # 首次自动 bun install + build，然后启动（端口 4177）
./start.sh --rebuild    # 改了前端后强制重建
COCKPIT_PORT=5000 ./start.sh
```

Windows 浏览器打开 `http://localhost:4177`。

开发模式（前端热更新）：

```bash
bun run server          # 终端 1：后端 :4177
bun run dev:web         # 终端 2：Vite :4176（代理 /api 到后端）
```

## 三个视图

1. **复盘** — `review --json` 四板块：待处理 corrections（一键晋升/丢弃）、晋升建议、
   未编译 raw、event 过期候选。顶栏显示「距上次复盘 N 天」。
2. **GTD** — 按 `open-loops.md` 的 `##` 分组展示，✅/[x] 标记完成。只读总览；
   编辑回到文件本身（Obsidian / CLI）。
3. **阅读** — 文件树 + Markdown 渲染 + `[[wikilink]]` 点击跳转。深度阅读仍推荐 Obsidian。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `COCKPIT_PORT` | `4177` | 后端端口 |
| `LLM_WIKI_ROOT` | `~/llm-wiki` | Wikified 数据根 |
| `LLM_WIKI_BIN_TARGET` | `~/.local/bin` | `llm-wiki-*` CLI 所在目录 |

## 测试

```bash
bun run typecheck        # server + web 两套 tsconfig
bash tests/test-server.sh # 冒烟 + 安全边界（自建隔离库，不碰真实数据）
```
