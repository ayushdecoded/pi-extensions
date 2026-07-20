# Product ideas

## Personalized follow-up chips (deferred)

**Intent:** After a settled main-agent reply, show 0–3 concise, clickable next-question chips that fit the current conversation and the user's preferred working style. Clicking places the text in the editor only; it never sends a message.

**One-time preparation:** Analyze selected past Pi sessions manually during product/design work, then have the user review and edit a compact Spark-specific system prompt. This establishes durable preferences (for example: challenge assumptions, establish contracts before implementation, discuss one decision at a time, distinguish goals/non-goals/constraints/assumptions, prefer simple designs). Spark does not analyze past sessions or learn at runtime.

**Runtime:** Spark receives only bounded active-session context plus the latest settled answer, and returns bounded structured output (0–3 chips, or none). It should return no chip when the reply is complete or the next move is obvious. Prefer showing chips only at natural discussion/decision boundaries to prevent visual noise.

**Non-goals:** Persistent behavioral profiling, autonomous actions, hidden prompt submission, runtime historical-session analysis, generic boilerplate suggestions.
