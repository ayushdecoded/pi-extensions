import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { askInComposer, type AskAnswer, type AskQuestion, type AskComposerResult } from "./composer.ts";

type HerdrEvents = { emit(channel: string, data: unknown): void };

const TOOL_DESCRIPTION =
  "Ask the user structured questions. Supports up to 15 questions and 6 options each; answers are reviewed before submission.";

const parameters = Type.Object({
  questions: Type.Array(
    Type.Object(
      {
        question: Type.String({ minLength: 1, description: "Question text." }),
        options: Type.Array(Type.String({ minLength: 1, description: "One selectable answer." }), {
          minItems: 2,
          maxItems: 6,
          description: "Short answer choices.",
        }),
        multiple: Type.Optional(Type.Boolean({ description: "Allow multiple choices." })),
      },
      { additionalProperties: false },
    ),
    { minItems: 1, maxItems: 15, description: "Questions to ask." },
  ),
}, { additionalProperties: false });

export type AskDetails = {
  answers: AskAnswer[];
  total: number;
};

/** Creates the interactive `ask` tool. */
export function createAskTool(options: { startDictation?: (ctx: ExtensionContext) => void; herdrEvents?: HerdrEvents } = {}) {
  return defineTool({
    name: "ask",
    label: "Ask",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Ask the user structured questions.",
    promptGuidelines: [
      "Use this tool by default whenever user input is needed.",
      "Batch related questions into one call.",
      "Ask only what you cannot decide or verify yourself.",
    ],
    parameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      const questions = (args as { questions?: Array<{ question?: string; options?: string[]; multiple?: boolean }> }).questions ?? [];
      if (questions.length === 0) return new Text(theme.fg("dim", "Ask"), 0, 0);
      // One compact line — the interactive panel above the editor already
      // presents the questions; echoing them here just duplicates it.
      return new Text(`${theme.fg("accent", "Ask")} ${theme.fg("muted", `${questions.length} ${questions.length === 1 ? "question" : "questions"}`)}`, 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<AskDetails>> {
      const questions = normalizeQuestions(params.questions);
      const details = (answers: AskAnswer[]): AskDetails => ({ answers, total: questions.length });
      if (!ctx.hasUI || questions.length === 0) {
        return {
          content: [{ type: "text", text: "No interactive UI available; the user cannot be asked right now. Proceed with your best judgment and state the assumption." }],
          details: details([]),
        };
      }
      const herdr = options.herdrEvents;
      if (herdr) {
        herdr.emit("herdr:blocked", { active: true, label: "Waiting for you" });
        if (process.env.HERDR_ENV === "1") process.stdout.write("\x07");
      }
      try {
        const result = ctx.mode === "tui" ? await askInComposer(ctx, questions, signal, options.startDictation ? () => options.startDictation!(ctx) : undefined) : await askWithDialogs(ctx, questions);
        return {
          content: [{ type: "text", text: formatAnswers(result.answers, questions.length) }],
          details: details(result.answers),
        };
      } finally {
        herdr?.emit("herdr:blocked", { active: false });
      }
    },
    renderResult(result, _options, theme) {
      const { answers } = result.details as AskDetails;
      if (!answers || answers.length === 0) return new Text(theme.fg("dim", "Ask · no answers"), 0, 0);
      const lines = answers.map((answer) => {
        const values = answer.selected.join(theme.fg("borderMuted", " · "));
        return `${theme.fg("success", "✓")} ${theme.fg("text", values)}`;
      });
      return new Text(`${theme.fg("success", "Ask · answered")}\n${lines.join("\n")}`, 0, 0);
    },
  });
}

function normalizeQuestions(raw: Array<{ question: string; options: string[]; multiple?: boolean }>): AskQuestion[] {
  return raw
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()).filter((o) => o.length > 0).slice(0, 6),
      multiple: q.multiple === true,
    }))
    .filter((q) => q.question.length > 0 && q.options.length >= 2)
    .slice(0, 15);
}

const CUSTOM_SENTINEL = "✎ Write your own…";
const DONE_SENTINEL = "✔ Done";

/** RPC / non-TUI degradation: plain sequential select+input dialogs. Typed notes are TUI-only. */
async function askWithDialogs(ctx: ExtensionContext, questions: AskQuestion[]): Promise<AskComposerResult> {
  const answers: AskAnswer[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    if (!question.multiple) {
      const choice = await ctx.ui.select(question.question, [...question.options, CUSTOM_SENTINEL]);
      if (choice === undefined) break;
      if (choice === CUSTOM_SENTINEL) {
        const typed = await ctx.ui.input(question.question, "Type your answer");
        if (typed === undefined || typed.trim() === "") break;
        answers.push({ index, selected: [typed.trim()], notes: {} });
      } else {
        answers.push({ index, selected: [choice], notes: {} });
      }
      continue;
    }
    const remaining = new Set(question.options);
    const selected: string[] = [];
    let dismissed = false;
    while (remaining.size > 0 || selected.length === 0) {
      const choice = await ctx.ui.select(`${question.question} — pick one per pass`, [...remaining, DONE_SENTINEL, CUSTOM_SENTINEL]);
      if (choice === undefined) {
        dismissed = true;
        break;
      }
      if (choice === DONE_SENTINEL) break;
      if (choice === CUSTOM_SENTINEL) {
        const typed = await ctx.ui.input(question.question, "Type your answer");
        if (typed !== undefined && typed.trim() !== "") selected.push(typed.trim());
        continue;
      }
      remaining.delete(choice);
      selected.push(choice);
    }
    if (dismissed) break;
    if (selected.length > 0) answers.push({ index, selected, notes: {} });
  }
  return { answers };
}

/**
 * Compact model-facing result. Questions are not echoed back — the caller just
 * asked them — so each line is `index → selections`, with notes inline.
 */
export function formatAnswers(answers: AskAnswer[], total: number): string {
  const byIndex = new Map(answers.map((answer) => [answer.index, answer]));
  const lines: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const answer = byIndex.get(index);
    if (!answer) { lines.push(`${index + 1} → unanswered`); continue; }
    const parts = answer.selected.map((value) =>
      Object.hasOwn(answer.notes, value) ? `${value} ${JSON.stringify(answer.notes[value])}` : value,
    );
    lines.push(`${index + 1} → ${parts.join(", ")}`);
  }
  const header = answers.length < total ? `[ask] answered ${answers.length}/${total} · unanswered ${total - answers.length}` : `[ask] answered ${answers.length}/${total}`;
  return [header, ...lines].join("\n");
}
