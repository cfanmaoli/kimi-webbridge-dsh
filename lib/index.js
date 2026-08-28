import z from "@deepseek-ai/schemastery";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Kimi WebBridge plugin for dsh.
 *
 * Infrastructure-only bridge plugin:
 * - provisions the daemon binary (official Kimi CDN, SHA-256 verified) and
 *   auto-starts it, keeping the bridge healthy;
 * - registers the packaged skill.md (the full 17-action HTTP protocol for
 *   driving the user's real browser) as a runtime skill via ctx.skills;
 * - registers one thin tool `kimi_webbridge` whose only action is `status`
 *   (daemon + extension health check) as an anchor for other skills.
 *
 * A browser extension must still be connected for browser actions to work.
 *
 * @module kimi-webbridge-dsh
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "kimi-webbridge";

/** Services required by this plugin. */
const inject = ["tools", "systemPrompt", "skills"];

/** The single action of the thin bridge tool. The full browser protocol lives in the generated skill. */
const ACTIONS = ["status"];

/** Runtime configuration schema for the plugin. */
const Config = z.object({
  baseUrl: z.string().default("http://127.0.0.1:10086"),
  requestTimeoutMs: z.number().step(1).min(1000).default(120000),
  autoStartDaemon: z.boolean().default(true),
  autoInstallDaemon: z.boolean().default(true),
  daemonVersion: z.string().default("latest"),
  registerSkill: z.boolean().default(true)
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

/** Skill identity registered into the host skill registry. */
const SKILL_NAME = "kimi-webbridge";

/** Model-facing routing description shown in the skill catalog. */
const SKILL_DESCRIPTION = `Drive the user's real browser (with their login sessions) through the local kimi-webbridge daemon at 127.0.0.1:10086: navigate, click, type, read, screenshot, evaluate JS, raw CDP, network capture, file upload, PDF export, and tab/session management. Use this skill whenever the user wants to interact with websites, automate browser tasks, scrape web content, or do anything that needs a real browser — even simple-sounding requests. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", or asks to read/interact with any website (浏览器 / 网页 / 打开网页 / 截图 / 页面).`;

/**
 * Read the packaged skill body (markdown instructions, no frontmatter).
 * @returns the skill body text.
 */
function readSkillBody() {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "skill.md"), "utf8");
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
    daemonVersion = "latest",
    registerSkill = true
  } = config;

  if (registerSkill) {
    try {
      ctx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        source: "bundled",
        content: readSkillBody()
      });
    } catch (error) {
      // Never break plugin startup over skill registration; the status tool still works.
      console.warn(`kimi-webbridge: skill registration failed: ${error?.message ?? error}`);
    }
  }

  ctx.systemPrompt.section({
    name: "tool:kimi-webbridge",
    order: 105,
    text: "kimi-webbridge: the local kimi-webbridge daemon (127.0.0.1:10086) bridges to the user's real browser with their login sessions; this plugin provisions the daemon binary and keeps it running. The `kimi_webbridge` tool is only the status health check (daemon + extension). For any browser automation (navigation, reading pages, clicking, typing, filling forms, screenshots, JS evaluation, CDP, uploads, PDF export, tab management), load the kimi-webbridge skill and drive the daemon over HTTP exactly as that skill documents."
  });

  ctx.tools.register(defineTool({
    name: "kimi_webbridge",
    description: "Health check for the local kimi-webbridge bridge (daemon at " + baseUrl + " and the browser extension). The plugin auto-provisions the daemon: it installs the binary from the official Kimi CDN when missing and starts it, then retries once. Returns daemon version/uptime and extension_connected. This tool does NOT perform browser actions — for navigation, clicking, typing, reading pages, screenshots, JS evaluation, CDP, uploads, PDF export and tab management, load the kimi-webbridge skill, which documents the full 17-action HTTP protocol (POST " + baseUrl + "/command) to drive the user's real browser.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ACTIONS,
        description: "The single supported action: status — check daemon and browser-extension health."
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
      const attempt = () => httpJson(`${baseUrl}/status`, { method: "GET", timeoutMs: requestTimeoutMs, signal: exec.signal });
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
        title: "kimi_webbridge status",
        rawInput: JSON.stringify({ action: callArgs.action ?? "status" }),
        content: [{ type: "text", text: "checking daemon + extension health" }]
      };
    }
  }));
}

export { Config, apply, inject, name };
