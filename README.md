# kimi-webbridge-dsh

Kimi 浏览器扩展（**Kimi Browser Extension**，原 Kimi WebBridge）的 dsh 插件（**基础设施 + 官方技能包注册**）。插件本身不代理浏览器操作，而是负责：

1. **保障桥完好**：守护进程二进制缺失时自动从官方 CDN 下载（跨平台、SHA-256 校验），守护进程未运行时自动拉起；
2. **注册官方技能包**：把**原样内置**的上游技能包（`skill/SKILL.md` + `skill/references/**`，与官方 CDN 逐字节一致、按摘要锁定）注册为运行时 skill，并把该目录作为 skill 的 `resourceBase` 暴露给模型 —— 这是 skill 正文里 `references/...` 链接能被解析的前提；
3. **注册一个瘦工具 `kimi_webbridge`**：只有 `status` 一个动作（守护进程 + 扩展 + 已安装技能副本健康检查），作为其他 skill（如 x-cli 系列）的桥健康锚点。

## 架构

| 层 | 角色 |
|---|---|
| 插件（本包） | 守护进程二进制供应 + 自动启动；apply() 时注册运行时 skill（含 `resourceBase`） |
| skill 正文（`skill/SKILL.md`，**上游原样内置**） | 官方文档：工具表、会话、截图/PDF、iframe 读取、CDP 焦点仿真、守护进程恢复、版本不匹配处置 |
| skill 参考文档（`skill/references/**`，**上游原样内置**） | `operations.md`（守护进程运维）；`cli-creator/*`（为网站生成可复用 CLI 的完整工作流） |
| 运行时增量（`DSH_RUNTIME_SECTION`，本插件追加） | 仅 dsh 特有差异：工具名映射（`read`/`read_image`/`bash`）、`kimi_webbridge` 健康锚点、references 解析方式、不要替 dsh 跑 `install-skill` |
| 瘦工具 `kimi_webbridge` | 仅 `status` 健康检查（自带守护进程自愈） |

**上游文档原样内置 + 末尾追加 dsh 差异**是刻意的分层：升级技能 = 覆盖文件，永远不需要合并散文，也就不会再次出现"文档停在旧版本"的漂移。

## 上游文档同步（本插件的核心维护动作）

上游把 skill 与守护进程二进制**同版本发布**在同一个 CDN：

```
https://cdn.kimi.com/webbridge/<release>/skills/kimi-webbridge.tar.gz
https://cdn.kimi.com/webbridge/<release>/skills/kimi-webbridge-windows.tar.gz   # 与上面逐字节相同
```

本包的 `skill/` 就是该 tar 包里的 `kimi-webbridge/` 目录，**逐字节原样**，由脚本维护：

```bash
npm run fetch-skill                                        # 拉取 latest，重写 skill/
node scripts/fetch-upstream-skill.mjs --version v2.0.22     # 或锁定具体版本
node scripts/fetch-upstream-skill.mjs --check               # 只报告上游是否已变动（不写盘）
node scripts/fetch-upstream-skill.mjs --verify-local        # 不联网：校验本地文件与清单一致
```

`skill/UPSTREAM.json` 记录：release、tar 包 SHA-256、每个文件的 SHA-256 与字节数、抓取时间。脚本拒绝安装 frontmatter 版本与 release 不一致的包，也拒绝两个平台变体不一致的情况。

## 安装（一次性，零手工配置）

```powershell
dsh plugin --profile web add kimi-webbridge-dsh
```

本包声明了 `dsh.bundle.patch`：`dsh plugin add` 会自动把它登记进 profile 的 bundle 层（`dsh.profile.bundles`），**无需手动编辑任何 cordis.patch.yml**。重启一次 `dsh web`：启动时插件把技能包注册进运行时 registry，新会话的 skill 目录中即出现 `kimi-webbridge`。

## 用法（模型视角）

1. 需要真实浏览器时，加载 `kimi-webbridge` skill（触发词：browser / webpage / open URL / 浏览器 / 网页 / 截图……；"给某个网站做个可复用的 CLI" 也走这个 skill）；
2. 先用 `kimi_webbridge` 工具的 `status` 确认守护进程 + 扩展健康（插件自动补装/拉起二进制）；
3. 按 skill 文档向 `POST http://127.0.0.1:10086/command` 发送 `{action, args, session}`。技能正文里的 `references/...` 路径以 skill 加载时返回的 `resourceBase` 目录为基准，用 `read` 工具读取。
4. Windows 上必须用临时文件承载 JSON（shell 会破坏非 ASCII 文本），skill 里有完整说明。

## 依赖

- **浏览器扩展**：需安装并连接 Kimi 浏览器扩展（Kimi Browser Extension，原 Kimi WebBridge）—— 从 [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) 安装（`kimi_webbridge status` 显示 `extension_connected: true`；扩展版本应与守护进程一致）。
- **守护进程**：无需预装。插件在守护进程不可达时会自动启动它；二进制缺失时会自动从官方 CDN（cdn.kimi.com，与官方安装器同源）下载安装——全程无需手动运行任何安装命令。

### 版本对齐

插件按官方 CDN 的 `version.json` 供应守护进程，因此始终与官方发布对齐；下表哈希对应 **v2.0.22**（守护进程与扩展的产品名已更名为 Kimi Browser Extension）。

`kimi_webbridge` 的 `status` 会原样透出守护进程的 `update_available`（有更新时）、`version_mismatch`（守护进程与扩展不同步时）、`skills`（守护进程在各 agent 运行时里发现的技能副本）与 `skill_mismatch`（这些副本与扩展不同步时）。按官方约定：出现这些字段时**不要**自动执行 `upgrade` / `stop` / `restart` / `uninstall`（它们会杀掉正在运行的守护进程），而应把字段里的 `command` 原样交给用户执行。

> dsh 不在守护进程识别/安装技能的运行时列表内（它只认 Claude Code / Codex / Hermes / OpenClaw / Kimi），所以 `skills` 为空是 dsh 下的正常结果 —— dsh 拿到技能的唯一途径就是本插件。

### 上游能力对齐（v2.0.8 → v2.0.22）

本插件曾停留在按 v2.0.8 手写的文档上。改为内置上游技能包后，以下上游变化自动跟进（也记录在此便于回顾）：

| 上游版本 | 新增/变化 |
|---|---|
| v2.0.16 | **CDP 焦点仿真**：后台标签页的真实输入需先 `cdp Emulation.setFocusEmulationEnabled {"enabled":true}`；`Page.bringToFront` 语义重写（先开仿真、不抢用户焦点）；`Target.activateTarget` 被拒绝 |
| v2.0.17 | **cli-creator 工作流**（`references/cli-creator/*` 五篇）：为网站生成可复用 CLI（勘探协议 → 实现 → 配套 skill）；`network` 增加 `bodyError` 语义（`detail` 必须在 `stop` 之前调用） |
| v2.0.21 | **iframe/frame 读取**：`snapshot` 返回 `frames: [{frame, url, size}]`、`read_page {"frame":"#f1"}`、`wait {"frame":"any"}`；取代旧的"跨域 iframe 请直接导航"限制 |
| v2.0.9–v2.0.15 / v2.0.18–v2.0.20 / v2.0.22 | 文档无实质变化（v2.0.22 仅改 frontmatter 版本号） |

另有早已存在于上游、但旧手写文档遗漏的部分：`ok/data` 回包信封与 `extension_not_connected` 错误码、`find_tab` 按 host 匹配、`status` 的 `skills` / `skill_mismatch`、守护进程 `install-skill` / `upgrade` 子命令、`references/operations.md`。

### 兼容性（dsh 版本）

插件只 import 宿主提供的 `@deepseek-ai/*` 包，并声明为 `peerDependencies`（不打包自己的副本），所以与 dsh 版本解耦；已在 **dsh 0.1.7-rc.2** 上验证：工具注册、skill 注册（含 `resourceBase` 与 references 解析）、system prompt 注入、`kimi_webbridge status` 健康检查均正常。技能注册走 `ctx.skills.register`（运行时技能），并额外传入 `resourceBase: { kind: "directory", path: <skill 目录> }`——宿主会把该目录作为 skill 的基准目录渲染给模型。

| peer | 声明范围 |
|---|---|
| `@deepseek-ai/dsh-tools` | `^0.1.0-rc.7 \|\| ^0.1.1-rc.2 \|\| ^0.1.2-rc.1 \|\| ^0.1.5-rc.1 \|\| ^0.1.7-rc.2` |
| `@deepseek-ai/dsh-llm` | 同上 |
| `@deepseek-ai/schemastery` | `^3.18.1` |

⚠️ **预发布版必须逐个元组写进范围。** node-semver 只在范围里存在一个**与该版本 `major.minor.patch` 完全一致、且自身带预发布标签**的比较符时才放行预发布版；因此看起来很宽的 `>=0.0.1-rc.1 <0.2.0` 会静默排除所有预发布构建，用户会遇到 `ERESOLVE`。dsh 发布新的预发布系列（如 `0.1.6-rc.1`）时，需要同步追加一个 `|| ^<新元组>-rc.N` 分支。

### 跨平台支持

插件根据运行时硬件自动选择并下载对应的守护进程二进制（含 SHA-256 校验，与官方清单核对后才安装）：

| 平台 | 二进制 | 存档哈希（v2.0.22） |
|---|---|---|
| Windows x64 | `windows-amd64.exe` | `8e9dfc5b…eb338` |
| macOS arm64 | `darwin-arm64` | `f36dfeba…901f0` |
| macOS x64 | `darwin-amd64` | `ad9aba7d…8d4ba` |
| Linux arm64 | `linux-arm64` | `6f083744…5527f` |
| Linux x64 | `linux-amd64` | `0d1b2bf5…fdcf6` |

技能包（两个平台变体逐字节相同）v2.0.22 的 tar 摘要：`4068a646…678ed1`。

不支持的平台组合会明确报错并提示手动安装。

### 守护进程二进制位置

下载到用户目录（与官方安装器路径一致，无需管理员权限；按用户隔离）：

| 平台 | 最终路径 |
|---|---|
| Windows | `%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe` |
| macOS / Linux | `~/.kimi-webbridge/bin/kimi-webbridge`（自动 `chmod 755`） |

下载流程：先落盘为临时文件（`kimi-webbridge(.exe).tmp-{pid}-{时间戳}`）→ SHA-256 与官方清单核对 → 匹配才重命名为最终路径；不匹配则删除临时文件并中止，任何未验证的二进制都不会留在磁盘。该路径与官方安装器 / `kimi-webbridge upgrade` 命令完全一致，插件、官方工具共用同一份守护进程。

## 功能（上游技能承载）

以官方文档为准（见 `skill/SKILL.md`），主要能力域：

| 能力 | 说明 |
|---|---|
| 导航 / 标签 | `navigate`、`find_tab`（按 host 匹配本会话标签页，`active:true` 借用用户正在看的标签页）、`list_tabs`、`close_tab`、`close_session` |
| 读页面 | `snapshot`（accessibility tree + `@e` 引用，并在有 iframe 时返回 `frames`）、`read_page`（全文文本，可 `{"frame":"#f1"}` 读 frame）、`find` |
| 点击 / 输入 | `click`、`fill`（含 ProseMirror/Lexical/Slate 等 contenteditable）、`hover`、`drag`、`select_option`、`dialog`、`scroll`、`wait`（支持 `{"frame":"any"}`） |
| 可信输入 | `mouse_click` / `key_type` / `send_keys`（CDP 真实输入）；后台标签页需先用 `cdp` 打开焦点仿真 |
| JS / CDP | `evaluate`（页面上下文）、`cdp`（chrome.debugger 直通） |
| 截图 / PDF | `screenshot`、`save_as_pdf`（写文件、返回路径） |
| 网络 / 上传 | `network`（请求捕获；`detail` 须在 `stop` 前）、`upload` |
| 会话分组 | 一个任务 = 一个 session = 一个标签页组，可一键清理 |
| 生成 CLI | `references/cli-creator/*`：为某个网站做可复用 CLI + 配套 skill（勘探 → 实现 → 验证） |

## 配置（可选）

在 profile 的用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）按 id 覆盖配置（替换整份 config，未给出的键取默认值）：

```yaml
- id: kimi-webbridge
  config:
    autoInstallDaemon: false
    daemonVersion: v2.0.22
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:10086` | 守护进程地址 |
| `requestTimeoutMs` | `120000` | 单次请求超时（毫秒） |
| `autoStartDaemon` | `true` | 守护进程未运行时自动启动 |
| `autoInstallDaemon` | `true` | 二进制缺失时自动从官方 CDN 下载安装（关闭后需手动[从官方安装](https://www.kimi.com/products/kimi-webbridge)） |
| `daemonVersion` | `latest` | 自动安装时的版本（可固定如 `v2.0.22`，需带 `v` 前缀与 CDN 路径一致；建议与扩展版本匹配） |
| `registerSkill` | `true` | 启动时把 `kimi-webbridge` skill 注册进运行时 registry（关闭后不注册） |

## 开发

```bash
npm run check         # node --check lib/index.js + 校验 skill/ 与 UPSTREAM.json 一致
npm run fetch-skill   # 重新内置上游技能包（更新 skill/ 与 UPSTREAM.json）
```

CI：`publish.yml` 在发布前跑 `npm run check`（离线、必须通过）并**报告**上游漂移（不阻断发布）；`skill-drift.yml` 每周一跑 `--check`，上游一有变动就让任务失败，避免再次静默落后。

## 移除

```powershell
dsh plugin --profile web remove kimi-webbridge-dsh
```

自动从 bundle 层移除（无需手动删补丁行），重启后生效。skill 为运行时注册，移除插件即随之消失，无残留文件。
