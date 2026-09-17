// Firstmate primary watcher bridge for Pi.
//
// Session-generation ownership (stated once here):
// Pi emits session_shutdown for ordinary same-process replacements (/new, /resume,
// /fork, reload) as well as terminal quit. This extension binds one generation per
// session activation. Only the active live generation may start, stop, rearm, or
// clear the arm child. An owning replacement session_start (or fresh factory bind)
// arms its new generation without a model turn. A replacement handoff carries
// actionable closes that were still pending delivery; its durable state lives at
// state/extensions/pi-primary-watch/session-replacement-actionable.json.
// Terminal quit leaves the final generation stopped so late callbacks cannot rearm.
// Stale callbacks from a prior generation are no-ops against the active replacement.
//
// Main delivery (one owner): successor creation never waits for main. Ordinary
// working-only signal closes may wait in the existing pending handoff while
// main is busy and share one custom operational message at a terminal no-tool
// response or idle boundary. Decisions, unknown evidence and failures retain
// their direct path. No model setting or native user queue is changed.
// Deferred groups use Pi's supported custom-message API, not user-input
// preflight: sendUserMessage returns void and idle/pending predicates do not
// cover an asynchronous input handler. Machine delivery must not impersonate
// or bypass the meaning of human input. Native consumption only marks a group
// as observed; its exact sources retire solely on positive acknowledgement.
// bin/fm-wake-drain.sh owns the bounded acknowledgement-evidence format.
// Missing/changed evidence remains actionable. An idle native-empty boundary
// may recover an unacknowledged custom group, with the existing retry bound;
// a still-queued or actively handled group is never duplicated. Replacement
// replays pending records rather than relying on an old session's acceptance.
// Direct legacy user notifications keep their existing consumption/replay path.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerFirstmateTool } from "./lib/fm-native-contract.ts";
import {
  type BranchDispatchOffer,
  createBranchDispatchOffer,
  FM_BRANCH_DISPATCH_EVENT,
  scopeForUnreadWake,
} from "./lib/fm-branch-dispatch.ts";
import {
  type CalmPresentationState,
  calmTranscriptClassIsVisible,
  FIRSTMATE_CALM_PRESENTATION_EVENT,
} from "./lib/fm-calm-visibility.ts";
import { encodeFirstmateOperationalInput } from "./lib/fm-operational-input.ts";

type ArmResult = {
  ok: boolean;
  message: string;
};

type LockOwnership = "owned" | "missing" | "other";

type CloseClassification = {
  kind: "actionable" | "failure";
  message: string;
};

type WakeSource = {
  rows: string[];
  files: Array<{name: string; identity: string; hash: string}>;
};

type PendingActionableClose = {
  version: 1;
  token: string;
  message: string;
  predecessorArmPid: string;
  delivered?: true;
  deferred?: true;
  source?: WakeSource;
  attempts?: number;
  consumed?: true;
};

type ReplacementActionableHandoff = {
  version: 2;
  pending: PendingActionableClose[];
};

type WatchToolShellState = {
  shell?: Box;
  call?: Component;
  result?: Component;
};

type WatchToolRenderContext = {
  isError: boolean;
  isPartial: boolean;
};

type UnconsumedWake = {
  content: string;
  pending: PendingActionableClose;
};

type SessionGeneration = {
  id: number;
  stopping: boolean;
  replacement: boolean;
  child: ChildProcess | null;
  continuityReady: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  retryFailures: number;
  restoring: boolean;
  seq: number;
  pendingActionables: PendingActionableClose[];
  cleanupFailure: string;
  mainFlushing: boolean;
  mainDeliveryFailure: string;
  // Main follow-ups Pi has accepted but not yet consumed, by pending token.
  // Never cleared at shutdown: a delivery continuation that runs after the
  // replacement began reads it to tell a main-queued wake (replayed) from a
  // branch-handled one (finished).
  unconsumedWakes: Map<string, UnconsumedWake>;
  // A verified successor's failure close that arrived while the pipeline was
  // still delivering the wake it was started for; its bounded retry runs once
  // that delivery settles instead of being skipped by the single-flight guard.
  deferredClose: { message: string; predecessorArmPid: string } | null;
};

function refreshWatchToolShell(
  state: WatchToolShellState,
  theme: Theme,
  context: WatchToolRenderContext,
): Box {
  const background = context.isPartial
    ? (text: string) => theme.bg("toolPendingBg", text)
    : context.isError
      ? (text: string) => theme.bg("toolErrorBg", text)
      : (text: string) => theme.bg("toolSuccessBg", text);
  const shell = state.shell ?? new Box(1, 1, background);
  state.shell = shell;
  shell.setBgFn(background);
  shell.clear();
  if (state.call) shell.addChild(state.call);
  if (state.result) shell.addChild(state.result);
  return shell;
}

const extensionFile = fileURLToPath(import.meta.url);
const extensionDir = dirname(extensionFile);
const root = resolve(extensionDir, "../..");
const fmHome = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || root;
const fmRoot = process.env.FM_ROOT_OVERRIDE || root;
const state = process.env.FM_STATE_OVERRIDE || `${fmHome}/state`;
const config = process.env.FM_CONFIG_OVERRIDE || `${fmHome}/config`;
const armScript = `${fmRoot}/bin/fm-watch-arm.sh`;
const marker = `${state}/.pi-watch-extension-loaded`;
const handoffDir = `${state}/extensions/pi-primary-watch`;
const actionableHandoff = `${handoffDir}/session-replacement-actionable.json`;
const extensionVersion = `sha256:${createHash("sha256").update(readFileSync(extensionFile)).digest("hex")}`;
const retryBaseMs = positiveInteger("FM_WATCH_REARM_RETRY_BASE_MS", 250);
const retryMaxMs = positiveInteger("FM_WATCH_REARM_RETRY_MAX_MS", 4000);
const retryLimit = positiveInteger("FM_WATCH_REARM_RETRY_LIMIT", 5);
// 35s on Windows so the budget stays above arm's MSYS confirm default (30s in
// bin/fm-watch-arm.sh): a slow but successful Git Bash cold start must not be
// SIGTERMed mid-confirmation. Conditioned on win32 so other platforms keep 12s.
const armReadyTimeoutMs = positiveInteger(
  "FM_PI_ARM_READY_TIMEOUT_MS",
  process.platform === "win32" ? 35000 : 12000,
);
const armRetireTimeoutMs = positiveInteger("FM_WATCH_ARM_RETIRE_TIMEOUT_MS", 1000);
const deferredMessageType = "fm-watcher-pending";
const repairOnlyHint = "call fm_watch_arm_pi again only after a later notification says the cycle is missing, failed, or unhealthy";
const shuttingDownMessage = "watcher: not armed - Pi session is shutting down";

let nextGenerationId = 0;
let nextHandoffId = 0;
let activeGeneration: SessionGeneration | null = null;
let replacementHandoff: PendingActionableClose[] | null = null;
type ReplacementActionableReceiver = (pending: PendingActionableClose) => void;
type ActionableDeliveryClaim = {
  owner: SessionGeneration;
  settlement: Promise<"delivered" | "failed">;
};
type ReplacementCoordinator = {
  receiver: ReplacementActionableReceiver | null;
  pending: PendingActionableClose[];
  nextTokenId: number;
  deliveries: Map<string, ActionableDeliveryClaim>;
};
type ReplacementCoordinatorGlobal = typeof globalThis & {
  __firstmatePiWatchReplacements?: Map<string, ReplacementCoordinator>;
};
const replacementCoordinatorGlobal = globalThis as ReplacementCoordinatorGlobal;
const replacementCoordinators = replacementCoordinatorGlobal.__firstmatePiWatchReplacements ??= new Map<string, ReplacementCoordinator>();
function replacementCoordinatorFor(handoff: string): ReplacementCoordinator {
  const existing = replacementCoordinators.get(handoff);
  if (existing) return existing;
  const created: ReplacementCoordinator = {
    receiver: null,
    pending: [],
    nextTokenId: 0,
    deliveries: new Map(),
  };
  replacementCoordinators.set(handoff, created);
  return created;
}
const replacementCoordinator = replacementCoordinatorFor(actionableHandoff);
const armReadiness = new WeakMap<ChildProcess, Promise<boolean>>();
const armClose = new WeakMap<ChildProcess, Promise<void>>();
// Children the extension itself asked to exit; their close is not a failure
// of the successor and never earns a deferred retry.
const armRetired = new WeakSet<ChildProcess>();
const armRecovery = new WeakMap<ChildProcess, { generation: string; watcherPid: string }>();
const armPendingActionable = new WeakMap<ChildProcess, PendingActionableClose>();

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parentPid(pid: string): string {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function pidAlive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function lockOwnership(): LockOwnership {
  let lockPid = "";
  try {
    lockPid = readFileSync(`${state}/.lock`, "utf8").trim();
  } catch {
    return "missing";
  }
  if (!/^[0-9]+$/.test(lockPid) || lockPid === "1") return "other";
  let pid = String(process.pid);
  for (let i = 0; i < 8; i += 1) {
    if (pid === lockPid) return "owned";
    pid = parentPid(pid);
    if (!pid || pid === "1") break;
  }
  return pidAlive(lockPid) ? "other" : "missing";
}

function markLoaded(): void {
  if (lockOwnership() === "other") return;
  mkdirSync(state, { recursive: true });
  writeFileSync(marker, `${extensionVersion}\n${process.pid}\n`);
}

function actionableLine(output: string): string {
  const lines = output.split(/\r?\n/);
  return lines.find((line) => /^(signal:|stale:|check:|heartbeat($|:))/.test(line)) || "";
}

function completedActionableLine(output: string): string {
  const newline = output.lastIndexOf("\n");
  return newline < 0 ? "" : actionableLine(output.slice(0, newline + 1));
}

// The text Pi carries in a user message_start: sendUserMessage wraps a string
// as one text part, so the joined text parts equal the sent content.
function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" && part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function nodeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function readStateEvidence(name: string): {text: string; identity: string; hash: string} {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid source filename");
  const path = `${state}/${name}`;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("unsafe or oversized source");
    const version = (value: typeof stat) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    const text = readFileSync(fd, "utf8");
    if (version(stat) !== version(fstatSync(fd)) || version(stat) !== version(lstatSync(path))) throw new Error("source changed during read");
    return {text, identity: version(stat), hash: createHash("sha256").update(text).digest("hex")};
  } finally { closeSync(fd); }
}

function captureWakeSource(message: string): WakeSource | undefined {
  if (!/^signal:/.test(message)) return;
  try {
    const keys = message.slice(7).trim().split(/\s+/).map(path => path.split("/").pop()!);
    if (keys.length === 0 || keys.length > 16 || keys.some(key => !/^[A-Za-z0-9._-]+\.status$/.test(key))) return;
    const queue = readStateEvidence(".wake-queue");
    const rows = queue.text.split("\n").filter(Boolean).filter(line => {
      const fields = line.split("\t");
      return fields.length === 5 && /^[0-9]+$/.test(fields[0]) && /^[1-9][0-9]*$/.test(fields[1]) && fields[2] === "signal" && keys.includes(fields[3]);
    });
    if (rows.length > 128 || rows.join("\n").length > 16 * 1024 || keys.some(key => !rows.some(row => row.split("\t")[3] === key))) return;
    const files = [...new Set(keys.flatMap(key => [key, key.replace(/\.status$/, ".meta")]))].map(name => {
      const evidence = readStateEvidence(name);
      return {name, identity: evidence.identity, hash: evidence.hash};
    });
    if (readStateEvidence(".wake-queue").identity !== queue.identity) return;
    return {rows, files};
  } catch { return; }
}

function sourceAcknowledged(pending: PendingActionableClose): boolean {
  if (!pending.source) return false;
  try {
    const queue = new Set(readStateEvidence(".wake-queue").text.split("\n"));
    const receipt = readStateEvidence(".wake-acknowledged").text.split("\n");
    if (receipt.shift() !== "firstmate-wake-acknowledged: v1") return false;
    const acknowledged = new Set(receipt);
    let unchanged: boolean | undefined;
    const sourceUnchanged = (): boolean => {
      if (unchanged !== undefined) return unchanged;
      try {
        unchanged = pending.source!.files.every(file => {
          const current = readStateEvidence(file.name);
          return current.identity === file.identity && current.hash === file.hash;
        });
      } catch { unchanged = false; }
      return unchanged;
    };
    if (!pending.source.rows.every(row => {
      if (queue.has(row)) return false;
      if (acknowledged.has(row)) return true;
      if (!sourceUnchanged()) return false;
      const original = row.split("\t");
      // A later real acknowledgement can cover an identical repeated source
      // after bounded receipt eviction. Key/text similarity alone cannot:
      // every captured status/meta identity and byte hash must still match.
      return receipt.some(later => {
        const fields = later.split("\t");
        return fields.length === 5 && /^[0-9]+$/.test(fields[0]) && /^[1-9][0-9]*$/.test(fields[1]) &&
          fields.slice(2).join("\t") === original.slice(2).join("\t") &&
          BigInt(fields[0]) >= BigInt(original[0]) && BigInt(fields[1]) > BigInt(original[1]);
      });
    })) return false;
    // Changed evidence still needs a notification. Once that notification has
    // actually reached main, these older exact rows can retire on their own
    // acknowledgement without deleting or claiming any newer source row.
    return pending.consumed === true || sourceUnchanged();
  } catch { return false; }
}

function createPendingActionable(message: string, predecessorArmPid: string): PendingActionableClose {
  return {
    version: 1,
    token: `${process.pid}-${Date.now()}-${++replacementCoordinator.nextTokenId}`,
    message,
    predecessorArmPid,
    source: captureWakeSource(message),
  };
}

function validWakeSource(value: unknown): value is WakeSource {
  if (typeof value !== "object" || value === null) return false;
  const source = value as WakeSource;
  if (!Array.isArray(source.rows) || source.rows.length === 0 || source.rows.length > 128 || !Array.isArray(source.files) || source.files.length > 32) return false;
  const names = new Set<string>();
  for (const row of source.rows) {
    if (typeof row !== "string" || row.includes("\n") || row.includes("\r")) return false;
    const fields = row.split("\t");
    if (fields.length !== 5 || !/^[0-9]+$/.test(fields[0]) || !/^[1-9][0-9]*$/.test(fields[1]) || fields[2] !== "signal" || !/^[A-Za-z0-9._-]+\.status$/.test(fields[3])) return false;
    names.add(fields[3]);
    names.add(fields[3].replace(/\.status$/, ".meta"));
  }
  if (source.rows.join("\n").length > 16 * 1024 || names.size !== source.files.length || new Set(source.files.map(file => file?.name)).size !== names.size) return false;
  return source.files.every(file => file && names.has(file.name) && typeof file.identity === "string" && /^[0-9]+:[0-9]+:[0-9]+:[0-9.]+:[0-9.]+$/.test(file.identity) && typeof file.hash === "string" && /^[0-9a-f]{64}$/.test(file.hash));
}

function validatePendingActionable(value: unknown): PendingActionableClose {
  if (
    typeof value !== "object" || value === null ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { token?: unknown }).token !== "string" ||
    !/^[0-9]+-[0-9]+-[0-9]+$/.test((value as { token: string }).token) ||
    typeof (value as { message?: unknown }).message !== "string" ||
    !actionableLine((value as { message: string }).message) ||
    typeof (value as { predecessorArmPid?: unknown }).predecessorArmPid !== "string" ||
    !/^[0-9]*$/.test((value as { predecessorArmPid: string }).predecessorArmPid) ||
    ((value as { delivered?: unknown }).delivered !== undefined &&
      (value as { delivered?: unknown }).delivered !== true) ||
    ((value as { deferred?: unknown }).deferred !== undefined &&
      (value as { deferred?: unknown }).deferred !== true)
  ) {
    throw new Error(`invalid Pi replacement actionable handoff at ${actionableHandoff}`);
  }
  const pending = value as PendingActionableClose;
  if ((pending.source !== undefined && !validWakeSource(pending.source)) ||
      (pending.deferred && !pending.source) ||
      (pending.consumed !== undefined && (pending.consumed !== true || !pending.deferred)) ||
      (pending.attempts !== undefined && (!pending.deferred || !Number.isSafeInteger(pending.attempts) || pending.attempts < 0))) {
    throw new Error(`invalid Pi pending source evidence at ${actionableHandoff}`);
  }
  return pending;
}

function validateReplacementHandoff(value: unknown): PendingActionableClose[] {
  if (
    typeof value !== "object" || value === null ||
    (value as { version?: unknown }).version !== 2 ||
    !Array.isArray((value as { pending?: unknown }).pending) ||
    (value as { pending: unknown[] }).pending.length === 0
  ) {
    throw new Error(`invalid Pi replacement actionable handoff at ${actionableHandoff}`);
  }
  const pending = (value as { pending: unknown[] }).pending.map(validatePendingActionable);
  if (new Set(pending.map((item) => item.token)).size !== pending.length) {
    throw new Error(`invalid Pi replacement actionable handoff at ${actionableHandoff}`);
  }
  return pending;
}

function writeReplacementHandoff(pending: PendingActionableClose[]): void {
  replacementHandoff = [...pending];
  mkdirSync(handoffDir, { recursive: true });
  const temporary = `${actionableHandoff}.tmp-${process.pid}-${++nextHandoffId}`;
  const handoff: ReplacementActionableHandoff = { version: 2, pending };
  try {
    writeFileSync(temporary, `${JSON.stringify(handoff)}\n`, { mode: 0o600 });
    renameSync(temporary, actionableHandoff);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original handoff publication error.
    }
    throw error;
  }
}

function persistReplacementHandoff(pending: PendingActionableClose[]): void {
  if (pending.length === 0) return;
  writeReplacementHandoff(pending);
}

function loadReplacementHandoff(): PendingActionableClose[] {
  try {
    const pending = validateReplacementHandoff(JSON.parse(readFileSync(actionableHandoff, "utf8")));
    replacementHandoff = pending;
    return [...pending];
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      replacementHandoff = null;
      return [];
    }
    throw error;
  }
}

function mergeReplacementHandoff(pending: PendingActionableClose): void {
  let stored: PendingActionableClose[] = [];
  try {
    stored = validateReplacementHandoff(JSON.parse(readFileSync(actionableHandoff, "utf8")));
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  if (!stored.some((item) => item.token === pending.token)) stored.push(pending);
  writeReplacementHandoff(stored);
}

function clearReplacementHandoff(pending: PendingActionableClose): void {
  try {
    const stored = validateReplacementHandoff(JSON.parse(readFileSync(actionableHandoff, "utf8")));
    const remaining = stored.filter((item) => item.token !== pending.token);
    if (remaining.length === stored.length) return;
    if (remaining.length > 0) {
      writeReplacementHandoff(remaining);
    } else {
      replacementHandoff = null;
      unlinkSync(actionableHandoff);
    }
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

function classifyClose(stdout: string, stderr: string, code: number | null, signal: NodeJS.Signals | null): CloseClassification {
  const combined = `${stdout}\n${stderr}`.trim();
  const reason = actionableLine(combined);
  if (reason) return { kind: "actionable", message: reason };
  const healthy = combined.split(/\r?\n/).find((line) => /^watcher: healthy\b/.test(line));
  if (healthy) {
    return {
      kind: "failure",
      message: `watcher: FAILED - Pi extension arm child found an external healthy watcher instead of owning wake delivery\n${healthy}`,
    };
  }
  const failed = combined.split(/\r?\n/).find((line) => /^watcher: FAILED/.test(line));
  if (failed) return { kind: "failure", message: failed };
  if (signal) {
    return {
      kind: "failure",
      message: `watcher: FAILED - Pi extension arm child ended from ${signal}${combined ? `\n${combined}` : ""}`,
    };
  }
  if (code && code !== 0) {
    return {
      kind: "failure",
      message: `watcher: FAILED - fm-watch-arm.sh exited ${code}${combined ? `\n${combined}` : ""}`,
    };
  }
  return {
    kind: "failure",
    message: "watcher: FAILED - Pi extension arm cycle ended without an actionable reason",
  };
}

function createGeneration(): SessionGeneration {
  return {
    id: ++nextGenerationId,
    stopping: false,
    replacement: false,
    child: null,
    continuityReady: false,
    retryTimer: null,
    cleanupTimer: null,
    retryFailures: 0,
    restoring: false,
    seq: 0,
    pendingActionables: [],
    cleanupFailure: "",
    mainFlushing: false,
    mainDeliveryFailure: "",
    unconsumedWakes: new Map(),
    deferredClose: null,
  };
}

function activateGeneration(generation: SessionGeneration): void {
  activeGeneration = generation;
}

function generationIsLive(generation: SessionGeneration): boolean {
  return activeGeneration === generation && !generation.stopping;
}

function stopGeneration(generation: SessionGeneration): ChildProcess | null {
  generation.stopping = true;
  if (generation.retryTimer) clearTimeout(generation.retryTimer);
  if (generation.cleanupTimer) clearTimeout(generation.cleanupTimer);
  generation.retryTimer = null;
  generation.cleanupTimer = null;
  const child = generation.child;
  if (child) child.kill("SIGTERM");
  generation.child = null;
  return child;
}

async function waitForGenerationChildClose(armChild: ChildProcess | null): Promise<void> {
  if (!armChild) return;
  const closed = armClose.get(armChild);
  if (!closed) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, armRetireTimeoutMs);
    void closed.then(() => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

async function stopSessionGeneration(generation: SessionGeneration, replacement: boolean): Promise<void> {
  generation.replacement = replacement;
  let persistedTokens = "";
  try {
    if (replacement && lockOwnership() === "owned" && generation.pendingActionables.length > 0) {
      persistReplacementHandoff(generation.pendingActionables);
      persistedTokens = generation.pendingActionables.map((pending) => pending.token).join("\n");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const pending of generation.pendingActionables) {
      if (replacementCoordinator.pending.some((item) => item.token === pending.token)) continue;
      replacementCoordinator.pending.push({
        ...pending,
        message: `${pending.message}\n\nwatcher: FAILED - Pi extension could not persist a replacement-session actionable wake\n${detail}`,
      });
    }
    throw error;
  } finally {
    const child = stopGeneration(generation);
    await waitForGenerationChildClose(child);
  }
  const currentTokens = generation.pendingActionables.map((pending) => pending.token).join("\n");
  if (replacement && lockOwnership() === "owned" && currentTokens && currentTokens !== persistedTokens) {
    persistReplacementHandoff(generation.pendingActionables);
  }
}

const cleanupOnProcessExit = () => {
  if (activeGeneration) stopGeneration(activeGeneration);
};
process.once("exit", cleanupOnProcessExit);

export default function (pi: ExtensionAPI) {
  let generation = createGeneration();
  activateGeneration(generation);
  let mainContext: ExtensionContext | undefined;
  let settledMainTurns = 0;

  // Deliberately narrow structural eligibility, not semantic novelty: every
  // source line must declare ordinary working activity. Any other verb/history,
  // decision, check or uncertain source keeps the established direct path.
  function canDeferOrdinarySignal(pending: PendingActionableClose, message: string): boolean {
    if (!pending.source || !/^signal:/.test(message) || message.includes("watcher: FAILED")) return false;
    const scope = scopeForUnreadWake(state, false);
    if (scope.corrupted || scope.needsDecisionKeys.length > 0) return false;
    try {
      if (!pending.source.files.every(file => {
        const current = readStateEvidence(file.name);
        return current.identity === file.identity && current.hash === file.hash;
      })) return false;
      const keys = message.slice(7).trim().split(/\s+/).map(path => path.split("/").pop()!);
      // The exact producer snapshot survives an acknowledgement during branch
      // fallback. Requiring its rows to remain queued would miss that race.
      const rows = pending.source.rows.map(line => line.split("\t"));
      return keys.length > 0 && keys.every(key => {
        if (!/^[A-Za-z0-9._-]+\.status$/.test(key)) return false;
        const matching = rows.filter(row => row[2] === "signal" && row[3] === key);
        if (matching.length === 0 || matching.some(row => row.length !== 5 || !/^working:/.test(row[4]))) return false;
        const history = readStateEvidence(key).text.trim().split("\n");
        return history.length > 0 && history.every(line => /^working:/.test(line));
      });
    } catch { return false; }
  }

  function reconcileMainSources(owner: SessionGeneration): void {
    if (!generationIsLive(owner) || lockOwnership() !== "owned") return;
    for (const pending of [...owner.pendingActionables]) {
      if (!pending.deferred || !sourceAcknowledged(pending)) continue;
      owner.unconsumedWakes.delete(pending.token);
      pending.delivered = true;
      try {
        finishPendingActionable(owner, pending);
      } catch (error) {
        surfaceCleanupFailure(owner, error);
        schedulePendingCleanup(owner);
      }
    }
    if (!owner.pendingActionables.some(item => item.deferred)) owner.mainDeliveryFailure = "";
  }

  function mainDeliveryFailure(owner: SessionGeneration, message: string): void {
    if (owner.mainDeliveryFailure === message) return;
    owner.mainDeliveryFailure = message;
    surfaceFailure(owner, message);
  }

  async function flushMain(owner: SessionGeneration, finalTurn = false, lateMainOwnedToken?: string): Promise<void> {
    if (!generationIsLive(owner) || owner.restoring || owner.mainFlushing) return;
    if (lockOwnership() !== "owned") {
      if (owner.pendingActionables.some(item => item.deferred)) mainDeliveryFailure(owner, "watcher: FAILED - deferred delivery lost session ownership; its source records remain pending");
      return;
    }
    reconcileMainSources(owner);
    if (!owner.pendingActionables.some(item => item.deferred && !item.delivered) || !owner.continuityReady) return;
    if (typeof mainContext?.isIdle !== "function" || typeof mainContext.hasPendingMessages !== "function" || typeof pi.sendMessage !== "function") {
      mainDeliveryFailure(owner, "watcher: FAILED - Pi lacks the required custom-delivery observations; pending source records are retained");
      return;
    }
    const idle = mainContext.isIdle() && !mainContext.hasPendingMessages();
    if (!idle && !finalTurn && !lateMainOwnedToken) return;
    // Only idle AND an empty native pending set proves that a previously
    // accepted but unconsumed group cannot still be queued. Never infer this
    // from sendUserMessage resolving or from an input hook running.
    if (idle) {
      for (const [token, wake] of owner.unconsumedWakes) {
        if (wake.pending.deferred) owner.unconsumedWakes.delete(token);
      }
    }
    const candidates = owner.pendingActionables.filter(item =>
      item.deferred &&
      !item.delivered &&
      !owner.unconsumedWakes.has(item.token) &&
      (idle || finalTurn || (item.token === lateMainOwnedToken && !(item.attempts ?? 0))),
    );
    const pending = candidates.filter(item => (item.attempts ?? 0) < retryLimit);
    if (candidates.some(item => (item.attempts ?? 0) >= retryLimit)) {
      mainDeliveryFailure(owner, `watcher: FAILED - no positive source acknowledgement after ${retryLimit} delivery attempts; pending notification records are retained for recovery`);
    }
    if (pending.length === 0) return;
    owner.mainFlushing = true;
    // A corrupt/missing/changed source is still actionable, never silent.
    const source = scopeForUnreadWake(state, false);
    const content = encodeFirstmateOperationalInput("watcher", `FIRSTMATE WATCHER WAKE: ${[...new Set(pending.map(item => item.message))].join("\n")}\n\nRun bin/fm-wake-drain.sh first and handle the queued wake. Watcher continuity is extension-owned.${source.corrupted ? " Source revalidation was uncertain; preserve and reconcile every pending obligation." : ""}`);
    for (const item of pending) {
      item.attempts = (item.attempts ?? 0) + 1;
      delete item.consumed;
      owner.unconsumedWakes.set(item.token, {content, pending: item});
    }
    try {
      persistReplacementHandoff(owner.pendingActionables);
      pi.sendMessage({customType: deferredMessageType, content, display: false}, {deliverAs: "followUp", triggerTurn: true});
    } catch (error) {
      for (const item of pending) owner.unconsumedWakes.delete(item.token);
      mainDeliveryFailure(owner, `watcher: FAILED - deferred delivery failed; pending source records retained: ${String(error)}`);
    } finally {
      owner.mainFlushing = false;
      if (generationIsLive(owner)) {
        reconcileMainSources(owner);
        // A synchronous rejected custom send may leave no new lifecycle event.
        // Retry only native-idle/native-empty custom delivery, within the bound;
        // never apply this inference to the opaque user-input preflight path.
        if (mainContext?.isIdle() && !mainContext.hasPendingMessages() && pending.some(item => owner.pendingActionables.includes(item) && (item.attempts ?? 0) < retryLimit)) {
          void flushMain(owner);
        }
      }
    }
  }

  let calmPresentation: CalmPresentationState = {
    active: false,
    stockExportRendering: false,
  };
  pi.events?.on?.(FIRSTMATE_CALM_PRESENTATION_EVENT, (data) => {
    const next = data as Partial<CalmPresentationState>;
    calmPresentation = {
      active: next.active === true,
      stockExportRendering: next.stockExportRendering === true,
    };
  });
  const calmHides = (itemClass: Parameters<typeof calmTranscriptClassIsVisible>[0]): boolean =>
    calmPresentation.active &&
    !calmPresentation.stockExportRendering &&
    !calmTranscriptClassIsVisible(itemClass);

  async function sendWake(
    owner: SessionGeneration,
    message: string,
    pending?: PendingActionableClose,
  ): Promise<boolean> {
    if (!generationIsLive(owner)) return false;
    const content = encodeFirstmateOperationalInput(
      "watcher",
      `FIRSTMATE WATCHER WAKE: ${message}\n\nRun bin/fm-wake-drain.sh first and handle the queued wake. Watcher continuity is extension-owned.`,
    );
    if (pending) owner.unconsumedWakes.set(pending.token, { content, pending });
    try {
      await pi.sendUserMessage(content, { deliverAs: "followUp" });
    } catch (error) {
      if (pending) owner.unconsumedWakes.delete(pending.token);
      throw error;
    }
    // Accepted by Pi. A generation replaced while Pi was accepting it may
    // have lost the follow-up with the old session, so report it undelivered
    // and let the replacement replay the still-pending record.
    return generationIsLive(owner);
  }

  // Pi consumed a main follow-up: an idle main at before_agent_start, a
  // streaming main at the user message_start that joins the running run.
  function consumeWake(owner: SessionGeneration, text: string, custom = false): void {
    if (!generationIsLive(owner) || lockOwnership() !== "owned") return;
    for (const [token, wake] of owner.unconsumedWakes) {
      if (wake.content !== text || (wake.pending.deferred && !custom)) continue;
      owner.unconsumedWakes.delete(token);
      if (wake.pending.deferred) {
        wake.pending.consumed = true;
        try {
          persistReplacementHandoff(owner.pendingActionables);
        } catch (error) {
          mainDeliveryFailure(owner, `watcher: FAILED - could not persist pending source handling: ${String(error)}`);
        }
        continue;
      }
      wake.pending.delivered = true;
      try {
        finishPendingActionable(owner, wake.pending);
      } catch (error) {
        surfaceCleanupFailure(owner, error);
        schedulePendingCleanup(owner);
      }
    }
  }

  function confirmHandlingDelivery(recovery: { generation: string; watcherPid: string }): {
    ok: boolean;
    detail: string;
  } {
    try {
      const result = spawnSync(
        "bash",
        [armScript, "--handling-delivered", recovery.generation, "--watcher-pid", recovery.watcherPid],
        {
          cwd: fmRoot,
          encoding: "utf8",
          env: { ...process.env, FM_HOME: fmHome, FM_STATE_OVERRIDE: state, FM_ROOT_OVERRIDE: fmRoot },
        },
      );
      if (result.status === 0) return { ok: true, detail: "" };
      const stderr = (result.stderr || "").trim();
      return {
        ok: false,
        detail: `watcher: FAILED - handling delivery confirmation was rejected (status=${result.status ?? "none"} generation=${recovery.generation} watcherPid=${recovery.watcherPid})${stderr ? `\n${stderr}` : ""}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        detail: `watcher: FAILED - handling delivery confirmation could not be executed (generation=${recovery.generation} watcherPid=${recovery.watcherPid})\n${message}`,
      };
    }
  }

  function confirmHandlingDeliveryWithRetry(
    owner: SessionGeneration,
    recovery: { generation: string; watcherPid: string },
  ): { ok: boolean; detail: string } {
    const snapshot = (): { generation: string; watcherPid: string } => {
      const current = owner.child ? armRecovery.get(owner.child) : undefined;
      return current ?? recovery;
    };
    const first = confirmHandlingDelivery(snapshot());
    if (first.ok) return first;
    return confirmHandlingDelivery(snapshot());
  }

  function offerWakeToBranch(message: string): BranchDispatchOffer | null {
    const heartbeat = /^heartbeat($|:)/.test(message);
    // A check-kind close (merge-confirmation polls, Relay mentions,
    // credential/auth failures, and every other legitimately main-only
    // class - docs/pi-supervision-branch.md) is never routed to the branch
    // even when other currently-unread rows are individually eligible: this
    // watcher cycle's own triggering event stays on main, exactly as before
    // scopeForUnreadWake stopped letting a co-present check row veto the
    // whole scan. That relaxation is what lets an UNRELATED eligible
    // signal/stale row still reach the branch on this cycle; it must never
    // also let a check-kind trigger itself slip past main's delivery.
    const isCheckTrigger = /^check:/.test(message);
    const scope = scopeForUnreadWake(state, heartbeat);
    // A signal close containing a needs-decision status file, or a stale close
    // for a captain-held task, gets the identical main-only treatment as a
    // check-kind trigger. The cross-reference deliberately includes every
    // unread decision row: until that row is read, a later signal or stale
    // trigger for the same task stays on main. Other tasks and heartbeat
    // handling remain independent.
    const triggerKeys = /^signal:/.test(message)
      ? message
        .slice("signal:".length)
        .split(/\s+/)
        .filter(Boolean)
        .map((path) => path.split("/").pop() ?? path)
      : /^stale:/.test(message)
        ? [message.slice("stale:".length).trim().split(/\s+/, 1)[0]].filter(Boolean)
        : [];
    const taskIdentity = (key: string): string =>
      scope.taskByWakeKey[key] ?? scope.taskByWakeKey[key.replace(/^fm-/, "")] ?? key;
    const needsDecisionTasks = new Set(scope.needsDecisionKeys.map(taskIdentity));
    const isNeedsDecisionTrigger = triggerKeys.some((key) => needsDecisionTasks.has(taskIdentity(key)));
    const eligible = !isCheckTrigger && !isNeedsDecisionTrigger && scope.eligible;
    const offer = createBranchDispatchOffer(message, scope.projects, heartbeat, eligible);
    pi.events?.emit?.(FM_BRANCH_DISPATCH_EVENT, offer);
    return offer.accepted ? offer : null;
  }

  async function deliverActionableWake(
    owner: SessionGeneration,
    message: string,
    repairFailed: boolean,
    pending: PendingActionableClose,
    recovery?: { generation: string; watcherPid: string },
  ): Promise<boolean | "deferred"> {
    if (!generationIsLive(owner)) return false;
    if (recovery) {
      const confirmed = confirmHandlingDeliveryWithRetry(owner, recovery);
      if (!confirmed.ok) {
        const watcherPid = recovery.watcherPid;
        if (!pidAlive(watcherPid)) {
          await retireArm(owner.child);
        }
        return await sendWake(owner, `${message}\n\n${confirmed.detail}`, pending);
      }
    }
    let lateMainOwned = false;
    if (!repairFailed) {
      const settledBeforeOffer = settledMainTurns;
      const branchDelivery = offerWakeToBranch(message);
      if (branchDelivery) {
        try {
          await branchDelivery.settlement;
          return true;
        } catch {
          if (!branchDelivery.mainOwned) {
            return await sendWake(owner, `${message}\n\nSupervision branch delivery failed; handle this notification on main and preserve its source rows.`, pending);
          }
          lateMainOwned = settledMainTurns > settledBeforeOffer;
        }
      }
    }
    if (!generationIsLive(owner)) return false;
    if (!repairFailed && lockOwnership() === "owned" && pending.source && typeof mainContext?.isIdle === "function" && typeof mainContext.hasPendingMessages === "function" && typeof pi.sendMessage === "function" && canDeferOrdinarySignal(pending, message)) {
      pending.deferred = true;
      persistReplacementHandoff(owner.pendingActionables);
      if (lateMainOwned) await flushMain(owner, false, pending.token);
      return "deferred";
    }
    return await sendWake(owner, message, pending);
  }

  function surfaceFailure(owner: SessionGeneration, message: string): void {
    void sendWake(owner, message).catch(() => {
      // Pi owns delivery errors; continuity restoration never waits on prompting.
    });
  }

  function enqueuePendingActionable(
    owner: SessionGeneration,
    pending: PendingActionableClose,
  ): void {
    if (owner.pendingActionables.some((item) => item.token === pending.token)) return;
    owner.pendingActionables.push(pending);
    if (owner.stopping && owner.replacement && lockOwnership() === "owned") {
      let replacementPending = pending;
      try {
        mergeReplacementHandoff(pending);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replacementPending = {
          ...pending,
          message: `${pending.message}\n\nwatcher: FAILED - Pi extension could not persist a late replacement-session actionable wake\n${detail}`,
        };
      }
      if (replacementCoordinator.receiver) {
        replacementCoordinator.receiver(replacementPending);
      } else if (replacementPending !== pending) {
        replacementCoordinator.pending.push(replacementPending);
      }
    }
  }

  function finishPendingActionable(owner: SessionGeneration, pending: PendingActionableClose): void {
    clearReplacementHandoff(pending);
    const index = owner.pendingActionables.findIndex((item) => item.token === pending.token);
    if (index >= 0) owner.pendingActionables.splice(index, 1);
    owner.cleanupFailure = "";
  }

  function surfaceCleanupFailure(
    owner: SessionGeneration,
    error: unknown,
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    if (owner.cleanupFailure === detail) return;
    owner.cleanupFailure = detail;
    surfaceFailure(owner, `watcher: FAILED - Pi extension could not clear a delivered replacement-session actionable wake\n${detail}`);
  }

  function schedulePendingCleanup(owner: SessionGeneration): void {
    if (!generationIsLive(owner) || owner.cleanupTimer) return;
    const timer = setTimeout(() => {
      if (owner.cleanupTimer === timer) owner.cleanupTimer = null;
      void processPendingActionables(owner);
    }, retryDelay(1));
    timer.unref();
    owner.cleanupTimer = timer;
  }

  async function processPendingActionables(owner: SessionGeneration): Promise<void> {
    if (!generationIsLive(owner) || owner.restoring || owner.pendingActionables.length === 0) return;
    owner.restoring = true;
    const attemptedCleanup = new Set<string>();
    try {
      // A recovered deferred group still owes successor verification. Skipping
      // its old delivery loop must not let it prompt before the new arm is ready.
      if (!owner.continuityReady && owner.pendingActionables.some(item => item.deferred && !item.delivered) && owner.pendingActionables.every(item => item.deferred || item.delivered)) {
        const restoration = await restoreAfterActionableClose(owner, owner.pendingActionables[0].predecessorArmPid);
        if (!generationIsLive(owner)) return;
        if (restoration.failure) {
          mainDeliveryFailure(owner, restoration.failure);
          return;
        }
      }
      while (generationIsLive(owner) && owner.pendingActionables.length > 0) {
        for (const delivered of owner.pendingActionables.filter((item) => item.delivered && !attemptedCleanup.has(item.token))) {
          attemptedCleanup.add(delivered.token);
          try {
            finishPendingActionable(owner, delivered);
          } catch (error) {
            surfaceCleanupFailure(owner, error);
          }
        }
        // A record Pi has accepted but not consumed is neither redelivered
        // nor finished here: consumption finishes it, replacement replays it.
        const pending = owner.pendingActionables.find(
          (item) => !item.delivered && !item.deferred && !owner.unconsumedWakes.has(item.token) && replacementCoordinator.deliveries.get(item.token)?.owner !== owner,
        );
        if (!pending) break;
        const existingClaim = replacementCoordinator.deliveries.get(pending.token);
        if (existingClaim && existingClaim.owner !== owner) {
          const settlement = await existingClaim.settlement;
          if (!generationIsLive(owner)) return;
          if (settlement === "delivered") {
            pending.delivered = true;
            continue;
          }
          if (replacementCoordinator.deliveries.get(pending.token) === existingClaim) {
            replacementCoordinator.deliveries.delete(pending.token);
          }
        }
        let settleClaim: (settlement: "delivered" | "failed") => void = () => {};
        const settlement = new Promise<"delivered" | "failed">((resolveSettlement) => {
          settleClaim = resolveSettlement;
        });
        const deliveryClaim = { owner, settlement };
        replacementCoordinator.deliveries.set(pending.token, deliveryClaim);
        const releaseClaim = (): void => {
          if (replacementCoordinator.deliveries.get(pending.token) === deliveryClaim) {
            replacementCoordinator.deliveries.delete(pending.token);
          }
        };
        try {
          // A new restoration supersedes whatever became of the previous
          // successor; only a failure during this delivery is retried after it.
          owner.deferredClose = null;
          const restoration = await restoreAfterActionableClose(owner, pending.predecessorArmPid);
          if (!generationIsLive(owner)) {
            settleClaim("failed");
            releaseClaim();
            return;
          }
          // An accepted branch turn or native submission must not hold up
          // the next close's successor. The exact delivery claim prevents
          // duplicate dispatch while restoration progresses independently.
          void (async () => {
            let completed = false;
            try {
              const message = restoration.failure ? `${pending.message}\n\n${restoration.failure}` : pending.message;
              const delivered = await deliverActionableWake(owner, message, Boolean(restoration.failure), pending, restoration.recovery);
              if (!delivered || delivered === "deferred") {
                settleClaim("failed");
                completed = delivered === "deferred";
                return;
              }
              const awaitingConsumption = owner.unconsumedWakes.has(pending.token);
              if (awaitingConsumption && !generationIsLive(owner)) {
                // Replacement replays native-accepted but unconsumed records.
                settleClaim("failed");
                return;
              }
              settleClaim("delivered");
              if (!awaitingConsumption) {
                pending.delivered = true;
                try { finishPendingActionable(owner, pending); }
                catch (error) { surfaceCleanupFailure(owner, error); }
              }
              completed = true;
            } catch (error) {
              settleClaim("failed");
              surfaceFailure(owner, `watcher: FAILED - Pi extension could not deliver an actionable wake\n${String(error)}`);
            } finally {
              releaseClaim();
              // Do not turn a rejected delivery into a new retry policy.
              if (completed && generationIsLive(owner)) void processPendingActionables(owner);
            }
          })();
        } catch (error) {
          settleClaim("failed");
          releaseClaim();
          throw error;
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      surfaceFailure(owner, `watcher: FAILED - Pi extension could not deliver an actionable wake\n${detail}`);
    } finally {
      if (generationIsLive(owner)) {
        owner.restoring = false;
        if (owner.pendingActionables.some((pending) => pending.delivered)) schedulePendingCleanup(owner);
        // No bare arm is launched here. A generation without a child at this
        // point has either delivered a typed restoration failure after its
        // bounded retries, which hands repair to main through fm_watch_arm_pi
        // (one more silent launch past the bound could hold a hung child that
        // the repair call would then report as "unchanged"), or lost a
        // verified successor during the delivery, which takes the ordinary
        // bounded, lock-checked retry it would have taken had the pipeline
        // been idle.
        const deferred = owner.deferredClose;
        owner.deferredClose = null;
        if (deferred && !owner.child && !owner.retryTimer) {
          scheduleRetry(owner, deferred.message, deferred.predecessorArmPid);
        }
        void flushMain(owner);
      }
    }
  }

  const receiveReplacementActionable: ReplacementActionableReceiver = (pending) => {
    if (!generationIsLive(generation)) return;
    enqueuePendingActionable(generation, pending);
    void processPendingActionables(generation);
  };

  function retryDelay(attempt: number): number {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempt - 1));
  }

  function waitForRetry(attempt: number): Promise<void> {
    return new Promise((resolveRetry) => {
      const timer = setTimeout(resolveRetry, retryDelay(attempt));
      timer.unref();
    });
  }

  function waitForReadiness(armChild: ChildProcess): Promise<boolean> {
    const readiness = armReadiness.get(armChild);
    if (!readiness) return Promise.resolve(false);
    return new Promise((resolveReady) => {
      const timer = setTimeout(() => resolveReady(false), armReadyTimeoutMs);
      timer.unref();
      void readiness.then((ready) => {
        clearTimeout(timer);
        resolveReady(ready);
      });
    });
  }

  async function retireArm(armChild: ChildProcess | null): Promise<boolean> {
    if (!armChild) return true;
    armRetired.add(armChild);
    armChild.kill("SIGTERM");
    const closed = armClose.get(armChild);
    if (!closed) return false;
    return new Promise((resolveRetired) => {
      const timer = setTimeout(() => resolveRetired(false), armRetireTimeoutMs);
      timer.unref();
      void closed.then(() => {
        clearTimeout(timer);
        resolveRetired(true);
      });
    });
  }

  async function restoreAfterActionableClose(owner: SessionGeneration, predecessorArmPid: string): Promise<{
    failure: string;
    recovery?: { generation: string; watcherPid: string };
  }> {
    let failure = "";
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      if (!generationIsLive(owner)) return { failure: "" };
      const replacement = startArm(owner, predecessorArmPid);
      const successorChild = owner.child;
      if (replacement.ok && successorChild && await waitForReadiness(successorChild)) {
        return { failure: "", recovery: armRecovery.get(successorChild) };
      }
      if (replacement.ok) {
        failure = "watcher: FAILED - Pi extension could not verify a ready successor watcher";
        if (!(await retireArm(successorChild))) {
          return {
            failure: `${failure}\nwatcher: FAILED - Pi extension could not restore watcher continuity because the unready successor arm did not exit within ${armRetireTimeoutMs}ms`,
          };
        }
      } else {
        failure = /(?:read-only|no live session)/.test(replacement.message)
          ? `watcher: FAILED - Pi extension cannot restore continuity because this session no longer owns the lock\n${replacement.message}`
          : `watcher: FAILED - Pi extension could not start the successor watcher cycle\n${replacement.message}`;
        if (/(?:read-only|no live session)/.test(replacement.message)) break;
      }
      if (attempt === retryLimit) break;
      await waitForRetry(attempt + 1);
    }
    return { failure: `${failure}\nwatcher: FAILED - Pi extension could not restore watcher continuity after ${retryLimit} retries` };
  }

  function scheduleRetry(owner: SessionGeneration, message: string, predecessorArmPid: string): void {
    if (!generationIsLive(owner) || owner.child || owner.retryTimer) return;
    const ownership = lockOwnership();
    if (ownership !== "owned") {
      surfaceFailure(owner, `watcher: FAILED - Pi extension cannot restore continuity because this session no longer owns the lock\n${message}`);
      return;
    }
    owner.retryFailures += 1;
    if (owner.retryFailures > retryLimit) {
      surfaceFailure(owner, `watcher: FAILED - Pi extension could not restore watcher continuity after ${retryLimit} retries\n${message}`);
      return;
    }
    const timer = setTimeout(() => {
      if (owner.retryTimer === timer) owner.retryTimer = null;
      if (!generationIsLive(owner)) return;
      const result = startArm(owner, predecessorArmPid);
      if (!result.ok) {
        surfaceFailure(owner, `watcher: FAILED - Pi extension could not launch a continuity retry\n${result.message}`);
      }
    }, retryDelay(owner.retryFailures));
    timer.unref();
    owner.retryTimer = timer;
  }

  function startArm(owner: SessionGeneration, predecessorArmPid = ""): ArmResult {
    if (!generationIsLive(owner)) return { ok: false, message: shuttingDownMessage };
    const ownership = lockOwnership();
    if (ownership === "other") return { ok: false, message: "watcher: read-only - session lock is held by another firstmate session" };
    if (ownership === "missing") {
      return {
        ok: false,
        message: "watcher: not armed - no live session holds the lock; run bin/fm-session-start.sh to reclaim it, then call fm_watch_arm_pi to re-arm",
      };
    }
    markLoaded();
    if (owner.child) {
      return {
        ok: true,
        message: `watcher: unchanged - Pi extension already owns an arm child; no manual re-arm needed; ${repairOnlyHint}`,
      };
    }
    if (owner.retryTimer) {
      return {
        ok: true,
        message: `watcher: unchanged - Pi extension already owns a scheduled continuity retry; no manual re-arm needed; ${repairOnlyHint}`,
      };
    }
    const id = ++owner.seq;
    const env = {
      ...process.env,
      FM_HOME: fmHome,
      FM_ROOT_OVERRIDE: fmRoot,
      FM_CONFIG_OVERRIDE: config,
      FM_WATCH_ARM_SCRIPT: armScript,
      FM_WATCH_PREDECESSOR_ARM_PID: predecessorArmPid,
    };
    const armChild = spawn("bash", ["-lc", "config_dir=\"${FM_CONFIG_OVERRIDE:-$FM_HOME/config}\"; [ -f \"$config_dir/x-mode.env\" ] && . \"$config_dir/x-mode.env\"; exec \"$FM_WATCH_ARM_SCRIPT\" --restart"], {
      cwd: fmRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    owner.child = armChild;
    owner.continuityReady = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let readinessSettled = false;
    let verified = false;
    let resolveReadiness: (ready: boolean) => void = () => {};
    let resolveClosed: () => void = () => {};
    const readiness = new Promise<boolean>((resolveReady) => {
      resolveReadiness = resolveReady;
    });
    armReadiness.set(armChild, readiness);
    const closed = new Promise<void>((resolveClosedChild) => {
      resolveClosed = resolveClosedChild;
    });
    armClose.set(armChild, closed);
    const settleReadiness = (ready: boolean): void => {
      if (readinessSettled) return;
      readinessSettled = true;
      verified = ready;
      if (generationIsLive(owner) && owner.child === armChild) owner.continuityReady = ready;
      resolveReadiness(ready);
    };
    const observeEstablishedArm = (): void => {
      const combined = `${stdout}\n${stderr}`;
      const recovery = combined.match(/^watcher: started pid=([0-9]+).* recovery-generation=([A-Za-z0-9._-]+)$/m);
      if (recovery) armRecovery.set(armChild, { watcherPid: recovery[1], generation: recovery[2] });
      if (/^watcher: (?:started|attached)\b/m.test(combined)) {
        settleReadiness(true);
      }
      const reason = completedActionableLine(stdout) || completedActionableLine(stderr);
      if (reason && !armPendingActionable.has(armChild)) {
        const pending = createPendingActionable(reason, String(armChild.pid ?? ""));
        armPendingActionable.set(armChild, pending);
        enqueuePendingActionable(owner, pending);
      }
      if (generationIsLive(owner) && owner.continuityReady && !owner.restoring && !armPendingActionable.has(armChild)) {
        void processPendingActionables(owner);
      }
    };
    const releaseChild = (): void => {
      if (owner.child === armChild) {
        owner.child = null;
        owner.continuityReady = false;
      }
    };
    armChild.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      observeEstablishedArm();
    });
    armChild.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      observeEstablishedArm();
    });
    armChild.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolveClosed();
      settleReadiness(false);
      releaseChild();
      const classification = classifyClose(stdout, stderr, code, signal);
      const predecessor = String(armChild.pid ?? "");
      if (classification.kind === "actionable") {
        const pending = armPendingActionable.get(armChild) ?? createPendingActionable(classification.message, predecessor);
        enqueuePendingActionable(owner, pending);
        if (!generationIsLive(owner)) return;
        owner.retryFailures = 0;
        void processPendingActionables(owner);
        return;
      }
      if (!generationIsLive(owner)) return;
      if (owner.restoring) {
        // The pipeline is still delivering the wake this successor was
        // started for. A verified successor that failed on its own keeps its
        // bounded retry for the end of that delivery; an unready child closing
        // here was retired by the restoration itself.
        if (verified && !armRetired.has(armChild)) {
          owner.deferredClose = { message: classification.message, predecessorArmPid: predecessor };
        }
        return;
      }
      scheduleRetry(owner, classification.message, predecessor);
    });
    armChild.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      resolveClosed();
      settleReadiness(false);
      releaseChild();
      if (!generationIsLive(owner)) return;
      if (owner.restoring) return;
      scheduleRetry(owner, `watcher: FAILED - Pi extension arm child ${id} failed: ${error.message}`, String(armChild.pid ?? ""));
    });
    return {
      ok: true,
      message: `watcher: started Pi extension arm child ${id}; future ordinary re-arms are automatic; ${repairOnlyHint}`,
    };
  }

  function activateOwnedWatch(owner: SessionGeneration, explicitRepair = false): ArmResult {
    if (!generationIsLive(owner)) return { ok: false, message: shuttingDownMessage };
    if (lockOwnership() !== "owned") return startArm(owner);
    if (explicitRepair) {
      for (const pending of owner.pendingActionables) {
        if (pending.deferred && (pending.attempts ?? 0) >= retryLimit && !owner.unconsumedWakes.has(pending.token)) pending.attempts = 0;
      }
      owner.mainDeliveryFailure = "";
    }
    replacementCoordinator.receiver = receiveReplacementActionable;
    let pending: PendingActionableClose[] = [];
    let loadFailure = "";
    try {
      pending = loadReplacementHandoff();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      loadFailure = `watcher: FAILED - Pi extension could not load a replacement-session actionable wake\n${detail}`;
    }
    const inProcessPending = replacementCoordinator.pending.splice(0);
    for (const actionable of [...pending, ...inProcessPending]) {
      if (actionable.deferred && !owner.pendingActionables.some(item => item.token === actionable.token)) {
        delete actionable.consumed;
      }
      enqueuePendingActionable(owner, actionable);
    }
    if (owner.pendingActionables.length > 0) {
      if (loadFailure) surfaceFailure(owner, loadFailure);
      const armResult = startArm(owner, owner.pendingActionables[0].predecessorArmPid);
      if (!armResult.ok) {
        surfaceFailure(owner, `watcher: FAILED - Pi extension could not arm before replacement wake delivery\n${armResult.message}`);
      }
      void processPendingActionables(owner);
      return armResult;
    }
    const result = startArm(owner);
    if (loadFailure) surfaceFailure(owner, `${loadFailure}\n${result.message}`);
    return result;
  }

  pi.on?.("before_agent_start", (event, ctx) => {
    mainContext = ctx;
    consumeWake(generation, event.prompt);
  });
  pi.on?.("agent_settled", (_event, ctx) => {
    mainContext = ctx;
    settledMainTurns++;
    void flushMain(generation);
  });
  // A terminal no-tool response is a native follow-up opportunity even when
  // a stream of human continuations prevents an agent_settled idle boundary.
  pi.on?.("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !["stop", "length"].includes(event.message.stopReason) || event.toolResults.length > 0) return;
    mainContext = ctx;
    void flushMain(generation, true);
  });
  pi.on?.("message_start", (event) => {
    const message = event.message;
    if (message.role === "user") {
      consumeWake(generation, userMessageText(message.content));
    } else if (message.role === "custom" && message.customType === deferredMessageType) {
      consumeWake(generation, userMessageText(message.content), true);
    }
  });

  pi.on?.("session_start", async (_event, ctx) => {
    mainContext = ctx;
    if (generation.stopping) generation = createGeneration();
    activateGeneration(generation);
    markLoaded();
    if (lockOwnership() !== "owned") return;
    activateOwnedWatch(generation);
  });
  pi.on?.("session_shutdown", async (event) => {
    const replacement = event.reason === "reload" || event.reason === "new" || event.reason === "resume" || event.reason === "fork";
    if (replacementCoordinator.receiver === receiveReplacementActionable) replacementCoordinator.receiver = null;
    await stopSessionGeneration(generation, replacement);
  });

  pi.registerCommand?.("fm-watch-arm-pi", {
    description: "Arm firstmate watcher supervision through the Pi extension instead of foreground bash.",
    handler: async (_args, ctx) => {
      const result = activateOwnedWatch(generation, true);
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });

  registerFirstmateTool(pi, {
    name: "fm_watch_arm_pi",
    label: "Arm firstmate watcher",
    description: "Start the first required Pi watcher cycle, or repair one only after a notification says the cycle is missing, failed, or unhealthy. Do not call after ordinary work or ordinary notifications; the Pi extension re-arms automatically. Never run bin/fm-watch-arm.sh through bash.",
    promptSnippet: "Start the first required Pi watcher cycle or repair a cycle reported missing, failed, or unhealthy; ordinary re-arming is automatic.",
    promptGuidelines: [
      "Call fm_watch_arm_pi only for the first required cycle or after a notification says the cycle is missing, failed, or unhealthy. Do not call it after ordinary work, turn completion, or ordinary signal, stale, check, or heartbeat handling because the Pi extension owns re-arming. Never run bin/fm-watch-arm.sh through bash.",
    ],
    parameters: Type.Object({}),
    renderShell: "self",
    renderCall: (_args, theme, context) => {
      if (calmHides("assistant-tool-call")) return new Container();
      if (calmPresentation.stockExportRendering) {
        return new Text(theme.fg("toolTitle", theme.bold("fm_watch_arm_pi")), 0, 0);
      }
      const state = context.state as WatchToolShellState;
      state.call = new Text(theme.fg("toolTitle", theme.bold("fm_watch_arm_pi")), 0, 0);
      return refreshWatchToolShell(state, theme, context);
    },
    renderResult: (result, _options, theme, context) => {
      if (calmHides("tool-result")) return new Container();
      const output = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (calmPresentation.stockExportRendering) {
        return new Text(theme.fg("toolOutput", output), 0, 0);
      }
      const state = context.state as WatchToolShellState;
      state.result = output
        ? new Text(theme.fg("toolOutput", output), 0, 0)
        : new Container();
      refreshWatchToolShell(state, theme, context);
      return new Container();
    },
    execute: async () => {
      const result = activateOwnedWatch(generation, true);
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
      };
    },
  });

  markLoaded();
}
