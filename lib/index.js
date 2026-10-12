import z from "@deepseek-ai/schemastery";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * Kimi WebBridge plugin for dsh.
 *
 * Infrastructure-only bridge plugin:
 * - provisions the daemon binary (official Kimi CDN, SHA-256 verified) and
 *   auto-starts it, keeping the bridge healthy;
 * - registers the skill package vendored under skill/ (the official upstream
 *   SKILL.md plus its references/) as a runtime skill via ctx.skills, with the
 *   directory exposed as its resource base;
 * - registers one thin tool `kimi_webbridge` whose only action is `status`
 *   (daemon + extension health check) as an anchor for other skills.
 *
 * Outbound HTTP uses the platform `fetch`, so requests inherit the process-wide
 * proxy policy the harness installs from the launch environment (`HTTP_PROXY`,
 * `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`); loopback traffic is never proxied.
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
  const page = "https://www.kimi.com/products/kimi-webbridge";
  if (process.platform === "win32") {
    return `run \"irm https://cdn.kimi.com/webbridge/install.ps1 | iex\" in PowerShell (or install from ${page})`;
  }
  return `run \"curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash\" (or install from ${page})`;
}

/** Skill identity registered into the host skill registry. */
const SKILL_NAME = "kimi-webbridge";

/** Vendored upstream skill package: `skill/SKILL.md` plus its `references/` tree. */
const SKILL_DIR = fileURLToPath(new URL("../skill/", import.meta.url));

/** The upstream instruction file inside {@link SKILL_DIR}. */
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");

/**
 * Extra routing triggers appended to the description upstream ships.
 *
 * The official description is English; the Chinese terms are what the same users type,
 * and the CLI trigger is one upstream only states at the very end of a long paragraph.
 * Keeping them here (rather than rewriting the vendored frontmatter) is what lets
 * `skill/UPSTREAM.json` stay byte-exact against the CDN.
 */
const SKILL_EXTRA_TRIGGERS = "Also use to build a reusable CLI or script that automates a specific website. Also use when the user mentions 浏览器 / 网页 / 打开网页 / 截图 / 页面.";

/**
 * Length of the routing line dsh renders in its model-facing skill catalog.
 *
 * `dsh-tool-skill` builds that line from the description and truncates it at
 * `catalogDescriptionMaxLength` (500 by default), silently dropping the rest — so the
 * registered description has to fit, or the model never sees the triggers above.
 */
const CATALOG_DESCRIPTION_LIMIT = 500;

/**
 * Used only when the vendored SKILL.md frontmatter cannot be parsed; a missing description
 * must never disable the skill. Carries no triggers of its own — {@link composeSkillDescription}
 * appends the shared ones either way.
 */
const FALLBACK_SKILL_DESCRIPTION = "Drive the user's real browser through the local kimi-webbridge daemon (127.0.0.1:10086) using their login sessions: navigate, read pages and iframes, click, type, screenshot, evaluate JS, raw CDP, network capture, uploads, PDF export, tabs and sessions. Use whenever a task needs a real browser.";

/**
 * The section appended after the vendored upstream instructions.
 *
 * Everything above it is upstream's document verbatim; this carries only the deltas
 * that are true in dsh (tool names, the status anchor, where references live), plus
 * the upstream release the copy came from — which stripping the frontmatter would
 * otherwise hide from the model. Keeping the split means refreshing the skill never
 * has to merge prose.
 *
 * @param version - the upstream version stamped in the vendored SKILL.md, when known.
 * @returns the markdown block to append.
 */
function dshRuntimeSection(version) {
  const provenance = typeof version === "string" && version.length > 0
    ? `This skill is vendored verbatim from the official upstream release v${version}; \`skill/UPSTREAM.json\` records its digests.`
    : "This skill is vendored verbatim from the official upstream release.";
  return `

## dsh runtime notes

The kimi-webbridge-dsh plugin adds these notes for this harness; where they conflict with the text above, they win.

${provenance}

- **Health check first**: before driving the browser, call the \`kimi_webbridge\` tool with action \`status\`. It reports daemon + extension health and auto-provisions this machine — it installs the daemon binary from the official CDN (SHA-256 checked against the release manifest) when it is missing, starts it, and retries once. The binary lives at \`~/.kimi-webbridge/bin/kimi-webbridge\` and is not on \`PATH\`; running it with \`start\` yourself is also safe and idempotent.
- **Tool names in this harness**: file tools are \`read\`, \`read_image\`, \`write\` and \`edit\`; the shell tool is \`bash\`; \`kimi_webbridge\` is the status anchor. Where the text above says "open it with the Read tool" for a screenshot or PDF, use \`read_image\`.
- **References**: paths such as \`references/operations.md\` and \`references/cli-creator/workflow.md\` resolve against the base directory reported when this skill loads. Read them with the \`read\` tool.
- **Skills installer**: the daemon's own \`install-skill\` / \`upgrade\` skill refresh targets the runtimes it detects (Claude Code, Codex, Hermes, OpenClaw, Kimi) — dsh is not one of them. This plugin is how dsh receives this skill, so never run \`install-skill\` on dsh's behalf.
- **Notices**: when \`status\` reports \`version_mismatch\`, \`update_available\` or \`skill_mismatch\`, hand the user that field's \`command\` verbatim. Never run \`stop\` / \`restart\` / \`upgrade\` / \`uninstall\` yourself — they kill the user's running daemon.
`;
}

/**
 * Parse the two frontmatter fields this plugin needs from the vendored SKILL.md.
 *
 * A deliberately small YAML subset parser: the upstream frontmatter is a fixed shape
 * (`name`, a `description` block scalar, `metadata.version`), and pulling in a YAML
 * dependency for three fields would cost more than it buys.
 *
 * @param raw - the SKILL.md text.
 * @returns the description, stamped version and body without frontmatter; fields are null when absent.
 */
function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (match === null) return { description: null, version: null, body: raw.trim() };
  let description = null;
  let version = null;
  let block = null;
  for (const line of match[1].split(/\r?\n/u)) {
    if (block !== null) {
      if (/^\s+\S/u.test(line)) {
        block.push(line.trim());
        continue;
      }
      description = block.join(" ").trim();
      block = null;
    }
    if (/^description:\s*[|>]\s*$/u.test(line)) {
      block = [];
      continue;
    }
    const inline = /^description:\s*(\S.*)$/u.exec(line);
    if (inline !== null) {
      description = inline[1].trim();
      continue;
    }
    const stamped = /^\s+version:\s*"?([^"\s]+)"?\s*$/u.exec(line);
    if (stamped !== null) version = stamped[1];
  }
  if (block !== null) description = block.join(" ").trim();
  return { description, version, body: raw.slice(match[0].length).trim() };
}

/**
 * Compose the registered routing description inside dsh's catalog budget.
 *
 * Upstream's own words lead — they name the product and the core capability — while the
 * added triggers are reserved their space up front, so the truncation dsh applies can
 * never eat them. When upstream does not fit, it is cut at a sentence boundary rather
 * than mid-word, which is what dsh's own truncation would do to the whole line.
 *
 * @param upstream - the description from the vendored SKILL.md frontmatter.
 * @returns a description of at most {@link CATALOG_DESCRIPTION_LIMIT} characters.
 */
function composeSkillDescription(upstream) {
  const triggers = SKILL_EXTRA_TRIGGERS;
  const text = upstream.replace(/\s+/gu, " ").trim();
  const room = CATALOG_DESCRIPTION_LIMIT - triggers.length - 1;
  if (text.length <= room) return `${text} ${triggers}`;
  const visible = text.slice(0, room + 1);
  const sentenceEnd = Math.max(visible.lastIndexOf(". "), visible.lastIndexOf("。"));
  if (sentenceEnd > 0) return `${visible.slice(0, sentenceEnd + 1)} ${triggers}`;
  return `${visible.slice(0, room).replace(/[\s,;:.]+$/u, "")} ${triggers}`;
}

/**
 * Load the vendored upstream skill package.
 *
 * @returns the routing description and the content to register (upstream body plus the
 * dsh runtime notes, which carry the upstream release the copy came from).
 */
function readSkillPackage() {
  const { description, version, body } = parseFrontmatter(readFileSync(SKILL_PATH, "utf8"));
  const fallback = typeof description !== "string" || description.length === 0;
  if (fallback) {
    console.warn(`kimi-webbridge: ${SKILL_PATH} has no frontmatter description; falling back to the built-in routing text`);
  }
  return {
    description: composeSkillDescription(fallback ? FALLBACK_SKILL_DESCRIPTION : description),
    content: `${body}${dshRuntimeSection(version)}`
  };
}

/** Underlying transport `code` for a rejected `fetch`, which buries it one level down in `cause`. */
function transportErrorCode(error) {
  const cause = error?.cause;
  return cause?.code ?? cause?.errors?.[0]?.code ?? error?.code;
}

/** Human-readable reason for a rejected `fetch`, preferring the transport cause over "fetch failed". */
function transportErrorMessage(error) {
  const cause = error?.cause;
  return cause?.errors?.[0]?.message ?? cause?.message ?? error?.message ?? String(error);
}

/**
 * Shape a rejected `fetch` into the error this plugin's callers expect.
 *
 * A caller abort surfaces as a bare `aborted` error, which the tool maps to the canonical abort;
 * a timeout names itself; and a transport failure keeps the underlying `code` (`ECONNREFUSED`,
 * `ENOTFOUND`, …) so daemon self-healing still recognizes an unreachable local daemon.
 *
 * @param error - the rejection from `fetch` or from consuming its body.
 * @param options - caller signal, whether our own timeout fired, and that timeout.
 * @returns the error to throw.
 */
function fetchFailure(error, { signal, timedOut, timeoutMs } = {}) {
  if (signal?.aborted) return new Error("aborted");
  if (timedOut || error?.name === "TimeoutError") {
    return new Error(`kimi-webbridge: request timed out after ${timeoutMs}ms`);
  }
  const failure = new Error(transportErrorMessage(error));
  const code = transportErrorCode(error);
  if (code !== void 0) failure.code = code;
  return failure;
}

/**
 * One HTTP JSON round-trip with a timeout and caller-abort support.
 *
 * Uses the platform `fetch`, so the request inherits the process-wide proxy policy the harness
 * installs from the launch environment. An already-aborted caller signal fails immediately,
 * without issuing a request.
 *
 * @param url - absolute URL.
 * @param options - method, optional JSON body, timeout, and AbortSignal.
 * @returns the parsed JSON body (or raw text fallback) plus the status code.
 */
async function httpJson(url, { method = "GET", body, timeoutMs, signal } = {}) {
  try {
    new URL(url);
  } catch (error) {
    throw new Error(`kimi-webbridge: invalid baseUrl ${url}: ${String(error)}`);
  }
  // Fail fast: never issue a request the caller has already cancelled.
  if (signal?.aborted) throw new Error("aborted");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const payload = body === void 0 ? void 0 : JSON.stringify(body);
  try {
    const response = await fetch(url, {
      method,
      headers: payload === void 0 ? void 0 : { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed, text };
  } catch (error) {
    throw fetchFailure(error, { signal, timedOut, timeoutMs });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Stream an HTTP response body to disk, following redirects.
 *
 * Uses the platform `fetch`, so a CDN download works behind the proxy the harness installs from
 * the launch environment. The timeout is an *idle* budget — it restarts on every received chunk —
 * so a large but progressing download is never cut off, matching the socket idle timeout the
 * previous `node:http` implementation relied on.
 *
 * @param url - absolute download URL.
 * @param dest - destination file path.
 * @param options - per-chunk idle timeout in milliseconds.
 * @returns the destination path on success.
 */
async function downloadFile(url, dest, { timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
  };
  arm();
  const file = createWriteStream(dest);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
    for await (const chunk of Readable.fromWeb(response.body)) {
      arm();
      if (!file.write(chunk)) await once(file, "drain");
    }
    await new Promise((resolve, reject) => {
      file.end((error) => (error ? reject(error) : resolve()));
    });
    return dest;
  } catch (error) {
    file.destroy();
    throw fetchFailure(error, { timedOut, timeoutMs });
  } finally {
    clearTimeout(timer);
  }
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
    throw new Error(`unsupported platform ${process.platform}-${process.arch} — install the daemon manually (see https://www.kimi.com/products/kimi-webbridge)`);
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
  try {
    await downloadFile(url, tmp, { timeoutMs });
    if (expectedSha !== null) {
      const actual = createHash("sha256").update(await readFile(tmp)).digest("hex");
      if (actual !== expectedSha) {
        throw new Error(`downloaded binary SHA-256 mismatch for ${platform}: expected ${expectedSha}, got ${actual}`);
      }
    }
    await rename(tmp, bin);
  } catch (error) {
    // Never leave a partial or unverified download behind.
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
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

/**
 * Compare two dotted numeric versions, ignoring any prerelease/build suffix.
 * @param a - left version (no leading "v").
 * @param b - right version (no leading "v").
 * @returns -1, 0, or 1.
 */
function compareVersions(a, b) {
  const parts = (value) => value.split(/[.\-+]/).map((piece) => Number.parseInt(piece, 10));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = Number.isNaN(left[index]) ? 0 : left[index] ?? 0;
    const y = Number.isNaN(right[index]) ? 0 : right[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
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
      const skill = readSkillPackage();
      // resourceBase is what lets the model resolve the upstream document's
      // "references/..." links: the host renders it as this skill's base directory.
      ctx.skills.register({
        name: SKILL_NAME,
        description: skill.description,
        source: "bundled",
        content: skill.content,
        resourceBase: { kind: "directory", path: SKILL_DIR }
      });
    } catch (error) {
      // Never break plugin startup over skill registration; the status tool still works.
      console.warn(`kimi-webbridge: skill registration failed: ${error?.message ?? error}`);
    }
  }

  ctx.systemPrompt.section({
    name: "tool:kimi-webbridge",
    order: 105,
    text: "kimi-webbridge: the local kimi-webbridge daemon (127.0.0.1:10086) bridges to the user's real browser with their login sessions; this plugin provisions the daemon binary, keeps it running, and registers the official upstream skill package (with its references/ directory). The `kimi_webbridge` tool is only the status health check (daemon + extension + installed skill copies). For any browser work — navigation, reading pages and iframes, clicking, typing, form filling, trusted input via CDP focus emulation, screenshots, JS/CDP, network capture, uploads, PDF export, tabs and sessions, attaching tabs the user already has open, and building a reusable CLI for a website — load the kimi-webbridge skill and drive the daemon over HTTP exactly as that skill (and its references) documents."
  });

  ctx.tools.register(defineTool({
    name: "kimi_webbridge",
    description: "Health check for the local kimi-webbridge bridge (daemon at " + baseUrl + " and the browser extension). The plugin auto-provisions the daemon: it installs the binary from the official Kimi CDN when missing and starts it, then retries once. Returns daemon version/uptime, extension_connected, plus version (daemon) and extension_version (extension) — a mismatch means the components have drifted (the extension likely auto-updated) — and the upstream notices skills, version_mismatch, update_available and skill_mismatch. This tool does NOT perform browser actions — for navigation, reading pages and iframes, clicking, typing, screenshots, JS/CDP, trusted input, network capture, uploads, PDF export, tabs/sessions, attaching tabs the user already has open, or building a reusable CLI for a website, load the kimi-webbridge skill, which documents the daemon's tool protocol (POST " + baseUrl + "/command) and ships its references/ alongside.",
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
        const blocks = [{ type: "text", text: JSON.stringify(value) }];
        const norm = (s) => (typeof s === "string" ? s.replace(/^v/i, "") : "");
        const daemonVer = norm(value?.version);
        const extVer = norm(value?.extension_version);
        if (daemonVer && extVer && daemonVer !== extVer) {
          const daemonAhead = compareVersions(daemonVer, extVer) > 0;
          blocks.push({
            type: "text",
            text: daemonAhead
              ? `⚠️ the browser extension (${value.extension_version}) is behind the daemon (${value.version}) — ask the user to update the extension, then retry.`
              : `⚠️ version drift: daemon ${value.version} vs extension ${value.extension_version} — the browser extension likely auto-updated ahead of the daemon. Re-audit the skill against the new tool surface and update the daemon.`
          });
        }
        // The official convention: surface the release fields verbatim and let the
        // user run the command — a model-triggered upgrade would kill the daemon.
        const update = value?.update_available;
        if (update !== null && typeof update === "object" && typeof update.command === "string") {
          blocks.push({
            type: "text",
            text: `⬆️ update available: daemon ${update.current ?? "?"} → ${update.latest ?? "?"} — tell the user and hand them this command verbatim; do NOT run it yourself: ${update.command}`
          });
        }
        // Installed skill copies the daemon found in the agent runtimes it manages.
        // dsh is not one of them, so an empty list is the normal dsh result.
        const skills = value?.skills;
        if (Array.isArray(skills) && skills.length > 0) {
          const listed = skills
            .map((entry) => `${entry?.agent ?? "?"}@${entry?.version ?? "?"}${typeof entry?.path === "string" ? ` (${entry.path})` : ""}`)
            .join("; ");
          blocks.push({ type: "text", text: `installed skill copies: ${listed}` });
        }
        const skillMismatch = value?.skill_mismatch;
        if (skillMismatch !== null && typeof skillMismatch === "object" && typeof skillMismatch.command === "string") {
          blocks.push({
            type: "text",
            text: `⚠️ installed kimi-webbridge skill copies are out of step with the extension (${skillMismatch.extension_version ?? "?"}) — tell the user and hand them this command verbatim; do NOT run it yourself: ${skillMismatch.command}`
          });
        }
        return blocks;
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
