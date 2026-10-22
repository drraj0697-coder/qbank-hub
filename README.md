# Custom layer for QBank Hub

Upload the `custom/` folder to the ROOT of your repo (next to `index.html`):

    custom/theme.css          colours + simpler layout
    custom/session-modes.js   Review/Test buttons, navigator above question, tools between Previous/Next
    custom/apply.mjs          adds the small hooks to app/app.js and index.html
    custom/apply.sh           runs apply.mjs (used by the sync workflow)

Then add `.github/workflows/sync-upstream.yml` (contents in sync-upstream.yml) and run
Actions -> Sync upstream -> Run workflow. It merges the original repo, runs apply.mjs and pushes.
If you bump the look later, change `?v=1` on the two lines apply.mjs adds to index.html.
