# Minimal question history

Implemented in the current working copy at `artifacts/measured-performance/repo`; the older `qbank-performance` checkout was not changed. Existing uncommitted performance and study fixes were retained.

## Changes

- Small question label: `✅ Correct × N · ❌ Wrong × N`. No dates or additional history screen. Counts aggregate existing `question_attempts` by canonical `questions.id`, across sources and supported study modes.
- Lazy cache loads 40 question IDs at a time after rendering; repeated navigation within that group makes no further history requests. Account/view guards and write versions prevent stale responses. Failed reads show unavailable, not zero. Successful answer responses carry refreshed counts without another network read.
- Three compact Home shortcuts: Incorrect, Bookmarked, Marked for Review. One asynchronous count request after Home renders; each opens up to 20 matching Practice questions through existing selection logic. Counts use precisely the Review page's state flags; normal practice eligibility/filtering still applies.
- QBank Test submission records answered outcomes within the existing database transaction. Removed the browser's sequential per-question recording loop. Unanswered selections create no attempts. Snapshot answer sets determine test correctness; existing completed scores are never rewritten or backfilled.
- Practice, Smart Recall and Active Recall retain their existing canonical recording paths. Stable event IDs are saved before recording; retry cannot add duplicate events. Removed the non-idempotent insert fallback. An unsynced answer prevents advancing/completing; exiting Recall also flushes the current answer.
- Late events add historical counts while preserving newer latest-answer state. They do not reschedule newer Recall state, including a newer retrieval of another question in the same concept. Scheduling ladders/rules, bookmarks and marks remain unchanged. Incorrect eligibility now follows the final rule below.

This covers the app's `test_sessions`-based Test mode. The separate source-position Grand Test exam engine is unchanged. No fuzzy question merging or new taxonomy was introduced.

## Final Incorrect rule (25 October)

A wrong answer enters Incorrect and resets the SURE count. Three explicitly SURE-correct responses after the most recent wrong answer resolve it. Correct GUESS, UNSURE and missing-confidence responses still increase lifetime correct history but leave the SURE count unchanged. Another wrong answer re-enters Incorrect. The stored threshold counter is capped at three; latest answer correctness remains a separate fact.

The follow-up migration `20261025092318_three_sure_incorrect_resolution.sql` adds one small learning-state counter and a partial index for explicit SURE-correct attempts. A bounded lookup (at most three indexed successes) runs only when a new attempt is recorded. Retries do not change the counter. Late events use their original answer times and cannot overwrite newer latest-answer state. A one-time historical reconstruction counts only explicitly stored SURE confidence; it does not rewrite historical attempts or recover confidence that earlier versions did not preserve.

New attempts preserve `sure`, `guess`, `unsure` and null confidence exactly. Active Recall's explicit strong retrieval maps to SURE when it is the source of confidence; saved confidence takes precedence. Missing confidence still uses the existing conservative scheduling fallback without being written as an inferred confidence value.

Resolved questions leave the Smart Recall mistake bucket and lose repeated-mistake bonus reasons. They remain eligible through ordinary due scheduling, bookmarks and importance. No scheduling ladder, test-score calculation, bookmark, Mark for Review or lifetime history is changed. Current Incorrect analytics use the same unresolved flag.

The local PostgreSQL fixture additionally passed: three-SURE resolution; GUESS/UNSURE/null non-advancement; wrong reset/re-entry; cross-mode Practice/Smart Recall/Active Recall/QBank Test recording; duplicates; historical explicit-confidence reconstruction; late-event protection; removal of only mistake priority with due/bookmark eligibility retained.

The indexing pilot can begin independently: this work changes learner-state handling, while the pilot can read existing question content and canonical IDs. It does not require the migration or deployment to begin. No indexing work was started as part of this final change.

## Performance

History: at most one bounded aggregate request per visited 40-question group, using the existing user/question/time index. The final Incorrect rule adds a small partial index and one bounded database-side lookup per new recorded outcome; it adds no browser requests or render-time recalculation. No history fetch on Home and no full attempt log transferred. Counts: one small JSON result with three numbers, using only the current user's learning-state rows. A read-only live query sample took about 3 ms of database execution (not a browser/network latency guarantee). Test submission: one browser RPC instead of submission plus one recording RPC per answered question. Database work remains proportional to answered questions, inside the transaction.

## Verification

Passed locally:

- `scripts/question-history-test.mjs`: lazy batches, in-flight deduplication, late response protection, account isolation, unavailable state, actual Home rendering/navigation handlers.
- `scripts/question-history-db-test.mjs`: real temporary PostgreSQL execution with PGlite; replay/conflict handling, unanswered exclusion, snapshot multi-answer scoring, atomic rollback, immutable completed scores, late-state protection, ownership isolation, bounded reads, bookmark/mark preservation, actual Active Recall wrapper and same-question/concept-sibling late-event guards. Existing snapshot-scoring SQL regression also passed. The older SRM function is a call spy in this fixture; its scheduling implementation was not changed.
- Existing study-reliability, Active Recall model, final Smart Recall, session timer and source-review tests passed. Reliability tests now also cover shared mode routing, stable retry IDs, and blocking advancement after a failed sync.
- JavaScript syntax and whitespace checks passed. DOM behavior uses fixtures; no authenticated live browser end-to-end run or deployment was performed.

The new migration is `supabase/migrations/20261018164848_minimal_question_history.sql`. Local reproduction: install `@electric-sql/pglite@0.3.14` outside the app runtime and run `PGLITE_PATH=/absolute/path/to/pglite/dist/index.js node scripts/question-history-db-test.mjs`.

## Release status

Not deployed. No live schema/data writes were made. After explicit deployment approval, apply both local history migrations in order before publishing the changed frontend; it depends on the existing snapshot-scoring and Active Recall migrations. The frontend asset version is bumped for cache refresh. No production dependency was added.
