# Pi skill-catalog verification

Audience: maintainer verification.

This record preserves the full-prompt measurement for hiding Firstmate's 15 agent-only skills from Pi's automatic model catalog.
The behavioral contract remains enforced by `tests/fm-pi-skill-catalog.test.sh`; this record owns the version-scoped byte evidence and its refresh method.

## Full-prompt audit

The audit was run on 2026-08-28 with Pi 0.84.0 on macOS against public base `420721401c4080d1a4f6982b0ef6769e2a749b23` and task head `8abb49e25da4e1211a933ca57e72c4c745b78276`.
Both captures used the same clean disposable checkout path, the same installed Pi configuration, and the normal discovered project context and skill catalog.
The only source difference was the task head.
Pi's command context exposed the complete generated system prompt without starting an agent turn or making a provider request.

Create this test-only hook in `.tmp-skill-catalog-audit/capture-system-prompt.ts` inside the disposable checkout:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fm-capture-full-prompt", {
    description: "Capture Pi's complete generated system prompt",
    handler: async (_args, ctx) => {
      const prompt = ctx.getSystemPrompt();
      writeFileSync(
        process.env.FM_PI_PROMPT_CAPTURE!,
        JSON.stringify({
          prompt,
          bytes: Buffer.byteLength(prompt, "utf8"),
          skills: ctx.getSystemPromptOptions().skills,
        }),
      );
    },
  });
}
```

Run this command at the base, save the resulting `before.json`, switch the same clean disposable checkout to the head, and run it again with `LABEL=after`.
Keeping the checkout path fixed matters because Pi includes each skill's absolute location in the generated catalog.

```sh
LABEL=before
AUDIT_DIR="$PWD/.tmp-skill-catalog-audit"
printf '%s\n' \
  '{"id":"capture","type":"prompt","message":"/fm-capture-full-prompt"}' \
  | PI_OFFLINE=1 \
    FM_PI_PROMPT_CAPTURE="$AUDIT_DIR/$LABEL.json" \
    pi --mode rpc --approve --no-session --no-extensions \
      -e "$AUDIT_DIR/capture-system-prompt.ts" \
      --no-prompt-templates --no-themes \
      --model openai-codex/gpt-5.6-sol --thinking low \
      >"$AUDIT_DIR/$LABEL.rpc" \
      2>"$AUDIT_DIR/$LABEL.stderr"
jq '{bytes, loadedSkills:(.skills | length)}' "$AUDIT_DIR/$LABEL.json"
```

The raw bounded output was:

```text
base=420721401c4080d1a4f6982b0ef6769e2a749b23
head=8abb49e25da4e1211a933ca57e72c4c745b78276
pi=0.84.0
before={"bytes":92325,"loadedSkills":29,"catalogSkills":29}
after={"bytes":82784,"loadedSkills":29,"catalogSkills":14}
saved=9541
providerRequests=0
```

The 29 loaded skills comprised all 20 Firstmate skills and nine installed global skills in both captures.
After the change, the automatic catalog retained those nine global skills plus the five captain-invocable Firstmate skills, while all 29 skill records remained loaded.
The focused behavioral regression separately confirms that Pi retains all 20 Firstmate skill commands.
The measured reduction was 9,541 UTF-8 bytes in Pi's complete generated system prompt.
