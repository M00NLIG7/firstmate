#!/usr/bin/env node
// Trusted external Firstmate extension binding host.
//
// Usage:
//   fm-extension.mjs bind <package-root> --adapter <name> [--adapter <name> ...]
//     --trust-same-user-code [--consent <fact> ...] [--timeout-ms <milliseconds>]
//   fm-extension.sh remote-bind <secondmate-id> <package-root> [bind options]
//   fm-extension.mjs retire-binding <extension-id>
//     --if-binding-digest <sha256:digest>
//   fm-extension.mjs retire-transfer <extension-id>
//     --if-transfer-digest <sha256:digest> --if-binding-digest <sha256:digest>
//   fm-extension.mjs list
//   fm-extension.mjs inspect <extension-id>
//   fm-extension.mjs verify [extension-id]
//   fm-extension.mjs resolve-process-event <adapter>
//   fm-extension.mjs process-event <adapter> <operation> [internal options]
//
// bind      Validate a package, copy its complete tree into this home's
//           content-addressed read-only package store, perform the protocol
//           handshake, and atomically write one home-local enabled binding.
//           --adapter is repeatable and enables only that manifest-declared
//           process-event adapter name. --trust-same-user-code is mandatory.
//           A package manifest may additionally require explicit --consent
//           facts: network, credential-store, task-metadata, or
//           artifact-references. No hash is hand-authored; this command computes
//           and verifies every manifest, entrypoint, binding, and tree digest.
// list      Show enabled home-local bindings. An absent registry is a quiet,
//           state-free "no extension bindings" result.
// inspect   Print one validated binding as deterministic JSON.
// verify    Revalidate package confinement, ownership, modes, links, complete
//           tree integrity, executable identity, and the live handshake.
// resolve-process-event
//           Internal registration boundary. Resolve one adapter from explicit
//           bindings, verify it and its handshake, and print one bounded
//           machine-readable identity record.
// process-event
//           Internal invocation boundary used by bin/fm-procevent.sh. It
//           revalidates the exact registration-pinned binding and package,
//           handshakes, then invokes source.poll, result.classify,
//           result.terminal, or result.silent through strict JSON.
//
// Discovery is only $FM_HOME/config/extensions.d/*.json. Current directories,
// projects, task copies, environment payloads, worker text, and Pi packages are
// never searched. Package executables are spawned directly with shell=false,
// receive one bounded UTF-8 JSON document on stdin, and must return exactly one
// bounded UTF-8 JSON document on stdout. Extension stderr is bounded and never
// copied into authoritative records. Timeout, malformed output, nonzero exit,
// or a surviving tracked process tree is rejected after TERM/KILL cleanup.
//
// This is a trust and integrity boundary, not an operating-system sandbox.
// Enabled packages are trusted same-user code and retain that user's OS access.
// Their protocol responses remain untrusted evidence: this host exposes no
// merge, decision, destination, force, discard, cleanup, credential-use, task
// mutation, or stronger-operation capability.

import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const SELF = fileURLToPath(import.meta.url);
const CODE_ROOT = path.dirname(path.dirname(SELF));
const MANIFEST_NAME = "firstmate-extension.json";
const HOST_PROTOCOLS = [1];
const PROCESS_EVENT_CAPABILITY = "process-event-adapter";
const PROCESS_EVENT_VERSIONS = [1];
const MANIFEST_SCHEMA = "firstmate.extension-manifest.v1";
const BINDING_SCHEMA = "firstmate.extension-binding.v1";
const HANDSHAKE_REQUEST_SCHEMA = "firstmate.extension-handshake-request.v1";
const HANDSHAKE_RESPONSE_SCHEMA = "firstmate.extension-handshake-response.v1";
const REQUEST_SCHEMA = "firstmate.extension-request.v1";
const RESPONSE_SCHEMA = "firstmate.extension-response.v1";
const RESOLUTION_SCHEMA = "fm-extension-process-event-resolution.v1";
const ERROR_EVIDENCE_SCHEMA = "firstmate.process-event-extension-error.v1";
const MAX_JSON_BYTES = 65536;
const MAX_RESULT_BYTES = 32768;
const MAX_STDERR_BYTES = 8192;
const MAX_TREE_ENTRIES = 4096;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const TRANSFER_SCHEMA = "firstmate.extension-package-transfer.v1";
const TRANSFER_MANIFEST_SCHEMA = "firstmate.extension-package-transfer-manifest.v1";
const MAX_TRANSFER_JSON_BYTES = 900000;
const MAX_TRANSFER_ENTRIES = 128;
const MAX_TRANSFER_FILE_BYTES = 256 * 1024;
const MAX_TRANSFER_PACKAGE_BYTES = 512 * 1024;
const MAX_BINDINGS = 128;
const HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 300000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 3600000;
const TERMINATE_GRACE_MS = 250;
const CLEANUP_WAIT_MS = 2000;
const CONSENT_NAMES = ["network", "credential-store", "task-metadata", "artifact-references"];
const RESPONSE_ERROR_CODES = new Set(["invalid-request", "incompatible", "conflict", "unavailable", "internal"]);
const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ADAPTER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^sha256:[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail("schema-invalid", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("schema-invalid", `${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function integerIn(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("schema-invalid", `${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boundedString(value, max, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) {
    fail("schema-invalid", `${label} must be a non-empty UTF-8 string of at most ${max} bytes`);
  }
  if (/[\x00-\x1f\x7f]/u.test(value)) fail("schema-invalid", `${label} contains a control character`);
  if (pattern && !pattern.test(value)) fail("schema-invalid", `${label} has an unsupported value`);
  return value;
}

function uniqueArray(value, label, itemValidator) {
  if (!Array.isArray(value) || value.length === 0) fail("schema-invalid", `${label} must be a non-empty array`);
  const seen = new Set();
  return value.map((item, index) => {
    const normalized = itemValidator(item, `${label}[${index}]`);
    const key = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
    if (seen.has(key)) fail("schema-invalid", `${label} contains a duplicate value`);
    seen.add(key);
    return normalized;
  });
}

function validateUnicode(value, label = "JSON") {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("json-invalid", `${label} contains an unpaired UTF-16 surrogate`);
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail("json-invalid", `${label} contains an unpaired UTF-16 surrogate`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => validateUnicode(entry, label));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      validateUnicode(key, label);
      validateUnicode(entry, label);
    }
  }
}

class StrictJsonParser {
  constructor(text, label) {
    this.text = text;
    this.label = label;
    this.index = 0;
  }

  parse() {
    this.space();
    const value = this.value();
    this.space();
    if (this.index !== this.text.length) fail("json-invalid", `${this.label} contains trailing or multiple JSON documents`);
    validateUnicode(value, this.label);
    return value;
  }

  space() {
    while (/[\x20\t\r\n]/.test(this.text[this.index] || "")) this.index += 1;
  }

  value() {
    this.space();
    const char = this.text[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (this.text.startsWith("true", this.index)) return this.literal("true", true);
    if (this.text.startsWith("false", this.index)) return this.literal("false", false);
    if (this.text.startsWith("null", this.index)) return this.literal("null", null);
    if (char === "-" || /[0-9]/.test(char || "")) return this.number();
    fail("json-invalid", `${this.label} has invalid JSON at byte ${this.index}`);
  }

  literal(token, value) {
    this.index += token.length;
    return value;
  }

  object() {
    const result = Object.create(null);
    this.index += 1;
    this.space();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      this.space();
      if (this.text[this.index] !== '"') fail("json-invalid", `${this.label} has a non-string object key`);
      const key = this.string();
      if (Object.hasOwn(result, key)) fail("json-invalid", `${this.label} contains duplicate object key: ${key}`);
      this.space();
      if (this.text[this.index] !== ":") fail("json-invalid", `${this.label} is missing ':' after object key`);
      this.index += 1;
      result[key] = this.value();
      this.space();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") fail("json-invalid", `${this.label} is missing ',' between object fields`);
      this.index += 1;
    }
    fail("json-invalid", `${this.label} has an unterminated object`);
  }

  array() {
    const result = [];
    this.index += 1;
    this.space();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.value());
      this.space();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") fail("json-invalid", `${this.label} is missing ',' between array values`);
      this.index += 1;
    }
    fail("json-invalid", `${this.label} has an unterminated array`);
  }

  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      const char = this.text[this.index];
      if (!escaped && char === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          fail("json-invalid", `${this.label} has an invalid JSON string`);
        }
      }
      if (!escaped && code < 0x20) fail("json-invalid", `${this.label} has an unescaped control character`);
      if (!escaped && char === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    fail("json-invalid", `${this.label} has an unterminated string`);
  }

  number() {
    const remainder = this.text.slice(this.index);
    const match = remainder.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) fail("json-invalid", `${this.label} has an invalid number`);
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("json-invalid", `${this.label} has a non-finite number`);
    return value;
  }
}

function parseStrictJson(bytes, label, maxBytes = MAX_JSON_BYTES) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length === 0) fail("json-invalid", `${label} is empty`);
  if (bytes.length > maxBytes) fail("json-oversized", `${label} exceeds ${maxBytes} bytes`);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("json-invalid", `${label} must not begin with a UTF-8 BOM`);
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail("json-invalid", `${label} is not valid UTF-8`);
  }
  return new StrictJsonParser(text, label).parse();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prettyJson(value) {
  const sort = (entry) => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (!isPlainObject(entry)) return entry;
    const result = Object.create(null);
    for (const key of Object.keys(entry).sort()) result[key] = sort(entry[key]);
    return result;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeRequestId(seed = randomBytes(32)) {
  const bytes = Buffer.isBuffer(seed) ? seed : Buffer.from(seed, "utf8");
  return digestBytes(Buffer.concat([Buffer.from("firstmate-extension-request-v1\0"), bytes]));
}

function modeOf(info) {
  return info.mode & 0o777;
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("platform-unsupported", "extension bindings require a POSIX user identity");
  return process.getuid();
}

async function maybeLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function activeHome() {
  const configured = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || CODE_ROOT;
  const absolute = path.resolve(configured);
  const info = await maybeLstat(absolute);
  if (!info || !info.isDirectory()) fail("home-invalid", `Firstmate home is not a directory: ${absolute}`);
  return realpath(absolute);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertOwnedSafeDirectory(target, label, exactPrivate = false) {
  const info = await maybeLstat(target);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail("path-unsafe", `${label} is not a real directory: ${target}`);
  if (info.uid !== currentUid()) fail("owner-mismatch", `${label} is not owned by the active user: ${target}`);
  const mode = modeOf(info);
  if (exactPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) {
    fail("mode-unsafe", `${label} has unsafe mode ${mode.toString(8)}: ${target}`);
  }
  const canonical = await realpath(target);
  if (canonical !== target) fail("path-unsafe", `${label} traverses a symbolic link: ${target}`);
}

async function ensureDirectory(target, mode, label, exactPrivate = true) {
  const existing = await maybeLstat(target);
  if (!existing) await mkdir(target, { mode });
  await assertOwnedSafeDirectory(target, label, exactPrivate);
}

async function ensureHomePrivatePath(home, segments) {
  let current = home;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const exact = index > 0 || segments[0] !== "data" && segments[0] !== "state" && segments[0] !== "config";
    const existing = await maybeLstat(current);
    if (!existing) await mkdir(current, { mode: 0o700 });
    await assertOwnedSafeDirectory(current, segments.slice(0, index + 1).join("/"), exact);
  }
  return current;
}

function safeTreeName(name, label) {
  if (!name || name === "." || name === ".." || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail("path-unsafe", `${label} has an unsafe path component`);
  }
  if (Buffer.from(name, "utf8").toString("utf8") !== name) fail("path-unsafe", `${label} has a non-UTF-8 path component`);
}

async function scanTree(root, { installed = false } = {}) {
  const uid = currentUid();
  const entries = [];
  let entryCount = 0;
  let totalBytes = 0;
  const rootInfo = await maybeLstat(root);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("package-invalid", `package root is not a real directory: ${root}`);
  if (rootInfo.uid !== uid) fail("owner-mismatch", `package root is not owned by the active user: ${root}`);
  if (installed ? modeOf(rootInfo) !== 0o555 : (modeOf(rootInfo) & 0o022) !== 0) {
    fail("mode-unsafe", `package root mode is unsafe: ${modeOf(rootInfo).toString(8)}`);
  }

  async function walk(directory, relativeDirectory) {
    const names = await readdir(directory, { encoding: "buffer" });
    names.sort(Buffer.compare);
    for (const rawName of names) {
      let name;
      try {
        name = decoder.decode(rawName);
      } catch {
        fail("path-unsafe", `package path ${relativeDirectory || "."} has a non-UTF-8 component`);
      }
      safeTreeName(name, `package path ${relativeDirectory || "."}`);
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const info = await lstat(absolute);
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) fail("package-oversized", `package tree exceeds ${MAX_TREE_ENTRIES} entries`);
      if (info.uid !== uid) fail("owner-mismatch", `package entry is not owned by the active user: ${relative}`);
      if (info.isSymbolicLink()) fail("link-unsafe", `package tree contains a symbolic link: ${relative}`);
      if (info.isDirectory()) {
        const mode = modeOf(info);
        if (installed ? mode !== 0o555 : (mode & 0o022) !== 0) {
          fail("mode-unsafe", `package directory has unsafe mode ${mode.toString(8)}: ${relative}`);
        }
        entries.push({ type: "directory", relative, executable: true, info });
        await walk(absolute, relative);
        continue;
      }
      if (!info.isFile()) fail("package-invalid", `package tree contains a non-file entry: ${relative}`);
      if (info.nlink !== 1) fail("link-unsafe", `package file has ${info.nlink} hard links: ${relative}`);
      const mode = modeOf(info);
      if (installed) {
        const wanted = (mode & 0o111) !== 0 ? 0o555 : 0o444;
        if (mode !== wanted) fail("mode-unsafe", `installed package file has mode ${mode.toString(8)}, expected ${wanted.toString(8)}: ${relative}`);
      } else if ((mode & 0o022) !== 0) {
        fail("mode-unsafe", `package file is group/world writable: ${relative}`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_TREE_BYTES) fail("package-oversized", `package tree exceeds ${MAX_TREE_BYTES} bytes`);
      const bytes = await readFile(absolute);
      entries.push({
        type: "file",
        relative,
        executable: (mode & 0o111) !== 0,
        size: bytes.length,
        digest: digestBytes(bytes),
        info,
      });
    }
  }

  await walk(root, "");
  const hash = createHash("sha256");
  hash.update("firstmate-package-tree-v1\0");
  for (const entry of entries) {
    hash.update(entry.type === "directory" ? "D\0" : "F\0");
    hash.update(entry.relative, "utf8");
    hash.update("\0");
    hash.update(entry.executable ? "x\0" : "-\0");
    if (entry.type === "file") {
      hash.update(String(entry.size));
      hash.update("\0");
      hash.update(entry.digest);
      hash.update("\0");
    }
  }
  return { entries, digest: `sha256:${hash.digest("hex")}`, entryCount, totalBytes };
}

function validateManifest(value) {
  exactKeys(value, ["schema", "id", "version", "host_protocols", "entrypoint", "capabilities", "required_consents"], "extension manifest");
  if (value.schema !== MANIFEST_SCHEMA) fail("schema-invalid", `unsupported extension manifest schema: ${value.schema}`);
  const id = boundedString(value.id, 128, "manifest id", ID_RE);
  const version = boundedString(value.version, 128, "manifest version", SEMVER_RE);
  const hostProtocols = uniqueArray(value.host_protocols, "manifest host_protocols", (entry, label) => integerIn(entry, 1, 2147483647, label));
  const entrypoint = boundedString(value.entrypoint, 256, "manifest entrypoint");
  if (path.isAbsolute(entrypoint) || entrypoint.includes("\\") || entrypoint.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("path-unsafe", "manifest entrypoint must be a normalized relative POSIX path");
  }
  const requiredConsents = uniqueArrayOrEmpty(value.required_consents, "manifest required_consents", (entry, label) => {
    const consent = boundedString(entry, 64, label);
    if (!CONSENT_NAMES.includes(consent)) fail("schema-invalid", `${label} is not a supported consent fact`);
    return consent;
  });
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 1) {
    fail("schema-invalid", "manifest capabilities must contain exactly process-event-adapter");
  }
  const capability = value.capabilities[0];
  exactKeys(capability, ["name", "versions", "adapter_names"], "process-event capability");
  if (capability.name !== PROCESS_EVENT_CAPABILITY) fail("schema-invalid", "only process-event-adapter is supported in this binding version");
  const versions = uniqueArray(capability.versions, "capability versions", (entry, label) => integerIn(entry, 1, 2147483647, label));
  const adapterNames = uniqueArray(capability.adapter_names, "capability adapter_names", (entry, label) => boundedString(entry, 32, label, ADAPTER_RE));
  return {
    schema: value.schema,
    id,
    version,
    host_protocols: hostProtocols,
    entrypoint,
    capabilities: [{ name: PROCESS_EVENT_CAPABILITY, versions, adapter_names: adapterNames }],
    required_consents: requiredConsents,
  };
}

function uniqueArrayOrEmpty(value, label, itemValidator) {
  if (!Array.isArray(value)) fail("schema-invalid", `${label} must be an array`);
  if (value.length === 0) return [];
  return uniqueArray(value, label, itemValidator);
}

async function validatePackage(root, { installed = false, expected = null } = {}) {
  const canonical = await realpath(root).catch(() => fail("package-missing", `package root is unavailable: ${root}`));
  if (canonical !== root) fail("path-unsafe", `package root is not canonical: ${root}`);
  const tree = await scanTree(root, { installed });
  const manifestEntry = tree.entries.find((entry) => entry.relative === MANIFEST_NAME);
  if (!manifestEntry || manifestEntry.type !== "file") fail("manifest-missing", `package has no ${MANIFEST_NAME}`);
  if (manifestEntry.size > MAX_JSON_BYTES) fail("manifest-oversized", `extension manifest exceeds ${MAX_JSON_BYTES} bytes`);
  const manifestBytes = await readFile(path.join(root, MANIFEST_NAME));
  const manifest = validateManifest(parseStrictJson(manifestBytes, "extension manifest"));
  const entrypointEntry = tree.entries.find((entry) => entry.relative === manifest.entrypoint);
  if (!entrypointEntry || entrypointEntry.type !== "file") fail("entrypoint-missing", `manifest entrypoint is missing: ${manifest.entrypoint}`);
  if (!entrypointEntry.executable) fail("entrypoint-invalid", `manifest entrypoint is not executable: ${manifest.entrypoint}`);
  const packageInfo = {
    root,
    tree,
    manifest,
    manifestDigest: digestBytes(manifestBytes),
    entrypoint: path.join(root, manifest.entrypoint),
    entrypointDigest: entrypointEntry.digest,
  };
  if (expected) {
    if (tree.digest !== expected.package_digest) fail("integrity-mismatch", "installed package tree digest does not match the binding");
    if (packageInfo.manifestDigest !== expected.manifest_sha256) fail("integrity-mismatch", "installed package manifest digest does not match the binding");
    if (manifest.entrypoint !== expected.entrypoint || packageInfo.entrypointDigest !== expected.entrypoint_sha256) {
      fail("integrity-mismatch", "installed package executable identity does not match the binding");
    }
  }
  return packageInfo;
}

async function hasGitAncestor(root) {
  let current = root;
  while (true) {
    const marker = await maybeLstat(path.join(current, ".git"));
    if (marker) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function validateSourceRoot(home, input) {
  const absolute = path.resolve(input);
  const finalInfo = await maybeLstat(absolute);
  if (!finalInfo || !finalInfo.isDirectory() || finalInfo.isSymbolicLink()) fail("package-missing", `package root is not a real directory: ${absolute}`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute) fail("path-unsafe", `package root traverses a symbolic link: ${absolute}`);
  if (isInside(home, canonical)) fail("path-unsafe", "package source must be outside the active Firstmate home");
  if (await hasGitAncestor(canonical)) fail("path-unsafe", "package source must not be inside a Git project or task copy");
  return canonical;
}

async function makeManagedTreeRemovable(root) {
  const info = await maybeLstat(root);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(root, 0o700);
  const names = await readdir(root);
  for (const name of names) {
    const child = path.join(root, name);
    const childInfo = await lstat(child);
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await makeManagedTreeRemovable(child);
    }
  }
}

async function removeManagedTree(root) {
  await makeManagedTreeRemovable(root).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

async function installPackage(home, sourceInfo) {
  const digestHex = sourceInfo.tree.digest.slice("sha256:".length);
  const parent = await ensureHomePrivatePath(home, ["data", "extensions", "packages", sourceInfo.manifest.id, sourceInfo.manifest.version]);
  const destination = path.join(parent, digestHex);
  const existing = await maybeLstat(destination);
  if (existing) {
    const installed = await validatePackage(destination, { installed: true });
    if (installed.tree.digest !== sourceInfo.tree.digest) fail("integrity-mismatch", "existing content-addressed package directory has different bytes");
    return { packageInfo: installed };
  }

  const temporary = path.join(parent, `.install-${process.pid}-${randomBytes(8).toString("hex")}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of sourceInfo.tree.entries.filter((candidate) => candidate.type === "directory")) {
      await mkdir(path.join(temporary, entry.relative), { recursive: true, mode: 0o700 });
    }
    for (const entry of sourceInfo.tree.entries.filter((candidate) => candidate.type === "file")) {
      const target = path.join(temporary, entry.relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(path.join(sourceInfo.root, entry.relative), target, fsConstants.COPYFILE_EXCL);
      await chmod(target, entry.executable ? 0o555 : 0o444);
    }
    const directories = sourceInfo.tree.entries
      .filter((candidate) => candidate.type === "directory")
      .sort((left, right) => right.relative.split("/").length - left.relative.split("/").length);
    for (const entry of directories) await chmod(path.join(temporary, entry.relative), 0o555);
    await chmod(temporary, 0o555);
    const copied = await validatePackage(temporary, { installed: true });
    const sourceAfterCopy = await validatePackage(sourceInfo.root, { installed: false });
    if (copied.tree.digest !== sourceInfo.tree.digest
        || copied.manifestDigest !== sourceInfo.manifestDigest
        || sourceAfterCopy.tree.digest !== sourceInfo.tree.digest
        || sourceAfterCopy.manifestDigest !== sourceInfo.manifestDigest) {
      fail("integrity-mismatch", "package changed while it was copied into the managed store");
    }
    try {
      await rename(temporary, destination);
      return { packageInfo: await validatePackage(destination, { installed: true }) };
    } catch (error) {
      if (!error || !["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      await removeManagedTree(temporary);
      const winner = await validatePackage(destination, { installed: true });
      if (winner.tree.digest !== sourceInfo.tree.digest) fail("integrity-mismatch", "concurrent package install produced a different tree");
      return { packageInfo: winner };
    }
  } catch (error) {
    await removeManagedTree(temporary).catch(() => {});
    throw error;
  }
}

function validateBinding(value, home) {
  exactKeys(value, [
    "schema", "extension_id", "extension_version", "source", "package_root",
    "manifest_sha256", "package_digest", "entrypoint", "entrypoint_sha256",
    "host_protocol", "capabilities", "consents", "timeout_ms",
  ], "extension binding");
  if (value.schema !== BINDING_SCHEMA) fail("schema-invalid", `unsupported extension binding schema: ${value.schema}`);
  const extensionId = boundedString(value.extension_id, 128, "binding extension_id", ID_RE);
  const extensionVersion = boundedString(value.extension_version, 128, "binding extension_version", SEMVER_RE);
  exactKeys(value.source, ["kind", "path"], "binding source");
  if (value.source.kind !== "local-directory") fail("schema-invalid", "binding source kind must be local-directory");
  const sourcePath = boundedString(value.source.path, 4096, "binding source path");
  if (!path.isAbsolute(sourcePath) || path.normalize(sourcePath) !== sourcePath) fail("path-unsafe", "binding source path must be canonical and absolute");
  const packageRoot = boundedString(value.package_root, 4096, "binding package_root");
  if (!path.isAbsolute(packageRoot) || path.normalize(packageRoot) !== packageRoot) fail("path-unsafe", "binding package_root must be canonical and absolute");
  for (const [name, digest] of Object.entries({
    manifest_sha256: value.manifest_sha256,
    package_digest: value.package_digest,
    entrypoint_sha256: value.entrypoint_sha256,
  })) {
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) fail("schema-invalid", `binding ${name} is not a SHA-256 digest`);
  }
  const entrypoint = boundedString(value.entrypoint, 256, "binding entrypoint");
  integerIn(value.host_protocol, 1, 2147483647, "binding host_protocol");
  if (value.host_protocol !== 1) fail("protocol-incompatible", `binding selects unsupported host protocol ${value.host_protocol}`);
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 1) fail("schema-invalid", "binding capabilities must contain exactly process-event-adapter");
  const capability = value.capabilities[0];
  exactKeys(capability, ["name", "version", "adapter_names"], "binding capability");
  if (capability.name !== PROCESS_EVENT_CAPABILITY || capability.version !== 1) {
    fail("protocol-incompatible", "binding must select process-event-adapter/1");
  }
  const adapterNames = uniqueArray(capability.adapter_names, "binding adapter_names", (entry, label) => boundedString(entry, 32, label, ADAPTER_RE));
  exactKeys(value.consents, ["trusted_same_user_code", "network", "credential_store", "task_metadata", "artifact_references"], "binding consents");
  for (const [name, consent] of Object.entries(value.consents)) {
    if (typeof consent !== "boolean") fail("schema-invalid", `binding consent ${name} must be boolean`);
  }
  if (value.consents.trusted_same_user_code !== true) fail("consent-missing", "binding lacks trusted-same-user-code consent");
  const timeoutMs = integerIn(value.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "binding timeout_ms");
  const expectedRoot = path.join(home, "data", "extensions", "packages", extensionId, extensionVersion, value.package_digest.slice("sha256:".length));
  if (packageRoot !== expectedRoot) fail("path-unsafe", "binding package_root is outside this home's content-addressed package store");
  return {
    schema: value.schema,
    extension_id: extensionId,
    extension_version: extensionVersion,
    source: { kind: "local-directory", path: sourcePath },
    package_root: packageRoot,
    manifest_sha256: value.manifest_sha256,
    package_digest: value.package_digest,
    entrypoint,
    entrypoint_sha256: value.entrypoint_sha256,
    host_protocol: value.host_protocol,
    capabilities: [{ name: PROCESS_EVENT_CAPABILITY, version: 1, adapter_names: adapterNames }],
    consents: { ...value.consents },
    timeout_ms: timeoutMs,
  };
}

async function validateBindingPackage(binding, home) {
  const canonical = await realpath(binding.package_root).catch(() => fail("package-missing", `bound package is unavailable: ${binding.package_root}`));
  if (canonical !== binding.package_root) fail("path-unsafe", "bound package_root is no longer canonical");
  const packageInfo = await validatePackage(binding.package_root, { installed: true, expected: binding });
  const manifest = packageInfo.manifest;
  if (manifest.id !== binding.extension_id || manifest.version !== binding.extension_version) {
    fail("integrity-mismatch", "bound package manifest identity does not match the binding");
  }
  if (!manifest.host_protocols.includes(binding.host_protocol)) fail("protocol-incompatible", "manifest no longer declares the bound host protocol");
  const capability = manifest.capabilities[0];
  if (!capability.versions.includes(1)) fail("protocol-incompatible", "manifest no longer declares process-event-adapter/1");
  for (const adapter of binding.capabilities[0].adapter_names) {
    if (!capability.adapter_names.includes(adapter)) fail("protocol-incompatible", `manifest no longer allows adapter: ${adapter}`);
  }
  for (const consent of manifest.required_consents) {
    const key = consent.replaceAll("-", "_");
    if (binding.consents[key] !== true) fail("consent-missing", `binding lacks manifest-required consent: ${consent}`);
  }
  return packageInfo;
}

async function registryPath(home) {
  return path.join(home, "config", "extensions.d");
}

async function loadBindingRecord(home, file, label, { packages = true } = {}) {
  const fileInfo = await lstat(file);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1) fail("link-unsafe", `${label} is not a single regular file`);
  if (fileInfo.uid !== currentUid()) fail("owner-mismatch", `${label} is not owned by the active user`);
  if (modeOf(fileInfo) !== 0o600) fail("mode-unsafe", `${label} must have mode 0600`);
  if (fileInfo.size > MAX_JSON_BYTES) fail("binding-oversized", `${label} exceeds ${MAX_JSON_BYTES} bytes`);
  const bytes = await readFile(file);
  const binding = validateBinding(parseStrictJson(bytes, label), home);
  return {
    binding,
    bindingDigest: digestBytes(bytes),
    bindingPath: file,
    packageInfo: packages ? await validateBindingPackage(binding, home) : null,
    bytes,
  };
}

async function loadBindings(home, { packages = true } = {}) {
  const registry = await registryPath(home);
  const info = await maybeLstat(registry);
  if (!info) return [];
  await assertOwnedSafeDirectory(registry, "extension binding registry", true);
  const names = await readdir(registry);
  if (names.length > MAX_BINDINGS) fail("registry-oversized", `extension binding registry exceeds ${MAX_BINDINGS} entries`);
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const bindings = [];
  const adapters = new Map();
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) fail("registry-invalid", `unexpected file in extension binding registry: ${name}`);
    safeTreeName(name, "extension binding registry");
    const file = path.join(registry, name);
    const record = await loadBindingRecord(home, file, `extension binding ${name}`, { packages });
    const { binding } = record;
    if (name !== `${binding.extension_id}.json`) fail("registry-invalid", `binding filename does not match extension id: ${name}`);
    for (const adapter of binding.capabilities[0].adapter_names) {
      if (adapters.has(adapter)) fail("adapter-conflict", `adapter ${adapter} is enabled by more than one binding`);
      adapters.set(adapter, binding.extension_id);
    }
    bindings.push(record);
  }
  return bindings;
}

function selectAdapter(bindings, adapter) {
  const matches = bindings.filter((record) => record.binding.capabilities[0].adapter_names.includes(adapter));
  if (matches.length === 0) fail("adapter-unbound", `no home-local extension binding enables adapter: ${adapter}`);
  if (matches.length !== 1) fail("adapter-conflict", `more than one extension binding enables adapter: ${adapter}`);
  return matches[0];
}

function sanitizedPath() {
  const candidates = [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(candidates)].join(path.delimiter);
}

function effectiveStateRoot(home) {
  return path.resolve(process.env.FM_STATE_OVERRIDE || path.join(home, "state"));
}

async function ensureExtensionState(home, binding) {
  let root;
  if (process.env.FM_STATE_OVERRIDE) {
    const stateRoot = effectiveStateRoot(home);
    await assertOwnedSafeDirectory(stateRoot, "extension state root");
    root = path.join(stateRoot, "extensions");
    await ensureDirectory(root, 0o700, "state/extensions", true);
  } else {
    root = await ensureHomePrivatePath(home, ["state", "extensions"]);
  }
  const statePath = path.join(root, binding.extension_id);
  await ensureDirectory(statePath, 0o700, `extension state ${binding.extension_id}`, true);
  return statePath;
}

function childEnvironment(binding, statePath = "", invocationMarker = "") {
  const env = {
    PATH: sanitizedPath(),
    LANG: "C",
    LC_ALL: "C",
    FIRSTMATE_EXTENSION_ID: binding.extension_id,
    FIRSTMATE_EXTENSION_VERSION: binding.extension_version,
  };
  if (statePath) env.FIRSTMATE_EXTENSION_STATE = statePath;
  if (invocationMarker) env.FIRSTMATE_EXTENSION_INVOCATION = invocationMarker;
  if (binding.consents.credential_store) {
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "SSH_AUTH_SOCK"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
  }
  return env;
}

let activeChild = null;
let activeProcessTracker = null;
let terminatingForSignal = false;
let activeLifecycleLock = null;

function readProcessTable(invocationMarker = "") {
  if (process.platform === "win32") return new Map();
  const args = invocationMarker
    ? [process.platform === "darwin" ? "-Eww" : "eww", "-A", "-o", "pid=,ppid=,pgid=,uid=,state=,lstart=,command="]
    : ["-A", "-o", "pid=,ppid=,pgid=,uid=,state=,lstart="];
  const result = spawnSync("/bin/ps", args, {
    encoding: "utf8",
    env: { PATH: sanitizedPath(), LANG: "C", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 1000,
  });
  if (result.status !== 0 || result.error) fail("process-tracking-unavailable", "cannot inspect the extension process tree");
  const table = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(\S+)\s+((?:\S+\s+){4}\S+)(?:\s+(.*))?\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, uid, state, started, command = ""] = match;
    const startedAt = Date.parse(started);
    if (!Number.isFinite(startedAt)) fail("process-tracking-unavailable", "cannot inspect extension process start times");
    table.set(Number(pid), {
      ppid: Number(ppid),
      pgid: Number(pgid),
      uid: Number(uid),
      state,
      startedAt,
      identity: `${pid}:${started}`,
      invocation: invocationMarker !== "" && command.includes(`FIRSTMATE_EXTENSION_INVOCATION=${invocationMarker}`),
    });
  }
  return table;
}

function processExecutable(pid) {
  if (process.platform === "linux") {
    try { return realpathSync(`/proc/${pid}/exe`); } catch { return ""; }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/sbin/lsof", ["-a", "-d", "txt", "-p", String(pid), "-Fn"], {
      encoding: "utf8",
      env: { PATH: sanitizedPath(), LANG: "C", LC_ALL: "C" },
      maxBuffer: 64 * 1024,
      timeout: 1000,
    });
    if (result.status !== 0 || result.error) return "";
    const name = result.stdout.split("\n").find((line) => line.startsWith("n"));
    return name ? name.slice(1) : "";
  }
  return "";
}

function refreshProcessTracker(tracker) {
  if (!tracker || process.platform === "win32") return;
  const table = readProcessTable(tracker.invocationMarker);
  const parents = new Set([tracker.rootPid]);
  for (const [pid, identity] of tracker.descendants) {
    if (table.get(pid)?.identity === identity) parents.add(pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, entry] of table) {
      const alreadyTracked = tracker.descendants.get(pid) === entry.identity;
      if (pid !== tracker.rootPid && (entry.invocation || parents.has(entry.ppid)) && !alreadyTracked) {
        tracker.descendants.set(pid, entry.identity);
        parents.add(pid);
        changed = true;
      }
    }
  }
  const unrelatedParents = new Set();
  for (const [pid, identity] of tracker.baseline) {
    if (pid !== 1 && table.get(pid)?.identity === identity) unrelatedParents.add(pid);
  }
  for (const [pid, identity] of tracker.unrelated) {
    if (table.get(pid)?.identity === identity) unrelatedParents.add(pid);
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const [pid, entry] of table) {
      if (pid === tracker.rootPid || parents.has(pid) || unrelatedParents.has(pid) || !unrelatedParents.has(entry.ppid)) continue;
      tracker.unrelated.set(pid, entry.identity);
      unrelatedParents.add(pid);
      changed = true;
    }
  }
  tracker.table = table;
}

function startProcessTracker(invocationMarker) {
  const table = readProcessTable();
  return {
    rootPid: 0,
    uid: currentUid(),
    startedAt: Date.now(),
    invocationMarker,
    baseline: new Map([...table].map(([pid, entry]) => [pid, entry.identity])),
    descendants: new Map(),
    unrelated: new Map(),
    table,
    timer: null,
    error: null,
  };
}

function ambiguousInvocationOrphans(tracker) {
  if (!tracker || process.platform === "win32") return [];
  if (!tracker.error) refreshProcessTracker(tracker);
  const candidates = [];
  for (const [pid, entry] of tracker.table) {
    if (pid === tracker.rootPid || entry.ppid !== 1 || entry.pgid !== pid || entry.uid !== tracker.uid || entry.state.startsWith("Z")) continue;
    if (entry.startedAt < tracker.startedAt - 1000 || tracker.baseline.get(pid) === entry.identity) continue;
    if (tracker.descendants.get(pid) === entry.identity) continue;
    if (tracker.unrelated.get(pid) === entry.identity) continue;
    candidates.push({ pid, identity: entry.identity });
  }
  return candidates;
}

function processQuarantinePath(statePath) {
  return statePath ? path.join(statePath, ".firstmate-process-quarantine.json") : "";
}

async function refuseActiveProcessQuarantine(statePath) {
  const quarantinePath = processQuarantinePath(statePath);
  if (!quarantinePath) return;
  const info = await maybeLstat(quarantinePath);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
    fail("process-quarantine-invalid", "extension process quarantine state is unsafe");
  }
  const quarantine = parseStrictJson(await readFile(quarantinePath), "extension process quarantine");
  exactKeys(quarantine, ["schema", "processes"], "extension process quarantine");
  if (quarantine.schema !== "firstmate.extension-process-quarantine.v1" || !Array.isArray(quarantine.processes) || quarantine.processes.length === 0) {
    fail("process-quarantine-invalid", "extension process quarantine state is invalid");
  }
  const table = readProcessTable();
  const active = quarantine.processes.some((processIdentity) => {
    if (!isPlainObject(processIdentity)) fail("process-quarantine-invalid", "extension process quarantine identity is invalid");
    exactKeys(processIdentity, ["identity", "pid"], "extension process quarantine identity");
    if (!Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 1 || typeof processIdentity.identity !== "string") {
      fail("process-quarantine-invalid", "extension process quarantine identity is invalid");
    }
    const entry = table.get(processIdentity.pid);
    return entry?.identity === processIdentity.identity && !entry.state.startsWith("Z");
  });
  if (active) fail("process-quarantined", "a prior invocation left an unattributable same-user process; refuse until that exact process identity exits");
  await unlink(quarantinePath);
}

async function quarantineAmbiguousProcesses(statePath, processes) {
  const quarantinePath = processQuarantinePath(statePath);
  if (!quarantinePath || processes.length === 0) return;
  await writeFile(quarantinePath, prettyJson({
    schema: "firstmate.extension-process-quarantine.v1",
    processes,
  }), { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
}

function armProcessTracker(tracker, child, onError) {
  tracker.rootPid = child.pid;
  if (!processExecutable(child.pid)) {
    tracker.error = new HostError("process-tracking-unavailable", "cannot inspect the extension executable identity");
    onError();
    return;
  }
  try {
    refreshProcessTracker(tracker);
  } catch (error) {
    tracker.error = error;
    onError();
    return;
  }
  // Processes present before the extension child is observed cannot be
  // attributed to that invocation.  The pre-spawn snapshot alone leaves a
  // small setup gap in which an unrelated same-user orphan can be mistaken
  // for an extension descendant.
  for (const [pid, entry] of tracker.table) tracker.baseline.set(pid, entry.identity);
  tracker.timer = setInterval(() => {
    try {
      refreshProcessTracker(tracker);
    } catch (error) {
      tracker.error = error;
      onError();
    }
  }, 20);
}

function stopProcessTracker(tracker) {
  if (!tracker) return;
  if (tracker.timer) clearInterval(tracker.timer);
  if (!tracker.error) {
    try { refreshProcessTracker(tracker); } catch (error) { tracker.error = error; }
  }
}

function trackedDescendantsAlive(tracker) {
  if (!tracker || process.platform === "win32") return false;
  if (!tracker.error) refreshProcessTracker(tracker);
  for (const [pid, identity] of tracker.descendants) {
    const entry = tracker.table.get(pid);
    if (entry?.identity === identity && !entry.state.startsWith("Z")) return true;
  }
  return false;
}

function groupAlive(pid) {
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(child, tracker, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
  if (!tracker || process.platform === "win32") return;
  try { refreshProcessTracker(tracker); } catch (error) { tracker.error = error; }
  for (const [pid, identity] of tracker.descendants) {
    const entry = tracker.table.get(pid);
    if (entry?.identity !== identity || entry.state.startsWith("Z")) continue;
    try { process.kill(pid, signal); } catch {}
  }
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanupProcessTree(child, tracker) {
  if (!child || !child.pid || (!groupAlive(child.pid) && !trackedDescendantsAlive(tracker))) return;
  signalProcessTree(child, tracker, "SIGTERM");
  const termUntil = Date.now() + TERMINATE_GRACE_MS;
  while (Date.now() < termUntil && (groupAlive(child.pid) || trackedDescendantsAlive(tracker))) await sleep(20);
  if (groupAlive(child.pid) || trackedDescendantsAlive(tracker)) signalProcessTree(child, tracker, "SIGKILL");
  const killUntil = Date.now() + CLEANUP_WAIT_MS;
  while (Date.now() < killUntil && (groupAlive(child.pid) || trackedDescendantsAlive(tracker))) await sleep(20);
  if (groupAlive(child.pid) || trackedDescendantsAlive(tracker)) fail("process-cleanup-failed", "extension process tree survived TERM and KILL");
}

async function runExtensionProcess(packageInfo, binding, verb, request, timeoutMs, statePath = "") {
  const requestBytes = Buffer.from(`${canonicalJson(request)}\n`, "utf8");
  if (requestBytes.length > MAX_JSON_BYTES) fail("request-oversized", `extension request exceeds ${MAX_JSON_BYTES} bytes`);
  const entryInfo = await lstat(packageInfo.entrypoint).catch(() => fail("entrypoint-missing", "bound extension entrypoint is missing"));
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.nlink !== 1 || entryInfo.uid !== currentUid()) {
    fail("entrypoint-invalid", "bound extension entrypoint identity is unsafe");
  }
  await refuseActiveProcessQuarantine(statePath);

  let child;
  const invocationMarker = randomBytes(32).toString("hex");
  const processTracker = startProcessTracker(invocationMarker);
  try {
    child = spawn(packageInfo.entrypoint, [verb], {
      cwd: packageInfo.root,
      detached: process.platform !== "win32",
      env: childEnvironment(binding, statePath, invocationMarker),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    fail("entrypoint-missing", "bound extension entrypoint could not be started");
  }
  activeChild = child;
  activeProcessTracker = processTracker;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout = [];
  let forcedCode = "";
  let forcedMessage = "";
  let killTimer = null;

  const forceStop = (code, message) => {
    if (forcedCode) return;
    forcedCode = code;
    forcedMessage = message;
    signalProcessTree(child, processTracker, "SIGTERM");
    killTimer = setTimeout(() => signalProcessTree(child, processTracker, "SIGKILL"), TERMINATE_GRACE_MS);
  };

  armProcessTracker(processTracker, child, () => {
    forceStop("process-tracking-unavailable", "cannot inspect the extension process tree");
  });

  const completion = new Promise((resolve, reject) => {
    child.once("error", () => reject(new HostError("entrypoint-missing", "bound extension entrypoint could not be started")));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_JSON_BYTES) {
        forceStop("response-oversized", `extension stdout exceeds ${MAX_JSON_BYTES} bytes`);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) forceStop("stderr-oversized", `extension stderr exceeds ${MAX_STDERR_BYTES} bytes`);
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const timeout = setTimeout(() => forceStop("timeout", `extension ${verb} exceeded ${timeoutMs} ms`), timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(requestBytes);

  let outcome;
  try {
    outcome = await completion;
  } catch (error) {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    await cleanupProcessTree(child, processTracker).catch(() => {});
    stopProcessTracker(processTracker);
    activeChild = null;
    activeProcessTracker = null;
    throw error;
  }
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  const leakedProcessTree = !forcedCode && (groupAlive(child.pid) || trackedDescendantsAlive(processTracker));
  try {
    if (forcedCode || leakedProcessTree) await cleanupProcessTree(child, processTracker);
  } finally {
    stopProcessTracker(processTracker);
  }
  const ambiguousProcesses = statePath ? ambiguousInvocationOrphans(processTracker) : [];
  await quarantineAmbiguousProcesses(statePath, ambiguousProcesses);
  activeChild = null;
  activeProcessTracker = null;
  if (processTracker.error) fail("process-tracking-unavailable", "cannot inspect the extension process tree");
  if (forcedCode) fail(forcedCode, forcedMessage);
  if (leakedProcessTree) fail("process-leak", `extension ${verb} left a background process tree`);
  if (ambiguousProcesses.length) {
    fail("process-attribution-ambiguous", `extension ${verb} overlapped a newly orphaned same-user process and its response cannot be accepted safely`);
  }
  if (outcome.signal || outcome.code !== 0) fail("process-failed", `extension ${verb} exited nonzero`);
  return parseStrictJson(Buffer.concat(stdout), `extension ${verb} response`);
}

async function handleSignal(signal) {
  if (terminatingForSignal) return;
  terminatingForSignal = true;
  if (activeChild) {
    signalProcessTree(activeChild, activeProcessTracker, "SIGTERM");
    await sleep(TERMINATE_GRACE_MS);
    signalProcessTree(activeChild, activeProcessTracker, "SIGKILL");
  }
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

process.on("SIGTERM", () => { void handleSignal("SIGTERM"); });
process.on("SIGINT", () => { void handleSignal("SIGINT"); });

function validateHandshakeResponse(response, request, binding) {
  exactKeys(response, ["schema", "request_id", "extension_id", "extension_version", "host_protocol", "capability", "capability_version", "adapter_names"], "handshake response");
  if (response.schema !== HANDSHAKE_RESPONSE_SCHEMA) fail("handshake-invalid", "extension returned an unsupported handshake response schema");
  if (response.request_id !== request.request_id) fail("request-id-mismatch", "extension handshake response request_id does not match");
  if (response.extension_id !== binding.extension_id || response.extension_version !== binding.extension_version) {
    fail("handshake-invalid", "extension handshake identity does not match the binding");
  }
  if (response.host_protocol !== binding.host_protocol || response.capability !== PROCESS_EVENT_CAPABILITY || response.capability_version !== 1) {
    fail("handshake-invalid", "extension handshake protocol or capability does not match the binding");
  }
  const names = uniqueArray(response.adapter_names, "handshake adapter_names", (entry, label) => boundedString(entry, 32, label, ADAPTER_RE));
  const expected = [...binding.capabilities[0].adapter_names].sort();
  const actual = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail("handshake-invalid", "extension handshake adapter names do not match the enabled binding subset");
  }
}

async function handshake(record, statePath = "") {
  const binding = record.binding;
  const request = {
    schema: HANDSHAKE_REQUEST_SCHEMA,
    request_id: makeRequestId(),
    host_protocols: HOST_PROTOCOLS,
    extension_id: binding.extension_id,
    extension_version: binding.extension_version,
    package_digest: binding.package_digest,
    capability: {
      name: PROCESS_EVENT_CAPABILITY,
      versions: PROCESS_EVENT_VERSIONS,
      adapter_names: binding.capabilities[0].adapter_names,
    },
  };
  const response = await runExtensionProcess(record.packageInfo, binding, "handshake", request, HANDSHAKE_TIMEOUT_MS, statePath);
  validateHandshakeResponse(response, request, binding);
}

function validateResponseEnvelope(response, request) {
  exactKeys(response, ["schema", "request_id", "ok", "result", "error"], "extension response");
  if (response.schema !== RESPONSE_SCHEMA) fail("response-invalid", "extension returned an unsupported response schema");
  if (response.request_id !== request.request_id) fail("request-id-mismatch", "extension response request_id does not match");
  if (typeof response.ok !== "boolean") fail("response-invalid", "extension response ok must be boolean");
  if (response.ok) {
    if (!isPlainObject(response.result) || response.error !== null) fail("response-invalid", "successful extension response must carry result and null error");
    return response.result;
  }
  if (response.result !== null || !isPlainObject(response.error)) fail("response-invalid", "failed extension response must carry null result and an error");
  exactKeys(response.error, ["code", "retryable", "diagnostic"], "extension response error");
  if (!RESPONSE_ERROR_CODES.has(response.error.code) || typeof response.error.retryable !== "boolean") {
    fail("response-invalid", "extension response error has an unsupported code or retryable value");
  }
  boundedString(response.error.diagnostic, 512, "extension response diagnostic");
  fail(`extension-${response.error.code}`, `extension reported ${response.error.code}`);
}

function validateOperationResult(operation, result) {
  if (operation === "source.poll") {
    exactKeys(result, ["status", "output"], "source.poll result");
    if (result.status !== "result" && result.status !== "no-result") fail("response-invalid", "source.poll status must be result or no-result");
    if (typeof result.output !== "string") fail("response-invalid", "source.poll output must be a UTF-8 string");
    validateUnicode(result.output, "source.poll output");
    const size = Buffer.byteLength(result.output, "utf8");
    if (size > MAX_RESULT_BYTES) fail("response-oversized", `source.poll output exceeds ${MAX_RESULT_BYTES} bytes`);
    if (result.status === "result" && size === 0) fail("response-invalid", "source.poll result output must not be empty");
    if (result.status === "no-result" && size !== 0) fail("response-invalid", "source.poll no-result output must be empty");
    return result;
  }
  if (operation === "result.classify") {
    exactKeys(result, ["classification"], "result.classify result");
    boundedString(result.classification, 64, "result.classify classification", /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    return result;
  }
  if (operation === "result.terminal" || operation === "result.silent") {
    exactKeys(result, ["value"], `${operation} result`);
    if (typeof result.value !== "boolean") fail("response-invalid", `${operation} value must be boolean`);
    return result;
  }
  fail("operation-unsupported", `unsupported process-event operation: ${operation}`);
}

async function readCapturedResult(home, resultFile) {
  const absolute = path.resolve(resultFile);
  const inbox = path.join(effectiveStateRoot(home), "procevent-inbox");
  if (!isInside(inbox, absolute) || path.dirname(absolute) !== inbox) fail("path-unsafe", "captured result must be directly inside this home's process-event inbox");
  const canonicalInbox = await realpath(inbox).catch(() => fail("path-unsafe", "process-event inbox is unavailable"));
  if (canonicalInbox !== inbox) fail("path-unsafe", "process-event inbox traverses a symbolic link");
  const info = await maybeLstat(absolute);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("link-unsafe", "captured result is not one regular file");
  if (info.uid !== currentUid() || modeOf(info) !== 0o600) fail("mode-unsafe", "captured result owner or mode is unsafe");
  if (info.size > MAX_RESULT_BYTES) fail("request-oversized", `captured extension result exceeds ${MAX_RESULT_BYTES} bytes`);
  const bytes = await readFile(absolute);
  let content;
  try {
    content = decoder.decode(bytes);
  } catch {
    fail("json-invalid", "captured extension result is not valid UTF-8");
  }
  const base = path.basename(absolute, ".result");
  const match = base.match(/^([A-Za-z0-9._-]{1,64})\.([0-9]+)$/);
  const sequence = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(sequence)) fail("path-unsafe", "captured result filename has no valid source identity");
  return { sourceId: match[1], sequence, content };
}

function parseExpectedOptions(args) {
  const expected = Object.create(null);
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (["--expect-extension", "--expect-version", "--expect-capability-version", "--expect-package-digest", "--expect-binding-digest", "--source-id", "--config-ref", "--result-file", "--request-id"].includes(name)) {
      if (index + 1 >= args.length) fail("usage", `${name} requires a value`);
      if (Object.hasOwn(expected, name)) fail("usage", `${name} may be supplied only once`);
      expected[name] = args[index + 1];
      index += 1;
    } else {
      rest.push(name);
    }
  }
  if (rest.length) fail("usage", `unknown process-event option: ${rest[0]}`);
  return expected;
}

function assertExpectedRecord(record, expected) {
  const required = ["--expect-extension", "--expect-version", "--expect-capability-version", "--expect-package-digest", "--expect-binding-digest"];
  for (const name of required) if (!Object.hasOwn(expected, name)) fail("usage", `${name} is required`);
  if (record.binding.extension_id !== expected["--expect-extension"]
      || record.binding.extension_version !== expected["--expect-version"]
      || expected["--expect-capability-version"] !== "1"
      || record.binding.package_digest !== expected["--expect-package-digest"]
      || record.bindingDigest !== expected["--expect-binding-digest"]) {
    fail("owner-mismatch", "current extension binding does not match the process-event registration owner");
  }
}

async function invokeProcessEvent(home, adapter, operation, options) {
  boundedString(adapter, 32, "adapter", ADAPTER_RE);
  if (!["source.poll", "result.classify", "result.terminal", "result.silent"].includes(operation)) {
    fail("operation-unsupported", `unsupported process-event operation: ${operation}`);
  }
  const bindings = await loadBindings(home, { packages: true });
  const record = selectAdapter(bindings, adapter);
  assertExpectedRecord(record, options);
  const statePath = await ensureExtensionState(home, record.binding);
  await handshake(record, statePath);
  let input;
  if (operation === "source.poll") {
    const sourceId = boundedString(options["--source-id"], 64, "source id", /^[A-Za-z0-9._-]+$/);
    const configRef = boundedString(options["--config-ref"], 512, "source configuration reference");
    input = { source_id: sourceId, config_ref: configRef };
  } else {
    if (!options["--result-file"]) fail("usage", `${operation} requires --result-file`);
    const captured = await readCapturedResult(home, options["--result-file"]);
    input = { source_id: captured.sourceId, sequence: captured.sequence, content: captured.content };
  }
  const requestId = options["--request-id"] || makeRequestId();
  if (!REQUEST_ID_RE.test(requestId)) fail("usage", "--request-id must be sha256:<64 lowercase hex>");
  const request = {
    schema: REQUEST_SCHEMA,
    request_id: requestId,
    host_protocol: record.binding.host_protocol,
    extension_id: record.binding.extension_id,
    extension_version: record.binding.extension_version,
    package_digest: record.binding.package_digest,
    capability: PROCESS_EVENT_CAPABILITY,
    capability_version: 1,
    adapter,
    operation,
    input,
  };
  const response = await runExtensionProcess(record.packageInfo, record.binding, "invoke", request, record.binding.timeout_ms, statePath);
  return validateOperationResult(operation, validateResponseEnvelope(response, request));
}

function errorEvidence(error, extensionId, operation) {
  const allowedCode = typeof error?.code === "string" && /^[a-z0-9-]{1,64}$/.test(error.code) ? error.code : "internal";
  const safeExtensionId = typeof extensionId === "string"
    && Buffer.byteLength(extensionId, "utf8") <= 128
    && ID_RE.test(extensionId) ? extensionId : "unknown";
  return `${canonicalJson({
    schema: ERROR_EVIDENCE_SCHEMA,
    extension_id: safeExtensionId,
    operation,
    code: allowedCode,
  })}\n`;
}

function parseBindArguments(args) {
  if (args.length === 0) fail("usage", "bind requires <package-root>");
  const packageRoot = args[0];
  const adapters = [];
  const consents = new Set();
  let trust = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--adapter" || name === "--consent" || name === "--timeout-ms") {
      if (index + 1 >= args.length) fail("usage", `${name} requires a value`);
      const value = args[index + 1];
      index += 1;
      if (name === "--adapter") adapters.push(value);
      else if (name === "--consent") consents.add(value);
      else timeoutMs = Number(value);
      continue;
    }
    if (name === "--trust-same-user-code") {
      if (trust) fail("usage", "--trust-same-user-code may be supplied only once");
      trust = true;
      continue;
    }
    fail("usage", `unknown bind option: ${name}`);
  }
  if (!trust) fail("consent-missing", "bind requires --trust-same-user-code");
  if (adapters.length === 0) fail("usage", "bind requires at least one --adapter");
  integerIn(timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "--timeout-ms");
  for (const consent of consents) if (!CONSENT_NAMES.includes(consent)) fail("usage", `unsupported consent fact: ${consent}`);
  return { packageRoot, adapters, consents, timeoutMs };
}

async function atomicWriteBinding(registry, destination, bytes) {
  const temporary = path.join(registry, `.binding-${process.pid}-${randomBytes(8).toString("hex")}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  let published = false;
  try {
    // Atomic no-replace publication: a concurrent binding always wins rather
    // than being overwritten between the caller's absence check and commit.
    await link(temporary, destination);
    published = true;
    await unlink(temporary);
  } catch (error) {
    if (published) await unlink(destination).catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cmdBind(args) {
  await runLifecycleBinding("bind", args);
}

async function cmdBindFrom(args, stagedRoot) {
  const parsed = parseBindArguments(args);
  const home = await activeHome();
  const sourceRoot = stagedRoot === null
    ? await validateSourceRoot(home, parsed.packageRoot)
    : await realpath(stagedRoot);
  if (stagedRoot !== null && (path.resolve(parsed.packageRoot) !== stagedRoot || sourceRoot !== stagedRoot)) {
    fail("path-unsafe", "received package root does not match its published staging path");
  }
  const sourceInfo = await validatePackage(sourceRoot, { installed: false });
  const selected = uniqueArray(parsed.adapters, "--adapter values", (entry, label) => boundedString(entry, 32, label, ADAPTER_RE));
  for (const adapter of selected) {
    if (!sourceInfo.manifest.capabilities[0].adapter_names.includes(adapter)) fail("capability-mismatch", `manifest does not allow adapter: ${adapter}`);
    if (await maybeLstat(path.join(CODE_ROOT, "bin", `fm-procevent-${adapter}.sh`))) {
      fail("adapter-conflict", `adapter name is already owned by a built-in: ${adapter}`);
    }
  }
  for (const consent of sourceInfo.manifest.required_consents) {
    if (!parsed.consents.has(consent)) fail("consent-missing", `manifest requires explicit --consent ${consent}`);
  }
  const commonHost = sourceInfo.manifest.host_protocols.filter((version) => HOST_PROTOCOLS.includes(version)).sort((a, b) => b - a)[0];
  const commonCapability = sourceInfo.manifest.capabilities[0].versions.filter((version) => PROCESS_EVENT_VERSIONS.includes(version)).sort((a, b) => b - a)[0];
  if (!commonHost || !commonCapability) fail("protocol-incompatible", "package and host have no common process-event protocol version");

  const existingBindings = await loadBindings(home, { packages: false });
  if (existingBindings.some((record) => record.binding.extension_id === sourceInfo.manifest.id)) {
    fail("binding-exists", `binding already exists for extension: ${sourceInfo.manifest.id}`);
  }
  for (const adapter of selected) {
    if (existingBindings.some((record) => record.binding.capabilities[0].adapter_names.includes(adapter))) {
      fail("adapter-conflict", `adapter is already enabled by another binding: ${adapter}`);
    }
  }

  const installed = await installPackage(home, sourceInfo);
  const binding = {
    schema: BINDING_SCHEMA,
    extension_id: sourceInfo.manifest.id,
    extension_version: sourceInfo.manifest.version,
    source: { kind: "local-directory", path: sourceRoot },
    package_root: installed.packageInfo.root,
    manifest_sha256: installed.packageInfo.manifestDigest,
    package_digest: installed.packageInfo.tree.digest,
    entrypoint: installed.packageInfo.manifest.entrypoint,
    entrypoint_sha256: installed.packageInfo.entrypointDigest,
    host_protocol: commonHost,
    capabilities: [{ name: PROCESS_EVENT_CAPABILITY, version: commonCapability, adapter_names: selected }],
    consents: {
      trusted_same_user_code: true,
      network: parsed.consents.has("network"),
      credential_store: parsed.consents.has("credential-store"),
      task_metadata: parsed.consents.has("task-metadata"),
      artifact_references: parsed.consents.has("artifact-references"),
    },
    timeout_ms: parsed.timeoutMs,
  };
  const record = { binding, packageInfo: installed.packageInfo };
  const statePath = await ensureExtensionState(home, binding);
  let publishedBinding = "";
  let publishedBytes = null;
  try {
    await handshake(record, statePath);
    const registry = await ensureHomePrivatePath(home, ["config", "extensions.d"]);
    const destination = path.join(registry, `${binding.extension_id}.json`);
    if (await maybeLstat(destination)) fail("binding-exists", `binding already exists for extension: ${binding.extension_id}`);
    const bytes = Buffer.from(prettyJson(binding), "utf8");
    await atomicWriteBinding(registry, destination, bytes);
    publishedBinding = destination;
    publishedBytes = bytes;
    const loaded = (await loadBindings(home, { packages: true })).find((candidate) => candidate.binding.extension_id === binding.extension_id);
    if (!loaded) fail("binding-write-failed", "binding was not readable after publication");
    await handshake(loaded, statePath);
    process.stdout.write(`bound: ${binding.extension_id}@${binding.extension_version}\n`);
    process.stdout.write(`binding: ${destination}\n`);
    process.stdout.write(`binding-digest: ${loaded.bindingDigest}\n`);
    process.stdout.write(`package: ${binding.package_root}\n`);
    process.stdout.write(`package-digest: ${binding.package_digest}\n`);
    process.stdout.write(`verified: ${PROCESS_EVENT_CAPABILITY}/${commonCapability} (${selected.join(",")})\n`);
  } catch (error) {
    if (publishedBinding && publishedBytes) {
      const current = await readFile(publishedBinding).catch(() => null);
      if (current && Buffer.compare(current, publishedBytes) === 0) {
        await rm(publishedBinding, { force: true }).catch(() => {});
      }
    }
    throw error;
  }
}

function transferEntryPath(value, label) {
  const relative = boundedString(value, 512, label);
  if (path.posix.isAbsolute(relative) || relative.includes("\\")
      || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("path-unsafe", `${label} must be a normalized relative POSIX path`);
  }
  return relative;
}

function validateTransferEnvelope(value) {
  exactKeys(value, ["schema", "manifest", "manifest_sha256", "payloads"], "package transfer envelope");
  if (value.schema !== TRANSFER_SCHEMA) fail("schema-invalid", "unsupported package transfer envelope schema");
  if (!DIGEST_RE.test(value.manifest_sha256)) fail("schema-invalid", "transfer manifest_sha256 is not a SHA-256 digest");
  exactKeys(value.manifest, ["schema", "extension_id", "extension_version", "package_digest", "entry_count", "total_bytes", "entries"], "package transfer manifest");
  const manifest = value.manifest;
  if (manifest.schema !== TRANSFER_MANIFEST_SCHEMA) fail("schema-invalid", "unsupported package transfer manifest schema");
  boundedString(manifest.extension_id, 128, "transfer extension_id", ID_RE);
  boundedString(manifest.extension_version, 128, "transfer extension_version", SEMVER_RE);
  if (!DIGEST_RE.test(manifest.package_digest)) fail("schema-invalid", "transfer package_digest is not a SHA-256 digest");
  integerIn(manifest.entry_count, 1, MAX_TRANSFER_ENTRIES, "transfer entry_count");
  integerIn(manifest.total_bytes, 1, MAX_TRANSFER_PACKAGE_BYTES, "transfer total_bytes");
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== manifest.entry_count) fail("schema-invalid", "transfer entry_count does not match entries");
  if (!Array.isArray(value.payloads) || value.payloads.length !== manifest.entry_count) fail("schema-invalid", "transfer payload count does not match entries");
  const seen = new Map();
  let total = 0;
  let previous = "";
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    exactKeys(entry, ["path", "type", "mode", "size", "sha256"], `transfer entry ${index}`);
    const relative = transferEntryPath(entry.path, `transfer entry ${index} path`);
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(relative)) >= 0) fail("schema-invalid", "transfer entries must be uniquely byte-sorted");
    previous = relative;
    for (const ancestor of relative.split("/").slice(0, -1).map((_, partIndex, parts) => parts.slice(0, partIndex + 1).join("/"))) {
      if (seen.get(ancestor) === "file") fail("path-unsafe", `transfer path collides with file ancestor: ${relative}`);
    }
    if (entry.type === "directory") {
      if (entry.mode !== 0o755 || entry.size !== 0 || entry.sha256 !== null || value.payloads[index] !== null) {
        fail("schema-invalid", `transfer directory entry is invalid: ${relative}`);
      }
    } else if (entry.type === "file") {
      if (entry.mode !== 0o644 && entry.mode !== 0o755) fail("mode-unsafe", `transfer file mode is not allowed: ${relative}`);
      integerIn(entry.size, 0, MAX_TRANSFER_FILE_BYTES, `transfer file size for ${relative}`);
      if (!DIGEST_RE.test(entry.sha256)) fail("schema-invalid", `transfer file digest is invalid: ${relative}`);
      if (typeof value.payloads[index] !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.payloads[index])) {
        fail("schema-invalid", `transfer payload is not canonical base64: ${relative}`);
      }
      const bytes = Buffer.from(value.payloads[index], "base64");
      if (bytes.length !== entry.size || digestBytes(bytes) !== entry.sha256) fail("integrity-mismatch", `transfer payload hash or size mismatch: ${relative}`);
      total += bytes.length;
      if (total > MAX_TRANSFER_PACKAGE_BYTES) fail("package-oversized", `transferred package exceeds ${MAX_TRANSFER_PACKAGE_BYTES} bytes`);
    } else {
      fail("package-invalid", `transfer entry type is not allowed: ${relative}`);
    }
    seen.set(relative, entry.type);
  }
  if (total !== manifest.total_bytes) fail("integrity-mismatch", "transfer total_bytes does not match payloads");
  const manifestDigest = digestBytes(Buffer.from(canonicalJson(manifest), "utf8"));
  if (manifestDigest !== value.manifest_sha256) fail("integrity-mismatch", "transfer manifest hash mismatch");
  return { manifest, manifestDigest };
}

async function readStdinBounded(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) fail("package-oversized", `package transfer exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function cmdPackTransfer(args) {
  if (args.length !== 1) fail("usage", "pack-transfer requires <package-root>");
  const home = await activeHome();
  const sourceRoot = await validateSourceRoot(home, args[0]);
  const packageInfo = await validatePackage(sourceRoot, { installed: false });
  if (packageInfo.tree.entryCount > MAX_TRANSFER_ENTRIES || packageInfo.tree.totalBytes > MAX_TRANSFER_PACKAGE_BYTES) {
    fail("package-oversized", "package exceeds the remote transfer entry or byte limit");
  }
  const entries = [];
  const payloads = [];
  for (const entry of packageInfo.tree.entries) {
    if (entry.type === "directory") {
      entries.push({ path: entry.relative, type: "directory", mode: 0o755, size: 0, sha256: null });
      payloads.push(null);
    } else {
      if (entry.size > MAX_TRANSFER_FILE_BYTES) fail("package-oversized", `package file exceeds ${MAX_TRANSFER_FILE_BYTES} bytes: ${entry.relative}`);
      const bytes = await readFile(path.join(sourceRoot, entry.relative));
      entries.push({ path: entry.relative, type: "file", mode: entry.executable ? 0o755 : 0o644, size: bytes.length, sha256: digestBytes(bytes) });
      payloads.push(bytes.toString("base64"));
    }
  }
  const manifest = {
    schema: TRANSFER_MANIFEST_SCHEMA,
    extension_id: packageInfo.manifest.id,
    extension_version: packageInfo.manifest.version,
    package_digest: packageInfo.tree.digest,
    entry_count: entries.length,
    total_bytes: packageInfo.tree.totalBytes,
    entries,
  };
  const envelope = { schema: TRANSFER_SCHEMA, manifest, manifest_sha256: digestBytes(Buffer.from(canonicalJson(manifest))), payloads };
  const output = Buffer.from(canonicalJson(envelope), "utf8");
  if (output.length > MAX_TRANSFER_JSON_BYTES) fail("package-oversized", `serialized package transfer exceeds ${MAX_TRANSFER_JSON_BYTES} bytes`);
  process.stdout.write(output);
}

async function transferRetiredDestination(home, manifest) {
  const parent = await ensureHomePrivatePath(home, ["data", "extensions", "retired-staging", manifest.extension_id, manifest.extension_version]);
  return path.join(parent, manifest.transfer_digest.slice("sha256:".length));
}

async function retirePublishedTransfer(home, published, receipt) {
  const retired = await transferRetiredDestination(home, receipt);
  if (await maybeLstat(retired)) fail("transfer-exists", "this transfer identity is already retired");
  await rename(published, retired);
  return retired;
}

async function assertLifecycleLockOwned() {
  if (!activeLifecycleLock) fail("lifecycle-lock-invalid", "retirement has no lifecycle lock ownership");
  const { lockPath, ownerPath } = activeLifecycleLock;
  const lockInfo = await maybeLstat(lockPath);
  if (!lockInfo?.isSymbolicLink()) fail("lifecycle-lock-lost", "retirement lifecycle lock is no longer held");
  const target = await readlink(lockPath).catch(() => fail("lifecycle-lock-lost", "retirement lifecycle lock cannot be read"));
  const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(lockPath), target);
  if (resolvedTarget !== ownerPath) fail("lifecycle-lock-lost", "retirement lifecycle lock owner changed");
  const ownerInfo = await maybeLstat(ownerPath);
  if (!ownerInfo?.isDirectory() || ownerInfo.isSymbolicLink() || ownerInfo.uid !== currentUid()) {
    fail("lifecycle-lock-invalid", "retirement lifecycle lock owner is unsafe");
  }
  const pidPath = path.join(ownerPath, "pid");
  const pidInfo = await maybeLstat(pidPath);
  if (!pidInfo?.isFile() || pidInfo.isSymbolicLink() || pidInfo.nlink !== 1 || pidInfo.uid !== currentUid()) {
    fail("lifecycle-lock-invalid", "retirement lifecycle lock pid is unsafe");
  }
  const pid = (await readFile(pidPath, "utf8")).trim();
  if (pid !== String(process.pid)) fail("lifecycle-lock-lost", "retirement process does not own the lifecycle lock");
}

async function claimInheritedLifecycleLock(home) {
  const mode = process.env.FM_EXTENSION_RETIREMENT_MODE;
  if (mode !== "binding" && mode !== "transfer" && mode !== "bind") fail("lifecycle-lock-invalid", "extension lifecycle mode is invalid");
  const stateRoot = effectiveStateRoot(home);
  const expectedLock = path.join(stateRoot, "procevent", ".extension-binding-lifecycle.lock");
  const lockPath = path.resolve(process.env.FM_EXTENSION_LIFECYCLE_LOCK || "");
  const ownerPath = path.resolve(process.env.FM_EXTENSION_LIFECYCLE_OWNER || "");
  if (lockPath !== expectedLock || path.dirname(ownerPath) !== path.dirname(lockPath)
      || !path.basename(ownerPath).startsWith(`${path.basename(lockPath)}.owner.`)) {
    fail("lifecycle-lock-invalid", "retirement lifecycle lock identity is invalid");
  }
  activeLifecycleLock = { lockPath, ownerPath };
  await assertLifecycleLockOwned();
  return mode;
}

async function releaseLifecycleLock() {
  await assertLifecycleLockOwned();
  const { lockPath, ownerPath } = activeLifecycleLock;
  await unlink(lockPath);
  await unlink(path.join(ownerPath, "pid"));
  await rmdir(ownerPath);
  activeLifecycleLock = null;
}

async function cmdReceiveTransferBind(args) {
  await runLifecycleBinding("receive-transfer-bind", args);
}

async function cmdReceiveTransferBindLocked(args) {
  const home = await activeHome();
  const envelope = parseStrictJson(await readStdinBounded(MAX_TRANSFER_JSON_BYTES), "package transfer", MAX_TRANSFER_JSON_BYTES);
  const { manifest, manifestDigest } = validateTransferEnvelope(envelope);
  const versionRoot = await ensureHomePrivatePath(home, ["data", "extensions", "staging", manifest.extension_id, manifest.extension_version]);
  const destination = path.join(versionRoot, manifestDigest.slice("sha256:".length));
  const receipt = { schema: TRANSFER_MANIFEST_SCHEMA, extension_id: manifest.extension_id, extension_version: manifest.extension_version, package_digest: manifest.package_digest, transfer_digest: manifestDigest };
  const retired = await transferRetiredDestination(home, receipt);
  if (await maybeLstat(destination) || await maybeLstat(retired)) fail("transfer-exists", "this transfer identity was already received");
  const lockPath = `${destination}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") fail("transfer-exists", "this transfer identity is already being received");
    throw error;
  });
  const temporary = path.join(versionRoot, `.receive-${process.pid}-${randomBytes(8).toString("hex")}`);
  let published = false;
  try {
    await mkdir(path.join(temporary, "package"), { recursive: true, mode: 0o700 });
    for (let index = 0; index < manifest.entries.length; index += 1) {
      const entry = manifest.entries[index];
      const target = path.join(temporary, "package", ...entry.path.split("/"));
      if (entry.type === "directory") {
        await mkdir(target, { mode: 0o755 });
      } else {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, Buffer.from(envelope.payloads[index], "base64"), { flag: "wx", mode: entry.mode });
        await chmod(target, entry.mode);
      }
    }
    await chmod(path.join(temporary, "package"), 0o755);
    const packageInfo = await validatePackage(path.join(temporary, "package"), { installed: false });
    if (packageInfo.tree.entries.length !== manifest.entries.length) fail("package-invalid", "received package contains an entry absent from its transfer manifest");
    for (let index = 0; index < manifest.entries.length; index += 1) {
      const declared = manifest.entries[index];
      const actual = packageInfo.tree.entries[index];
      const actualMode = actual.type === "directory" || actual.executable ? 0o755 : 0o644;
      if (actual.relative !== declared.path || actual.type !== declared.type || actualMode !== declared.mode
          || (actual.type === "file" && (actual.size !== declared.size || actual.digest !== declared.sha256))) {
        fail("package-invalid", "received package tree does not exactly match its transfer manifest");
      }
    }
    if (packageInfo.manifest.id !== manifest.extension_id || packageInfo.manifest.version !== manifest.extension_version
        || packageInfo.tree.digest !== manifest.package_digest) fail("integrity-mismatch", "received package identity does not match its transfer manifest");
    await writeFile(path.join(temporary, "receipt.json"), prettyJson(receipt), { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    published = true;
    await cmdBindFrom([path.join(destination, "package"), ...args], path.join(destination, "package"));
    process.stdout.write(`transfer-digest: ${manifestDigest}\n`);
    process.stdout.write(`staged-package: ${path.join(destination, "package")}\n`);
  } catch (error) {
    if (published) await retirePublishedTransfer(home, destination, receipt).catch(() => {});
    else await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function cmdRetireTransferLocked(args) {
  if (args.length !== 5 || args[1] !== "--if-transfer-digest" || args[3] !== "--if-binding-digest") {
    fail("usage", "retire-transfer requires <extension-id> --if-transfer-digest <sha256:digest> --if-binding-digest <sha256:digest>");
  }
  const extensionId = boundedString(args[0], 128, "extension id", ID_RE);
  const transferDigest = args[2];
  const bindingDigest = args[4];
  if (!DIGEST_RE.test(transferDigest)) fail("usage", "--if-transfer-digest must be sha256:<64 lowercase hex>");
  if (!DIGEST_RE.test(bindingDigest)) fail("usage", "--if-binding-digest must be sha256:<64 lowercase hex>");
  const home = await activeHome();
  const idRoot = path.join(home, "data", "extensions", "staging", extensionId);
  const versions = await readdir(idRoot).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const matches = [];
  for (const version of versions) {
    boundedString(version, 128, "staged extension version", SEMVER_RE);
    const candidate = path.join(idRoot, version, transferDigest.slice("sha256:".length));
    if (await maybeLstat(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) fail("transfer-missing", "no unique staged package matches that extension and transfer digest");
  await assertOwnedSafeDirectory(matches[0], "staged transfer", true);
  const receiptPath = path.join(matches[0], "receipt.json");
  const receiptInfo = await maybeLstat(receiptPath);
  if (!receiptInfo || !receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.nlink !== 1) fail("link-unsafe", "transfer receipt is not one regular file");
  if (receiptInfo.uid !== currentUid()) fail("owner-mismatch", "transfer receipt is not owned by the active user");
  if (modeOf(receiptInfo) !== 0o600) fail("mode-unsafe", "transfer receipt must have mode 0600");
  const receipt = parseStrictJson(await readFile(receiptPath), "transfer receipt");
  exactKeys(receipt, ["schema", "extension_id", "extension_version", "package_digest", "transfer_digest"], "transfer receipt");
  if (receipt.schema !== TRANSFER_MANIFEST_SCHEMA || receipt.extension_id !== extensionId || receipt.transfer_digest !== transferDigest
      || !SEMVER_RE.test(receipt.extension_version) || !DIGEST_RE.test(receipt.package_digest)) fail("integrity-mismatch", "staged transfer receipt does not match retirement identity");
  if (path.basename(path.dirname(matches[0])) !== receipt.extension_version) fail("integrity-mismatch", "staged transfer version directory does not match its receipt");
  const stagedPackage = await validatePackage(path.join(matches[0], "package"), { installed: false });
  if (stagedPackage.manifest.id !== receipt.extension_id || stagedPackage.manifest.version !== receipt.extension_version
      || stagedPackage.tree.digest !== receipt.package_digest) fail("integrity-mismatch", "staged package identity does not match its transfer receipt");
  const retired = await transferRetiredDestination(home, receipt);
  if (await maybeLstat(retired)) fail("transfer-exists", "this transfer identity is already retired");
  const retiredBinding = path.join(matches[0], "binding.json");
  const partialInfo = await maybeLstat(retiredBinding);
  const bindings = await loadBindings(home, { packages: true });
  const record = bindings.find((candidate) => candidate.binding.extension_id === extensionId);
  if (partialInfo) {
    if (record) fail("retirement-partial", "enabled and partial binding state coexist for this transfer identity");
    const partial = await loadBindingRecord(home, retiredBinding, "partial retired binding");
    if (partial.bindingDigest !== bindingDigest
        || partial.binding.extension_id !== receipt.extension_id
        || partial.binding.extension_version !== receipt.extension_version
        || partial.binding.package_digest !== receipt.package_digest
        || partial.binding.source.path !== path.join(matches[0], "package")) {
      fail("owner-mismatch", "partial binding does not match the exact transfer retirement identity");
    }
    await bindingRetirementPreflight(home, bindingDigest);
    await assertLifecycleLockOwned();
    await rename(matches[0], retired);
    process.stdout.write(`retired-transfer: ${extensionId} ${transferDigest}\n`);
    process.stdout.write(`retired-binding: ${extensionId} ${bindingDigest}\n`);
    process.stdout.write(`retained-at: ${retired}\n`);
    return;
  }
  if (!record) fail("binding-missing", `no enabled binding exists for extension: ${extensionId}`);
  if (record.bindingDigest !== bindingDigest) fail("owner-mismatch", "current extension binding does not match the expected binding identity");
  if (record.binding.extension_version !== receipt.extension_version
      || record.binding.package_digest !== receipt.package_digest
      || record.binding.source.path !== path.join(matches[0], "package")) {
    fail("owner-mismatch", "current extension binding is not owned by this staged transfer identity");
  }
  await bindingRetirementPreflight(home, bindingDigest);
  let bindingMoved = false;
  try {
    await assertLifecycleLockOwned();
    await rename(record.bindingPath, retiredBinding);
    bindingMoved = true;
    const movedBytes = await readFile(retiredBinding);
    if (digestBytes(movedBytes) !== bindingDigest || Buffer.compare(movedBytes, record.bytes) !== 0) {
      fail("owner-mismatch", "binding changed during conditional retirement");
    }
    await assertLifecycleLockOwned();
    await rename(matches[0], retired);
    bindingMoved = false;
  } catch (error) {
    if (bindingMoved) await rename(retiredBinding, record.bindingPath).catch(() => {});
    throw error;
  }
  process.stdout.write(`retired-transfer: ${extensionId} ${transferDigest}\n`);
  process.stdout.write(`retired-binding: ${extensionId} ${bindingDigest}\n`);
  process.stdout.write(`retained-at: ${retired}\n`);
}

async function cmdRetireBindingLocked(args) {
  if (args.length !== 3 || args[1] !== "--if-binding-digest") fail("usage", "retire-binding requires <extension-id> --if-binding-digest <sha256:digest>");
  const extensionId = boundedString(args[0], 128, "extension id", ID_RE);
  const bindingDigest = args[2];
  if (!DIGEST_RE.test(bindingDigest)) fail("usage", "--if-binding-digest must be sha256:<64 lowercase hex>");
  const home = await activeHome();
  const bindings = await loadBindings(home, { packages: true });
  const record = bindings.find((candidate) => candidate.binding.extension_id === extensionId);
  if (!record) fail("binding-missing", `no enabled binding exists for extension: ${extensionId}`);
  if (record.bindingDigest !== bindingDigest) fail("owner-mismatch", "current extension binding does not match the expected binding identity");
  const stagingRoot = path.join(home, "data", "extensions", "staging");
  if (isInside(stagingRoot, record.binding.source.path)) fail("retirement-incomplete", "a transferred binding must retire with its exact transfer identity");
  await bindingRetirementPreflight(home, bindingDigest);
  const parent = await ensureHomePrivatePath(home, ["data", "extensions", "retired-bindings", extensionId]);
  const destination = path.join(parent, `${bindingDigest.slice("sha256:".length)}.json`);
  if (await maybeLstat(destination)) fail("binding-exists", "this binding identity is already retired");
  let moved = false;
  try {
    await assertLifecycleLockOwned();
    await rename(record.bindingPath, destination);
    moved = true;
    const retiredBytes = await readFile(destination);
    if (digestBytes(retiredBytes) !== bindingDigest || Buffer.compare(retiredBytes, record.bytes) !== 0) {
      fail("owner-mismatch", "binding changed during conditional retirement");
    }
    moved = false;
  } catch (error) {
    if (moved) await rename(destination, record.bindingPath).catch(() => {});
    throw error;
  }
  process.stdout.write(`retired-binding: ${extensionId} ${bindingDigest}\n`);
  process.stdout.write(`retained-at: ${destination}\n`);
}

async function runLifecycleRetirement(mode, args) {
  const command = path.join(CODE_ROOT, "bin", "fm-procevent.sh");
  const home = await activeHome();
  const env = { PATH: sanitizedPath(), LANG: "C", LC_ALL: "C", HOME: process.env.HOME || home, FM_HOME: home, FM_ROOT_OVERRIDE: CODE_ROOT };
  if (process.env.FM_STATE_OVERRIDE) env.FM_STATE_OVERRIDE = process.env.FM_STATE_OVERRIDE;
  if (process.env.XDG_STATE_HOME) env.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
  if (process.env.FM_PROCEVENT_CLAIM_ROOT) env.FM_PROCEVENT_CLAIM_ROOT = process.env.FM_PROCEVENT_CLAIM_ROOT;
  const child = spawn(command, ["extension-retirement", mode, ...args], {
    cwd: CODE_ROOT,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_JSON_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch(() => fail("retirement-failed", "extension lifecycle retirement could not start"));
  if (stdoutBytes > MAX_JSON_BYTES || stderrBytes > MAX_STDERR_BYTES || outcome.code !== 0 || outcome.signal) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
    fail("retirement-failed", diagnostic || "extension lifecycle retirement failed");
  }
  process.stdout.write(Buffer.concat(stdout));
}

async function runLifecycleBinding(commandName, args) {
  const command = path.join(CODE_ROOT, "bin", "fm-procevent.sh");
  const home = await activeHome();
  const env = { PATH: sanitizedPath(), LANG: "C", LC_ALL: "C", HOME: process.env.HOME || home, FM_HOME: home, FM_ROOT_OVERRIDE: CODE_ROOT };
  if (process.env.FM_STATE_OVERRIDE) env.FM_STATE_OVERRIDE = process.env.FM_STATE_OVERRIDE;
  if (process.env.XDG_STATE_HOME) env.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
  if (process.env.FM_PROCEVENT_CLAIM_ROOT) env.FM_PROCEVENT_CLAIM_ROOT = process.env.FM_PROCEVENT_CLAIM_ROOT;
  const child = spawn(command, ["extension-bind", commandName, ...args], {
    cwd: CODE_ROOT,
    env,
    shell: false,
    stdio: [commandName === "receive-transfer-bind" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (commandName === "receive-transfer-bind") process.stdin.pipe(child.stdin);
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_JSON_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch(() => fail("binding-failed", "extension lifecycle binding could not start"));
  if (stdoutBytes > MAX_JSON_BYTES || stderrBytes > MAX_STDERR_BYTES || outcome.code !== 0 || outcome.signal) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
    fail("binding-failed", diagnostic || "extension lifecycle binding failed");
  }
  process.stdout.write(Buffer.concat(stdout));
}

async function cmdRetireBinding(args) {
  await runLifecycleRetirement("binding", args);
}

async function cmdRetireTransfer(args) {
  await runLifecycleRetirement("transfer", args);
}

async function runInheritedLifecycleRetirement(args) {
  const home = await activeHome();
  const mode = await claimInheritedLifecycleLock(home);
  try {
    if (mode === "binding") await cmdRetireBindingLocked(args);
    else if (mode === "transfer") await cmdRetireTransferLocked(args);
    else {
      const [command, ...commandArgs] = args;
      if (command === "bind") await cmdBindFrom(commandArgs, null);
      else if (command === "receive-transfer-bind") await cmdReceiveTransferBindLocked(commandArgs);
      else fail("lifecycle-lock-invalid", "extension lifecycle binding command is invalid");
    }
  } finally {
    await releaseLifecycleLock();
  }
}

async function bindingRetirementPreflight(home, bindingDigest) {
  const command = path.join(CODE_ROOT, "bin", "fm-procevent.sh");
  const env = { PATH: sanitizedPath(), LANG: "C", LC_ALL: "C", HOME: process.env.HOME || home, FM_HOME: home, FM_ROOT_OVERRIDE: CODE_ROOT };
  if (process.env.FM_STATE_OVERRIDE) env.FM_STATE_OVERRIDE = process.env.FM_STATE_OVERRIDE;
  if (process.env.XDG_STATE_HOME) env.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
  if (process.env.FM_PROCEVENT_CLAIM_ROOT) env.FM_PROCEVENT_CLAIM_ROOT = process.env.FM_PROCEVENT_CLAIM_ROOT;
  const child = spawn(command, ["binding-retirement-preflight", bindingDigest], {
    cwd: CODE_ROOT,
    env,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch(() => fail("retirement-preflight-failed", "process-event retirement preflight could not start"));
  if (stderrBytes > MAX_STDERR_BYTES || outcome.code !== 0 || outcome.signal) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
    fail("binding-in-use", diagnostic || "binding retirement process-event preflight refused");
  }
}

async function cmdList(args) {
  if (args.length) fail("usage", "list takes no arguments");
  const home = await activeHome();
  const bindings = await loadBindings(home, { packages: false });
  if (bindings.length === 0) {
    process.stdout.write("no extension bindings\n");
    return;
  }
  process.stdout.write("EXTENSION VERSION CAPABILITY ADAPTERS PACKAGE_DIGEST\n");
  for (const record of bindings) {
    const binding = record.binding;
    process.stdout.write(`${binding.extension_id} ${binding.extension_version} process-event-adapter/1 ${binding.capabilities[0].adapter_names.join(",")} ${binding.package_digest}\n`);
  }
}

async function cmdInspect(args) {
  if (args.length !== 1) fail("usage", "inspect requires <extension-id>");
  const id = boundedString(args[0], 128, "extension id", ID_RE);
  const home = await activeHome();
  const bindings = await loadBindings(home, { packages: true });
  const record = bindings.find((candidate) => candidate.binding.extension_id === id);
  if (!record) fail("binding-missing", `no binding exists for extension: ${id}`);
  process.stdout.write(prettyJson(record.binding));
}

async function cmdVerify(args) {
  if (args.length > 1) fail("usage", "verify accepts at most one extension id");
  const wanted = args[0] ? boundedString(args[0], 128, "extension id", ID_RE) : "";
  const home = await activeHome();
  let bindings = await loadBindings(home, { packages: true });
  if (wanted) bindings = bindings.filter((record) => record.binding.extension_id === wanted);
  if (bindings.length === 0) {
    if (wanted) fail("binding-missing", `no binding exists for extension: ${wanted}`);
    process.stdout.write("no extension bindings\n");
    return;
  }
  for (const record of bindings) {
    const statePath = await ensureExtensionState(home, record.binding);
    await handshake(record, statePath);
    process.stdout.write(`verified: ${record.binding.extension_id}@${record.binding.extension_version} ${record.binding.package_digest}\n`);
  }
}

async function cmdResolveProcessEvent(args) {
  if (args.length !== 1) fail("usage", "resolve-process-event requires <adapter>");
  const adapter = boundedString(args[0], 32, "adapter", ADAPTER_RE);
  const home = await activeHome();
  const bindings = await loadBindings(home, { packages: true });
  const record = selectAdapter(bindings, adapter);
  const statePath = await ensureExtensionState(home, record.binding);
  await handshake(record, statePath);
  const fields = [
    RESOLUTION_SCHEMA,
    record.binding.extension_id,
    record.binding.extension_version,
    "1",
    record.binding.package_digest,
    record.bindingDigest,
  ];
  process.stdout.write(`${fields.join("\t")}\n`);
}

async function cmdProcessEvent(args) {
  if (args.length < 2) fail("usage", "process-event requires <adapter> <operation>");
  const [adapter, operation, ...optionArgs] = args;
  const options = parseExpectedOptions(optionArgs);
  const home = await activeHome();
  let extensionId = options["--expect-extension"] || "unknown";
  try {
    const result = await invokeProcessEvent(home, adapter, operation, options);
    if (operation === "source.poll") {
      if (result.status === "no-result") process.exitCode = 75;
      else process.stdout.write(result.output);
    } else if (operation === "result.classify") {
      process.stdout.write(`${result.classification}\n`);
    } else {
      process.exitCode = result.value ? 0 : 1;
    }
  } catch (error) {
    if (operation === "source.poll") {
      process.stdout.write(errorEvidence(error, extensionId, operation));
      process.exitCode = 70;
      return;
    }
    throw error;
  }
}

function usage() {
  process.stderr.write(`Trusted external Firstmate extension binding host.

Usage:
  bin/fm-extension.mjs bind <package-root> --adapter <name> [--adapter <name> ...] --trust-same-user-code [--consent <fact> ...] [--timeout-ms <milliseconds>]
  bin/fm-extension.sh remote-bind <secondmate-id> <package-root> --adapter <name> --trust-same-user-code [bind options]
  bin/fm-extension.mjs retire-binding <extension-id> --if-binding-digest <sha256:digest>
  bin/fm-extension.mjs retire-transfer <extension-id> --if-transfer-digest <sha256:digest> --if-binding-digest <sha256:digest>
  bin/fm-extension.mjs list
  bin/fm-extension.mjs inspect <extension-id>
  bin/fm-extension.mjs verify [extension-id]

The manifest file is firstmate-extension.json. Supported consent facts are network, credential-store, task-metadata, and artifact-references. The host supports only process-event-adapter/1; see docs/extension-bindings.md for its manifest, binding, handshake, and invocation contracts.
`);
  process.exitCode = 2;
}

async function main() {
  if (process.env.FM_EXTENSION_RETIREMENT_MODE) {
    await runInheritedLifecycleRetirement(process.argv.slice(2));
    return;
  }
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "bind": await cmdBind(args); break;
    case "pack-transfer": await cmdPackTransfer(args); break;
    case "receive-transfer-bind": await cmdReceiveTransferBind(args); break;
    case "retire-binding": await cmdRetireBinding(args); break;
    case "retire-transfer": await cmdRetireTransfer(args); break;
    case "list": await cmdList(args); break;
    case "inspect": await cmdInspect(args); break;
    case "verify": await cmdVerify(args); break;
    case "resolve-process-event": await cmdResolveProcessEvent(args); break;
    case "process-event": await cmdProcessEvent(args); break;
    case "":
    case undefined:
    case "help":
    case "-h":
    case "--help": usage(); break;
    default: fail("usage", `unknown command: ${command}`);
  }
}

main().catch((error) => {
  const code = error instanceof HostError ? error.code : "internal";
  const message = error instanceof Error ? error.message : "unexpected extension host failure";
  process.stderr.write(`error[${code}]: ${message}\n`);
  process.exitCode = 1;
});
