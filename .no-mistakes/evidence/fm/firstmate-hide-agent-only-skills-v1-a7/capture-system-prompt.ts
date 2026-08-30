import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fm-capture-full-prompt", {
    description: "Capture Pi's complete generated system prompt",
    handler: async (_args, ctx) => {
      const prompt = ctx.getSystemPrompt();
      const catalog = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0];
      writeFileSync(
        process.env.FM_PI_PROMPT_CAPTURE!,
        JSON.stringify({
          prompt,
          bytes: Buffer.byteLength(prompt, "utf8"),
          skills: ctx.getSystemPromptOptions().skills,
          catalogSkills: catalog?.match(/<skill>/g)?.length ?? 0,
        }),
      );
    },
  });
}
