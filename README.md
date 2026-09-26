# kimi-webbridge-dsh

把 [Kimi 浏览器扩展](https://www.kimi.com/products/kimi-webbridge)（Kimi Browser Extension，原 Kimi WebBridge）接进 dsh：**供应守护进程 + 注册官方技能包**。插件本身不代理浏览器操作——浏览器能力全部由官方技能文档描述，模型照它驱动本地守护进程。

| 职责 | 说明 |
|---|---|
| 守护进程供应 | 按官方清单下载对应平台二进制（SHA-256 校验），未运行时自动拉起；落在 `~/.kimi-webbridge/bin/` |
| 技能注册 | 随包内置官方技能文档（含 `references/`），启动时注册为 `kimi-webbridge` skill |
| 健康锚点 | 瘦工具 `kimi_webbridge`，只有 `status` 一个动作（守护进程 + 扩展 + 已装技能副本） |

## 安装

```bash
dsh plugin --profile web add kimi-webbridge-dsh
```

自带 bundle patch，无需手改 `cordis.patch.yml`；重启一次 dsh 生效。

## 用法

1. 需要真实浏览器时加载 `kimi-webbridge` skill（触发词：browser / 网页 / 截图 / ……，也包括"给某个网站做个可复用 CLI"）；
2. 先调 `kimi_webbridge` 的 `status` 确认守护进程 + 扩展健康（会自动补装 / 拉起）；
3. 按 skill 文档 `POST http://127.0.0.1:10086/command`，请求体 `{action, args, session}`；
4. Windows 必须用临时文件承载 JSON 请求体（shell 会破坏非 ASCII），skill 里有说明。

工具清单、参数与注意事项一律以 skill 文档为准。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 按 id 覆盖（整份替换，未给出的键取默认）：

```yaml
- id: kimi-webbridge
  config:
    daemonVersion: v2.0.22
```

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:10086` | 守护进程地址 |
| `requestTimeoutMs` | `120000` | 单次请求超时（ms） |
| `autoStartDaemon` | `true` | 未运行时自动启动 |
| `autoInstallDaemon` | `true` | 二进制缺失时自动下载安装 |
| `daemonVersion` | `latest` | 自动安装的版本，带 `v` 前缀，建议与扩展版本一致 |
| `registerSkill` | `true` | 注册 `kimi-webbridge` skill |

## 要求与提示

- **浏览器扩展**：需自行安装并连接（[Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)）；`status` 显示 `extension_connected: true` 即可用。
- **守护进程**：无需预装，插件自动供应；与官方安装器共用 `~/.kimi-webbridge/bin/`（Windows `%USERPROFILE%\.kimi-webbridge\bin\`）。
- **dsh 版本**：只 import 宿主提供的 `@deepseek-ai/*`（声明为 peer，不打包副本），已在 **0.1.7-rc.2** 验证。
- **`status` 里的 `version_mismatch` / `update_available` / `skill_mismatch`**：把其中的 `command` 原样交给用户执行；**不要**自行 `upgrade` / `stop` / `restart` / `uninstall`，它们会杀掉正在运行的守护进程。
- `status.skills` 为空是正常的：守护进程只识别 Claude Code / Codex / Hermes / OpenClaw / Kimi，dsh 拿到技能的唯一途径就是本插件。

## 移除

```bash
dsh plugin --profile web remove kimi-webbridge-dsh
```

重启后生效；skill 随插件注册，移除即消失。
