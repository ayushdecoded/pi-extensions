import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createWebSearchTool } from "../src/web-search/index.ts";
import { parseLiteResults, resolveDuckDuckGoUrl } from "../src/web-search/primitives/fetch.ts";
import { parseSections, shapePage } from "../src/web-search/primitives/page.ts";

test("web search can be injected into child agent sessions", () => {
  const tool = createWebSearchTool();
  assert.equal(tool.name, "web_search");
  assert.match(tool.description, /Search DuckDuckGo Lite or read URLs/);
});

test("DuckDuckGo parsing resolves redirect URLs and keeps citation text", () => {
  const target = "https://example.com/docs?q=pi";
  const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`;
  const html = `<a class="result-link" href="${href}">Example &amp; Docs</a><td class="result-snippet">Useful <b>Pi</b> documentation.</td>`;

  assert.equal(resolveDuckDuckGoUrl(href), target);
  assert.deepEqual(parseLiteResults(html, 5), [
    {
      title: "Example & Docs",
      url: target,
      snippet: "Useful Pi documentation.",
    },
  ]);
});

test("page shaping exposes outlines and selects bounded sections", () => {
  const raw = {
    requestedUrl: "https://example.com/docs",
    finalUrl: "https://example.com/docs",
    ok: true,
    status: 200,
    contentType: "text/html",
    raw: "<h1>Guide</h1><p>Overview</p><h2>Install</h2><p>Run npm install.</p>",
  };
  const sections = parseSections(raw);

  const outline = shapePage(raw, sections, { mode: "structure", maxChars: 1_000 });
  assert.deepEqual(outline.sections?.map((section) => section.heading), ["Guide", "Install"]);

  const selected = shapePage(raw, sections, { mode: "section", section: "Install", maxChars: 1_000 });
  assert.equal(selected.sections?.length, 1);
  assert.match(selected.sections?.[0]?.text ?? "", /npm install/);
});

test("create-skill is a native prompt template with argument forwarding", async () => {
  const prompt = await readFile(".pi/prompts/create-skill.md", "utf8");
  assert.match(prompt, /description: Guide the creation/);
  assert.match(prompt, /\$ARGUMENTS/);
  assert.match(prompt, /\.pi\/skills\/<name>\/SKILL\.md/);
});
