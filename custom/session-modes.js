/* Overlay for QBank Hub. Does not change the original code: it only rearranges
   what the app has already drawn. Works together with the small hooks that
   custom/apply.mjs adds to app.js. */
(() => {
  'use strict';
  const app = document.getElementById('app');
  if (!app) return;

  const REVIEW_SECONDS = 60;
  const $ = (selector, root = app) => root.querySelector(selector);

  /* 1. Start screen: two big buttons, Review mode and Test mode. */
  function enhanceReady() {
    const start = $('.ready-card [data-action="start-pending-test"]');
    if (!start || $('.qb-modes') || !/test/i.test(start.textContent)) return;

    const metrics = [...app.querySelectorAll('.ready-card .metric')];
    const count = parseInt(metrics.find((m) => /questions/i.test(m.textContent))?.querySelector('b')?.textContent, 10) || 0;
    metrics.forEach((m) => {
      if (/^\s*(per question|total target|mode)/i.test(m.querySelector('span')?.textContent || '')) m.hidden = true;
    });
    const intro = $('.page-heading p');
    if (intro) intro.textContent = 'Choose how you want to work through this set.';

    const minutes = `${count} minute${count === 1 ? '' : 's'}`;
    const box = document.createElement('div');
    box.className = 'qb-modes';
    box.innerHTML =
      '<button type="button" class="qb-mode qb-mode-review" data-qb-mode="practice">' +
        '<b>Review mode</b>' +
        '<span>60 seconds for each question. The answer and explanation appear as soon as you choose, or when the time is up.</span>' +
      '</button>' +
      '<button type="button" class="qb-mode qb-mode-test" data-qb-mode="test">' +
        '<b>Test mode</b>' +
        `<span>${count ? minutes + ' for the whole set' : 'One timer for the whole set'} (60 seconds × ${count || 'number of'} questions). Answers and explanations come after you submit.</span>` +
      '</button>';
    start.hidden = true;
    start.before(box);
  }

  app.addEventListener('click', (event) => {
    const button = event.target.closest('[data-qb-mode]');
    if (!button) return;
    const start = $('.ready-card [data-action="start-pending-test"]');
    if (!start) return;
    window.__qbankMode = button.dataset.qbMode;
    const all = app.querySelectorAll('[data-qb-mode]');
    all.forEach((b) => { b.disabled = true; });
    start.click();
    setTimeout(() => all.forEach((b) => { b.disabled = false; }), 5000);
  });

  /* 2. Question screen: navigator above the question, tools between Previous and Next. */
  function centreCurrent(layout) {
    const strip = $('.palette', layout);
    const current = strip && strip.querySelector('.current');
    if (!strip || !current) return;
    requestAnimationFrame(() => {
      strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    });
  }

  /* 3. The line above the question.
        Review mode: a 60 s timer moving left to right.
        Test mode: the app's own progress through the set (left unchanged). */
  function animateBar(progress) {
    if (!progress || progress.dataset.qbKind !== 'practice') return;
    const bar = progress.firstElementChild;
    if (!bar) return;
    const revealed = progress.dataset.qbReveal === '1';
    const timedOut = progress.dataset.qbTimeout === '1';
    const match = /^(\d+):(\d+)$/.exec((document.getElementById('question-timer')?.textContent || '').trim());
    const left = timedOut ? 0 : match ? Number(match[1]) * 60 + Number(match[2]) : REVIEW_SECONDS;
    const used = Math.min(1, Math.max(0, (REVIEW_SECONDS - left) / REVIEW_SECONDS));

    progress.classList.add('qb-timer-line');
    progress.classList.toggle('qb-frozen', revealed);
    progress.classList.toggle('qb-warn', !revealed && left <= 15 && left > 8);
    progress.classList.toggle('qb-low', !revealed && left <= 8);

    bar.style.transition = 'none';
    bar.style.width = `${used * 100}%`;
    if (!revealed && left > 0) {
      void bar.offsetWidth;
      bar.style.transition = 'width 1s linear';
      bar.style.width = `${Math.min(100, (used + 1 / REVIEW_SECONDS) * 100)}%`;
    }
  }

  function enhanceQuestion() {
    const layout = $('.question-layout');
    if (!layout) {
      delete document.body.dataset.qbKind;
      return;
    }
    const card = $('.question-card', layout);
    const progress = card && $('.progress', card);
    document.body.dataset.qbKind = progress?.dataset.qbKind || '';

    if (card && !card.dataset.qbArranged) {
      const navigator = $('.palette-card', layout);
      const tools = $('.question-tools', layout);
      const actions = $('.question-actions', card);
      const next = actions && actions.querySelector('[data-action="next"]');
      const anchor = progress || $('.question-stem', card);

      if (navigator && anchor) anchor.before(navigator);
      if (tools && next) next.before(tools);
      // icon-only buttons on small screens still need a name for screen readers and long-press
      if (tools) tools.querySelectorAll('.tool-button').forEach((b) => {
        const label = b.textContent.replace(/^\s*\S\s*/, '').trim() || b.textContent.trim();
        b.setAttribute('aria-label', label);
        b.title = label;
      });
      const side = $('.question-sidebar', layout);
      if (side && !side.children.length) side.hidden = true;

      card.dataset.qbArranged = '1';
      centreCurrent(layout);
    }
    animateBar(progress);
  }


  /* 4. Grand Test runner (gt-exam-mode.js): same layout, no change to its code.
        Question number list -> navigator strip above the question,
        Clear / Mark for review -> between Previous and Next. */
  function enhanceGT() {
    const gt = $('#gt-exam');
    const actions = gt && $('.gt-browse-actions', gt);
    if (!actions || actions.dataset.qbGt) return;
    const select = actions.querySelector('[data-position]');
    const next = actions.querySelector('[data-next]');
    const stem = $('.question-stem', gt);
    if (!select || !next || !stem) return;

    gt.classList.add('question-card', 'qb-gt');
    const options = [...select.options];

    const nav = document.createElement('section');
    nav.className = 'palette-card';
    const strip = document.createElement('div');
    strip.className = 'palette';
    options.forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = parseInt(o.text, 10);
      b.className = 'palette-item ' + (/answered/.test(o.text) || /review/.test(o.text) ? 'answered' : 'unattempted') +
        (/review/.test(o.text) ? ' marked' : '') + (o.selected ? ' current' : '');
      b.setAttribute('aria-label', 'Question ' + b.textContent);
      b.disabled = select.disabled;
      b.addEventListener('click', () => {
        select.value = o.value;
        select.dispatchEvent(new Event('change'));
      });
      strip.appendChild(b);
    });
    nav.appendChild(strip);

    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('i');
    fill.style.width = ((select.selectedIndex + 1) / options.length) * 100 + '%';
    bar.appendChild(fill);

    stem.before(nav, bar);
    select.hidden = true;

    const row = $('[data-clear]', gt)?.closest('.row');
    if (row) { row.classList.add('question-tools'); next.before(row); }
    actions.dataset.qbGt = '1';
    centreCurrent(gt);
  }

  /* Re-run after every redraw (and every timer tick, which is cheap). */
  const observer = new MutationObserver(run);
  function run() {
    observer.disconnect();
    try {
      enhanceReady();
      enhanceQuestion();
      enhanceGT();
    } catch (error) {
      console.error('[custom]', error);
    }
    observer.observe(app, { childList: true, subtree: true, characterData: true });
  }
  run();
})();
