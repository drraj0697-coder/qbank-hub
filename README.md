# Full-screen add-on for your existing custom QBank Hub fork

This package is specifically for the existing fork that already contains:

```text
custom/theme.css
custom/session-modes.js
custom/apply.mjs
custom/apply.sh
.github/workflows/sync-upstream.yml
```

It does **not** replace `index.html`, `theme.css`, `session-modes.js`, or `apply.sh`.

## Upload exactly these three files

```text
custom/apply.mjs                  (replace the existing one)
custom/session-fullscreen.js      (new)
custom/session-fullscreen.css     (new)
```

## Then do this on GitHub

1. Commit those three uploaded files.
2. Open **Actions → Sync upstream → Run workflow**.
3. Wait for the green tick.

During that run, `custom/apply.mjs` automatically adds the two loading tags to `index.html` **while keeping** the existing tags for `theme.css` and `session-modes.js`.  You do not need to edit `index.html` yourself.

After the workflow push, Vercel redeploys normally.

## Included behaviour

- Full screen / Exit full screen control in standard Test, Review/Practice, Recall, completed Review, and browse sessions.
- The same control in Grand Test attempts.
- Optional remembered start-in-full-screen choice on the standard ready screen and Grand Test start screen.
- iPad/phone-focused layout. The normal navigation hides only while in full screen.
- No change to Supabase, question data, answers, scoring, or timers.

## Check after deployment

On an iPad in Safari:

1. Open a regular question set, choose Review or Test, and tap **Full screen**.
2. Leave with **Exit full screen** or `Esc` if using a keyboard.
3. Open one Grand Test attempt and test the same control.

The update was syntax-checked and `custom/apply.mjs` was run twice against the current custom fork: it added the tags once and made no duplicate tags on the second run.
