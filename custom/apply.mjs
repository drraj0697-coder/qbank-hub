// Re-applies the Review / Test mode hooks to the ORIGINAL files.
// Safe to run many times: a patch that is already applied is skipped.
// If upstream changed a line we patch, the script stops and says which one.
//
// Usage (repo root):   node custom/apply.mjs
// Test on other paths: node custom/apply.mjs path/to/app.js path/to/index.html
import { readFileSync, writeFileSync } from 'node:fs';

const APP = process.argv[2] || 'app/app.js';
const INDEX = process.argv[3] || 'index.html';

const appPatches = [
  {
    name: 'Time per question = 60 s',
    from: 'const TARGET_SECONDS = 50;',
    to: 'const TARGET_SECONDS = 60;',
  },
  {
    name: 'Question timer limit follows TARGET_SECONDS',
    from: '?? 50) * 1000) : 50000; }',
    to: '?? 50) * 1000) : TARGET_SECONDS * 1000; }',
  },
  {
    name: 'Start button can choose Review (practice) or Test mode',
    from: 'const questionSet = state.pendingSet; if (!questionSet) return;',
    to: "const questionSet = state.pendingSet; if (!questionSet) return;\n  { const qbMode = window.__qbankMode; window.__qbankMode = null; if ((qbMode === 'practice' || qbMode === 'test') && questionSet.mode !== 'recall') { questionSet.mode = qbMode; questionSet.autoSubmit = qbMode === 'test'; } } /*qb-custom*/",
  },
  {
    name: 'Review mode opens the explanation straight away (new session)',
    from: 'explanationOpen: false, completedReview: false,',
    to: "explanationOpen: mode === 'practice', completedReview: false,",
  },
  {
    name: 'Review mode keeps the explanation open when moving between questions',
    from: 'active.explanationOpen = false;',
    to: "active.explanationOpen = active.kind === 'practice';",
    count: 3,
  },
  {
    name: 'Reveal the answer when the 60 s run out',
    from: "const reveal = active.completedReview || ['practice', 'recall'].includes(active.kind) && Boolean(answer?.selected_option)",
    to: "const reveal = active.completedReview || answer?.timeout_reveal || ['practice', 'recall'].includes(active.kind) && Boolean(answer?.selected_option)",
  },
  {
    name: 'Timer keeps running in Test mode, stops after reveal in Review mode',
    from: 'const timerShouldTick = timerRunning && !answer?.selected_option && active.questionTimeRemainingSeconds !== 0;',
    to: "const timerShouldTick = timerRunning && (active.kind === 'test' || (!answer?.selected_option && !answer?.timeout_reveal && active.questionTimeRemainingSeconds !== 0));",
  },
  {
    name: 'Progress bar carries mode info for the overlay',
    from: '<div class="progress"><i style="width:${((active.index + 1) / active.questions.length) * 100}%"></i></div>',
    to: '<div class="progress" data-qb-kind="${active.kind}" data-qb-reveal="${reveal ? 1 : 0}" data-qb-timeout="${answer?.timeout_reveal ? 1 : 0}"><i style="width:${((active.index + 1) / active.questions.length) * 100}%"></i></div>',
  },
  {
    name: 'Review mode: auto-reveal when the 60 s are over',
    from: "if(totalTimeRemaining(active)===0&&active.kind==='test'&&active.auto_submit)submitActive(true);",
    to: "if(totalTimeRemaining(active)===0&&active.kind==='test'&&active.auto_submit)submitActive(true);\n  if(active.kind==='practice'&&questionTimeRemaining(active)===0){const q=activeQuestion(),a=active.answers[q?.id];const done=a?.selected_option&&(a.submitted||correctKeys(q).length===1);if(q&&!done&&!a?.timeout_reveal){active.answers[q.id]={...(a||{}),selected_option:a?.selected_option||'',submitted:Boolean(a?.selected_option),timeout_reveal:true,time_spent_seconds:TARGET_SECONDS};active.explanationOpen=true;pauseAttemptTimers(active);renderActive();return;}} /*qb-custom*/",
  },
  {
    name: 'Test mode: choosing an answer does not pause the shared timer',
    from: 'if (selectedOption && !existing?.selected_option) pauseAttemptTimers(active, selectedAt);',
    to: "if (selectedOption && !existing?.selected_option && active.kind !== 'test') pauseAttemptTimers(active, selectedAt);",
  },
  {
    name: 'Test mode: shared timer keeps running when moving between questions',
    from: "if (active.kind !== 'browse' && !destinationAnswer?.selected_option) resumeTotalTimer(active, active.questionStartedAt);",
    to: "if (active.kind !== 'browse' && (active.kind === 'test' || !destinationAnswer?.selected_option)) resumeTotalTimer(active, active.questionStartedAt);",
  },
];

const indexPatches = [
  {
    name: 'Load theme.css',
    done: 'custom/theme.css',
    from: '</head>',
    to: '  <link rel="stylesheet" href="./custom/theme.css?v=1" />\n  </head>',
  },
  {
    name: 'Load session-modes.js',
    done: 'custom/session-modes.js',
    from: '</body>',
    to: '  <script src="./custom/session-modes.js?v=1" defer></script>\n  </body>',
  },
];

function run(file, patches) {
  let text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fix = (s) => s.replace(/\n/g, eol);
  let failed = 0;
  for (const p of patches) {
    const from = fix(p.from), to = fix(p.to), count = p.count || 1;
    const applied = p.done ? text.includes(p.done) : text.includes(to);
    if (applied) { console.log(`  already applied  ${p.name}`); continue; }
    const found = text.split(from).length - 1;
    if (found !== count) {
      console.error(`  FAILED           ${p.name}  (expected ${count} match, found ${found})`);
      failed++; continue;
    }
    text = text.split(from).join(to);
    console.log(`  applied          ${p.name}`);
  }
  if (!failed) writeFileSync(file, text);
  return failed;
}

console.log(`Patching ${APP}`);
let failures = run(APP, appPatches);
console.log(`Patching ${INDEX}`);
failures += run(INDEX, indexPatches);
if (failures) {
  console.error(`\n${failures} patch(es) no longer match the upstream code. Nothing was written to the file(s) that failed.`);
  process.exit(1);
}
console.log('\nAll customisations are in place.');
