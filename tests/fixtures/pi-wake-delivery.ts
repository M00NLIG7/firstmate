// Real Pi/SDK delivery regression. Only the provider response and watcher
// trigger are controlled; native queues, extension events, grants and acks run.
// All model judgment is scripted. No provider request leaves this process.
import {
  createAgentSession, createAgentSessionRuntime, createAgentSessionServices,
  createAgentSessionFromServices, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("wake-delivery-test", {handler: async () => {
    try { await exercise(); process.exit(0); }
    catch (error) { console.error(error); process.exit(1); }
  }});
}

async function exercise() {
  const root = process.env.FM_TEST_ROOT!;
  const home = process.env.FM_HOME!;
  const scenario = process.env.FM_TEST_SCENARIO!;
  const exhaustion = scenario.startsWith("exhaustion-");
  const lifecycle = ["current-reload-control", "current-reload-rollback"].includes(scenario);
  let legacy = scenario === "baseline" || lifecycle;
  const installVersion = (version: "previous" | "candidate") => {
    for (const path of [".pi/extensions/fm-primary-pi-watch.ts", ".pi/extensions/fm-branch-supervision.ts", ".pi/extensions/lib/fm-branch-dispatch.ts", "bin/fm-wake-drain.sh"]) copyFileSync(`${root}/${version}/${path}`, `${root}/${path}`);
  };
  if (lifecycle) installVersion("previous");
  const handoff = `${home}/state/extensions/pi-primary-watch/session-replacement-actionable.json`;
  const human = "Please include a review step in the sample diagram.";
  const rows = () => readFileSync(`${home}/state/.wake-queue`, "utf8");
  const pending = () => existsSync(handoff) ? JSON.parse(readFileSync(handoff, "utf8")).pending : [];
  const text = (content: any): string => typeof content === "string" ? content : content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  const bash = (command: string) => execFileSync("bash", ["-c", command], {cwd: root, encoding: "utf8", env: process.env});
  const drain = () => bash("bin/fm-wake-drain.sh 2>&1");
  const ack = (output: string) => {
    const match = output.match(/WAKE_ACK_REQUIRED: after handling completes run bin\/fm-wake-drain\.sh --ack-through ([0-9]+) --recovery-generation ([A-Za-z0-9._-]+)(?:\n|$)/);
    assert.ok(match, `no printed acknowledgement: ${output}`);
    const before = rows();
    execFileSync("bash", [`${root}/bin/fm-wake-drain.sh`, "--ack-through", match[1], "--recovery-generation", match[2]], {cwd: root, env: process.env});
    const receipt = `${home}/state/.wake-acknowledged`;
    events.push({kind: "acknowledgement", before, after: rows(), receipt: existsSync(receipt) ? readFileSync(receipt, "utf8") : null});
  };
  const wait = async (predicate: () => boolean, label: string) => {
    const until = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error(`timeout: ${label}; ${JSON.stringify({events, calls: calls.length, queues, pending: pending()})}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const calls: any[] = [], events: any[] = [], queues: any[] = [];
  let release!: () => void, started!: () => void;
  let heldCall = 1;
  let held = new Promise<void>(resolve => { release = resolve; });
  let beginning = new Promise<void>(resolve => { started = resolve; });
  let contextRelease!: () => void, contextReached!: () => void;
  const contextHeld = new Promise<void>(resolve => { contextRelease = resolve; });
  const contextReady = new Promise<void>(resolve => { contextReached = resolve; });
  let intercepted = false, filtering = true, latestDrain = "", branchSettled = 0;
  let session: any, runtime: any, context: any, observerApi: ExtensionAPI;
  let observerGeneration = 0, barrierQueued = false, acknowledgeUnacked = false;
  const barrierText = "Synthetic provider barrier for the lifecycle interruption.";
  const alarmText = "no positive source acknowledgement after 5 delivery attempts";
  let barrierStarted!: () => void, barrierRelease!: () => void;
  const barrierReady = new Promise<void>(resolve => { barrierStarted = resolve; });
  const barrierHeld = new Promise<void>(resolve => { barrierRelease = resolve; });
  const lastUserText = (messages: any[]) => text(messages.filter(message => message.role === "user").at(-1)?.content ?? "");
  const alarmCalls = () => calls.filter(messages => lastUserText(messages).includes(alarmText)).length;
  const ordinaryMessages = () => events.filter(event => event.kind === "message" && event.customType === "fm-watcher-pending").length;
  const isCustom = (message: any) => message.role === "custom" && message.customType === "fm-watcher-pending";
  const noHuman = ["drop-no-human", "delayed-context", "replacement", "crash-prepare", "recover"].includes(scenario);
  const earlyAck = ["acknowledged", "missing-receipt", "corrupt-receipt", "protected"].includes(scenario);
  const protectedSource = scenario === "protected" || scenario === "quiet";
  const payload = protectedSource ? "blocked: synthetic open blocker" : "working: ordinary fixture activity";
  const append = () => bash(`. bin/fm-wake-lib.sh; fm_wake_append signal sample.status '${payload}'`);

  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.startsWith("https://fixture.invalid/"), `unexpected network request: ${url}`);
    const request = JSON.parse(String(init.body));
    calls.push(request.messages);
    const number = calls.length;
    events.push({kind: "provider", number, pending: pending(), queue: queues.at(-1)});
    started();
    const last = request.messages.filter((m: any) => m.role === "user").at(-1);
    if (last && text(last.content).includes("FIRSTMATE WATCHER WAKE") && !text(last.content).includes("watcher: FAILED")) {
      // The later explicit re-observation repairs lost optional evidence only
      // through a new real append/drain/ack of the same unchanged source.
      if (!rows().trim() && ["missing-receipt", "corrupt-receipt"].includes(scenario)) append();
      if (rows().trim() && (acknowledgeUnacked || (scenario !== "continuous-unacknowledged" && !exhaustion))) ack(drain());
    }
    if (scenario === "continuous" && number >= 2 && number < 8) {
      await session.prompt(`Human continuation ${number}`, {source: "interactive", streamingBehavior: "followUp"});
    }
    if ((scenario === "continuous-unacknowledged" || scenario === "exhaustion-crash-prepare") && number >= 2 && number < 8) {
      await session.prompt(`Human continuation ${number}`, {source: "interactive", streamingBehavior: "followUp"});
    }
    if (scenario === "exhaustion-crash-prepare" && !barrierQueued && pending().length === 3 && pending().every((item: any) => item.attempts === 5)) {
      barrierQueued = true;
      observerApi.sendMessage({customType: "fixture-lifecycle-barrier", content: barrierText, display: false}, {deliverAs: "followUp", triggerTurn: true});
    }
    const atBarrier = lastUserText(request.messages) === barrierText;
    if (atBarrier) {
      assert.equal(typeof init.signal?.addEventListener, "function", "the real provider request lacks its abort signal");
      init.signal.addEventListener("abort", () => { events.push({kind: "provider-aborted", number}); barrierRelease(); }, {once: true});
      barrierStarted();
    }
    const chunk = (delta: any, finish: string | null) => `data: ${JSON.stringify({id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{index: 0, delta, finish_reason: finish}], ...(finish ? {usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}} : {})})}\n\n`;
    return new Response(new ReadableStream({async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(chunk({role: "assistant", content: "synthetic response"}, null)));
      if (number === heldCall && scenario !== "recover" && scenario !== "exhaustion-recover") await held;
      if (atBarrier) await barrierHeld;
      controller.enqueue(encoder.encode(chunk({}, "stop") + "data: [DONE]\n\n"));
      controller.close();
    }}), {status: 200, headers: {"content-type": "text/event-stream"}});
  }) as typeof fetch;

  writeFileSync(`${home}/state/.lock`, `${process.pid}\n`);
  if (scenario === "branch-failure") writeFileSync(`${home}/config/supervision-branch-model`, "missing/fixture\n");
  const agentDir = `${home}/agent`;
  mkdirSync(agentDir, {recursive: true});
  writeFileSync(`${agentDir}/models.json`, JSON.stringify({providers: {fixture: {baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", contextWindow: 1000000, maxTokens: 64}]}}}));
  const settings = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}});
  const loaderOptions = {
    cwd: root, agentDir, settingsManager: settings, noExtensions: true,
    additionalExtensionPaths: [`${root}/.pi/extensions/fm-primary-pi-watch.ts`, `${root}/.pi/extensions/fm-branch-supervision.ts`],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{name: "delivery-observer", factory: (api: ExtensionAPI) => {
      observerApi = api;
      const generation = ++observerGeneration;
      api.registerCommand("fixture-reload", {handler: async (_args, ctx) => { await ctx.reload(); return; }});
      api.on("session_start", (event, ctx) => { events.push({kind: "start", reason: event.reason, generation, session: ctx.sessionManager.getSessionId()}); });
      api.on("input", (event, ctx) => { context = ctx; events.push({kind: "input", source: event.source, text: event.text}); });
      api.on("message_start", event => {
        if (event.message.role === "user" || event.message.role === "custom") events.push({kind: "message", role: event.message.role, customType: event.message.role === "custom" ? event.message.customType : undefined, text: text(event.message.content)});
      });
      api.on("session_shutdown", (event, ctx) => { events.push({kind: "shutdown", reason: event.reason, session: ctx.sessionManager.getSessionId()}); });
      api.on("context", async (event, ctx) => {
        if ((intercepted && scenario !== "retry-repair") || !event.messages.some(isCustom)) return;
        if (scenario === "crash-prepare") {
          assert.equal(pending().length, 3);
          assert.ok(pending().every((p: any) => p.consumed === true));
          assert.ok(rows().trim(), "consumption removed unacknowledged sources");
          assert.ok(session.sessionFile && existsSync(session.sessionFile));
          writeFileSync(`${home}/resume-session`, session.sessionFile);
          writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, pending: pending()}));
          console.log("ok - real Pi pending delivery crash-prepare: durable sources survive interruption after native consumption");
          process.exit(0);
        }
        if (["drop-once", "drop-no-human"].includes(scenario) || (scenario === "retry-repair" && filtering)) {
          intercepted = true;
          events.push({kind: "context-dropped", pending: pending()});
          return {messages: event.messages.filter(message => !isCustom(message))};
        }
        if (scenario === "delayed-context") {
          intercepted = true; context = ctx; contextReached(); await contextHeld;
        }
      });
      api.events.on("fm-branch-supervision:dispatch", (offer: any) => {
        if (!offer.accepted || legacy) return;
        if (scenario === "quiet") ack(latestDrain);
        void offer.settlement.then(() => { branchSettled++; }, () => { branchSettled++; });
      });
    }}],
  };
  const modelRuntime = await ModelRuntime.create({authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json`});
  const model = modelRuntime.getModel("fixture", "fixture");
  assert.ok(model, "fixture model missing");
  const observeSession = () => session.subscribe((event: any) => {
    if (event.type === "queue_update") queues.push({session: session.sessionId, steering: event.steering, followUp: event.followUp});
  });
  // Bind the real host operations, as Pi's print-mode host does. Empty bindings
  // leave command-context reload as a no-op; event/tool contexts lack reload.
  const bindRuntime = async () => {
    session = runtime.session;
    await session.bindExtensions({commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: (options: any) => runtime.newSession(options),
      fork: (id: string, options: any) => runtime.fork(id, options),
      navigateTree: (id: string, options: any) => session.navigateTree(id, options),
      switchSession: (path: string, options: any) => runtime.switchSession(path, options),
      reload: () => session.reload(),
    }, onError: (error: any) => events.push({kind: "extension-error", error})});
    observeSession();
  };
  if (scenario === "replacement" || exhaustion || lifecycle) {
    runtime = await createAgentSessionRuntime(async ({cwd, sessionManager, sessionStartEvent}) => {
      const services = await createAgentSessionServices({cwd, agentDir, modelRuntime, settingsManager: settings, resourceLoaderOptions: loaderOptions});
      return {...await createAgentSessionFromServices({services, sessionManager, sessionStartEvent, model, noTools: "builtin"}), services, diagnostics: services.diagnostics};
    }, {cwd: root, agentDir, sessionManager: scenario === "exhaustion-recover" ? SessionManager.open(readFileSync(`${home}/resume-session`, "utf8")) : SessionManager.create(root, `${home}/sessions`)});
    runtime.setRebindSession(bindRuntime);
    await bindRuntime();
  } else {
    const loader = new DefaultResourceLoader(loaderOptions);
    await loader.reload();
    ({session} = await createAgentSession({cwd: root, agentDir, modelRuntime, model, settingsManager: settings, resourceLoader: loader, sessionManager: scenario === "recover" ? SessionManager.open(readFileSync(`${home}/resume-session`, "utf8")) : SessionManager.create(root, `${home}/sessions`), noTools: "builtin"}));
  }
  if (!runtime) observeSession();
  if (scenario === "recover") {
    await session.bindExtensions({});
    await wait(() => calls.length === 1 && !session.isStreaming && pending().length === 0 && !rows().trim(), "cold source recovery");
    assert.equal(calls[0].filter((m: any) => m.role === "user" && text(m.content) === "Begin the synthetic work.").length, 1, "cold recovery changed the original human request");
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: 1, calls, events, queues}));
    session.dispose();
    console.log("ok - real Pi pending delivery recover: one provider call handles interrupted sources without replacing human history");
    return;
  }
  if (scenario === "exhaustion-recover") {
    const durable = () => pending().map((item: any) => ({token: item.token, attempts: item.attempts, source: item.source}));
    const before = durable(), sourceRows = rows();
    assert.ok(before.length === 3 && before.every((item: any) => item.attempts === 5));
    // Do not invoke the repair tool at startup: that would renew the budget and
    // turn this missing-alarm regression into a vacuous successful recovery.
    await wait(() => alarmCalls() === 1 && !session.isStreaming, "cold recovery of the accepted-but-unconsumed exhaustion alarm");
    assert.equal(calls.length, 1);
    const humans = ["Begin the synthetic work.", human, ...Array.from({length: 6}, (_, i) => `Human continuation ${i + 2}`)];
    assert.deepEqual(calls[0].filter((message: any) => message.role === "user").map((message: any) => text(message.content)).filter((content: string) => humans.includes(content)), humans, "cold recovery altered the human history or ordering");
    let expectedCalls = 1;
    for (const transition of ["reload", "replacement", "reload", "replacement"]) {
      const id = session.sessionId, generation = observerGeneration;
      if (transition === "reload") {
        await session.prompt("/fixture-reload");
        assert.equal(session.sessionId, id, "reload replaced the session rather than its resources");
        assert.equal(observerGeneration, generation + 1);
        assert.ok(events.some(event => event.kind === "shutdown" && event.reason === "reload" && event.session === id));
        assert.ok(events.some(event => event.kind === "start" && event.reason === "reload" && event.generation === generation + 1));
      } else {
        await runtime.newSession();
        assert.notEqual(session.sessionId, id);
        assert.ok(events.some(event => event.kind === "shutdown" && event.reason === "new" && event.session === id));
      }
      expectedCalls++;
      await wait(() => alarmCalls() === expectedCalls && !session.isStreaming, `${transition} generation alarm`);
      assert.equal(calls.length, expectedCalls, `${transition} renewed ordinary delivery model calls`);
      assert.equal(ordinaryMessages(), 0, `${transition} renewed an exhausted ordinary attempt`);
      assert.deepEqual(durable(), before, `${transition} changed exhausted source identity or attempts`);
      assert.equal(rows(), sourceRows, `${transition} acknowledged or discarded unseen sources`);
      assert.equal(new Set(pending().map((item: any) => item.token)).size, 3);
    }
    assert.ok(!events.some(event => event.kind === "extension-error"), "the actual SDK reported an extension error");
    acknowledgeUnacked = true;
    const repaired = await session.getToolDefinition("fm_watch_arm_pi").execute("fixture-repair", {}, undefined, undefined, {});
    assert.equal(repaired.details.ok, true);
    await wait(() => calls.length === 6 && !session.isStreaming && pending().length === 0 && !rows().trim(), "explicit repair and positive acknowledgement");
    assert.equal(ordinaryMessages(), 1, "only explicit repair restores an ordinary retry");
    assert.equal(alarmCalls(), 5);
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, sourceRows, calls, events, queues, pending: pending()}, null, 2));
    await runtime.dispose();
    console.log(`ok - real Pi pending delivery ${scenario}: six provider calls, real reload/replacement and five generation alarms`);
    return;
  }
  const armed = await session.getToolDefinition("fm_watch_arm_pi").execute("fixture-arm", {}, undefined, undefined, {});
  assert.equal(armed.details.ok, true);
  const running = session.prompt("Begin the synthetic work.");
  await beginning;
  writeFileSync(`${home}/state/sample.meta`, "project=/synthetic/project\nwindow=fm-sample\n");
  writeFileSync(`${home}/state/sample.status`, `${payload}\n`);
  if (scenario === "idle") {
    release(); await running;
    append(); latestDrain = drain();
    writeFileSync(`${home}/trigger`, `signal: ${home}/state/sample.status\n`);
    await wait(() => calls.length === 2 && !session.isStreaming && !rows().trim() && pending().length === 0, "idle delivery");
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: 2, calls, events, queues}));
    session.dispose();
    console.log("ok - real Pi pending delivery idle: 2 provider calls without a later human request");
    return;
  }
  const trigger = async (index: number) => {
    append(); latestDrain = drain();
    writeFileSync(`${home}/trigger`, `signal: ${home}/state/sample.status\n`);
    if (legacy) {
      await wait(() => queues.at(-1)?.followUp.filter((message: string) => message.includes("FIRSTMATE WATCHER WAKE")).length >= index, "baseline native notification acceptance");
      events.push({kind: "source-accepted", index, rows: rows(), pending: pending(), queue: queues.at(-1)});
      return;
    }
    if (scenario === "quiet") { await wait(() => branchSettled >= index, "quiet settlement"); return; }
    if (scenario === "late-ack") {
      await wait(() => existsSync(`${home}/refused-${index}`), "grant refusal barrier");
      ack(latestDrain); writeFileSync(`${home}/release-${index}`, "release");
      await wait(() => branchSettled >= index, "late-ack settlement");
      return;
    }
    if (protectedSource || (scenario === "branch-failure" && index === 1)) await wait(() => events.filter(e => e.kind === "input" && e.source === "extension").length >= index, "protected direct delivery");
    else await wait(() => pending().some((p: any) => p.deferred && p.source?.rows.some((r: string) => r.split("\t")[1] === String(index))), "durable pending source");
    if (earlyAck) ack(latestDrain);
  };
  await trigger(1);
  if (!noHuman) await session.prompt(human, {source: "interactive", streamingBehavior: "followUp"});
  await trigger(2); await trigger(3);
  if (scenario === "missing-receipt") unlinkSync(`${home}/state/.wake-acknowledged`);
  if (scenario === "corrupt-receipt") writeFileSync(`${home}/state/.wake-acknowledged`, "invalid receipt\n");
  if (scenario === "mixed") {
    writeFileSync(`${home}/state/sample.status`, `${payload}\nneeds-decision: [key=new] new fixture decision\n`);
    bash(". bin/fm-wake-lib.sh; fm_wake_append signal sample.status 'needs-decision: new fixture decision'");
    writeFileSync(`${home}/trigger`, `signal: ${home}/state/sample.status\n`);
    await wait(() => events.some(e => e.kind === "input" && e.source === "extension"), "new decision direct delivery");
    bash(". bin/fm-wake-lib.sh; fm_wake_append check security 'check: fixture security rejection'");
    writeFileSync(`${home}/trigger`, "check: fixture security rejection\n");
    await wait(() => events.some(e => e.kind === "input" && e.text.includes("fixture security rejection")), "security direct delivery");
  }
  const queuedBefore = queues.at(-1)?.followUp ?? [];
  if (lifecycle) {
    const originalId = session.sessionId;
    assert.equal(queuedBefore.length, 4);
    assert.equal(queuedBefore[1], human);
    const reloadVersion = async (version: "previous" | "candidate") => {
      const queued = [...(queues.at(-1)?.followUp ?? [])];
      const generation = observerGeneration;
      installVersion(version);
      legacy = version === "previous";
      await session.prompt("/fixture-reload");
      assert.equal(session.sessionId, originalId);
      assert.equal(observerGeneration, generation + 1);
      assert.ok(events.some(event => event.kind === "shutdown" && event.reason === "reload" && event.session === originalId));
      assert.deepEqual(queues.at(-1)?.followUp ?? [], queued, `${version} reload changed already accepted messages`);
    };
    const originalSources = rows();
    assert.equal(pending().length, 0, "legacy in-memory delivery unexpectedly persisted before reload");
    // Current upstream replays legacy unconsumed handoffs on real reload even
    // though Pi retains its native queue. This is an explicit existing-limit
    // characterization, not the older baseline's five-call activation claim.
    // Hold the provider until all three replays reach native acceptance so
    // consumption timing cannot turn the same limitation into a guessed count.
    await reloadVersion(scenario === "current-reload-control" ? "previous" : "candidate");
    const originalPending = pending();
    assert.equal(originalPending.length, 3);
    assert.equal(new Set(originalPending.map((item: any) => item.token)).size, 3);
    assert.ok(originalPending.every((item: any) => item.message === `signal: ${home}/state/sample.status` && /^[0-9]+$/.test(item.predecessorArmPid)));
    await wait(() => queues.at(-1)?.followUp.length === 7, "three legacy replay acceptances before consumption");
    const expectedQueue = [...queuedBefore, queuedBefore[0], queuedBefore[2], queuedBefore[3]];
    assert.deepEqual(queues.at(-1).followUp, expectedQueue);
    assert.equal(calls.length, 1, "reload ran an extra provider before the held response settled");
    assert.equal(rows(), originalSources, "reload acknowledged unseen sources");
    assert.deepEqual(pending(), originalPending, "reload changed the legacy delivery identities");
    events.push({kind: "reload-accepted", rows: rows(), pending: pending(), queue: queues.at(-1)});
    release(); await running;
    await wait(() => calls.length === 8 && !session.isStreaming && pending().length === 0 && !rows().trim(), "exact legacy replay consumption");
    assert.deepEqual(calls.slice(1).map(lastUserText), expectedQueue, "native accepted message content/order changed");
    assert.deepEqual(events.filter(event => event.kind === "message").map(event => event.text), ["Begin the synthetic work.", ...expectedQueue]);
    const firstAck = events.findIndex(event => event.kind === "acknowledgement");
    assert.ok(firstAck > events.findIndex(event => event.kind === "reload-accepted"));
    assert.equal(events[firstAck].before, originalSources);
    assert.equal(events[firstAck].after, "");
    if (scenario === "current-reload-control") {
      assert.ok(!events.some(event => event.kind === "extension-error"));
      writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, queuedBefore, originalSources, originalPending, calls, events, queues}, null, 2));
      await runtime.dispose();
      console.log("ok - real Pi pending delivery current-reload-control: 8 calls, three existing legacy replays, exact accepted-message and source ordering");
      return;
    }
    const holdNext = async (prompt: string) => {
      heldCall = calls.length + 1;
      held = new Promise<void>(resolve => { release = resolve; });
      beginning = new Promise<void>(resolve => { started = resolve; });
      const work = session.prompt(prompt);
      await beginning;
      return {work};
    };
    const upgraded = await holdNext("Synthetic work after upgrading.");
    await trigger(4);
    await session.prompt(human, {source: "interactive", streamingBehavior: "followUp"});
    await trigger(5); await trigger(6);
    assert.deepEqual(queues.at(-1).followUp, [human]);
    release(); await upgraded.work;
    await wait(() => calls.length === 11 && !session.isStreaming && pending().length === 0 && !rows().trim(), "three-call behavior after same-session activation");
    assert.equal(lastUserText(calls[8]), "Synthetic work after upgrading.");
    assert.equal(lastUserText(calls[9]), human);
    assert.ok(lastUserText(calls[10]).includes("FIRSTMATE WATCHER WAKE"));
    const rollingBack = await holdNext("Synthetic work before rollback.");
    await trigger(7);
    await session.prompt(human, {source: "interactive", streamingBehavior: "followUp"});
    const retained = readFileSync(handoff, "utf8"), sourceRows = rows();
    assert.equal(pending().length, 1);
    await reloadVersion("previous");
    // Current upstream already understands the v1 handoff and auto-arms on
    // reload. It delivers this unconsumed record through its legacy user path,
    // rather than leaving it inert as an older baseline did.
    await wait(() => queues.at(-1)?.followUp.length === 2, "rollback's native delivery after automatic restoration");
    const rollbackQueue = [...queues.at(-1).followUp];
    assert.equal(rollbackQueue[0], human);
    assert.ok(rollbackQueue[1].includes("FIRSTMATE WATCHER WAKE"));
    assert.equal(calls.length, 12, "rollback triggered a provider before native consumption");
    assert.equal(readFileSync(handoff, "utf8"), retained, "rollback changed pending source identity or attempts before consumption");
    assert.equal(rows(), sourceRows, "rollback changed unhandled source rows");
    events.push({kind: "rollback-accepted", rows: rows(), pending: pending(), queue: queues.at(-1)});
    release(); await rollingBack.work;
    await wait(() => calls.length === 14 && !session.isStreaming && pending().length === 0 && !rows().trim(), "rollback delivery, consumption and source acknowledgement");
    assert.deepEqual(calls.slice(12).map(lastUserText), rollbackQueue);
    const rollbackAccepted = events.findIndex(event => event.kind === "rollback-accepted");
    const rollbackAck = events.findIndex((event, index) => index > rollbackAccepted && event.kind === "acknowledgement");
    assert.ok(rollbackAck > rollbackAccepted);
    assert.equal(events[rollbackAck].before, sourceRows);
    assert.equal(events[rollbackAck].after, "");
    bash(". bin/fm-wake-lib.sh; fm_wake_append check rollback-proof 'check: post-rollback delivery'");
    writeFileSync(`${home}/trigger`, "check: post-rollback delivery\n");
    await wait(() => calls.length === 15 && !session.isStreaming && !rows().trim(), "post-rollback delivery and acknowledgement");
    assert.ok(lastUserText(calls[14]).includes("check: post-rollback delivery"));
    assert.equal(events.filter(event => event.kind === "input" && event.source === "interactive" && event.text === human).length, 3);
    assert.equal(calls.at(-1).filter((message: any) => message.role === "user" && text(message.content) === human).length, 3);
    assert.ok(!events.some(event => event.kind === "extension-error"));
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, queuedBefore, retained, sourceRows, calls, events, queues}, null, 2));
    await runtime.dispose();
    console.log("ok - real Pi pending delivery current-reload-rollback: 8 legacy reload calls, upgraded burst 3 calls, rollback 3 calls plus one new check, exact native/source preservation");
    return;
  }
  if (scenario === "baseline") {
    assert.equal(queuedBefore.length, 4);
    assert.equal(queuedBefore[1], human);
    assert.ok(readFileSync(`${home}/arms`, "utf8").trim().split("\n").length >= 4);
    release(); await running;
    await wait(() => !session.isStreaming && calls.length === 5, "baseline five serialized provider calls");
    assert.equal(events.filter(event => event.kind === "input" && event.source === "interactive" && event.text === human).length, 1);
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, queuedBefore, calls, events, queues}, null, 2));
    session.dispose();
    console.log("ok - real Pi pending delivery baseline: 5 provider calls, three native automated follow-ups and preserved human input");
    return;
  }
  if (scenario === "branch-failure") assert.ok(queuedBefore.some((s: string) => s.includes("Supervision branch delivery failed")), "branch failure did not bypass ordinary deferral");
  if (!protectedSource && !["mixed", "branch-failure"].includes(scenario)) assert.deepEqual(queuedBefore, noHuman ? [] : [human]);
  assert.ok(readFileSync(`${home}/arms`, "utf8").trim().split("\n").length >= 4, "successor creation waited for main");
  if (scenario === "replacement") {
    const oldId = session.sessionId;
    const switching = runtime.newSession(); release(); await switching;
    assert.notEqual(session.sessionId, oldId);
  } else release();
  if (scenario === "delayed-context") {
    await contextReady;
    await session.prompt(human, {source: "interactive", streamingBehavior: "followUp"});
    await trigger(4);
    assert.equal(context.isIdle(), false);
    assert.equal(context.hasPendingMessages(), true);
    assert.deepEqual(queues.at(-1).followUp, [human]);
    contextRelease();
  }
  if (scenario === "exhaustion-crash-prepare") {
    await barrierReady;
    await wait(() => queues.at(-1)?.followUp.some((message: string) => message.includes(alarmText)), "native acceptance of the unconsumed exhaustion alarm");
    assert.equal(alarmCalls(), 0, "the interrupted alarm already reached the provider");
    assert.equal(events.filter(event => event.kind === "message" && event.text.includes(alarmText)).length, 0, "the interrupted alarm was already consumed");
    assert.equal(ordinaryMessages(), 5);
    assert.equal(calls.length, 14);
    assert.ok(pending().length === 3 && pending().every((item: any) => item.attempts === 5));
    assert.ok(rows().trim());
    assert.ok(session.sessionFile && existsSync(session.sessionFile));
    writeFileSync(`${home}/resume-session`, session.sessionFile);
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, calls, events, queues, pending: pending()}, null, 2));
    console.log("ok - real Pi pending delivery exhaustion-crash-prepare: interrupted after native alarm acceptance, before consumption, with five durable attempts");
    process.exit(0);
  }
  await running;
  if (scenario === "drop-once") {
    await wait(() => intercepted, "one-shot context removal");
    await session.prompt("Human after the one-shot filter disappeared.", {source: "interactive", streamingBehavior: "followUp"});
  }
  if (scenario === "retry-repair") {
    await wait(() => calls.length === 8 && !session.isStreaming && pending().every((p: any) => p.attempts >= 5), "bounded delivery failure");
    assert.equal(pending().length, 3);
    assert.ok(rows().trim(), "failed delivery discarded source rows");
    filtering = false;
    const repaired = await session.getToolDefinition("fm_watch_arm_pi").execute("fixture-repair", {}, undefined, undefined, {});
    assert.equal(repaired.details.ok, true);
  }
  if (scenario === "continuous-unacknowledged") {
    await wait(() => pending().length > 0 && pending().every((item: any) => item.attempts === 5), "bounded unacknowledged delivery");
    await wait(() => calls.some(messages => JSON.stringify(messages).includes("no positive source acknowledgement after 5 delivery attempts")), "visible exhaustion");
    assert.ok(rows().trim(), "exhaustion discarded the unacknowledged source");
    assert.equal(pending().length, 3, "exhaustion lost a deferred pending record");
    assert.equal(new Set(pending().map((item: any) => item.token)).size, 3, "retry created duplicate pending records");
    assert.equal(calls.length, 14, "unexpected provider invocation count for bounded retries");
    writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, calls, events, queues, pending: pending()}, null, 2));
    if (runtime) await runtime.dispose(); else session.dispose();
    console.log(`ok - real Pi pending delivery ${scenario}: ${calls.length} bounded provider calls, retained unacknowledged sources`);
    return;
  }
  const expected: Record<string, number> = {ordinary: 3, acknowledged: 2, "late-ack": 2, protected: 5, quiet: 2, mixed: 5, "missing-receipt": 3, "corrupt-receipt": 3, "drop-once": 5, "drop-no-human": 3, "delayed-context": 3, continuous: 9, replacement: 2, "branch-failure": 4, "retry-repair": 9};
  await wait(() => calls.length >= expected[scenario] && !session.isStreaming && !rows().trim() && pending().length === 0, "acknowledged completion");
  assert.equal(calls.length, expected[scenario], "unexpected provider invocation count");
  if (!noHuman || scenario === "delayed-context") assert.equal(events.filter(e => e.kind === "input" && e.source === "interactive" && e.text === human).length, 1);
  if (scenario === "continuous") {
    assert.ok(JSON.stringify(calls[2].at(-1)).includes("FIRSTMATE WATCHER WAKE"), "pending work starved behind continuous input");
    for (let n = 2; n < 8; n++) assert.ok(JSON.stringify(calls[n + 1].at(-1)).includes(`Human continuation ${n}`));
  }
  if (scenario.startsWith("drop-")) assert.ok(intercepted, "drop counterfactual did not execute");
  writeFileSync(process.env.FM_TEST_OUTPUT!, JSON.stringify({scenario, scriptedJudgment: true, paidCalls: 0, providerCalls: calls.length, queuedBefore, calls, events, queues}, null, 2));
  if (runtime) await runtime.dispose(); else session.dispose();
  console.log(`ok - real Pi pending delivery ${scenario}: ${calls.length} provider calls, acknowledged sources, preserved human input`);
}
