# Composer

`src/composer.ts` customizes Pi through its native editor and footer APIs.

- Context usage sits in the composer's top border, alongside the native working indicator.
- A single footer row shows the project directory, Git branch, cache hit rate, and cost. The subscription marker follows Pi's native subscription detection.
- Model/provider and thinking level stay on the right when there is room; narrower terminals prioritize the project and usage details.
- Cache hit rate (`CH`) is the latest assistant request's cache-read share of prompt tokens, matching Pi's default footer.
- Cost combines Pi's native session usage entries (including synchronous tools, compaction, and branch summaries) with persisted background subagent reports, deduplicated by run ID. Nested reports and synchronous runs are not added again. Title usage is included in each child's reported usage.
- This aggregation affects the custom footer only, not Pi's built-in session-stat APIs or the parent model's context/cache statistics. Background costs appear when runs finish; historical recorded reports are picked up on reload.

The extension subclasses `CustomEditor` and changes only its top-border rendering. Native editing, autocomplete, multiline scrolling, images, shortcuts, and working/retry indicators remain Pi's responsibility. No separate footer token-total/context row is added.

Reload the package with `/reload` to apply changes. Terminal fixture evidence is under `artifacts/composer/`.
