# kimi-webbridge-dsh

Kimi WebBridge 的 dsh 插件：通过本机 kimi-webbridge 守护进程（`127.0.0.1:10086`）驱动用户的真实浏览器（保留登录态与 Cookie）。注册一个模型工具 `kimi_webbridge`，覆盖导航、点击、输入、读取页面（accessibility tree + @e 引用）、截图、JS 求值、CDP、网络、上传、PDF 导出、标签页与会话管理。

## 安装（一次性，零手工配置）

```powershell
dsh plugin --profile web add kimi-webbridge-dsh
```

本包声明了 `dsh.bundle.patch`：`dsh plugin add` 会自动把它登记进 profile 的 bundle 层（`dsh.profile.bundles`），**无需手动编辑任何 cordis.patch.yml**。安装后重启一次 dsh web 即生效（bundle 在启动时加载）：

```powershell
dsh web
```

## 用法

模型在新会话中可直接调用 `kimi_webbridge` 工具。核心规则：

- **一个任务 = 一个 session = 一个标签页组**：任务开始时选一个 session 名，之后每次调用都带上（如 `camping-research`）。
- **读页面用 snapshot**：返回 accessibility tree 和 `@e` 引用，点击/输入优先用 `@e` 引用而非手写 CSS。
- **截图返回文件路径**：用 read 工具打开查看。
- **守护进程不可达**：工具会自动启动；二进制缺失时自动从官方 CDN 下载安装。

## 依赖

- **浏览器扩展**：需安装并连接 Kimi WebBridge 浏览器扩展 —— 从 [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) 安装（`kimi-webbridge status` 显示 `extension_connected: true`；扩展版本应与守护进程一致）。
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

## 功能

| 能力 | 说明 |
|---|---|
| 浏览真实页面 | 在用户已登录的浏览器中导航、点击、填表、滚动 |
| 读页面 | `snapshot` 返回 accessibility tree 与 `@e` 元素引用 |
| 截图 / 导出 PDF | 结果写入本地文件，返回路径 |
| JS 求值 / CDP | `evaluate`（页面上下文）、`cdp`（chrome.debugger 直通） |
| 网络 / 上传 | 请求捕获与文件上传 |
| 会话分组 | 一个任务 = 一个 session = 一个标签页组，可一键清理 |

## 配置（可选）

在 profile 的用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）按 id 覆盖配置（替换整份 config，未给出的键取默认值）：

```yaml
- id: kimi-webbridge
  config:
    autoInstallDaemon: false
    daemonVersion: 0.3.0
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:10086` | 守护进程地址 |
| `requestTimeoutMs` | `120000` | 单次请求超时（毫秒） |
| `autoStartDaemon` | `true` | 守护进程未运行时自动启动 |
| `autoInstallDaemon` | `true` | 二进制缺失时自动从官方 CDN 下载安装（关闭后需手动运行 `irm https://cdn.kimi.com/webbridge/install.ps1 | iex`） |
| `daemonVersion` | `latest` | 自动安装时的版本（可固定如 `0.3.0`） |

## 移除

```powershell
dsh plugin --profile web remove kimi-webbridge-dsh
```

自动从 bundle 层移除（无需手动删补丁行），重启后生效。
