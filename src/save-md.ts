import { open, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.3-codex-spark";
const DIRECTORY_NAME = "AgentDocs";
const GITIGNORE_ENTRY = "AgentDocs/";

export function registerSaveMarkdown(pi: ExtensionAPI): void {
  pi.registerCommand("save-md", {
    description: "Save the last assistant response as a Markdown file",
    handler: async (_args, ctx) => {
      try {
        const response = lastAssistantResponse(ctx.sessionManager.getBranch());
        if (!response) {
          notify(ctx, "There is no completed assistant response to save.", "warning");
          return;
        }

        const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
        if (!model) {
          notify(ctx, "Spark is unavailable to name this document.", "warning");
          return;
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          notify(ctx, "Spark authentication is unavailable.", "warning");
          return;
        }

        const title = await generateFilename(response, model, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env }, ctx.signal);
        if (!title) {
          notify(ctx, "Spark did not return a usable document name.", "warning");
          return;
        }

        const directory = join(ctx.cwd, DIRECTORY_NAME);
        await mkdir(directory, { recursive: true });
        await ensureGitignored(ctx.cwd);
        const file = await writeUnique(directory, title, response);
        notify(ctx, `Saved Markdown: ${file}`, "info");
      } catch (error) {
        notify(ctx, `Could not save Markdown: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

export function lastAssistantResponse(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") continue;
    const text = contentText(entry.message.content);
    if (text.trim()) return text;
  }
  return undefined;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export function normalizeFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const stem = value
    .replace(/[`*_#]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  return stem ? `${stem}.md` : undefined;
}

async function generateFilename(response: string, model: any, auth: { apiKey: string; headers?: ProviderHeaders; env?: Record<string, string> }, signal?: AbortSignal): Promise<string | undefined> {
  const result = await complete(
    model,
    {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: [
            "Create a concise filename for this Markdown document.",
            "Return exactly one plain-text title of 3 to 8 words.",
            "Return nothing except the title: no quotes, markdown, labels, or ending punctuation.",
            "The title should describe the document, not the instruction to name it.",
            "",
            "<document>",
            response,
            "</document>",
          ].join("\n"),
        }],
        timestamp: Date.now(),
      }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 128, signal },
  );
  const text = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return normalizeFilename(text);
}

async function ensureGitignored(cwd: string): Promise<void> {
  const file = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  if (entries.has(GITIGNORE_ENTRY) || entries.has("AgentDocs")) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${existing}${prefix}${GITIGNORE_ENTRY}\n`, "utf8");
}

async function writeUnique(directory: string, filename: string, content: string): Promise<string> {
  const extension = ".md";
  const stem = filename.slice(0, -extension.length);
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? filename : `${stem}-${index}${extension}`;
    const path = join(directory, candidate);
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
