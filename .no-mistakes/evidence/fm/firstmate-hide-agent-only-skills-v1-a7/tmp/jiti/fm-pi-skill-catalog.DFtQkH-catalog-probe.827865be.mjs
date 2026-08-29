"use strict";Object.defineProperty(exports, "__esModule", { value: true });exports.default = _default;
var _nodeFs = await jitiImport("node:fs");

function _default(pi) {
  pi.registerProvider("fm-skill-catalog-probe", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "local-test-key",
    api: "openai-completions",
    models: [{
      id: "probe",
      name: "Skill catalog probe",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 1024
    }]
  });

  pi.registerCommand("fm-capture-skill-catalog", {
    description: "Capture Pi's loaded skill catalog for a behavioral regression",
    handler: async (_args, ctx) => {
      const prompt = ctx.getSystemPrompt();
      (0, _nodeFs.writeFileSync)(
        process.env.FM_PI_SKILL_CAPTURE,
        JSON.stringify({
          prompt,
          bytes: Buffer.byteLength(prompt, "utf8"),
          skills: ctx.getSystemPromptOptions().skills,
          commands: pi.getCommands()
        })
      );
    }
  });
} /* v9-448a97bb01bf0dde */
