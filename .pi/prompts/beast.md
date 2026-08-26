---
description: Orchestrate a reviewed parallel Devin implementation in isolated worktrees
argument-hint: "<implementation request>"
---

Run this request as a `/beast` development campaign coordinated through the installed `herdr`, `devin`, and `git` CLIs.

Requested outcome:

$ARGUMENTS

If the requested outcome is blank, ask what should be built and do nothing else. This workflow requires a Herdr-managed session: first verify `HERDR_ENV=1` and the caller workspace, tab, and pane IDs are present. If not, explain that `/beast` must run inside Herdr and stop. Use `herdr --skill` and the installed CLI help as the authority if syntax or behavior is uncertain. Do not use Pi's subagent tool during this workflow.

You are the sole architect, coordinator, reviewer, and integrator. Devin workers implement bounded parts of an approved plan; they do not choose product behavior, introduce consequential architecture, coordinate other workers, merge, push, or clean up. Keep the user in control of decisions and irreversible transitions.

## 1. Understand and plan before mutation

Inspect the repository, relevant code, tests, conventions, documentation, current branch, remotes, Git status, and existing worktrees before proposing work. Infer routine facts from the repository. Ask focused questions only where answers materially change behavior or architecture.

Produce a detailed, context-rich campaign plan containing:

- the requested outcome, explicit goals, non-goals, constraints, assumptions, and acceptance criteria;
- the current implementation and the important files, symbols, data flows, conventions, and reusable components;
- the proposed design and how it achieves each goal, including meaningful trade-offs and migration or compatibility questions;
- the implementation sequence, testing strategy, integration strategy, and material risks;
- every consequential product, behavior, API, data-model, security, or architecture decision that still needs the user's input;
- an adaptive worker decomposition of no more than ten genuinely independent assignments.

Use fewer workers when the work does not parallelize cleanly. Do not manufacture duplicate reviews or overlapping implementation merely to increase fanout. Resolve dependencies into phases when one assignment needs another's output. For every worker specify its objective, relevant context, owned files or symbols, required reuse, implementation guidance, prohibited scope, acceptance criteria, tests, dependencies, expected commit, and stop condition. State how the pieces form one coherent implementation.

Discuss unresolved consequential decisions with the user. Then present the final plan and worker matrix and wait for explicit approval to launch. Planning approval does not authorize later merging or pushing.

## 2. Establish a safe base

After launch approval, re-check Git status and HEAD. If the working tree is dirty, show the exact staged, unstaged, and untracked paths and ask whether to create a checkpoint commit. Do not stash, discard, or checkpoint changes without approval. If approved, stage only the paths the user authorized and create a clearly named checkpoint commit. Keep that commit in history unless the user later explicitly requests otherwise. If the user declines, stop and ask how to proceed; workers must not silently start from a base that omits local changes.

Record the approved base commit, original branch, repository root, caller Herdr IDs, and pre-existing tabs, worktrees, and branches. Never modify or remove pre-existing workspaces, tabs, panes, worktrees, or branches. Use unique campaign and worker slugs. Put campaign worktrees under `<repo>/.worktrees/` and exclude that directory locally through the repository's Git exclude mechanism rather than changing a tracked `.gitignore` solely for this workflow.

Create one branch and one linked worktree per worker from the recorded base using Git CLI. Use names recognizable as belonging to this campaign, such as `beast/<campaign>/<worker>`, and paths such as `.worktrees/beast-<campaign>-<worker>`. Create later dependency-phase worktrees only when their prerequisites are ready. On setup failure, report the exact partial state and roll back only artifacts created by this campaign when doing so cannot destroy worker changes.

## 3. Build the Herdr fanout

Create exactly one new background Herdr tab in the caller's workspace for the campaign, with a useful `beast: <campaign>` label and `--no-focus`. Keep the user's focus in the calling pane unless they ask otherwise. Place every worker in a pane in this tab, with that pane's cwd set to the worker's own worktree.

Use the tab's root pane for the first worker and split existing campaign panes for subsequent workers. Inspect the live layout and build a balanced grid instead of repeatedly splitting the same pane: prefer two useful columns, split the currently largest suitable region, and keep pane sizes as even as practical. Parse workspace, tab, and pane IDs from Herdr's JSON responses; never predict IDs or rely on UI ordering. Give panes and agents short, unique, descriptive names.

Before starting agents, keep Beast panes visible but omit their agents from Herdr's Agents sidebar: tag every campaign pane with `herdr pane report-metadata <pane-id> --source "pi-beast:<campaign>" --token pi_beast=1`, then send one newline-delimited `agent.view.set` request through the official Unix socket API (`$HERDR_SOCKET_PATH`, falling back to `~/.config/herdr/herdr.sock`) using source `pi-beast` and filter `{"op":"not","filter":{"op":"exists","field":{"token":"pi_beast"}}}`. Omit `label` entirely so Herdr shows no view banner; verify the response reports `active: true` and `source: "pi-beast"`. This projection affects only the Agents view—not tabs, panes, detection, notifications, `agent.list`, prompting, or waits—and should remain installed across cleanup so concurrent and future tagged Beast panes stay hidden.

Start each worker as an interactive Devin agent through Herdr. Use the exact Devin model `glm-5-2` (GLM-5.2 High), bypass approvals with `--permission-mode dangerous`, and disable workspace-trust prompting. The intended shape is:

```bash
herdr agent start <name> --kind devin --pane <pane-id> -- \
  --permission-mode dangerous \
  --respect-workspace-trust false \
  --model glm-5-2
```

Treat installed CLI help as authoritative if argument ordering differs. Wait for startup readiness and inspect any blocked or failed pane before proceeding. Do not answer an unexpected interactive question on the user's behalf.

## 4. Give every worker a complete implementation brief

A worker starts with no campaign context. Its initial prompt must stand alone and include:

- the overall approved outcome and design, the base commit, and where its assignment fits;
- its detailed objective, goals, non-goals, owned scope, dependencies, and acceptance criteria;
- relevant files, symbols, current behavior, data flow, conventions, and reusable code identified during planning;
- a concrete implementation approach, engineering principles, expected code quality, tests, and documentation changes;
- explicit instructions to inspect before editing, prefer the simplest robust design, reuse existing mechanisms, avoid unrelated cleanup and speculative abstractions, and keep changes within its worktree;
- explicit instructions not to use, launch, or delegate to any subagent or other agent;
- explicit instructions to stop and report rather than decide when it encounters a new cross-cutting, product, behavior, API, schema, security, compatibility, or architecture question;
- instructions to run relevant tests, review its diff, commit only its owned completed changes with a clear message, and report the commit hash, files changed, tests and results, assumptions, risks, and remaining issues.

Do not tell a worker merely to "follow the plan"; transmit the applicable plan and evidence in full. Do not let workers edit overlapping ownership concurrently unless the approved plan explicitly makes the overlap safe.

Start all ready workers before waiting for any one of them to finish: submit each prompt without a settling wait, then monitor the set through Herdr. For every initial or follow-up wave, after confirming all prompted agents entered `working`, launch one aggregate `herdr agent wait` shell command as a single background run and do not poll or continue until its one completion follow-up reports that every agent has settled. Herdr is the coordination channel: workers report in their final response, and you retrieve that response and inspect their Git state. If terminal history truncates a report, ask that same worker to write the complete report to an untracked temporary file and return its path.

## 5. Review, test, and iterate

For each completed worker:

1. Read its report and inspect its worktree status, branch log, commit, and full diff from the approved base.
2. Check correctness, scope, consistency with the approved design, reuse of existing code, maintainability, error handling, tests, documentation, and accidental generated or unrelated files.
3. Run the relevant tests independently in that worktree; do not accept a worker's assertion as verification.
4. Send precise follow-ups to the same persistent Devin agent through Herdr for defects, missing tests, or unjustified changes. Require it to test and commit the follow-up.
5. If the worker is blocked on a consequential decision, summarize the evidence and options for the user, obtain the decision, and only then send the answer back to the worker.

Continue until every assignment is reviewed and accepted or explicitly removed from scope by the user. Do not merge a branch merely because its agent reached `done`. Report failures candidly and preserve recoverable work.

Before asking to merge into the user's branch, verify the combined result away from that branch. Create a temporary campaign integration branch and worktree from the approved base, combine the reviewed worker branches in the intended order, resolve only routine conflicts, and run the repository's relevant full test, typecheck, lint, build, and other validation commands. Discuss consequential conflict resolutions or design changes with the user before applying them. Record the exact integrated commits, merge order, commands, and results. Use the worker sessions for follow-ups when integration exposes defects, then rebuild and reverify the integration result.

## 6. Merge only on the user's call

When the implementation and temporary integration result are well tested, present a concise merge-readiness report:

- accepted worker branches and commits;
- final behavior and notable design choices;
- independent and integration verification results;
- merge order, known conflicts, residual risks, and documentation or operational notes;
- the original branch and intended push remote/ref;
- all campaign artifacts that cleanup will remove.

Wait for explicit approval to begin merging. The main agent chooses the safest appropriate Git integration method for the actual commit graph; it need not automate a fixed merge strategy. Integrate reviewed work into the original branch one worker branch at a time in the tested order, inspect the resulting diff and history, and run appropriate verification after every step. Stop on an unexpected conflict, test failure, changed remote state, or new consequential decision and discuss it with the user. After all steps, run the full agreed verification again.

Before pushing, confirm that the resulting branch, commits, tests, remote, and target ref match what the user approved. Never force-push unless the user separately and explicitly requests it with the consequences explained. Push through Git CLI only after successful verification.

## 7. Clean up only after successful integration and push

After the approved push succeeds, close only the Herdr campaign tab created by this run so its worker processes have exited. Confirm campaign worktrees contain no uncommitted work that is absent from the integrated history. Remove only this campaign's worker and integration worktrees, prune their worktree metadata, and delete only their now-integrated local branches. Preserve any artifact with unmerged or uncommitted work and report why it remains. Do not remove the checkpoint commit by default.

Finish with the pushed commit/ref, verification evidence, merged branches, cleanup performed, and any deliberately retained artifact. At every phase, prefer explicit state inspection and recoverable operations over assumptions or destructive shortcuts.
