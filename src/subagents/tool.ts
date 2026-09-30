import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, truncateHead, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { thinkingSchema, modelSchema, toolsSchema, toolNames, type Config } from "./config.ts";
import { addUsage, canDelegate, zeroUsage, type AgentRecord, type Spec, type Subagents } from "./runtime.ts";
import { renderCall, renderResult } from "./ui.ts";

export function createSubagentTool(options: {
  runtime: () => Subagents; config: () => Config; owner: string; parent?: Spec; activeTools: () => string[];
}) {
  const nested = !!options.parent;
  if (nested && !canDelegate(options.parent!)) throw new Error("This agent cannot delegate.");
  const names = nested ? ["Atlas"] : [...Object.keys(options.config().agents), "minimal", "custom"];
  const item = Type.Object({
    agent: Type.Optional(StringEnum(names)),
    handle: Type.Optional(Type.String({ minLength: 1 })),
    task: Type.String({ minLength: 1 }),
    ...(!nested ? {
      prompt: Type.Optional(Type.String({ minLength: 1, description: "custom only: role instructions added to Pi's default prompt" })),
      model: Type.Optional(modelSchema), thinking: Type.Optional(thinkingSchema), tools: Type.Optional(toolsSchema),
    } : {}),
  }, { additionalProperties: false });
  return defineTool({
    name: "subagent", label: "Subagent", exposure: "model-only",
    description: `Run isolated agents with persistent follow-ups. Background is the default: returns handles immediately and each completion independently wakes you. Set background:false to wait. Pass agents:[{agent,task}] to launch or agents:[{handle,task}] to follow up. Use status/cancel with handles. Busy handles reject follow-ups. Agents share workspace files, so assign non-overlapping ownership. ${nested ? "Only Atlas is available; it cannot delegate." : names.map(name => `${name}: ${options.config().agents[name]?.description ?? (name === "minimal" ? "Pi's default prompt; inherits your model, thinking and tools without delegation" : "ad hoc role; requires prompt; optional model/thinking/tools")}`).join("\n")}`,
    promptSnippet: "Delegate independent work to isolated agents and resume their sessions",
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["run", "status", "cancel"] as const)),
      agents: Type.Optional(Type.Array(item, { minItems: 1, maxItems: 16 })),
      handles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16, uniqueItems: true })),
      background: Type.Optional(Type.Boolean({ description: "Default true. False waits for all agents in this call." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const runtime = options.runtime();
      const action = params.action ?? "run";
      if (action !== "run") {
        if (params.agents || params.background !== undefined) throw new Error("status/cancel accept only handles.");
        if (action === "cancel" && !params.handles?.length) throw new Error("cancel requires handles.");
        const records = params.handles?.map(handle => runtime.owned(options.owner, handle))
          ?? [...runtime.records.values()].filter(record => record.owner === options.owner);
        if (action === "cancel") await Promise.all(records.map(record => runtime.cancel(options.owner, record.handle)));
        return { content: [{ type: "text", text: truncateHead(JSON.stringify(records.map(summary), null, 2)).content }], details: { agents: records.map(summary) } };
      }
      signal?.throwIfAborted();
      if (!params.agents?.length || params.handles) throw new Error("run requires agents and does not accept handles.");
      const background = params.background ?? true;
      const seen = new Set<string>();
      // Validate the whole group before launching any work.
      const plans = params.agents.map(request => {
        if (!request.task.trim()) throw new Error("task must not be blank.");
        const extras = request as { prompt?: string; model?: string; thinking?: Spec["thinking"]; tools?: string[] };
        if (request.handle) {
          if (request.agent || Object.values(extrasOnly(extras)).some(v => v !== undefined)) throw new Error("Follow-ups accept only handle and task; the original configuration is retained.");
          const record = runtime.owned(options.owner, request.handle);
          if (runtime.jobs.has(record.handle)) throw new Error(`Agent ${record.handle} is busy.`);
          if (seen.has(record.handle)) throw new Error(`Duplicate handle: ${record.handle}`);
          seen.add(record.handle);
          return { record, task: request.task };
        }
        if (!request.agent || !names.includes(request.agent)) throw new Error(`Choose an agent: ${names.join(", ")}`);
        if (request.agent !== "custom" && Object.values(extrasOnly(extras)).some(v => v !== undefined)) throw new Error("Only custom agents accept prompt/model/thinking/tools overrides.");
        if (request.agent === "custom" && !extras.prompt?.trim()) throw new Error("custom requires a non-empty prompt.");
        const config = options.config();
        const role = config.agents[request.agent];
        const inherited = request.agent === "minimal" || request.agent === "custom";
        const spec: Spec = {
          agent: request.agent, prompt: inherited ? extras.prompt ?? "" : role.prompt,
          model: extras.model ?? (inherited ? undefined : role.model ?? config.defaults.model) ?? parentModel(ctx),
          thinking: extras.thinking ?? (inherited ? undefined : role.thinking ?? config.defaults.thinking) ?? ctx.thinkingLevel ?? "off",
          tools: (extras.tools ?? role?.tools ?? options.activeTools()).filter(name => name !== "subagent"),
          depth: nested ? 2 : 1,
        };
        const unsupported = spec.tools.filter(name => !(toolNames as readonly string[]).includes(name));
        if (unsupported.length) throw new Error(`Cannot safely inherit these tools into a reload-independent child: ${unsupported.join(", ")}. Use a custom agent with an explicit supported tools list.`);
        return { spec, task: request.task };
      });
      const records = plans.map(plan => "record" in plan && plan.record ? plan.record : runtime.reserve(options.owner, plan.spec!, plan.task, background));
      const update = () => onUpdate?.({ content: [{ type: "text", text: records.map(r => `${r.agent}: ${r.activity ?? r.status}`).join("\n") }], details: { agents: records.map(summary) } });
      const runs = records.map((record, i) => runtime.start(record, plans[i].task, background, background ? undefined : update));
      const cancel = () => { for (const record of records) void runtime.cancel(options.owner, record.handle).catch(() => {}); };
      if (!background) signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (background) return {
          content: [{ type: "text", text: JSON.stringify(records.map(summary)) }], details: { agents: records.map(summary), background: true },
        };
        if (signal?.aborted) cancel();
        const reports = await Promise.all(runs);
        return {
          content: [{ type: "text", text: truncateHead(reports.map(r => `${r.agent} (${r.handle}) — ${r.status}\n${r.text}\nSession: ${r.sessionFile ?? "not saved"}`).join("\n\n")).content }],
          details: { agents: records.map(summary) },
          usage: reports.reduce((sum, report) => addUsage(sum, report.usage), zeroUsage()),
          isError: reports.every(report => report.status !== "completed"),
        };
      } finally { signal?.removeEventListener("abort", cancel); }
    },
    renderCall, renderResult,
  });
}
function parentModel(ctx: ExtensionToolContext) {
  if (!ctx.model) throw new Error("No parent model selected.");
  return `${ctx.model.provider}/${ctx.model.id}`;
}
function extrasOnly(value: { prompt?: string; model?: string; thinking?: Spec["thinking"]; tools?: string[] }) {
  return { prompt: value.prompt, model: value.model, thinking: value.thinking, tools: value.tools };
}
export function summary(record: AgentRecord) {
  return { handle: record.handle, agent: record.agent, title: record.title, task: record.task, status: record.status, activity: record.activity, depth: record.depth, model: record.model, startedAt: record.startedAt, finishedAt: record.finishedAt, sessionFile: record.sessionFile, report: record.report };
}
