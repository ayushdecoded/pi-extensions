---
description: Guide the creation of a concise Pi skill
argument-hint: "[skill request]"
---
Create a new concise Pi skill in this repository.

Start with a guided interview. Use the initial request below as a starting point, then ask focused questions whose answers would materially change the skill. Ask one question at a time or a small, coherent group; do not make the user complete a needless questionnaire. Resolve the skill's purpose, intended use cases, inputs, outputs, workflow, constraints, and definition of done. If the user requests examples, capture those examples and include them in the skill. Infer routine details from the repository rather than asking about them.

Before writing, inspect the existing skills and the project's Pi skill conventions. Do not write files while material ambiguity remains. Once the skill is sufficiently specified, write it directly to `.pi/skills/<name>/SKILL.md`; do not wait for a separate approval. Use a lowercase, hyphenated skill name and concise frontmatter:

```yaml
---
name: <name>
description: <specific, concise description>
---
```

Write only the smallest complete skill:

- Put ordered actions in the skill when the model must perform them; end meaningful steps with a checkable completion criterion.
- Keep reference material with the skill when every use needs it. Use a clearly named linked reference file only when progressive disclosure genuinely keeps the main skill concise.
- Split only when there is a real independent branch or a sequence split prevents premature completion.
- Keep each meaning in one authoritative place, remove irrelevant prose, and prune repetition aggressively.
- Prefer positive instructions; retain prohibitions only as necessary guardrails paired with the desired behavior.
- Treat premature completion, duplication, sediment, sprawl, no-ops, and excessive negation as failure modes to check before finishing.

Do not design invocation routing, add another command, or add optional invocation metadata. Create the skill itself under the project's existing `.pi/skills/` directory. Put requested examples inline in `SKILL.md` unless the user explicitly asks for separate files. Do not modify unrelated files or package configuration.

After writing, read the file back, verify its frontmatter and structure, and report the created path with a brief summary. If a new material uncertainty appears during the interview, pause and ask rather than guessing.

Initial request from the command invocation:

$ARGUMENTS

If the initial request is blank, ask what skill the user wants to create.
