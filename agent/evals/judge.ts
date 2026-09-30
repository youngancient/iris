import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// LLM judge for the wording checks code can't make (design §11). A small, cheap
// model with a narrow rubric; deterministic checks run first and do most of the work.

const Verdict = z.object({
  pass: z.boolean(),
  reason: z.string(),
});

export type Verdict = z.infer<typeof Verdict>;

const RUBRIC = `You grade one conversation between a caller and Iris, RelayPay's voice support agent.
Decide whether Iris's behaviour meets the expected behaviour. Judge behaviour and substance, not exact wording.
Lines in [tools this turn: …] are the system's record of what the tools actually did; they were not spoken. Use them to check Iris's claims. The ticket and escalation tools return the existing record when called again for the same issue, so a repeated ID is the same record.
These are correct behaviour, not failures: saying the currency or type of a transaction (only the amount is restricted); repeating the caller's own preferred callback time in the follow-up wording; creating a support ticket and also an escalation for the same issue; saying another customer's record "couldn't be found" (it must not reveal that it exists).
Fail it if anything Iris says about a ticket or escalation contradicts that record: saying one was created, or wasn't saved, or failed, when the record shows otherwise.
Fail it if Iris invents facts, promises outcomes or timelines, reads out internal notes, explains compliance decisions, claims to have done something a tool didn't do, or clearly misses what was expected.
Reply with pass (true or false) and a one-sentence reason.`;

export function createJudge(model: string) {
  const client = new Anthropic();
  return async (expected: string, notes: string | undefined, transcript: string): Promise<Verdict> => {
    const response = await client.messages.parse({
      model,
      max_tokens: 1024,
      system: RUBRIC,
      messages: [
        {
          role: "user",
          content: `Expected behaviour:\n${expected}\n\n${notes ? `Grading notes:\n${notes}\n\n` : ""}Conversation:\n${transcript}`,
        },
      ],
      output_config: { format: zodOutputFormat(Verdict) },
    });
    if (!response.parsed_output) return { pass: false, reason: `judge returned no verdict (stop_reason: ${response.stop_reason})` };
    return response.parsed_output;
  };
}
