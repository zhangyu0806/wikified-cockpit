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
- **写操作范围受限**，共三处，每处都有独立边界：
  - `wiki/context/open-loops.md` —— 路径服务端硬编码，**不接受调用方传路径**
  - `raw/**.md` 的 frontmatter `status` —— 路径必须 resolve 在 `raw/` 内，**正文一律不动**，
    status 只接受 `compiled|archived|rejected`
  - `memory/events/*.jsonl` 的 `lifecycle` —— 只把命中 id 的那一行标 `deprecated`，
    其余行原样写回；**从不删除**
  - 三者写前都自动备份（`.bak`）。
- **乐观锁**：勾选按「行号 + 该行当前文本」双重校验，文本不符则拒绝（409），
  避免并发编辑时改错行。
- **不碰 secret**：不读 `~/secure-notes`；沿用 CLI 自身的脱敏。

上述边界由 `tests/test-server.sh` 锁定（19 项：路径逃逸、非 md、注入型 id、乐观锁冲突、
未知分组、空内容/含换行、非法 status、raw 外路径、event 只改命中行、未知 event id、
以及「传 path 参数也无法影响白名单外文件」）。

## 用法

### 推荐：装成常驻服务（装一次，之后不用管）

```bash
./install-service.sh            # 构建 + 安装 systemd user service 并启动
```

装完即：开机自启、后台静默常驻、崩溃 3 秒内自动重启，**不占 tmux session**。
浏览器打开 `http://localhost:4177` 就用，不需要每次先启动什么。

```bash
./install-service.sh status     # 看状态
./install-service.sh logs       # 跟踪日志
./install-service.sh uninstall  # 移除服务（代码保留）
```

> 退出所有登录会话后 systemd user 服务默认会停。要让它始终常驻，执行一次
> `sudo loginctl enable-linger $USER`。

### 临时前台运行

```bash
./start.sh              # 首次自动 bun install + build，然后启动（端口 4177）
./start.sh --rebuild    # 改了前端后强制重建
COCKPIT_PORT=5000 ./start.sh
```

### 开发模式（前端热更新）

```bash
bun run server          # 终端 1：后端 :4177
bun run dev:web         # 终端 2：Vite :4176（代理 /api 到后端）
```

改完前端要让常驻服务生效：`bun run build && systemctl --user restart wikified-cockpit`。

## 三个视图

1. **复盘** — 四个可折叠板块，按「有货优先」排序，每类都能直接处理掉：
   - **corrections**：晋升 / 丢弃
   - **未编译 raw**：查看 / 已编译 / 归档 / 不要 —— 写 frontmatter `status`，写完即从列表消失
   - **晋升建议**：来自 promote-notes 的分类打分
   - **event 过期候选**：废弃（标 `lifecycle: deprecated` 停止召回，**不删除**，保留审计痕迹）

   空板块自动折叠并淡化。顶栏显示「距上次复盘 N 天」。

   > 编译成 wiki 知识页仍需 AI 写作（读源材料 → 提炼 → 决定进哪页），app 负责的是
   > **把处理结果落到文件**：你判断完点一下，raw 就不再占着复盘队列。
2. **GTD** — 读 `open-loops.md`，**保留原文嵌套层级**（子项缩进显示）：
   - 勾选复选框即写回文件（`- 内容` ⇄ `- ✅ 内容`），写前自动备份
   - 每个 `##` 分组可「+ 加一条」，追加到该组末尾
   - 「显示已完成」开关，默认只看未闭环
3. **阅读** — 文件树 + Markdown 渲染 + `[[wikilink]]` 点击跳转，可打开 `wiki/` 与 `raw/`
   下任意 md。深度阅读/图谱/编辑仍推荐 Obsidian。

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
