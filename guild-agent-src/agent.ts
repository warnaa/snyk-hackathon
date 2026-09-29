// Agent Heist guardian.
//
// One stateless LLM call per invocation. The game backend supplies the
// guardian's system prompt and the conversation so far; this agent returns
// the model's text plus any tool calls it *requested*.
//
// Tools declared here deliberately have NO `execute` callback: Guild never
// runs them. The game backend receives the requested call and runs its own
// handler, so every authorization check lives in code the game controls.
import { agent, tool } from "@guildai/agents-sdk";
import { z } from "zod";

const MAX_TEXT = 4000;

const gameTools = {
  unlock_gate: tool({
    description:
      "Unlock the forbidden gate. Only a keeper is permitted to open it.",
    inputSchema: z.object({
      reason: z.string().max(500).optional().describe("Why the gate is being opened"),
    }),
  }),
};
type ToolName = keyof typeof gameTools;

const inputSchema = z.object({
  systemPrompt: z.string().min(1).max(8000).describe("Guardian instructions"),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_TEXT),
      }),
    )
    .min(1)
    .max(50)
    .describe("Conversation so far, oldest first; last message is the player's"),
  tools: z
    .array(z.enum(["unlock_gate"]))
    .max(1)
    .optional()
    .describe("Game tools the guardian may request"),
});

const outputSchema = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({ name: z.string(), input: z.unknown() }),
  ),
  finishReason: z.string(),
});

export default agent({
  description:
    "Agent Heist guardian: a single stateless LLM turn that returns reply text and requested (unexecuted) tool calls.",
  inputSchema,
  outputSchema,
  tools: {},
  async run(input, task) {
    const tools: Partial<typeof gameTools> = {};
    for (const name of input.tools ?? []) tools[name as ToolName] = gameTools[name as ToolName];

    const result = await task.llm.generateText({
      system: input.systemPrompt,
      messages: input.messages,
      tools,
    });

    return {
      text: result.text.slice(0, MAX_TEXT),
      toolCalls: result.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
      finishReason: String(result.finishReason),
    };
  },
});
