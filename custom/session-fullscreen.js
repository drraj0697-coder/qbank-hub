/*
 * QBank Hub session focus mode
 *
 * This file is intentionally independent of app/app.js.  It watches the UI
 * after each render and adds controls without changing the question engine,
 * timers, answer saving, or Grand Test database rules.
 */
(() => {
  'use strict';

  const APP = '#app';
  const PREFERENCE_KEY = 'qbank-session-fullscreen-preference';
  const FOCUS_CLASS = 'qbank-session-focus';
  const SUPPORTS_FULLSCREEN = Boolean(
    document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
  );

  const fullScreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const isFocused = () => Boolean(fullScreenElement());

  function getPreference() {
    try { return localStorage.getItem(PREFERENCE_KEY) === 'true'; }
    catch { return false; }
  }

  function setPreference(value) {
    try { localStorage.setItem(PREFERENCE_KEY, String(Boolean(value))); }
    catch { /* Private browsing can block storage; the current page still works. */ }
  }

  function announce(message, error = false) {
    let region = document.querySelector('[data-session-fullscreen-status]');
    if (!region) {
      region = document.createElement('div');
      region.className = 'session-fullscreen-status';
      region.dataset.sessionFullscreenStatus = '';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.querySelector(APP)?.append(region);
    }
    region.textContent = message;
    region.classList.toggle('is-error', error);
    window.clearTimeout(region.__removeTimer);
    region.__removeTimer = window.setTimeout(() => region.remove(), 4200);
  }

  async function enterFocus() {
    if (!SUPPORTS_FULLSCREEN) {
      announce('Full screen is not available in this browser. Open the site in Safari or a current browser.', true);
      return false;
    }
    if (isFocused()) return true;
    const target = document.querySelector(APP) || document.documentElement;
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    try {
      await Promise.resolve(request.call(target));
      return true;
    } catch (error) {
      announce('Full screen could not start. Please try the Full screen button again.', true);
      return false;
    }
  }

  async function exitFocus() {
    if (!isFocused()) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try { await Promise.resolve(exit.call(document)); }
    catch { announce('Full screen could not close. Press Esc or use your browser controls.', true); }
  }

  function refreshButtons() {
    const active = isFocused();
    document.documentElement.classList.toggle(FOCUS_CLASS, active);
    document.querySelectorAll('[data-session-fullscreen-toggle]').forEach((button) => {
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
      button.innerHTML = active
        ? '<span aria-hidden="true">⤢</span><span>Exit full screen</span>'
        : '<span aria-hidden="true">⛶</span><span>Full screen</span>';
    });
  }

  function makeToggle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary compact session-fullscreen-toggle';
    button.dataset.sessionFullscreenToggle = '';
    button.addEventListener('click', () => (isFocused() ? exitFocus() : enterFocus()));
    return button;
  }

  function addToggle(container, placement = 'append') {
    if (!container || container.querySelector('[data-session-fullscreen-toggle]')) return;
    const wrap = document.createElement('div');
    wrap.className = 'session-fullscreen-control';
    wrap.append(makeToggle());
    if (placement === 'prepend') container.prepend(wrap);
    else container.append(wrap);
  }

  function addSessionPreference(card, buttonSelector, label = 'Open this session in full screen') {
    if (!card || card.querySelector('[data-session-fullscreen-preference]')) return;
    const startButton = card.querySelector(buttonSelector);
    if (!startButton) return;

    const preference = document.createElement('label');
    preference.className = 'session-fullscreen-preference';
    preference.innerHTML = `<input type="checkbox" data-session-fullscreen-preference ${getPreference() ? 'checked' : ''} />
      <span><b>${label}</b><small>You can always leave with the on-screen button or Esc.</small></span>`;
    preference.querySelector('input').addEventListener('change', (event) => setPreference(event.currentTarget.checked));
    const actionRow = startButton.closest('.row, .builder-footer');
    if (actionRow) actionRow.before(preference);
    else startButton.before(preference);
  }

  function decorateStandardSession() {
    const header = document.querySelector('.question-header');
    const layout = document.querySelector('.question-layout');
    if (!header || !layout) return;

    // Applies to Test, Practice, Recall, an in-session review and browsed sets.
    addToggle(header);
  }

  function decorateGrandTest() {
    const host = document.querySelector('#gt-exam');
    if (!host) return;
    const heading = host.querySelector(':scope > .section-heading');
    if (heading) addToggle(heading);
  }

  function decorateStartScreens() {
    const ready = document.querySelector('.ready-card');
    if (ready) addSessionPreference(ready, '[data-action="start-pending-test"]');

    // Grand Tests use a direct onclick handler, so they do not carry data-action.
    document.querySelectorAll('.builder-card').forEach((card) => {
      if (card.querySelector('[data-gt-begin]')) {
        addSessionPreference(card, '[data-gt-begin]', 'Open the Grand Test in full screen');
      }
    });
  }

  function decorate() {
    decorateStandardSession();
    decorateGrandTest();
    decorateStartScreens();
    refreshButtons();
  }

  function startInFullscreenIfPreferred(event) {
    const trigger = event.target.closest('[data-action="start-pending-test"], [data-gt-begin], [data-qb-mode]');
    if (!trigger || trigger.disabled) return;
    const card = trigger.closest('.ready-card, .builder-card');
    const checkbox = card?.querySelector('[data-session-fullscreen-preference]');
    if (checkbox?.checked) void enterFocus();
  }

  // Capture keeps the request in the same user gesture even though the app's
  // own start handler performs asynchronous work before it renders a question.
  document.addEventListener('click', startInFullscreenIfPreferred, true);
  document.addEventListener('fullscreenchange', refreshButtons);
  document.addEventListener('webkitfullscreenchange', refreshButtons);
  document.addEventListener('fullscreenerror', () => announce('Full screen could not start. Please try again.', true));
  document.addEventListener('webkitfullscreenerror', () => announce('Full screen could not start. Please try again.', true));

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; decorate(); });
  });

  function boot() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    decorate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
