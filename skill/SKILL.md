---
name: kimi-webbridge
description: |
  Operate websites in the user's real browser with existing login sessions: read pages, interact, capture screenshots, and automate browser workflows. Also use when building a reusable website CLI or script through Kimi WebBridge.
metadata:
  version: "2.0.32"
---

# Kimi Browser Extension (formerly Kimi WebBridge)

Control the user's real browser (with their login sessions) via a local daemon at `http://127.0.0.1:10086` (the default address — see [If a tool call fails](#if-a-tool-call-fails-daemon-or-extension-not-ready) for when it differs).

For a reusable website CLI or script, follow the [CLI creation workflow](references/cli-creator/workflow.md). For one-off browser tasks, use the tools below.

## Common tools

| Tool | Args | Returns | Note |
|------|------|---------|------|
| `navigate` | `url`, `newTab`(bool), `group_title` | `{success, url, tabId}` | First call opens a tab — see [Tabs](#tabs-and-the-current-tab). `group_title` sets the group's visible label |
| `find_tab` | `url`, `active`(bool) | `{success, url, tabId, borrowed}` | Re-select a tab in **this session**; `active:true` borrows the tab the **user** is viewing — see [Tabs](#tabs-and-the-current-tab) |
| `snapshot` | optional `ref`; `format:"aria"` opts into text with optional `max_chars` (1–60000), or `cursor` to continue | Default `{url, title, tree}`; ARIA `{url, title, tree_text}` | **Accessibility tree** (text) — use this to read page content and locate elements |
| `find` | `query` | `{matches, totalMatches}` | Search page text for refs, then narrow with `snapshot(ref)` |
| `read_page` | optional `max_chars`, `start`, `frame` | `{text, complete, nextStart?, note?}` | Read document text; follow completeness and continuation metadata |
| `wait` | `text`, `text_gone`, `selector`, or `frame`; optional `timeout_ms` | condition result, timeout observation | Wait for an observed condition; a duration alone is not a condition |
| `send_keys` | `keys`, optional `repeat`, `focus_emulation` | `{success, dispatched, os}` | e.g. `Enter`, `Escape`, `Mod+A`; acts on the focused element |
| `mouse_click` | `selector`, optional `focus_emulation` | action result | Real pointer input for a visible element |
| `click` | `selector` (@e ref or CSS) | `{success, tag, text}` | Synthetic `el.click()` |
| `fill` | `selector`, `value` | `{success, tag, mode}` | Works on `<input>`/`<textarea>` AND `[contenteditable]` (ProseMirror/Lexical/Slate). `mode` is `"value"` or `"contenteditable"` |
| `evaluate` | `code` | `{type, value}` | Page JavaScript; wrap statements/async work in an IIFE |
| `cdp` | `method`, `params` | raw CDP response | Low-level fallback; see [Browser interaction](#browser-interaction) |
| `screenshot` | `format`(png\|jpeg), `quality`(0-100), optional `selector` (@e/CSS), optional `path` | `{format, path, sizeBytes, mimeType}` | Returns a file path, not base64 — see [Screenshots](#screenshots-and-pdf-export) |
| `network` | `cmd`(start\|stop\|list\|detail), `filter`(URL substring, for `list`), `requestId`(for `detail`) | `list`: `{count, requests:[{requestId, url, method, status, mimeType, completed}]}`; `detail`: that request plus `requestHeaders`, `requestBody`, `body` (the response) | Capture is per tab, from `start` on. Call `detail` before `stop` — stopping releases the response bodies, and `detail` then returns `bodyError` instead of `body` |
| `upload` | `selector`, `files`(string[]) | `{success, fileCount}` | |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, optional `path` | `{path, sizeBytes, mimeType, pageTitle}` | Render current page → PDF, returns a file path — see [Save as PDF](#screenshots-and-pdf-export) |
| `list_tabs` | — | `{success, tabs:[{tabId, url, title, active, groupTitle, borrowed}]}` | Inspect tabs in the current session; `borrowed:true` identifies tabs to preserve during cleanup |
| `list_browser_tabs` | — | `{success, tabs:[{tabId, windowId, url, title, active}]}` | Inspect all tabs visible to this WebBridge connection, across windows; does not attach or focus a tab |
| `attach_tab` | `tabId` | `{success, tabId, url, title, borrowed}` | Attach a specific existing tab to this session without focusing it; borrowed tabs survive `close_session` |
| `close_tab` | — | `{success, closed: bool}` | Close the current tab only when that is intended; it can close a borrowed tab |
| `close_session` | — | `{success, closed: int}` | Close tabs opened by this session; borrowed tabs stay open. `closed` is the count. See [Sessions](#sessions) for when to call |

### Tabs and the current tab

Single-tab tools (`snapshot`, `click`, `fill`, `screenshot`, `save_as_pdf`) act on the **current tab** — the one you most recently opened with `navigate`, selected with `find_tab`, or attached with `attach_tab`.

- **Opening pages**: use `newTab:true` when pages should coexist (comparing, cross-referencing); omit it to send the current tab to a new URL.
- **Going back to an earlier tab**: `find_tab` searches tabs already in this session by host, ignoring paths (`kimi.com` also matches `www.kimi.com`). For a specific tab among several on the same host, take its `tabId` from `list_tabs` and use `attach_tab` to select it exactly. Reattaching an owned tab preserves its ownership.
- **Acting on a page the user already has open**: call `list_browser_tabs`, choose the tab by its URL/title and `tabId`, then call `attach_tab` with that ID. This also works for tabs in other windows and does not change the user's foreground tab. The attached tab is borrowed and remains open after `close_session`. For the particular tab the user is currently viewing, `find_tab` with `active:true` still works.
- If `find_tab` errors with "no tab matching … in this session", the page isn't open in this session — `navigate` with `newTab:true` instead.

### Call Format

Every command carries a top-level `session` naming the current task — see [Sessions](#sessions) below. The examples in later sections omit it only for brevity; in real calls always include it. Every reply is an envelope: `{"ok":true,"data":…}` on success (the **Returns** column above describes `data`) or `{"ok":false,"error":{"code","message"}}` on failure. The command format depends on the user's OS.

**macOS / Linux** — inline JSON is fine:

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"My task"},"session":"my-task"}'
```

If the inline call fails — a shell quoting/syntax error from bash, or an HTTP 400 from the daemon — do **not** retry the same command unchanged. Resend the request as a file body:

1. Write the JSON body to a **uniquely-named** temp file with your own file-write tool — never with shell `echo`/heredoc, which mangles the JSON the same way. Use a fresh name per request (e.g. `/tmp/webbridge-req-<random>.json`).
2. POST the file:

```bash
curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' --data-binary @/tmp/webbridge-req-<random>.json
```

3. Delete the temp file as soon as the request returns.

**Windows (PowerShell / cmd)** — the shell corrupts non-ASCII characters (Chinese etc.) carried inline in command arguments or pipes; they reach the daemon as `?` and the text is unrecoverable. Send **every** request as a file body instead:

1. Write the JSON body to a **uniquely-named** temp file with your own file-write tool — never with shell `echo`/heredoc, which corrupts non-ASCII the same way. Give **every** request its own filename with a random suffix (e.g. `webbridge-req-<random>.json`) so concurrent requests never share a file and overwrite each other.
2. POST the file with `curl.exe` — always `curl.exe`, never bare `curl`, which Windows PowerShell aliases to `Invoke-WebRequest`:

```powershell
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$env:TEMP\webbridge-req-<random>.json"
```

3. Delete the temp file as soon as the request returns — don't leave request bodies on disk.

## Sessions

**One task = one session = one tab group.** A `session` collects every tab the task opens into one tab group, so the user sees a single group for "what the agent is doing right now". Pass it as a **top-level field** of the request body (not inside `args`).

- **Pick one session name at the task's start, put it on every command, and never switch mid-task — even across different sites.** Switching session names per site is the #1 cause of fragmented tab groups.
- Name it after the **task**, not the site (`camping-research`, `phone-compare`). Use multiple sessions only for genuinely unrelated parallel tasks.
- `group_title` is the human-readable group label — write it in the user's language, on the **first** `navigate` of the task.
- Keep startup updates about the user's task; defer tab cleanup decisions to [Task completion](#task-completion), without an opening reminder about closing the group.

```bash
# First tab: set session + a human label (in the user's language)
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"navigate","args":{"url":"https://www.kimi.com","newTab":true,"group_title":"K2.6 feature research"},"session":"k26-research"}'
# Another site, same task → same session → joins the same group automatically
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"navigate","args":{"url":"https://www.moonshot.cn","newTab":true},"session":"k26-research"}'
```

### Task completion

Treat the task group as the cleanup unit. Follow existing user instructions to keep or close it. A turn ending is not task completion: keep the group while work, login, approval or recovery is still pending.

When the task is complete and its verified result is ready to deliver, call `list_tabs` to record the current inventory. Retaining any page in the group means keeping the group:

- **Temporary task, results captured:** call `close_session` to close the whole task group. Borrowed user tabs are automatically spared; no separate ownership classification is needed.
- **Pages are the deliverable or still in use:** keep the whole group, including when there is unsaved work or the user has taken over a page. No cleanup question is needed.
- **Uncertain:** present the result, then ask once whether to close the named task group or keep it. Prefer the host's native choice tool when exposed and permitted for this purpose in the current mode; otherwise ask in plain text. Use concrete options such as “Close task pages” / “Keep pages”. Mention any uncertainty about unsaved work. An unanswered question, dismissal or preselected option means keep; do not repeatedly ask.

For a delayed close answer, refresh `list_tabs`. If the group has gained pages or its use has changed since the question, keep it until the changed scope is resolved. Use `close_session` for group cleanup, not a per-page deletion workflow. Report only the actual `closed` count; if fewer tabs close than expected, check the original IDs with `list_browser_tabs` before claiming all pages closed, since `close_session` clears its ledger even on partial closure.

## Reading pages

Start with `snapshot` for structure and actionable `@e` refs. Copy refs as opaque strings: they stay bound to the same DOM nodes, not to a replacement with the same name. Refresh the snapshot after navigation or a stale-ref error. Use `find(query)` then `snapshot(ref)` to narrow a large page.

For bounded text, call `snapshot` with `format:"aria"` and `max_chars` (1–60000, default 60000). If `truncated:true`, pass `next_cursor` as `cursor` with `format:"aria"` and without `ref`; concatenate `tree_text` chunks without extra separators. Continuations read the saved observation, not later page edits. Restart the snapshot if the cursor expires.

Use `read_page({})` for the main document's text; omit `frame`. The main document may be an empty shell around an embedded document, so inspect `snapshot.frames` when the expected content is absent. A `complete:false` result is partial, not proof the rest of the document is empty. Follow its `note`; when `nextStart` is supplied, pass it as `start` to continue. Dynamic pages may change between scans; do not keep scanning an endless feed to try to finish it.

**Embedded documents:** top-page refs and DOM actions do not reach into iframes. Use a `frame` handle from `snapshot.frames` with `read_page`, e.g. `{"frame":"#f1"}`. `wait` with `{"frame":"any"}` waits for a large readable embedded document; use the snapshot for smaller frames. Frame reads must echo `frame` in the response; if absent, the extension is older and returned the top page. Ask the user to update it. Acting inside frames is not supported by these DOM tools; a frame URL may work as a separate page, but authenticated previews often do not.

## Browser interaction

- After an action, wait for an observed condition, e.g. `wait({"selector":".search-result","timeout_ms":10000})`; a duration alone is not a condition. Text and selectors check the main page, excluding iframe documents. For embedded documents, follow the frame workflow above. On `timedOut:true`, inspect `observation` if present, then use `snapshot` to choose the next step. Extend the deadline only when the page shows continuing progress.
- Use `click` / `fill` with observed refs. `fill` replaces existing text; to append, read the current value first and concatenate.
- For Enter, Escape or shortcuts, use `send_keys`, e.g. `{"keys":"Enter"}`. On background tabs, enable focus emulation (below) before focusing the intended element, send the keys, then disable emulation. Verify the resulting page state: successful dispatch alone does not prove the form submitted. `Mod` selects Cmd on macOS and Ctrl elsewhere; native macOS text inputs may ignore Cmd editing shortcuts, so use `fill` for text replacement.
- When a site requires real pointer events, use `mouse_click` with the observed selector and `focus_emulation:true` for a background tab. Login, CAPTCHA or other human-only gates may still require the user.
- Use `evaluate` for attributes absent from the snapshot, page data extraction, verified in-page API requests, or interactions the higher-level tools cannot express. Wrap code in `(() => { ... })()` or `(async () => { ... })()` to avoid global declaration collisions and allow `await`. Keep returned data bounded; if serializing, use compact `JSON.stringify`.
- Raw `cdp` is a fallback. For background rendering/input, enable `Emulation.setFocusEmulationEnabled` with `{"enabled":true}` and disable it when done. `Page.bringToFront` first enables emulation if off; a subsequent call can activate the tab. Reserve activation for when background operation fails; `Target.activateTarget` is refused.

## Screenshots and PDF export

`screenshot` and `save_as_pdf` return a local `path`, not base64. Open screenshots with the host's available image-viewing tool. An explicit `path` overwrites an existing file, so choose a unique output path.

For `screenshot`, omit options for a PNG viewport capture; use `selector` for one element, or `format:"jpeg"` and `quality` for JPEG.

For `save_as_pdf`, optional arguments are `paper_format` (`letter` default, `a4`, `legal`, `a3`, `tabloid`), `landscape` (default false), `scale` (0.1–2, default 1), `print_background` (default true), and `path`. The daemon rejects PDFs larger than 100 MB; reduce the output or split the page.

## If a tool call fails (daemon or extension not ready)

**If a tool call can't reach the daemon (connection refused), or the reply isn't the `ok` envelope above (another program is answering on that port), run `start` yourself, don't ask the user. It is safe anytime: it no-ops if the daemon is already up.** The binary is not on PATH: `~/.kimi-webbridge/bin/kimi-webbridge` (Windows: `%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe`).

Where the daemon listens is always in `start`'s output, or in `kimi-webbridge status` (`port` when it is running, `addr` when it is not). If it isn't `127.0.0.1:10086`, use that address for every call in this task. The config file is only for moving the daemon, never for finding it. Then retry the tool call.

**If the reply is `ok:false` with code `extension_not_connected`**, the daemon is fine and the browser side isn't — `start` won't change that. The message names what the user has to do; relay it in their language and carry on once they confirm.

**`start` fails with “held by another program”**: follow [Listen address](references/operations.md#listen-address) to move the daemon and reconnect the extension.

If it still fails, the binary is missing (`command not found` means kimi-webbridge isn't installed), or the browser extension won't connect — point the user to the help page instead of deep-troubleshooting:

- English: https://www.kimi.com/en/products/kimi-webbridge
- 中文: https://www.kimi.com/products/kimi-webbridge

Never run `stop` / `restart` / `upgrade` / `uninstall` automatically — those kill a running daemon. When `status` shows `version_mismatch`, `update_available` or `skill_mismatch`, or a command prints a `==> … Run: <command>` notice, read [Update notices](references/operations.md#update-notices) for when and how to relay it. When the user asks about kimi-webbridge itself (install, start/stop/upgrade, "is it running", what `status` means, moving it to another port), read `references/operations.md` first.

## Version mismatches

If a tool error says **“Please update the Kimi Browser Extension”**, tell the user to update the browser extension using the help page above, then retry. Updating only the daemon does not add missing browser tools.
