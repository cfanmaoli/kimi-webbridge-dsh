# kimi-webbridge-dsh

Kimi WebBridge 的 dsh 插件（**基础设施 + 技能注册**）。插件本身不代理浏览器操作，而是负责：

1. **保障桥完好**：守护进程二进制缺失时自动从官方 CDN 下载（跨平台、SHA-256 校验），守护进程未运行时自动拉起；
2. **注册 skill**：启动时把随包内置的 `skill.md` 注册为运行时 skill（`ctx.skills.register`，`source: bundled`），模型通过 `skill` 工具加载它，按文档用 HTTP 行使全部浏览器能力（25 个动作）；
3. **注册一个瘦工具 `kimi_webbridge`**：只有 `status` 一个动作（守护进程 + 扩展健康检查），作为其他 skill（如 x-cli 系列）的桥健康锚点。

## 架构

| 层 | 角色 |
|---|---|
| 插件（本包） | 守护进程二进制供应 + 自动启动；apply() 时注册运行时 skill |
| skill（运行时注册，随包内置 `skill.md`） | 模型经 `skill` 工具加载，按文档驱动守护进程：navigate / find_tab / snapshot / read_page / find / click / mouse_click / hover / drag / fill / key_type / send_keys / select_option / dialog / evaluate / cdp / screenshot / network / upload / save_as_pdf / scroll / wait / list_tabs / close_tab / close_session |
| 瘦工具 `kimi_webbridge` | 仅 `status` 健康检查（自带守护进程自愈） |

## 安装（一次性，零手工配置）

```powershell
dsh plugin --profile web add kimi-webbridge-dsh
```

本包声明了 `dsh.bundle.patch`：`dsh plugin add` 会自动把它登记进 profile 的 bundle 层（`dsh.profile.bundles`），**无需手动编辑任何 cordis.patch.yml**。重启一次 `dsh web`：启动时插件把 skill 注册进运行时 registry，新会话的 skill 目录中即出现 `kimi-webbridge`。

## 用法（模型视角）

1. 需要真实浏览器时，加载 `kimi-webbridge` skill（触发词：browser / webpage / open URL / 浏览器 / 网页 / 截图……）；
2. 先用 `kimi_webbridge` 工具的 `status` 确认守护进程 + 扩展健康（插件自动补装/拉起二进制）；
3. 按 skill 文档向 `POST http://127.0.0.1:10086/command` 发送 `{action, args, session}` 行使浏览器能力。Windows 上必须用临时文件承载 JSON（shell 会破坏非 ASCII 文本），skill 里有完整说明。

## 依赖

- **浏览器扩展**：需安装并连接 Kimi WebBridge 浏览器扩展 —— 从 [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) 安装（`kimi_webbridge status` 显示 `extension_connected: true`；扩展版本应与守护进程一致）。
- **守护进程**：无需预装。插件在守护进程不可达时会自动启动它；二进制缺失时会自动从官方 CDN（cdn.kimi.com，与官方安装器同源）下载安装——全程无需手动运行任何安装命令。

### 跨平台支持

插件根据运行时硬件自动选择并下载对应的守护进程二进制（含 SHA-256 校验，与官方清单核对后才安装）：

| 平台 | 二进制 | 存档哈希（v1.11.6） |
|---|---|---|
| Windows x64 | `windows-amd64.exe` | `e085991e…90520` |
| macOS arm64 | `darwin-arm64` | `46fe401e…c9930` |
| macOS x64 | `darwin-amd64` | `edd1b126…e1ec54` |
| Linux arm64 | `linux-arm64` | `b1b139bf…b7923d` |
| Linux x64 | `linux-amd64` | `5c6eaf79…0150d` |

不支持的平台组合会明确报错并提示手动安装。

### 守护进程二进制位置

下载到用户目录（与官方安装器路径一致，无需管理员权限；按用户隔离）：

| 平台 | 最终路径 |
|---|---|
| Windows | `%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe` |
| macOS / Linux | `~/.kimi-webbridge/bin/kimi-webbridge`（自动 `chmod 755`） |

下载流程：先落盘为临时文件（`kimi-webbridge(.exe).tmp-{pid}-{时间戳}`）→ SHA-256 与官方清单核对 → 匹配才重命名为最终路径；不匹配则删除临时文件并中止，任何未验证的二进制都不会留在磁盘。该路径与官方安装器 / `kimi-webbridge upgrade` 命令完全一致，插件、官方工具共用同一份守护进程。

## 功能（skill 承载，25 个动作）

| 能力 | 动作 |
|---|---|
| 导航 / 标签 | `navigate`、`find_tab`、`list_tabs`、`close_tab`、`close_session` |
| 读页面 | `snapshot`（accessibility tree + `@e` 引用）、`read_page`（全文文本）、`find`（页面内搜索） |
| 点击 / 输入 | `click`、`mouse_click`（真实鼠标，可信输入）、`hover`、`drag`、`fill`、`key_type`（键入，可信）、`send_keys`（组合键）、`select_option`、`dialog` |
| JS / CDP | `evaluate`（页面上下文）、`cdp`（chrome.debugger 直通） |
| 截图 / PDF | `screenshot`、`save_as_pdf`（写文件、返回路径） |
| 网络 / 上传 | `network`（请求捕获）、`upload`（文件上传） |
| 滚动 / 等待 | `scroll`（滚动/定位）、`wait`（等待文本/选择器条件） |
| 会话分组 | 一个任务 = 一个 session = 一个标签页组，可一键清理 |

## 配置（可选）

在 profile 的用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）按 id 覆盖配置（替换整份 config，未给出的键取默认值）：

```yaml
- id: kimi-webbridge
  config:
    autoInstallDaemon: false
    daemonVersion: v1.11.6
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:10086` | 守护进程地址 |
| `requestTimeoutMs` | `120000` | 单次请求超时（毫秒） |
| `autoStartDaemon` | `true` | 守护进程未运行时自动启动 |
| `autoInstallDaemon` | `true` | 二进制缺失时自动从官方 CDN 下载安装（关闭后需手动[从官方安装](https://www.kimi.ai/products/kimi-webbridge)） |
| `daemonVersion` | `latest` | 自动安装时的版本（可固定如 `v1.11.6`，需带 `v` 前缀与 CDN 路径一致） |
| `registerSkill` | `true` | 启动时把 `kimi-webbridge` skill 注册进运行时 registry（关闭后不注册） |

## 移除

```powershell
dsh plugin --profile web remove kimi-webbridge-dsh
```

自动从 bundle 层移除（无需手动删补丁行），重启后生效。skill 为运行时注册，移除插件即随之消失，无残留文件。
