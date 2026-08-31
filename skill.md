# Kimi WebBridge

Control the user's real browser (their login sessions) through the local daemon at `http://127.0.0.1:10086`.

> This skill is registered by the `kimi-webbridge-dsh` plugin (plugin v1.4.6 / daemon v1.11.6). Do not hand-edit it.

## Health check first

Before driving the browser, call the **`kimi_webbridge` tool with action `status`**. It reports daemon + extension health and auto-provisions the daemon (downloads the binary from the official Kimi CDN when missing and starts it, then retries once). `extension_connected: true` means the browser extension is ready; if false, tell the user to install/connect the Kimi WebBridge extension.

## The 17 actions

Every action is one HTTP call: `POST http://127.0.0.1:10086/command` with body `{"action": "<name>", "args": {...}, "session": "<task-name>"}`.

| action | args | returns | notes |
|---|---|---|---|
| `navigate` | `url` (required), `newTab?`, `group_title?` | `{success, url, tabId}` | first call opens a tab |
| `find_tab` | `url` (required), `active?` | `{success, url, tabId, borrowed}` | re-select a session tab; `active:true` borrows the tab the user is viewing |
| `snapshot` | — | `{url, title, tree}` | accessibility tree with `@e` refs — read pages with this |
| `click` | `selector` (`@e` or CSS) | `{success, tag, text}` | synthetic `el.click()` |
| `mouse_click` | `selector` (`@e` or CSS) | `{success, x, y, tag, text}` | real mouse click at element center (CDP input) — trusted |
| `fill` | `selector`, `value` | `{success, tag, mode}` | inputs/textareas/contenteditable; clear-and-insert |
| `key_type` | `text` | `{success, length}` | types into the focused element (CDP input) — trusted |
| `send_keys` | `keys`, `repeat?` (1–100) | `{success, dispatched, os}` | named keys/shortcuts, e.g. "Enter", "Mod+A", "Enter Escape" |
| `evaluate` | `code` (async ok) | `{type, value}` | JS in the page realm |
| `cdp` | `method`, `params` | raw CDP response | chrome.debugger passthrough |
| `screenshot` | `format?` png/jpeg, `quality?`, `selector?`, `path?` | `{format, path, sizeBytes, mimeType}` | writes a file, returns the path |
| `network` | `cmd` start/stop/list/detail, `filter?`, `requestId?` | request/response data | |
| `upload` | `selector`, `files` (array of local paths) | `{success, fileCount}` | |
| `save_as_pdf` | `paper_format?` letter/a4/legal/a3/tabloid, `landscape?`, `scale?` 0.1–2.0, `print_background?`, `path?` | `{path, sizeBytes, mimeType, pageTitle}` | |
| `list_tabs` | — | `{success, tabs:[{tabId,url,title,active,groupTitle}]}` | |
| `close_tab` | — | `{success, closed}` | |
| `close_session` | — | `{success, closed}` | close all session tabs — only when the user asks |

## Sending requests (shell-proof)

On **Windows (PowerShell)**, inline JSON with non-ASCII text gets corrupted by the shell — **always** send the body via a temp file: write the JSON to a uniquely-named temp file with your file-write tool, then:

```powershell
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$env:TEMP\wb-<random>.json"
```

then delete the temp file. Always `curl.exe`, never bare `curl` (PowerShell aliases it to Invoke-WebRequest).

On **macOS / Linux**, inline `-d '{...}'` is fine; if a call fails with a shell quoting error or HTTP 400, switch to the temp-file form above.

## Sessions

One task = one session = one tab group. Pick a task-named session (`camping-research`) and pass it on **every** call, never switching mid-task. `group_title` (in the user's language) on the first `navigate` labels the group. Example body:

```json
{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Research"},"session":"research"}
```

Call `close_session` only when the user explicitly asks to close the tabs.

## Reading and interacting

- Prefer `snapshot` + `@e` refs over hand-written CSS selectors.
- `find_tab` searches only this session's tabs; pass the exact URL (a bare domain may miss www/subdomain variants). On "no tab matching", `navigate` with `newTab:true`. With `active:true` it borrows the user's currently-viewed tab and operates it in place.
- `evaluate`: wrap re-declarations in an IIFE; return compact `JSON.stringify` (never pretty-print).
- `fill` is clear-and-insert; to append, read the current value via `evaluate` first.
- Trusted input: on sites that reject synthetic events (`event.isTrusted` checks — banking portals, captchas), use `mouse_click` instead of `click` and `key_type`/`send_keys` instead of `fill`. If those still fail, tell the user the page needs manual interaction.
- `send_keys` keys: Enter/Return, Escape/Esc, Tab, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home/End, PageUp/PageDown, F1–F12, single letters/digits. Modifiers: Alt/Ctrl/Control/Cmd/Meta/Shift, or `Mod` (Cmd on Mac, Ctrl elsewhere). Join with `+` ("Mod+A", "Shift+Tab"); space-separate several ("Enter Escape").
- Cross-origin iframes are not covered — navigate to the iframe URL directly.

## Screenshots and PDF

`screenshot` and `save_as_pdf` write files and return a path — open it with your read tool. A caller-supplied `path` is honored verbatim (parent dirs created, existing files overwritten). PDF decoded cap is 100 MB; reduce `scale` to shrink.

## Daemon or extension problems

- Call the `kimi_webbridge` tool (`status`) — the plugin auto-provisions and starts the daemon. Never run `stop` / `restart` / `uninstall` yourself.
- If an error mentions "Please update the Kimi WebBridge extension", the extension is outdated — ask the user to update it (https://www.kimi.com/features/webbridge).
- If the daemon stays unreachable after the status tool's retry, point the user to the help page instead of deep-troubleshooting.
- If the status tool warns that `version` (daemon) and `extension_version` (extension) differ, the extension has drifted (likely auto-updated) — re-audit the 17-action list above and ask the user to update the daemon.

---

Protocol and workflow adapted from the Kimi WebBridge community skill (Apache-2.0). Daemon binary and browser extension by Kimi. This skill is registered by kimi-webbridge-dsh.
