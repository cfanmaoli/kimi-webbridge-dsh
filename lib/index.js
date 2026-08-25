import z from "@deepseek-ai/schemastery";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Kimi WebBridge plugin for dsh.
 *
 * Registers one model-facing tool `kimi_webbridge` that drives the user's real
 * browser (their login sessions) through the local kimi-webbridge daemon at
 * `127.0.0.1:10086`.
 *
 * The plugin is self-sufficient: if the daemon binary is missing it is
 * downloaded from the official Kimi CDN (the same source the official
 * installer uses) and started automatically, so no external installer
 * command is required. A browser extension must still be connected for
 * browser actions to work.
 *
 * All requests go straight to the daemon over HTTP, so there are none of the
 * shell-quoting / non-ASCII corruption issues of curl-based integration.
 *
 * @module kimi-webbridge-dsh
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "kimi-webbridge";

/** Services required by this plugin. */
const inject = ["tools", "systemPrompt"];

/** Every action the daemon accepts on POST /command, plus local "status". */
const ACTIONS = [
  "status",
  "navigate",
  "find_tab",
  "snapshot",
  "click",
  "fill",
  "evaluate",
  "cdp",
  "screenshot",
  "network",
  "upload",
  "save_as_pdf",
  "list_tabs",
  "close_tab",
  "close_session"
];

/** Runtime configuration schema for the plugin. */
const Config = z.object({
  baseUrl: z.string().default("http://127.0.0.1:10086"),
  requestTimeoutMs: z.number().step(1).min(1000).default(120000),
  autoStartDaemon: z.boolean().default(true),
  autoInstallDaemon: z.boolean().default(true),
  daemonVersion: z.string().default("latest")
});

/** Official release CDN base. */
const CDN_BASE = "https://cdn.kimi.com/webbridge";

/**
 * Absolute path of the kimi-webbridge daemon binary under the user home.
 * Windows: ~/.kimi-webbridge/bin/kimi-webbridge.exe; elsewhere: ~/.kimi-webbridge/bin/kimi-webbridge.
 */
function daemonBinPath() {
  const dir = join(homedir(), ".kimi-webbridge", "bin");
  return join(dir, process.platform === "win32" ? "kimi-webbridge.exe" : "kimi-webbridge");
}

/**
 * Map the current Node platform/arch to the official release filename.
 * Mirrors the official install.sh (darwin/linux) and install.ps1 (windows).
 * @returns the release filename, or null when unsupported.
 */
function releasePlatform() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32" && a === "x64") return "windows-amd64.exe";
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-amd64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  if (p === "linux" && a === "x64") return "linux-amd64";
  return null;
}

/**
 * Platform-aware manual-install hint shown when auto-install is disabled or fails.
 * Windows users get the PowerShell one-liner; macOS/Linux users get the bash one-liner.
 * @returns a short human-readable install instruction.
 */
function manualInstallHint() {
  const page = "https://www.kimi.ai/products/kimi-webbridge";
  if (process.platform === "win32") {
    return `run \"irm https://cdn.kimi.com/webbridge/install.ps1 | iex\" in PowerShell (or install from ${page})`;
  }
  return `run \"curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash\" (or install from ${page})`;
}

/**
 * One HTTP JSON round-trip with a timeout and caller-abort support.
 * @param url - absolute URL.
 * @param options - method, optional JSON body, timeout, and AbortSignal.
 * @returns the parsed JSON body (or raw text fallback) plus the status code.
 */
function httpJson(url, { method = "GET", body, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(new Error(`kimi-webbridge: invalid baseUrl ${url}: ${String(error)}`));
      return;
    }
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = body === void 0 ? void 0 : JSON.stringify(body);
    let req;
    let timer;
    const abort = (error) => {
      clearTimeout(timer);
      if (req) req.destroy(error);
      else reject(error);
    };
    timer = setTimeout(() => abort(new Error(`kimi-webbridge: request timed out after ${timeoutMs}ms`)), timeoutMs);
    const onSignal = () => abort(new Error("aborted"));
    if (signal?.aborted) onSignal();
    else signal?.addEventListener("abort", onSignal, { once: true });
    req = transport(target, {
      method,
      headers: payload !== void 0 ? { "Content-Type": "application/json" } : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onSignal);
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          parsed = { raw: text };
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onSignal);
      reject(error);
    });
    if (payload !== void 0) req.write(payload);
    req.end();
  });
}

/**
 * Download a file to disk, following up to maxRedirects redirects.
 * @param url - absolute download URL.
 * @param dest - destination file path.
 * @param options - per-request timeout and redirect budget.
 * @returns the destination path on success.
 */
function downloadFile(url, dest, { timeoutMs, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const fetch = (targetUrl, depth) => {
      let target;
      try {
        target = new URL(targetUrl);
      } catch (error) {
        reject(new Error(`kimi-webbridge: invalid download URL ${targetUrl}: ${String(error)}`));
        return;
      }
      const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
      const req = transport(target, { method: "GET" }, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location !== void 0 && depth > 0) {
          res.resume();
          fetch(new URL(location, target).toString(), depth - 1);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`download failed: HTTP ${status} for ${targetUrl}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(dest)));
        file.on("error", reject);
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timed out after ${timeoutMs}ms`)));
      req.end();
    };
    fetch(url, maxRedirects);
  });
}

/**
 * Download the daemon binary from the official CDN into ~/.kimi-webbridge/bin.
 *
 * The URL layout mirrors the official installer: {CDN}/{version}/releases/kimi-webbridge-{platform}.
 * The platform is derived from the runtime hardware (see releasePlatform), so the
 * correct binary for Windows / macOS / Linux is fetched automatically.
 *
 * When the release manifest (version.json) for the same version is available, the
 * downloaded binary is verified against its published SHA-256 before being installed;
 * a mismatch aborts the install and removes the file, so an unexpected binary can
 * never land on disk.
 *
 * @returns { bin, url, sha256 } on success (sha256 is the manifest digest, or null when the manifest is unavailable).
 */
async function installDaemonBinary({ version, timeoutMs }) {
  const platform = releasePlatform();
  if (platform === null) {
    throw new Error(`unsupported platform ${process.platform}-${process.arch} — install the daemon manually (see https://www.kimi.com/zh-cn/features/webbridge)`);
  }
  const manifestKey = platform.endsWith(".exe") ? platform.slice(0, -4) : platform;
  const bin = daemonBinPath();
  await mkdir(dirname(bin), { recursive: true });
  const base = `${CDN_BASE}/${encodeURIComponent(version)}`;
  const url = `${base}/releases/kimi-webbridge-${platform}`;
  // Best-effort: fetch the release manifest for the expected SHA-256.
  let expectedSha = null;
  try {
    const manifest = await httpJson(`${base}/version.json`, { method: "GET", timeoutMs });
    if (manifest.status >= 200 && manifest.status < 300 && manifest.body !== null && typeof manifest.body === "object") {
      expectedSha = manifest.body?.binaries?.[manifestKey]?.sha256 ?? null;
    }
  } catch {
    // Manifest unavailable (e.g. old pinned version) — install without checksum.
  }
  const tmp = `${bin}.tmp-${process.pid}-${Date.now()}`;
  await downloadFile(url, tmp, { timeoutMs });
  if (expectedSha !== null) {
    const actual = createHash("sha256").update(await readFile(tmp)).digest("hex");
    if (actual !== expectedSha) {
      await rm(tmp, { force: true });
      throw new Error(`downloaded binary SHA-256 mismatch for ${platform}: expected ${expectedSha}, got ${actual}`);
    }
  }
  await rename(tmp, bin);
  if (process.platform !== "win32") await chmod(bin, 0o755);
  return { bin, url, sha256: expectedSha };
}

/** Start the daemon detached (idempotent — no-ops when port 10086 is already bound). */
function startDaemonProcess() {
  return new Promise((resolve) => {
    const child = spawn(daemonBinPath(), ["start"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.unref();
    // Give the daemon a moment to bind the port before retrying.
    setTimeout(() => resolve(true), 1500);
  });
}

/** Turn a thrown error into the canonical aborted HarnessError. */
function abortError() {
  const error = new HarnessError("tool call aborted", TOOL_ABORTED);
  error.name = "AbortError";
  return error;
}

/** Shape one daemon response into the canonical tool value. */
function canonicalResult(result) {
  if (result.status >= 200 && result.status < 300) {
    const body = result.body;
    return { ok: true, ...(body !== null && typeof body === "object" ? body : { value: body }) };
  }
  const body = result.body;
  return {
    ok: false,
    httpStatus: result.status,
    ...(body !== null && typeof body === "object" ? body : { message: result.text || `HTTP ${result.status}` })
  };
}

/**
 * Cordis plugin apply: register the kimi_webbridge tool and a short usage
 * section in the system prompt.
 */
function apply(ctx, config = {}) {
  const {
    baseUrl = "http://127.0.0.1:10086",
    requestTimeoutMs = 120000,
    autoStartDaemon = true,
    autoInstallDaemon = true,
    daemonVersion = "latest"
  } = config;

  ctx.systemPrompt.section({
    name: "tool:kimi-webbridge",
    order: 105,
    text: "kimi_webbridge drives the user's real browser through the local kimi-webbridge daemon. Use it for any web task that needs a real browser: navigation, reading pages (snapshot returns an accessibility tree with @e refs), clicking, filling forms, screenshots, JS evaluation, and PDF export. Keep one session name per task and pass it on every call so tabs group under one label."
  });

  ctx.tools.register(defineTool({
    name: "kimi_webbridge",
    description: "Drive the user's real browser (with their login sessions) via the local kimi-webbridge daemon at " + baseUrl + ". The browser extension must be connected (status shows extension_connected). One task = one session = one tab group: pick a session name at the start of a task and pass it on every call. Actions: status (daemon + extension health); navigate {url, newTab?, group_title?} (first call opens a tab); find_tab {url, active?} (re-select a session tab, or borrow the user's active tab); snapshot (accessibility tree with @e refs — use it to read content and locate elements); click {selector} (@e ref or CSS); fill {selector, value} (inputs, textareas, and contenteditable editors; clear-and-insert); evaluate {code} (async JS in the page realm; wrap re-declarations in an IIFE; return compact JSON); cdp {method, params} (raw chrome.debugger passthrough); screenshot {format?, quality?, selector?, path?} (returns a file path — open it with the read tool to see it); network {cmd, filter?, requestId?}; upload {selector, files}; save_as_pdf {paper_format?, landscape?, scale?, print_background?, path?}; list_tabs; close_tab; close_session (only when the user asks to close the tabs). Prefer @e refs from snapshot over hand-written CSS selectors. When the daemon is unreachable the plugin starts it automatically; if the daemon binary is missing it is downloaded from the official Kimi CDN (config autoInstallDaemon:false disables this). Limits: sites that strictly check event.isTrusted (some banking portals, captchas) ignore click/fill — tell the user the page needs manual interaction; cross-origin iframes are not covered by fill/click/snapshot/evaluate — navigate to the iframe URL directly; if an error says 'Please update the Kimi WebBridge extension', the extension is outdated — ask the user to update it and retry.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ACTIONS,
        description: "Which WebBridge action to perform."
      },
      session: {
        type: "string",
        description: "Task session name — one session per task, passed on every call so all tabs land in one group (e.g. \"camping-research\"). Defaults to \"default\"."
      },
      args: {
        type: "object",
        additionalProperties: true,
        description: "Action-specific arguments (see the tool description for each action's fields)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true
      },
      render(args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      }
    },
    isConcurrencySafe() {
      return false;
    },
    async execute(args, exec) {
      const action = args.action;
      const session = args.session ?? "default";
      const actionArgs = args.args ?? {};
      const target = action === "status" ? `${baseUrl}/status` : `${baseUrl}/command`;
      const attempt = () => action === "status"
        ? httpJson(target, { method: "GET", timeoutMs: requestTimeoutMs, signal: exec.signal })
        : httpJson(target, {
            method: "POST",
            body: { action, args: actionArgs, session },
            timeoutMs: requestTimeoutMs,
            signal: exec.signal
          });
      let result;
      try {
        result = await attempt();
      } catch (error) {
        const aborted = error?.message === "aborted" || error?.name === "AbortError";
        if (aborted) throw abortError();
        const refused = error?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(error?.message ?? error));
        if (!refused) {
          throw new Error(`kimi-webbridge: cannot reach daemon at ${baseUrl} (${error?.message ?? error}).`);
        }
        // The daemon is down. Provision the binary when missing, start it, then retry once.
        const notes = [];
        if (!existsSync(daemonBinPath())) {
          if (!autoInstallDaemon) {
            throw new Error(`kimi-webbridge: daemon binary not found at ${daemonBinPath()} and autoInstallDaemon is disabled. Install it manually: ${manualInstallHint()}`);
          }
          try {
            const { url } = await installDaemonBinary({ version: daemonVersion, timeoutMs: requestTimeoutMs });
            notes.push(`installed daemon from ${url}`);
          } catch (installError) {
            throw new Error(`kimi-webbridge: daemon binary missing and auto-install failed: ${installError?.message ?? installError}. Install it manually: ${manualInstallHint()}`);
          }
        }
        if (autoStartDaemon) {
          await startDaemonProcess();
          try {
            result = await attempt();
          } catch (retryError) {
            const hint = notes.length > 0 ? " " + notes.join("; ") + "." : "";
            throw new Error(`kimi-webbridge: daemon at ${baseUrl} still unreachable after starting it.${hint} Check ~/.kimi-webbridge/logs/daemon.log, or reinstall: ${manualInstallHint()}`);
          }
        } else {
          throw new Error(`kimi-webbridge: daemon at ${baseUrl} is not running and autoStartDaemon is disabled. Start it with: ${daemonBinPath()} start`);
        }
      }
      return canonicalResult(result);
    },
    presentCall(callArgs) {
      return {
        card: "generic",
        title: `kimi_webbridge ${callArgs.action}`,
        rawInput: JSON.stringify({ session: callArgs.session ?? "default", args: callArgs.args ?? {} }),
        content: [{ type: "text", text: `action: ${callArgs.action}` }]
      };
    }
  }));
}

export { Config, apply, inject, name };
