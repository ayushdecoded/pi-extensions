import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Hardcoded image models the painter tool can use. Codex exposes no
 * image-model catalog endpoint (first-party Codex hardcodes gpt-image-2),
 * so this curated list is the picker. Flare is the default. */
export const PAINTER_MODELS = [
  {
    id: "flare",
    slug: "gpt-image-2.5-flare",
    label: "Flare",
    description: "Fast everyday generation and edits, higher quality than 2.0 (default).",
  },
  {
    id: "sunburst",
    slug: "gpt-image-2.5-sunburst",
    label: "Sunburst",
    description: "Slower, extra precision for detailed creative work.",
  },
  {
    id: "gpt-image-2",
    slug: "gpt-image-2",
    label: "GPT Image 2",
    description: "Previous generation; fallback if 2.5 is not on your sub yet.",
  },
] as const;

export type PainterModelId = (typeof PAINTER_MODELS)[number]["id"];

export const DEFAULT_PAINTER_MODEL: PainterModelId = "flare";

export function painterModelSlug(id: string): string {
  return PAINTER_MODELS.find((model) => model.id === id)?.slug ?? PAINTER_MODELS[0]!.slug;
}

export function isPainterModelId(value: unknown): value is PainterModelId {
  return PAINTER_MODELS.some((model) => model.id === value);
}

export function painterModelsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "pi", "painter.json");
}

export function projectPainterModelsPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".pi", "painter.json");
}

export type PainterModelScope = "global" | "project";

export type PainterModelStore = {
  /** Project file wins over the global file; falls back to the default. */
  getDefault(): PainterModelId;
  set(scope: PainterModelScope, id: PainterModelId): void;
};

export function createPainterModelStore(options: { globalPath?: string; projectPath?: string } = {}): PainterModelStore {
  const globalPath = options.globalPath ?? painterModelsPath();
  const projectPath = options.projectPath ?? projectPainterModelsPath();
  let globalMtime = -1;
  let projectMtime = -1;
  let globalCached: PainterModelId | undefined;
  let projectCached: PainterModelId | undefined;
  let loaded = false;

  const read = (file: string): { id: PainterModelId; mtime: number } | undefined => {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const id = parsed.model;
      if (!isPainterModelId(id)) return undefined;
      return { id, mtime };
    } catch {
      return undefined;
    }
  };

  const load = (): void => {
    const global = read(globalPath);
    const project = read(projectPath);
    globalCached = global?.id;
    projectCached = project?.id;
    globalMtime = global?.mtime ?? -1;
    projectMtime = project?.mtime ?? -1;
    loaded = true;
  };

  const fresh = (): boolean => {
    if (!loaded) return false;
    try {
      const globalMtimeNow = fs.existsSync(globalPath) ? fs.statSync(globalPath).mtimeMs : -1;
      const projectMtimeNow = fs.existsSync(projectPath) ? fs.statSync(projectPath).mtimeMs : -1;
      return globalMtimeNow === globalMtime && projectMtimeNow === projectMtime;
    } catch {
      return false;
    }
  };

  return {
    getDefault() {
      if (!fresh()) load();
      return projectCached ?? globalCached ?? DEFAULT_PAINTER_MODEL;
    },
    set(scope, id) {
      const file = scope === "project" ? projectPath : globalPath;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${JSON.stringify({ model: id }, null, 2)}\n`, { mode: 0o600 });
      load();
    },
  };
}
