#!/usr/bin/env node
/**
 * Vendor the official kimi-webbridge skill package into ./skill.
 *
 * Upstream publishes one skill package per release alongside the daemon binary:
 *
 *   https://cdn.kimi.com/webbridge/{version}/skills/kimi-webbridge.tar.gz
 *   https://cdn.kimi.com/webbridge/{version}/skills/kimi-webbridge-windows.tar.gz
 *
 * The tarball holds `kimi-webbridge/SKILL.md` plus `kimi-webbridge/references/**`.
 * This plugin ships that tree verbatim under `skill/` and registers it; keeping a
 * byte-exact copy is what lets the plugin track upstream without hand-editing
 * protocol prose. `skill/UPSTREAM.json` records the release, the tarball digest
 * and every vendored file digest so drift is detectable.
 *
 * Usage:
 *   node scripts/fetch-upstream-skill.mjs                  # fetch latest, rewrite skill/
 *   node scripts/fetch-upstream-skill.mjs --version v2.0.22
 *   node scripts/fetch-upstream-skill.mjs --check           # fetch and compare, never write
 *   node scripts/fetch-upstream-skill.mjs --verify-local    # no network: verify vendored files
 *
 * `--check` exits non-zero when upstream moved (release, tarball digest, file set or
 * file contents), so a scheduled job can open an issue instead of drifting silently.
 *
 * @module scripts/fetch-upstream-skill
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const CDN_BASE = "https://cdn.kimi.com/webbridge";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(PACKAGE_ROOT, "skill");
const MANIFEST_PATH = join(SKILL_DIR, "UPSTREAM.json");
/** Directory inside the tarball that becomes `skill/`. */
const TARBALL_PREFIX = "kimi-webbridge/";

/** Files this script owns. Anything else under skill/ is hand-written and left alone. */
const MANAGED_ROOT = ["SKILL.md", "references"];

/** SHA-256 of a buffer, as lowercase hex. */
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Read a NUL/space-padded octal field from a tar header.
 * @param block - the 512-byte header block.
 * @param offset - field start.
 * @param length - field length.
 * @returns the parsed number, or 0 for an empty field.
 */
function readOctal(block, offset, length) {
  const text = block.subarray(offset, offset + length).toString("latin1").replace(/\0.*$/s, "").trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

/** Read a NUL-terminated string field from a tar header. */
function readString(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/**
 * Parse a ustar archive into regular-file entries.
 *
 * Handles the ustar `prefix` field and skips GNU/PAX extension records, which is
 * everything the Go `archive/tar` writer behind the CDN actually emits.
 *
 * @param archive - the uncompressed tar bytes.
 * @returns an array of `{ path, data }` for regular files.
 */
function parseTar(archive) {
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    offset += 512;
    if (block.every((byte) => byte === 0)) break;
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const data = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") continue; // PAX metadata record
    if (type === "L") { // GNU long name
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const prefix = readString(block, 345, 155);
    const base = readString(block, 0, 100);
    const name = longName ?? (prefix.length > 0 ? posix.join(prefix, base) : base);
    longName = null;
    if (type !== "0" && type !== "") continue; // directories, links, …
    entries.push({ path: name, data });
  }
  return entries;
}

/** Download a URL, failing loudly on a non-2xx reply. */
async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Read the recorded vendoring manifest, or null when the skill has never been fetched. */
function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    throw new Error(`skill/UPSTREAM.json is not valid JSON: ${error?.message ?? error}`);
  }
}

/**
 * Fetch a release's skill package and normalise it to `{ version, tarUrl, tarSha256, files }`.
 *
 * The Windows package is fetched too and must be byte-identical: upstream publishes a
 * platform-named copy for its installer, and a divergence would mean this plugin is
 * vendoring the wrong variant.
 *
 * @param version - `latest` or a pinned tag such as `v2.0.22`.
 * @returns the normalised package.
 */
async function fetchPackage(version) {
  // Resolve "latest" to a concrete tag first: the vendored tree should be traceable to
  // one immutable release path, not to a moving alias.
  const resolved = version === "latest"
    ? JSON.parse((await download(`${CDN_BASE}/latest/version.json`)).toString("utf8"))?.version
    : version;
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error(`could not resolve the latest release from ${CDN_BASE}/latest/version.json`);
  }
  const base = `${CDN_BASE}/${encodeURIComponent(resolved)}`;
  const tarUrl = `${base}/skills/kimi-webbridge.tar.gz`;
  const windowsUrl = `${base}/skills/kimi-webbridge-windows.tar.gz`;
  const [archive, windowsArchive] = await Promise.all([download(tarUrl), download(windowsUrl)]);
  if (!archive.equals(windowsArchive)) {
    throw new Error("the windows skill tarball differs from the default one; vendor both instead of assuming they match");
  }
  const files = parseTar(gunzipSync(archive))
    .filter((entry) => entry.path.startsWith(TARBALL_PREFIX) && entry.path !== TARBALL_PREFIX)
    .map((entry) => ({ path: entry.path.slice(TARBALL_PREFIX.length), data: entry.data }))
    .filter((entry) => !entry.path.endsWith("/"))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (files.length === 0) throw new Error(`${tarUrl} contained no files under ${TARBALL_PREFIX}`);
  // The release tag is authoritative for the version; "latest" is not a version.
  const skillVersion = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(files[0].data.toString("utf8"))?.[1]
    ?.match(/version:\s*"?([^"\n]+)"?/u)?.[1]?.trim() ?? null;
  if (skillVersion !== null && resolved.replace(/^v/u, "") !== skillVersion) {
    throw new Error(`release ${resolved} ships a skill stamped ${skillVersion}; refusing to vendor a mismatched pair`);
  }
  return {
    version: skillVersion ?? resolved,
    release: resolved,
    tarUrl,
    tarSha256: sha256(archive),
    files: files.map((entry) => ({ path: entry.path, sha256: sha256(entry.data), bytes: entry.data.length, data: entry.data })),
  };
}

/** Shape a fetched package into the on-disk manifest (no file bodies). */
function toManifest(pkg, previous) {
  return {
    note: "Generated by scripts/fetch-upstream-skill.mjs — do not hand-edit. Vendored verbatim from the official CDN.",
    version: pkg.version,
    release: pkg.release,
    tarUrl: pkg.tarUrl,
    tarSha256: pkg.tarSha256,
    fetchedAt: previous?.tarSha256 === pkg.tarSha256 && previous?.version === pkg.version ? previous.fetchedAt : new Date().toISOString(),
    files: pkg.files.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes })),
  };
}

/** Write `skill/SKILL.md` and `skill/references/**`, replacing only managed paths. */
function writeSkill(pkg) {
  for (const name of MANAGED_ROOT) rmSync(join(SKILL_DIR, name), { recursive: true, force: true });
  for (const file of pkg.files) {
    const target = join(SKILL_DIR, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
}

/** Compare a manifest against a freshly fetched package; returns human-readable differences. */
function compare(previous, pkg) {
  const differences = [];
  if (previous === null) return ["skill/UPSTREAM.json is missing"];
  if (previous.version !== pkg.version) differences.push(`release ${previous.version} -> ${pkg.version}`);
  if (previous.tarSha256 !== pkg.tarSha256) differences.push(`tarball digest ${previous.tarSha256.slice(0, 12)}… -> ${pkg.tarSha256.slice(0, 12)}…`);
  const before = new Map((previous.files ?? []).map((file) => [file.path, file.sha256]));
  for (const file of pkg.files) {
    const recorded = before.get(file.path);
    if (recorded === undefined) differences.push(`added ${file.path}`);
    else if (recorded !== file.sha256) differences.push(`changed ${file.path}`);
    before.delete(file.path);
  }
  for (const path of before.keys()) differences.push(`removed ${path}`);
  return differences;
}

/** List every file under the managed roots, relative to skill/. */
function listManagedFiles() {
  const found = [];
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const nextAbsolute = join(absolute, entry.name);
      const nextRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(nextAbsolute, nextRelative);
      else found.push(nextRelative);
    }
  };
  for (const name of MANAGED_ROOT) {
    const absolute = join(SKILL_DIR, name);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) walk(absolute, name);
    else found.push(name);
  }
  return found.sort();
}

/**
 * Recompute the vendored files and compare them with the recorded digests.
 *
 * Checks both directions: every recorded file must be present and unmodified, and the
 * managed roots must not contain anything the manifest does not list — otherwise a
 * stray file in references/ would quietly become part of what the model can read.
 */
function verifyLocal() {
  const manifest = readManifest();
  if (manifest === null) throw new Error("skill/UPSTREAM.json is missing — run: node scripts/fetch-upstream-skill.mjs");
  const problems = [];
  const recorded = new Set();
  for (const file of manifest.files ?? []) {
    recorded.add(file.path);
    const target = join(SKILL_DIR, file.path);
    if (!existsSync(target)) { problems.push(`missing ${file.path}`); continue; }
    const digest = sha256(readFileSync(target));
    if (digest !== file.sha256) problems.push(`modified ${file.path}`);
  }
  for (const path of listManagedFiles()) {
    if (!recorded.has(path)) problems.push(`unexpected ${path} (not in UPSTREAM.json)`);
  }
  return { manifest, problems };
}

async function main() {
  const args = process.argv.slice(2);
  const versionFlag = args.indexOf("--version");
  const requested = versionFlag === -1 ? "latest" : args[versionFlag + 1];
  if (requested === undefined) throw new Error("--version needs a value, e.g. --version v2.0.22");
  if (args.includes("--verify-local")) {
    const { manifest, problems } = verifyLocal();
    if (problems.length > 0) {
      console.error(`vendored skill v${manifest.version} has drifted from skill/UPSTREAM.json:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`vendored skill v${manifest.version}: ${manifest.files.length} files match skill/UPSTREAM.json`);
    return;
  }
  const previous = readManifest();
  const pkg = await fetchPackage(requested);
  if (args.includes("--check")) {
    const differences = compare(previous, pkg);
    if (differences.length > 0) {
      console.error(`upstream skill moved (vendored ${previous?.version ?? "nothing"} -> ${pkg.version}):\n  ${differences.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`vendored skill is current: v${pkg.version}, ${pkg.files.length} files`);
    return;
  }
  writeSkill(pkg);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(toManifest(pkg, previous), null, 2)}\n`);
  const differences = compare(previous, pkg);
  console.log(`vendored skill v${pkg.version} (${pkg.files.length} files) from ${pkg.tarUrl}`);
  console.log(differences.length === 0 ? "no change" : `changes:\n  ${differences.join("\n  ")}`);
}

main().catch((error) => {
  console.error(`fetch-upstream-skill: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
