import {createQuestionHistory,historyLabel} from './question-history.mjs';
import {studyIcon} from './study-icons.js';
import { compactStudy } from './compact-study.js?v=20261017-study1';
import { resolveImportedMedia } from './imported-media.js?v=marrow-qbank-v1';
import {createActiveRecall} from './active-recall.js';
import {safeRecallMetadata,recallConcept,isRecallSelection,studyContext} from './study-flow.mjs';
import { isCerebellum, cerebellumMedia, cerebellumNotice, essentialMediaReady, bindCerebellumMedia } from './cerebellum-media.js?v=20261004-v1';
import {renderContent,questionContent,installMediaFailures} from './media-content.js?v=20261003-media1';
import { createSmartRecall } from './smart-recall.js?v=20261005-finalrecall1';
import { recallQuestionLimit, LABELS as SMART_RECALL_LABELS } from './smart-recall-model.mjs';
import { createGlobalImportance } from './global-importance.js?v=20261017-study1';
import {readClock,freezeClock,runClock,checkpointClock,initialClock} from './session-timers.js?v=20260926-recall1';
import { createGTExamMode } from './gt-exam-mode.js?v=20261003-media1';
import { createGrandTests } from './grand-tests.js?v=20261003-media1';
import { db, initError, isMissingTable, requireUser, withAuthTimeout } from './supabase.js';
import { analyticsActionQuestionIds, analyticsMetadataCapabilities, analyticsPlatformDisagreement, analyticsStudyPriority, analyticsTopicSubtopicRedundant, assertValidation, buildTaxonomyIndex, canonicalCorrectOptionKeys, filterAnalyticsPopulation, isCanonicalAnswerCorrect, normalizeOptionKeys, resolveTaxonomyCascade, validateGeneratedQuestionSet, validateQuestionStateBindings, validateResumeSnapshot, validateSrmQueue } from './validation.js?v=20260902-srm2';
import { runTaxonomyDomRegression } from './taxonomy-dom-regression.js?v=20260902-canonical-subject';

const root = document.querySelector('#app');
const TARGET_SECONDS = 60;
const PAGE_SIZE = 500;
const RECALL_BATCH_SIZE = 20;
const metadataRequests = new Map();
const facetCache = new Map();
const payloadRequests = new Map();
const populationCache = new Map();
let recallGeneration = 0;
function recallTimerSeconds() {
  try { const value = localStorage.getItem(`qbank-recall-timer:${state.user?.id}`); return ['0', '50', '55'].includes(value) ? Number(value) : 50; } catch { return 50; }
}
function recallTimerSetting(value = recallTimerSeconds()) {
  return `<label>Recall timer <select data-recall-timer aria-label="Recall timer">${[0, 50, 55].map(n => `<option value="${n}" ${n === value ? 'selected' : ''}>${n ? n + ' sec' : 'Off'}</option>`).join('')}</select></label>`;
}
const filterCountRequests = new WeakMap();
const state = {
  user: null,
  route: 'home',
  meta: { subjects: [], platforms: [], systems: [], topics: [], subtopics: [], sourceTests: [] },
  active: null,
  pendingSet: null,
  actionSets: new Map(),
  lastBuilder: null,
  reviewFilters: null,
  analyticsFilters: null,
  analyticsBreakdown: null,
  analyticsSection: 'overview',
  analyticsSubjectId: null,
  analyticsPyqBreakdown: null,
  analyticsView: null,
  analyticsPyqSet: new Set(),
  analyticsSnapshot: null,
  pyqCatalog: null,
  coreBtrCatalog: null,
  recallFilters: { platform_id: '', subject_id: '', scope: 'all' },
  recallQueue: [],
  payloadCache: new Map(),
  timer: null,
  filterTimer: null,
  features: { learning: true, subtopics: true, sessions: true, personal: true, srm: true },
};

const e = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '—';
const route = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'home';
const goToHash = (target) => { if (location.hash === target) render(); else location.hash = target; };
const unique = (rows, key = 'question_id') => [...new Set((rows || []).map((row) => row[key]).filter(Boolean))];
const byId = (rows) => new Map((rows || []).map((row) => [String(row.id), row]));
const keyList = (value) => normalizeOptionKeys(value);
const correctKeys = (question) => canonicalCorrectOptionKeys(question);
const correctKey = (question) => correctKeys(question)[0] || '';
const selectedKey = (answer) => String(answer?.selected_option || '').toUpperCase();
const selectedKeys = (answer) => keyList(answer?.selected_option);
const isAnswerCorrect = (question, answer) => isCanonicalAnswerCorrect(question, answer);
const intersect = (left, right) => left == null ? new Set(right) : new Set([...left].filter((value) => right.has(value)));

function toast(text, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  document.querySelector('#toast-region')?.append(node);
  setTimeout(() => node.remove(), 4200);
}

function invalidateLearnerCaches() { analyticsTabCache.clear(); activeRecall.invalidate(); state.analyticsSnapshot = null; facetCache.clear(); populationCache.clear(); }

function safeUrl(value, image = false) {
  try {
    const parsed = new URL(value, location.href);
    const allowed = image ? ['http:', 'https:', 'data:'] : ['http:', 'https:', 'mailto:'];
    return allowed.includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

function richHtml(value) { return renderContent(value); }
installMediaFailures(root);

// Old session snapshots omitted image arrays. Recover references for only the visible question.
async function recoverSnapshotMedia(active, question) {
  if (!question.restoreMedia || question.mediaLoading) return;
  question.mediaLoading = true;
  try {
    const [source] = await loadQuestionsByIds([question.id], active.filters || {});
    if (!source) throw new Error('Question media source is unavailable');
    question.question_images = source.question_images || [];
    question.explanation_images = source.explanation_images || [];
    question.image_url = source.image_url || question.image_url || '';
    question.audio = source.audio || source.audio_url || null;
    question.video_url = source.video_url || '';
    question.restoreMedia = false;
    question.mediaError = false;
  } catch { question.mediaError = true; }
  finally { question.mediaLoading = false; }
  if (state.active === active && activeQuestion()?.id === question.id && active.solvingVisible !== false) renderActive();
}

function layout(content) {
  const nav = [['home', 'Home'], ['qbank', 'QBank'], ['tests', 'Test'], ['global-importance', 'Global Importance'],    ['review', 'Incorrect / Saved'], ['analytics', 'Analytics'], ['grand-test-analytics', 'GT Analytics'], ['my-bank', 'My Bank']];
  root.innerHTML = `<header class="topbar"><div class="shell topbar-row"><a class="brand" href="#/home">QBank <span>Hub</span></a><div class="user-actions"><span class="email">${e(state.user?.email)}</span><button class="button secondary compact" data-action="signout">Sign out</button></div></div><nav class="shell nav" aria-label="Primary navigation">${nav.map(([id, label]) => `<a href="#/${id}" class="${state.route === id ? 'active' : ''}">${label}</a>`).join('')}</nav></header><main class="shell">${content}</main>`;
}

function loading(message = 'Loading QBank Hub…') {
  root.innerHTML = `<main class="shell"><div class="card empty"><span class="spinner" aria-hidden="true"></span>${e(message)}</div></main>`;
}

function featureNotice(text) {
  return `<div class="notice"><b>Setup required</b><p>${e(text)}</p></div>`;
}

async function optional(query, feature) {
  const result = await query;
  if (result.error && isMissingTable(result.error)) {
    if (feature) state.features[feature] = false;
    return { data: [], count: 0, error: result.error, missing: true };
  }
  if (result.error) console.warn(result.error.message);
  return result;
}

async function loadMeta(force = false, scope = '') {
  const basic = scope!=='full' && ['recall','global-importance','importance-subject','importance-recall','history','tests','marrow-pyqs','analytics'].includes(route());
  const homeOnly=scope!=='full' && route()==='home';
  const key = `${state.user?.id}:${basic ? 'basic' : homeOnly ? 'home' : 'full'}`;
  if (force) metadataRequests.clear();
  if (metadataRequests.has(key)) return metadataRequests.get(key);
  const request = (async () => {
    if (!basic) return loadFullMeta(force,!homeOnly);
    if (state.meta.subjects.length && state.meta.platforms.length) return;
    const [subjects, platforms] = await Promise.all([db.from('subjects').select('id,name').order('name'), db.from('platforms').select('id,name').order('name')]);
    if (subjects.error || platforms.error) throw subjects.error || platforms.error;
    state.meta = { ...state.meta, subjects: subjects.data || [], platforms: platforms.data || [] };
  })();
  metadataRequests.set(key, request);
  try { return await request; } catch (error) { metadataRequests.delete(key); throw error; }
}

async function loadFullMeta(force = false, includeSources = true) {
  if (!force && state.meta.fullLoaded) return;
  const [subjects, platforms, platformSubjects, systems, topics, subtopics, sourceTests] = await Promise.all([
    db.from('subjects').select('id,name').order('name'),
    db.from('platforms').select('id,name').order('name'),
    db.from('platform_subjects').select('id,subject_id'),
    optional(db.from('systems').select('id,name,platform_subject_id').order('sort_order').order('name')),
    optional(paged(() => db.from('topics').select('id,name,platform_subject_id,system_id,parent_topic_id').order('sort_order').order('name').order('id'))),
    optional(db.from('subtopics').select('id,name,topic_id').order('sort_order').order('name'), 'subtopics'),
    includeSources ? optional(paged(() => db.from('qbank_source_tests').select('id,title,platform_id,subject_id,sequence,declared_question_count,is_pyq,source_path').order('sequence').order('id')), 'hybrid') : Promise.resolve(state.meta.sourceTests),
  ]);
  if (subjects.error) throw subjects.error;
  if (platforms.error) throw platforms.error;
  if (platformSubjects.error) throw platformSubjects.error;
  // A slower Home-only request must not erase modules loaded by a newer builder.
  if (!includeSources && state.meta.fullLoaded) return;
  const subjectByPlatformSubject = new Map((platformSubjects.data || []).map((row) => [row.id, row.subject_id]));
  const hydratedTopics = (topics.data || topics || []).map((topic) => ({ ...topic, subject_id: subjectByPlatformSubject.get(topic.platform_subject_id) || '' }));
  const topicById = new Map(hydratedTopics.map((topic) => [topic.id, topic]));
  state.meta = {
    fullLoaded: includeSources, subjects: subjects.data || [], platforms: platforms.data || [],
    systems: (systems.data || []).map((system) => ({ ...system, subject_id: subjectByPlatformSubject.get(system.platform_subject_id) || '' })),
    topics: hydratedTopics.filter((topic) => !topic.parent_topic_id),
    subtopics: (subtopics.data || []).map((subtopic) => ({ ...subtopic, subject_id: topicById.get(subtopic.topic_id)?.subject_id || '' })),
    sourceTests: (sourceTests.data || sourceTests || []).map((test) => ({ ...test, name: test.title })),
  };
}

async function resolvePopulation(filters, options = {}) {
  const cacheable = options.includeIds === false;
  if (!cacheable) return fetchPopulation(filters, options);
  const key = JSON.stringify([state.user?.id, filters, options]);
  const cached = populationCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return cached.promise;
  const promise = fetchPopulation(filters, options);
  populationCache.set(key, { at: Date.now(), promise });
  if (populationCache.size > 32) populationCache.delete(populationCache.keys().next().value);
  try { return await promise; } catch (error) { populationCache.delete(key); throw error; }
}
async function fetchPopulation(filters, { includeIds = true, limit = null, offset = 0, order = 'canonical' } = {}) {
  const result = await db.rpc('qbank_resolve_population', {
    p_filters: filters || {}, p_include_ids: includeIds, p_limit: limit, p_offset: offset, p_order: order,
  });
  if (result.error) throw result.error;
  return { count: Number(result.data?.count || 0), questionIds: (result.data?.question_ids || []).map(String) };
}

async function resolveFacets(filters) {
  const key = JSON.stringify([state.user?.id, filters]);
  const cached = facetCache.get(key);
  if (cached && Date.now() - cached.at < 30000) return cached.promise;
  const promise = fetchFacets(filters);
  facetCache.set(key, { at: Date.now(), promise });
  if (facetCache.size > 32) facetCache.delete(facetCache.keys().next().value);
  try { return await promise; } catch (error) { facetCache.delete(key); throw error; }
}
async function fetchFacets(filters) {
  const result = await db.rpc('qbank_filter_facets_fast', { p_filters: filters || {} });
  if (result.error) throw result.error;
  const data = result.data || {};
  return {
    count: Number(data.count || 0),
    platforms: new Set((data.platforms || []).map(String)), subjects: new Set((data.subjects || []).map(String)),
    systems: new Set((data.systems || []).map(String)), topics: new Set((data.topics || []).map(String)),
    subtopics: new Set((data.subtopics || []).map(String)), source_tests: new Set((data.source_tests || []).map(String)),
    exams: (data.exams || []).map(String), years: (data.years || []).map(String), sessions: (data.sessions || []).map(String),
  };
}

async function resolvePopulationGroups(filters, dimension) {
  const result = await db.rpc('qbank_population_groups', { p_filters: filters || {}, p_dimension: dimension });
  if (result.error) throw result.error;
  return (result.data || []).map((group) => ({ ...group, id: String(group.id), questionIds: (group.question_ids || []).map(String) }));
}

function multiPicker(name, label, items, empty = `No ${label.toLowerCase()} available`) {
  return `<div class="field multi-field" data-multi-field="${e(name)}"><label>${e(label)}</label><details class="multi-picker"><summary><span data-multi-summary>${e(`All ${name}`)}</span></summary><div class="multi-menu">${items.length ? items.map((item) => `<label class="check-row" data-taxonomy-label="${e(item.name)}" data-subject="${e(item.subject_id || '')}" data-topic="${e(item.topic_id || '')}"><input type="checkbox" name="${e(name)}" value="${e(item.id)}" /> <span>${e(item.name)}</span></label>`).join('') : `<span class="subtle">${e(empty)}</span>`}</div></details></div>`;
}

function statusPicker(revision = false) {
  const values = revision
    ? [['incorrect', 'Incorrect'], ['bookmarked', 'Bookmarked'], ['marked', 'Marked for review'], ['recall_due', 'Recall due'], ['difficult', 'Personally difficult'], ['confident_wrong', 'Confidently wrong'], ['slow', 'Slow >50 sec'], ['my_content', 'My Content']]
    : [['new', 'Unattempted'], ['incorrect', 'Incorrect'], ['correct', 'Correct'], ['bookmarked', 'Bookmarked'], ['marked', 'Marked for review'], ['recall_due', 'Recall due'], ['my_content', 'My Content']];
  return `<fieldset class="field wide status-field"><legend>Question status</legend><div class="chip-checks"><label><input type="checkbox" name="statuses" value="all" checked /> <span>All</span></label>${values.map(([value, label]) => `<label><input type="checkbox" name="statuses" value="${value}" /> <span>${label}</span></label>`).join('')}</div></fieldset>`;
}

function filterFields({ revision = false, sourceTests = false } = {}) {
  return `${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics, 'Choose a subject first')}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics, 'Choose a topic first')}${sourceTests && state.meta.sourceTests.length ? multiPicker('source_tests', 'Source Tests (optional)', state.meta.sourceTests) : ''}${statusPicker(revision)}<div class="field"><label>PYQ</label><select name="pyq"><option value="">All questions</option><option value="yes">PYQ only</option><option value="no">Non-PYQ</option></select></div><div class="field"><label>Exam year/session</label><input name="year" type="number" min="1950" max="2100" placeholder="e.g. 2024" /></div><div class="field wide"><label>Search question text</label><input name="search" placeholder="e.g. thyroid, ECG, nephrotic" /></div><div class="field wide"><label>Source / collection</label><input name="source" placeholder="Cerebellum, Marrow, PrepLadder, BTR…" /></div>`;
}

function readMulti(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((node) => node.value);
}

function readFilters(form) {
  const raw = Object.fromEntries(new FormData(form));
  const folders=readMulti(form,'source_folders'),explicitTests=readMulti(form,'source_tests');
  const sourceTests=folders.length?state.meta.sourceTests.filter(t=>folders.includes(JSON.stringify([t.platform_id,...(t.source_path||[])]))&&(!explicitTests.length||explicitTests.includes(t.id))).map(t=>t.id):explicitTests;
  return {
    study_sources:readMulti(form,'study_sources'),source_folders:folders,
    platforms: readMulti(form, 'platforms'), subjects: readMulti(form, 'subjects'), systems: readMulti(form, 'systems'),
    topics: readMulti(form, 'topics'), subtopics: readMulti(form, 'subtopics'), statuses: readMulti(form, 'statuses'),
    source_tests: folders.length&&!sourceTests.length?['00000000-0000-0000-0000-000000000000']:sourceTests, exams: readMulti(form, 'exams'), years: readMulti(form, 'years'), sessions: readMulti(form, 'sessions'),
    pyq: form.dataset.marrowPlatform && readMulti(form,'platforms').includes(form.dataset.marrowPlatform) ? 'no' : raw.pyq || '', srm: raw.srm || '', year: raw.year || '', search: raw.search?.trim() || '', source: raw.source?.trim() || '',
  };
}

function setupDependentFilters(form) {
  compactStudy(form,{meta:state.meta,e,practice:async(test,status)=>{
    try {const filters={...readFilters(form),platforms:[test.platform_id],subjects:[],systems:[],topics:[],subtopics:[],source_tests:[test.id],statuses:[status]};await createSession({mode:form.id==='test-form'?'test':'practice',preset:form.dataset.preset||'qbank',title:test.title,filters,requested:'all',autoSubmit:form.id==='test-form',origin:location.hash});}catch(error){toast(error.message||'Could not open this module.','error');}
  },resume:async id=>{try{await resumeSession(id);}catch(error){toast(error.message||'Could not resume this session.','error');}}});

  const update = async () => {
    const requestId = (filterCountRequests.get(form) || 0) + 1;
    filterCountRequests.set(form, requestId);
    const holder = form.querySelector('[data-match-count]');
    if (holder) holder.textContent = 'Counting…';
    const facets = await resolveFacets(readFilters(form));
    if (!form.isConnected || filterCountRequests.get(form) !== requestId) return;
    form.__lastFacets = facets;
    let pruned = false;
    for (const level of ['platforms', 'subjects', 'systems', 'topics', 'subtopics', 'source_tests']) {
      const selected = new Set(readMulti(form, level));
      form.querySelectorAll(`[data-multi-field="${level}"] input`).forEach((input) => {
        const visible = facets[level].has(input.value);
        const row = input.closest('.check-row');
        row.hidden = !visible;
        row.style.display = visible ? '' : 'none';
        const nextChecked = visible && selected.has(input.value);
        if (input.checked !== nextChecked) pruned = true;
        input.checked = nextChecked;
      });
    }
    form.querySelectorAll('[data-multi-field]').forEach((field) => {
      const checked = readMulti(form, field.dataset.multiField);
      field.querySelector('[data-multi-summary]').textContent = checked.length ? `${checked.length} selected` : `All ${field.dataset.multiField}`;
    });
    if (pruned) return update();
    form.dispatchEvent(new Event('study-facets-ready'));
    if (holder) {
      holder.textContent = `${facets.count.toLocaleString()} question${facets.count === 1 ? '' : 's'} match`;
      holder.dataset.count = facets.count;
    }
  };
  form.addEventListener('change', (event) => {
    if (event.target.name === 'statuses') {
      const all = form.querySelector('input[name="statuses"][value="all"]');
      if (event.target.value === 'all' && event.target.checked) form.querySelectorAll('input[name="statuses"]').forEach((input) => { if (input !== all) input.checked = false; });
      else if (event.target.checked && all) all.checked = false;
    }
    clearTimeout(state.filterTimer);
    state.filterTimer = setTimeout(() => { form.__cascadeReady = update().catch((error) => { console.warn(error); const holder = form.querySelector('[data-match-count]'); if (holder) holder.textContent = 'Count unavailable'; }); }, 100);
  });
  form.__cascadeReady = update().catch((error) => { console.warn(error); const holder = form.querySelector('[data-match-count]'); if (holder) holder.textContent = 'Count unavailable'; });
}

async function paged(queryFactory, size = PAGE_SIZE) {
  const rows = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await queryFactory().range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
}

async function statusCandidateIds(filters) {
  const statuses = new Set(filters.statuses || []);
  if (!statuses.size || statuses.has('all') || statuses.has('my_content')) return null;
  const union = new Set(); const add = (values) => values.forEach((value) => union.add(value));
  if (statuses.has('attempted')) add(unique(await paged(() => db.from('question_attempts').select('question_id').eq('user_id', state.user.id))));
  if (statuses.has('bookmarked')) add(unique(await paged(() => db.from('user_question_state').select('question_id').eq('user_id', state.user.id).eq('bookmarked', true))));
  const needsLearning = ['marked', 'incorrect', 'correct', 'recall_due', 'difficult', 'confident_wrong', 'slow'].some((value) => statuses.has(value));
  if (needsLearning) {
    const result = await optional(db.from('user_question_state').select('*').eq('user_id', state.user.id), 'learning');
    const rows = result.data || [];
    if (statuses.has('marked')) add(rows.filter((x) => x.marked_for_review).map((x) => x.question_id));
    if (statuses.has('incorrect')) add(rows.filter((x) => x.last_is_correct === false || x.wrong).map((x) => x.question_id));
    if (statuses.has('correct')) add(rows.filter((x) => x.last_is_correct === true).map((x) => x.question_id));
    if (statuses.has('recall_due')) add(rows.filter((x) => x.srm_active && x.srm_due_at && new Date(x.srm_due_at) <= new Date()).map((x) => x.question_id));
    if (statuses.has('difficult')) add(rows.filter((x) => x.personally_difficult).map((x) => x.question_id));
    if (statuses.has('confident_wrong')) add(rows.filter((x) => x.last_is_correct === false && x.last_confidence === 'sure').map((x) => x.question_id));
    if (statuses.has('slow')) add(rows.filter((x) => x.last_time_seconds > TARGET_SECONDS).map((x) => x.question_id));
  }
  if (statuses.has('new')) {
    const attempted = new Set(unique(await paged(() => db.from('question_attempts').select('question_id').eq('user_id', state.user.id))));
    add((await paged(() => db.from('questions').select('id').eq('is_usable', true))).filter((q) => !attempted.has(q.id)).map((q) => q.id));
  }
  return union;
}

async function candidateIds(filters) {
  let candidate = null;
  if (filters.source_tests?.length || filters.pyq === 'yes' || filters.pyq === 'no') {
    candidate = intersect(candidate, new Set(filterAnalyticsPopulation(state.meta.questionTaxonomy, filters)));
  }
  if (filters.topics?.length) {
    const result = await db.from('question_topics').select('question_id').in('topic_id', filters.topics);
    if (result.error) throw result.error; candidate = intersect(candidate, new Set(unique(result.data)));
  }
  if (filters.subtopics?.length) {
    const result = await optional(db.from('question_subtopics').select('question_id').in('subtopic_id', filters.subtopics), 'subtopics');
    candidate = intersect(candidate, new Set(unique(result.data)));
  }
  if (filters.exams?.length) {
    const examIds = new Set();
    for (const exam of filters.exams) {
      const rows = await paged(() => {
        let query = db.from('questions').select('id');
        if (exam === 'inicet') query = query.eq('is_inicet', true);
        else if (exam === 'neet_pg') query = query.eq('is_neet_pg', true);
        else query = query.contains('exam_tags', [exam]);
        return query;
      });
      rows.forEach((row) => examIds.add(row.id));
    }
    candidate = intersect(candidate, examIds);
  }
  const status = await statusCandidateIds(filters);
  if (status) candidate = intersect(candidate, status);
  return candidate;
}

async function rowsForQuestionIds(table, columns, questionIds, configure = (query) => query) {
  const rows = [];
  for (let index = 0; index < questionIds.length; index += 200) {
    const result = await configure(db.from(table).select(columns).in('question_id', questionIds.slice(index, index + 200)));
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
  }
  return rows;
}

async function validationMembership(filters, questions) {
  const questionIds = questions.map((question) => question.id);
  const scoped = await resolvePopulation({ ...filters, question_ids: questionIds }, { includeIds: true, limit: questionIds.length });
  const validIds = scoped.questionIds;
  return {
    topicQuestionIds: validIds, subtopicQuestionIds: validIds, statusQuestionIds: validIds,
    pyqQuestionIds: filters.pyq === 'yes' ? validIds : [], nonPyqQuestionIds: filters.pyq === 'no' ? validIds : [],
  };
}

function applyDirectFilters(query, filters) {
  query = query.eq('is_usable', true);
  if (filters.platforms?.length) query = query.in('platform_id', filters.platforms);
  if (filters.subjects?.length) query = query.in('subject_id', filters.subjects);
  if (filters.systems?.length) query = query.in('system_id', filters.systems);
  if (filters.years?.length) query = query.in('exam_year', filters.years.map(Number));
  if (filters.sessions?.length) query = query.in('exam_shift', filters.sessions);
  if (filters.year) query = query.eq('exam_year', Number(filters.year));
  if (filters.search) query = query.ilike('question_text', `%${filters.search}%`);
  if (filters.source) query = query.ilike('source_reference', `%${filters.source}%`);
  if (filters.statuses?.includes('my_content')) query = query.eq('created_by', state.user.id);
  return query;
}

async function matchingCount(filters) {
  return (await resolvePopulation(filters, { includeIds: false })).count;
}

async function updateMatchCount(form) {
  const holder = form.querySelector('[data-match-count]'); if (!holder) return;
  const requestId = (filterCountRequests.get(form) || 0) + 1;
  filterCountRequests.set(form, requestId);
  holder.textContent = 'Counting…';
  try {
    const count = await matchingCount(readFilters(form));
    if (!form.isConnected || filterCountRequests.get(form) !== requestId) return;
    holder.textContent = `${count.toLocaleString()} question${count === 1 ? '' : 's'} match`; holder.dataset.count = count;
  } catch (error) {
    if (!form.isConnected || filterCountRequests.get(form) !== requestId) return;
    holder.textContent = 'Count unavailable'; console.warn(error);
  }
}

async function batchOptions(questionIds) {
  const all = [];
  for (let i = 0; i < questionIds.length; i += 200) {
    const result = await db.from('question_options').select('question_id,option_key,option_text,is_correct').in('question_id', questionIds.slice(i, i + 200)).order('option_key');
    if (result.error) throw result.error; all.push(...(result.data || []));
  }
  const grouped = new Map();
  all.forEach((option) => { if (!grouped.has(option.question_id)) grouped.set(option.question_id, []); grouped.get(option.question_id).push(option); });
  return grouped;
}

async function sha256Buffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function decodePayloadObject(object) {
  const key = `${object.object_path}:${object.sha256}`;
  if (payloadRequests.has(key)) return payloadRequests.get(key);
  const request = fetchPayloadObject(object);
  payloadRequests.set(key, request);
  try { return await request; } finally { payloadRequests.delete(key); }
}
async function fetchPayloadObject(object) {
  const cacheKey = `${object.object_path}:${object.sha256}`;
  if (state.payloadCache.has(cacheKey)) return state.payloadCache.get(cacheKey);
  const downloaded = await db.storage.from('qbank-payloads').download(object.object_path);
  if (downloaded.error) throw downloaded.error;
  const compressed = await downloaded.data.arrayBuffer();
  if (await sha256Buffer(compressed) !== object.sha256) throw new Error(`Payload checksum failed: ${object.object_path}`);
  let decoded = compressed;
  if (object.compression === 'gzip') {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress QBank payloads.');
    decoded = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const payload = JSON.parse(new TextDecoder().decode(decoded));
  if (payload.schema_version !== 1 || !Array.isArray(payload.questions)) throw new Error('Unsupported QBank payload schema.');
  state.payloadCache.set(cacheKey, payload);
  if (state.payloadCache.size > 8) state.payloadCache.delete(state.payloadCache.keys().next().value);
  return payload;
}

async function sourceContext(questionIds, filters = {}) {
  if (!questionIds.length) return new Map();
  const rows = [];
  for (let index = 0; index < questionIds.length; index += 200) {
    let query = db.from('qbank_source_occurrences').select('question_id,question_position,source_question_id,source_test_id,qbank_source_tests(title,sequence,is_pyq)').in('question_id', questionIds.slice(index, index + 200)).eq('is_current', true);
    if (filters.source_tests?.length) query = query.in('source_test_id', filters.source_tests);
    const result = await optional(query, 'hybrid'); if (!result.error) rows.push(...(result.data || []));
  }
  rows.sort((left, right) => Number(left.qbank_source_tests?.sequence || 0) - Number(right.qbank_source_tests?.sequence || 0) || left.question_position - right.question_position);
  const context = new Map(); rows.forEach((row) => { if (!context.has(String(row.question_id))) context.set(String(row.question_id), row); });
  return context;
}

async function hydrateHybridQuestions(questions, options, filters = {}) {
  const missingIds = questions.filter((question) => !(options.get(question.id) || []).length).map((question) => question.id);
  if (!missingIds.length) return questions.map((question) => ({ ...question, options: options.get(question.id) || [] }));
  const refs = [];
  for (let index = 0; index < missingIds.length; index += 200) {
    const result = await optional(db.from('qbank_question_payloads').select('question_id,payload_index,correct_option_keys,media_status,qbank_payload_objects!inner(object_path,sha256,compression)').in('question_id', missingIds.slice(index, index + 200)), 'hybrid');
    if (!result.error) refs.push(...(result.data || []));
  }
  const context = await sourceContext(missingIds, filters); const byQuestion = new Map();
  const documents = new Map();
  for (const ref of refs) {
    const object = ref.qbank_payload_objects;
    if (!documents.has(object.object_path)) documents.set(object.object_path, await decodePayloadObject(object));
  }
  const importedMedia = refs.flatMap(ref => documents.get(ref.qbank_payload_objects.object_path).questions[Number(ref.payload_index)]?.media || []);
  const resolvedMedia = await resolveImportedMedia(db, importedMedia);
  const storedMedia = new Map(resolvedMedia.filter(item => item.storage_path).map(item => [item.storage_path, item.reference]));
  for (const ref of refs) {
    const object = ref.qbank_payload_objects; const document = documents.get(object.object_path);
    const payload = document.questions[Number(ref.payload_index)];
    if (!payload) throw new Error(`Payload index is missing for question ${ref.question_id}`);
    const media = (payload.media || []).filter(item => item.type !== 'tracking').map(item => ({ ...item, reference: storedMedia.get(item.storage_path) || item.reference })); const source = context.get(String(ref.question_id));
    byQuestion.set(String(ref.question_id), {
      question_text: payload.question_html,
      explanation_html: payload.explanation_html,
      correct_answer: (payload.correct_keys || ref.correct_option_keys || []).join(','),
      correct_option_keys: payload.correct_keys || ref.correct_option_keys || [],
      options: (payload.options || []).map((option, position) => ({ question_id: ref.question_id, option_key: option.key, option_text: option.html, is_correct: option.is_correct, sort_order: position })),
      question_images: media.filter((item) => item.placement === 'question' && (!payload.cerebellum_full_v1 || item.type === 'image')).map((item) => item.reference),
      explanation_images: media.filter((item) => item.placement === 'explanation' && (!payload.cerebellum_full_v1 || item.type === 'image')).map((item) => item.reference),
      image_url: media.find((item) => item.placement === 'question')?.reference || '',
      source_test_label: source?.qbank_source_tests?.title || document.source_test?.title || '',
      source_question_id: source?.source_question_id || '', source_position: source?.question_position || null,
      media_status: ref.media_status, audio: payload.audio || null, video_url: payload.video || '',
      ...(payload.cerebellum_full_v1 ? {cerebellum_full_v1:true,source_media:media,import_warnings:payload.import_warnings||[],option_text_blank:payload.option_text_blank,needs_media_review:payload.needs_media_review} : {}),
    });
  }
  return questions.map((question) => ({ ...question, options: options.get(question.id) || [], ...(byQuestion.get(String(question.id)) || {}) }));
}

async function loadQuestions(filters, requested = 10) {
  const candidate = await candidateIds(filters); if (candidate && !candidate.size) return [];
  const limit = requested === 'all' ? null : Math.max(1, Number(requested) || 10);
  let rows;
  if (limit) {
    let query = applyDirectFilters(db.from('questions').select('*'), filters);
    if (candidate) query = query.in('id', [...candidate]);
    const result = await query.limit(Math.min(Math.max(limit * 4, limit), 1000));
    if (result.error) throw result.error; rows = result.data || [];
  } else {
    rows = await paged(() => applyDirectFilters(db.from('questions').select('*'), filters));
    if (candidate) rows = rows.filter((row) => candidate.has(row.id));
  }
  rows.sort(() => Math.random() - .5); if (limit) rows = rows.slice(0, limit);
  const options = await batchOptions(rows.map((row) => row.id));
  const hydrated = await hydrateHybridQuestions(rows, options, filters);
  return Promise.all(hydrated.map(async (question) => {
    let imageUrl = question.image_url || '';
    if (!imageUrl && question.image_path) { const signed = await db.storage.from('question-media').createSignedUrl(question.image_path, 3600); imageUrl = signed.data?.signedUrl || ''; }
    return { ...question, image_url: imageUrl };
  }));
}

async function loadQuestionsByIds(questionIds, filters = {}) {
  const ordered = [...new Set((questionIds || []).map(String).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < ordered.length; index += 200) {
    const result = await db.from('questions').select('*').in('id', ordered.slice(index, index + 200)).eq('is_usable', true);
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
  }
  const byQuestion = new Map(rows.map((question) => [String(question.id), question]));
  const questions = ordered.map((id) => byQuestion.get(id)).filter(Boolean);
  const options = await batchOptions(questions.map((question) => question.id));
  const hydrated = await hydrateHybridQuestions(questions, options, filters);
  return Promise.all(hydrated.map(async (question) => {
    let imageUrl = question.image_url || '';
    if (!imageUrl && question.image_path) { const signed = await db.storage.from('question-media').createSignedUrl(question.image_path, 3600); imageUrl = signed.data?.signedUrl || ''; }
    return { ...question, image_url: imageUrl };
  }));
}

async function matchingQuestionIds(filters) {
  const result = await resolvePopulation(filters, { includeIds: true, limit: null, order: filters.source_tests?.length ? 'source' : 'canonical' });
  return result.questionIds;
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

async function prepareQuestionSet({ mode = 'test', preset = 'custom', title = 'Question set', filters, requested = 'all', autoSubmit = true, questionIds = null, origin = '#/qbank' }) {
  loading('Building your exact question set…');
  const normalizedFilters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], statuses: ['all'], pyq: '', year: '', search: '', source: '', ...(filters || {}) };
  let populationCount; let selectedIds;
  if (questionIds) {
    selectedIds = [...new Set(questionIds.map(String))]; populationCount = selectedIds.length;
  } else {
    const requestedLimit = requested === 'all' ? null : Math.max(1, Number(requested) || 10);
    const population = await resolvePopulation(normalizedFilters, { includeIds: true, limit: requestedLimit, order: normalizedFilters.source_tests?.length ? 'source' : 'sample' });
    populationCount = population.count; selectedIds = population.questionIds;
  }
  if (mode === 'recall' && preset !== 'active-recall-v2') selectedIds = selectedIds.slice(0, recallQuestionLimit(preset, normalizedFilters));
  const questions = await loadQuestionsByIds(selectedIds, normalizedFilters);
  const membership = await validationMembership(normalizedFilters, questions);
  assertValidation(validateGeneratedQuestionSet({ questions, filters: normalizedFilters, requested: selectedIds.length, matchingCount: populationCount, ...membership }), 'Generated question set');
  if (!questions.length) throw new Error('No questions match those filters.');
  return { mode, preset, title, filters: normalizedFilters, requested, autoSubmit, origin, questionIds: selectedIds, questions, matchingCount: populationCount, targetSeconds: questions.length * TARGET_SECONDS };
}

function taxonomySummary(questionSet) {
  const names = (items, ids) => {
    const lookup = byId(items);
    const values = (ids || []).map((id) => lookup.get(String(id))?.name).filter(Boolean);
    return values.length ? values.join(', ') : 'All applicable';
  };
  return {
    platforms: names(state.meta.platforms, questionSet.filters.platforms),
    subjects: names(state.meta.subjects, questionSet.filters.subjects),
    topics: names(state.meta.topics, questionSet.filters.topics),
    subtopics: names(state.meta.subtopics, questionSet.filters.subtopics),
  };
}

function registerActionSet(definition) {
  const token = `set-${Date.now()}-${state.actionSets.size + 1}`;
  const questionIds = definition.questionIds == null ? null : [...new Set(definition.questionIds.map(String))];
  state.actionSets.set(token, { origin: `#/${state.route}`, ...definition, questionIds });
  return token;
}

function actionSetButtons(definition, testLabel = 'Start test') {
  if (!definition.questionIds?.length) return '<span class="subtle">No matching questions</span>';
  const token = registerActionSet(definition);
  return `<div class="row"><button class="button secondary compact" data-action="open-action-set" data-set="${e(token)}">Open questions</button><button class="button compact" data-action="preview-action-set" data-set="${e(token)}">${e(testLabel)}</button></div>`;
}

function smartRecallReady(filters){const mix=filters?.smart_recall;if(!mix)return '';return `<div class="smart-recall-ready"><b>${e(mix.focus)}</b><p>${Object.entries(mix.counts).map(([key,n])=>`${e(SMART_RECALL_LABELS[key]||key)}: ${Number(n)}`).join(' · ')}</p>${mix.fallbackCount?`<p class="subtle">${Number(mix.fallbackCount)} places filled from available fallback questions.</p>`:''}${mix.shortfall?`<p class="subtle">${Number(mix.size)-Number(mix.shortfall)} available of ${Number(mix.size)} requested.</p>`:''}<details><summary>Why these questions?</summary><ul>${(mix.questions||[]).map(q=>`<li>${e(q.subject)} — ${e(safeRecallMetadata(q))}</li>`).join('')}</ul></details></div>`;}

function readyScreen(questionSet) {
  state.pendingSet = questionSet;
  const summary = taxonomySummary(questionSet);
  const recallMode = questionSet.mode === 'recall';
  layout(`<div class="page-heading"><span class="eyebrow">READY</span><h1>${e(isRecallSelection(questionSet)?'Recall practice':questionSet.title)}</h1><p>Your exact question set and order are frozen. Nothing starts until you press ${recallMode ? 'START RECALL' : 'START TEST'}.</p></div><section class="card ready-card"><div class="result-grid"><div class="metric"><span>Questions</span><b>${questionSet.questions.length}</b></div>${recallMode ? `<div class="metric"><span>Order</span><b>Priority</b></div><div class="metric">${recallTimerSetting()}</div>` : `<div class="metric"><span>Per question</span><b>50s</b></div><div class="metric"><span>Total target</span><b>${timerText(questionSet.targetSeconds)}</b></div>`}<div class="metric"><span>Mode</span><b>${recallMode ? 'Recall' : questionSet.mode === 'practice' ? 'Practice' : 'Test'}</b></div></div>${smartRecallReady(questionSet.filters)}<dl class="ready-summary"><div><dt>Platforms</dt><dd>${e(summary.platforms)}</dd></div><div><dt>Subjects</dt><dd>${e(summary.subjects)}</dd></div><div><dt>Topics</dt><dd>${e(isRecallSelection(questionSet)?'Hidden until answered':summary.topics)}</dd></div><div><dt>Subtopics</dt><dd>${e(isRecallSelection(questionSet)?'Hidden until answered':summary.subtopics)}</dd></div></dl><div class="row"><button class="button large" data-action="start-pending-test">${recallMode ? 'START RECALL' : 'START TEST'}</button><button class="button secondary" data-action="cancel-question-set">BACK / CANCEL</button></div></section>`);
}

async function createSession(definition) {
  try { readyScreen(await prepareQuestionSet(definition)); }
  catch (error) { toast(error.message || 'Could not build question set.', 'error'); goToHash(definition.origin || '#/qbank'); }
}

async function openQuestionSet(definition) {
  try {
    const questionSet = await prepareQuestionSet({ ...definition, mode: 'browse', autoSubmit: false });
    const personal = await loadPersonalState(questionSet.questionIds);
    const recent = [];
    for (let index = 0; index < questionSet.questionIds.length; index += 200) {
      const result = await db.from('question_attempts').select('question_id,selected_option,is_correct,answered_at,time_spent_seconds,confidence,error_reason').eq('user_id', state.user.id).in('question_id', questionSet.questionIds.slice(index, index + 200)).order('answered_at', { ascending: false });
      if (!result.error) recent.push(...(result.data || []));
    }
    const answers = {};
    recent.forEach((answer) => { if (!answers[answer.question_id]) answers[answer.question_id] = answer; });
    state.active = { ...questionSet, kind: 'browse', testMode: definition.mode === 'practice' ? 'practice' : 'test', index: 0, answers, bookmarks: personal.bookmarks, marked: personal.marked, learning: personal.learning, questionStartedAt: null, explanationOpen: false, completedReview: true };
    renderActive();
  } catch (error) { toast(error.message || 'Could not open questions.', 'error'); goToHash(definition.origin || '#/qbank'); }
}

async function loadPersonalState(questionIds) {
  const bookmarks = new Set(); const marked = new Set(); const learning = new Map();
  for (let i = 0; i < questionIds.length; i += 200) {
    const chunk = questionIds.slice(i, i + 200);
    const learningResult = await optional(db.from('user_question_state').select('*').eq('user_id', state.user.id).in('question_id', chunk), 'learning');
    (learningResult.data || []).forEach((row) => {
      learning.set(row.question_id, row);
      if (row.bookmarked) bookmarks.add(row.question_id);
      if (row.marked_for_review || row.revision) marked.add(row.question_id);
    });
  }
  return { bookmarks, marked, learning };
}

async function startPendingSession(isCurrent = () => true) {
  const questionSet = state.pendingSet; if (!questionSet) return;
  { const qbMode = window.__qbankMode; window.__qbankMode = null; if ((qbMode === 'practice' || qbMode === 'test') && questionSet.mode !== 'recall') { questionSet.mode = qbMode; questionSet.autoSubmit = qbMode === 'test'; } } /*qb-custom*/
  const sessionUser=state.user?.id;
  const { mode, preset, title, filters, autoSubmit, questions } = questionSet;
  const startedMs = Date.now();
  const now = new Date(startedMs).toISOString();
  const payload = {
    user_id: state.user.id, title, mode, status: 'in_progress', filters, total_questions: questions.length,
    duration_minutes: Math.max(1, Math.ceil(questions.length * TARGET_SECONDS / 60)), started_at: now,
    current_position: 0, preset, target_seconds_per_question: mode === 'recall' ? recallTimerSeconds() : TARGET_SECONDS, auto_submit: autoSubmit,
    last_question_started_at: now,
  };
  let session = null;
  const created = await optional(db.from('test_sessions').insert(payload).select().single(), 'sessions');
  if (!created.error) {
    session = created.data;
    const snapshots = questions.map((q, position) => ({
      session_id: session.id, question_id: q.id, position,
      question_snapshot: { ...(isCerebellum(q)?{cerebellum_full_v1:true,source_media:q.source_media,import_warnings:q.import_warnings,option_text_blank:q.option_text_blank,needs_media_review:q.needs_media_review,question_images:q.question_images,explanation_images:q.explanation_images,video_url:q.video_url,audio:q.audio}:{}), question_text: q.question_text, correct_answer: q.correct_answer, correct_option_keys: q.correct_option_keys || correctKeys(q), explanation_html: q.explanation_html, source_reference: q.source_reference, source_collection: q.source_collection, source_test_label: q.source_test_label, source_position: q.source_position, is_pyq:q.is_pyq, media_status: q.media_status, image_url: q.image_url, subject_id: q.subject_id, platform_id: q.platform_id, system_id: q.system_id, options: q.options },
    }));
    for (let i = 0; i < snapshots.length; i += 100) {
      const result = await db.from('test_session_questions').insert(snapshots.slice(i, i + 100));
      if (result.error) throw result.error;
    }
  }
  if(preset==='active-recall-v2'&&(!isCurrent()||state.user?.id!==sessionUser))return;
  const personal = await loadPersonalState(questions.map((q) => q.id));
  if(preset==='active-recall-v2'&&(!isCurrent()||state.user?.id!==sessionUser))return;
  assertValidation(validateQuestionStateBindings({ questions, answers: {}, bookmarks: personal.bookmarks, marked: personal.marked }), 'Question state');
  state.active = {
    ...payload, ...(session || {}), kind: mode, questions, index: 0, answers: {}, solvingVisible: true,
    bookmarks: personal.bookmarks, marked: personal.marked, learning: personal.learning,
    questionStartedAt: Date.now(), questionTimeRemainingSeconds: null,
    explanationOpen: mode === 'practice', completedReview: false,
  };
  state.pendingSet = null;
  if (preset === 'smart-recall' || preset === 'active-recall-v2') {
    window.history.replaceState({}, '', '#/recall');
    state.route = 'recall';
  }
  await persistTimer(state.active);
  renderActive();
}

async function mountHomeReviewTiles(isCurrent) {
  const {data,error}=await db.rpc('qbank_home_review_counts');
  if(!isCurrent())return;
  const host=document.querySelector('[data-home-review-tiles]');if(!host)return;
  host.innerHTML=[['incorrect','Incorrect'],['bookmarked','Bookmarked'],['marked','Marked for Review']].map(([status,label])=>
    `<button class="button secondary compact" data-home-practice="${status}">${label} <b>${error?'—':Number(data?.[status]||0)}</b><small>Practice →</small></button>`).join('');
  host.querySelectorAll('[data-home-practice]').forEach(button=>button.onclick=async()=>{
    button.disabled=true;
    try { await createSession({mode:'practice',preset:'qbank',title:button.dataset.homePractice==='marked'?'Marked for Review':button.dataset.homePractice==='bookmarked'?'Bookmarked':'Incorrect',filters:{platforms:[],subjects:[],systems:[],topics:[],subtopics:[],source_tests:[],statuses:[button.dataset.homePractice],pyq:'',year:'',search:'',source:''},requested:20,autoSubmit:false,origin:'#/home'}); }
    catch(error){toast(error.message||'Could not start practice.','error');button.disabled=false;}
  });
}

async function home() {
  const homeGeneration=recallGeneration,homeUser=state.user?.id;
  const homeCurrent=()=>homeGeneration===recallGeneration&&state.user?.id===homeUser&&state.route==='home';
  loading('Preparing your study plan…');
  const now = new Date().toISOString();
  const [attempts, sessions, due, cards, studyContinuation] = await Promise.all([
    db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).order('answered_at', { ascending: false }).limit(1000),
    optional(db.from('test_sessions').select('*').eq('user_id', state.user.id).eq('status', 'in_progress').order('updated_at', { ascending: false }).limit(1), 'sessions'),
    optional(db.from('user_question_state').select('question_id', { count: 'exact', head: true }).eq('user_id', state.user.id).eq('srm_active', true).lte('srm_due_at', now), 'srm'),
    optional(db.from('recall_card_progress').select('card_id', { count: 'exact' }).eq('user_id', state.user.id).lte('due_at', now), 'personal'),
    db.rpc('qbank_study_continuation'),
  ]);
  if(!homeCurrent())return;
  const logs = attempts.data || []; const correct = logs.filter((row) => row.is_correct).length;
  state.continueLearning=!studyContinuation.error&&studyContinuation.data?.kind==='next'?studyContinuation.data.module:null;
  const nextModule=state.continueLearning;
  const study=studyContinuation.error?null:studyContinuation.data;
  // Home needs the names of at most its two continuation sessions, not every module.
  const contextIds=[...new Set([sessions.data?.[0],study?.session].flatMap(s=>s?.filters?.source_tests||[]))];
  const missingIds=contextIds.filter(id=>!state.meta.sourceTests.some(t=>t.id===id));
  if(missingIds.length){
    const context=await db.from('qbank_source_tests').select('id,title').in('id',missingIds);
    if(!homeCurrent())return;
    if(context.error)throw context.error;
    state.meta.sourceTests.push(...(context.data||[]).map(t=>({...t,name:t.title})));
  }
  const active = sessions.data?.[0]; const dueCount = (due.count || due.data?.length || 0) + (cards.count || cards.data?.length || 0);
  const mistakes = new Map(); logs.filter((row) => !row.is_correct).forEach((row) => mistakes.set(row.question_id, (mistakes.get(row.question_id) || 0) + 1));
  const recommendation = dueCount ? { label: 'Start Active Recall', route: '#/recall' }
    : [...mistakes.values()].some((count) => count > 1) ? { label: 'Revise repeated mistakes', route: '#/review' }
      : { label: 'Start a focused QBank set', route: '#/qbank' };
  let weak = [];
  const attemptedIds = [...new Set(logs.map((row) => row.question_id))];
  if (attemptedIds.length) {
    const result = await db.from('questions').select('id,subject_id').in('id', attemptedIds.slice(0, 1000));
    const questionSubject = new Map((result.data || []).map((q) => [q.id, q.subject_id])); const tally = new Map();
    logs.forEach((row) => { const id = questionSubject.get(row.question_id); if (!id) return; const value = tally.get(id) || { correct: 0, total: 0, incorrectIds: new Set() }; value.correct += row.is_correct ? 1 : 0; value.total++; if (!row.is_correct) value.incorrectIds.add(String(row.question_id)); tally.set(id, value); });
    const names = byId(state.meta.subjects);
    weak = [...tally].filter(([, value]) => value.total >= 2 && value.incorrectIds.size).sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total).slice(0, 3).map(([id, value]) => ({ id, name: names.get(String(id))?.name || 'Unclassified', accuracy: pct(value.correct, value.total), questionIds: [...value.incorrectIds] }));
  }
  if(!homeCurrent())return;
  layout(`<section class="home-hero"><div><span class="eyebrow">YOUR STUDY PLAN</span><h1>What should you do next?</h1><p class="subtle">One clear action, based on your real learning state.</p></div>${dueCount?`<button class="button large" data-action="ar-start">Start Active Recall</button>`:`<a class="button large" href="${recommendation.route}">${e(recommendation.label)}</a>`}</section>
  <section class="action-grid">${active ? `<article class="card action-card priority"><span class="eyebrow">CONTINUE</span><h2>${e(active.mode==='recall'?'Recall practice':studyContext(active,state.meta))}</h2><p>Question ${(active.current_position || 0) + 1} of ${active.total_questions}</p><button class="button" data-action="resume" data-id="${e(active.id)}">Resume exact session</button></article>` : nextModule?`<article class="card action-card priority"><span class="eyebrow">CONTINUE LEARNING</span><h2>Continue ${e(nextModule.subject)}</h2><p>${e(nextModule.platform)} · ${e((nextModule.source_path||[]).join(' → '))}</p><p>Next: ${e(nextModule.title)}</p><button class="button" data-action="continue-learning">Open next QBank</button></article>` : `<article class="card action-card"><span class="eyebrow">CONTINUE</span><h2>No unfinished session</h2><p class="subtle">Start a practice set or test when you are ready.</p><a class="button secondary" href="#/qbank">Build practice</a></article>`}<article class="card action-card" id="active-recall-home"><span class="eyebrow">ACTIVE RECALL</span><p role="status">Loading knowledge units…</p></article><a class="card action-card link-card" href="#/analytics"><span class="eyebrow">ACCURACY</span><h2>${pct(correct, logs.length)}</h2><p>${logs.length} recent attempts · Open analytics</p></a></section>
  <div class="home-review-tiles" data-home-review-tiles></div>
  ${study?`<section class="card section-card" id="continue-studying"><span class="eyebrow">CONTINUE STUDYING</span>${study.kind==='resume'?`<h2>Resume ${e(studyContext(study.session,state.meta))}</h2><p>Question ${Number(study.session.current_position||0)+1}/${study.session.total_questions}</p><button class="button" data-action="resume" data-id="${e(study.session.id)}">Continue →</button>`:`<h2>Continue ${e(study.module.subject)}</h2><p>${e(study.module.platform)} · ${e((study.module.source_path||[]).join(' → '))}</p><p>Next: ${e(study.module.title)}</p><button class="button" data-action="continue-learning">Continue →</button>`}</section>`:''}${smartRecall.card()}<section class="card section-card"><div class="section-heading"><div><span class="eyebrow">WEAK AREAS</span><h2>Turn weakness into an exact question set</h2></div><a href="#/analytics">See all analytics</a></div>${weak.length ? `<div class="weak-list">${weak.map((item) => `<article class="weak-item"><span>${e(item.name)}</span><b>${item.accuracy}</b><small>${item.questionIds.length} incorrect contributing question${item.questionIds.length === 1 ? '' : 's'}</small>${actionSetButtons({ mode: 'test', preset: 'analytics', title: `${item.name} weak-area revision`, filters: { platforms: [], subjects: [item.id], systems: [], topics: [], subtopics: [], statuses: ['all'], pyq: '', year: '', search: '', source: '' }, questionIds: item.questionIds }, 'Start revision test')}</article>`).join('')}</div>` : '<div class="empty">Answer a few questions and weak areas will appear here.</div>'}</section><div class="secondary-metrics"><span>${logs.length} recent attempts</span><span>${correct} correct</span></div>`);
  void smartRecall.mount();
  void activeRecall.mountHome();
  void mountHomeReviewTiles(homeCurrent);
}

async function qbank() {
  layout(`<div class="page-heading"><span class="eyebrow">QBANK</span><h1>Build a focused practice set</h1><p>Choose platforms, choose subjects, then practice a module. Multiple selections are welcome.</p></div><section class="card builder-card"><form id="practice-form" class="stack"><div class="filters">${filterFields({ sourceTests: true })}</div><div class="builder-footer"><div><b data-match-count>Choose filters to count questions</b><div class="subtle">Browse without timers, or preview the same exact set before starting.</div></div><div class="row"><label class="inline-label">Questions <select name="count-mode"><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="all">All matching</option><option value="custom">Custom</option></select></label><input class="custom-count hidden" name="custom-count" type="number" min="1" max="5000" value="30" aria-label="Custom question count" /><button class="button secondary" name="intent" value="browse">Open questions</button><button class="button" name="intent" value="test">Start practice</button></div></div></form></section>`);
  const form = document.querySelector('#practice-form'); setupDependentFilters(form);
  form.elements['count-mode'].onchange = () => form.querySelector('.custom-count').classList.toggle('hidden', form.elements['count-mode'].value !== 'custom');
  form.onsubmit = async (event) => {
    event.preventDefault(); const filters = readFilters(form); const mode = form.elements['count-mode'].value;
    const requested = mode === 'custom' ? Number(form.elements['custom-count'].value) : mode;
    const definition = { mode: 'practice', preset: 'qbank', title: 'QBank practice', filters, requested, autoSubmit: false, origin: '#/qbank' };
    try { if (event.submitter?.value === 'browse') await openQuestionSet(definition); else await createSession(definition); }
    catch (error) { toast(error.message || 'Could not build practice set.', 'error'); qbank(); }
  };
  const studyUser=state.user?.id;
  void db.rpc('qbank_session_history_light',{p_limit:4,p_offset:0,p_include_unfinished:true}).then(result=>{if(form.isConnected&&state.user?.id===studyUser&&!result.error)form.studySetSessions?.(result.data);}).catch(()=>{});
  const diagnostic = new URLSearchParams(location.hash.split('?')[1] || '').get('dom-regression');
  if (diagnostic === '1') {
    const regressionRun = `${Date.now()}-${Math.random()}`;
    document.documentElement.dataset.qbankDomRegressionRun = regressionRun;
    document.documentElement.dataset.qbankDomRegression = JSON.stringify({ status: 'RUNNING' });
    window.__QBANK_DOM_REGRESSION__ = { status: 'RUNNING' };
    setTimeout(async () => {
      if (!form.isConnected || document.documentElement.dataset.qbankDomRegressionRun !== regressionRun) return;
      try {
        window.__QBANK_DOM_REGRESSION__ = await runTaxonomyDomRegression({ form });
      } catch (error) {
        window.__QBANK_DOM_REGRESSION__ = { status: 'FAIL', error: error?.message || String(error) };
      }
      if (document.documentElement.dataset.qbankDomRegressionRun !== regressionRun) return;
      document.documentElement.dataset.qbankDomRegression = JSON.stringify(window.__QBANK_DOM_REGRESSION__);
      console.info('QBank taxonomy DOM regression', window.__QBANK_DOM_REGRESSION__);
    }, 100);
  }
}

function srmIntervalLabel(minutes, dueAt = null) {
  const value = Number(minutes || 0);
  if (!value && dueAt) return new Date(dueAt) <= new Date() ? 'Now' : date(dueAt);
  if (value < 60) return `${value} minute${value === 1 ? '' : 's'}`;
  if (value < 1440) return `${Math.round(value / 60)} hours`;
  const days = Math.round(value / 1440);
  return days === 1 ? 'Tomorrow' : `${days} days`;
}

async function legacyRecall() {
  const generation = ++recallGeneration;
  loading('Building your Recall queue…');
  const filters = state.recallFilters || { platform_id: '', subject_id: '', scope: 'all' };
  const platformIds = filters.platform_id ? [filters.platform_id] : null;
  const subjectIds = filters.subject_id ? [filters.subject_id] : null;
  const params = { p_platform_ids: platformIds, p_subject_ids: subjectIds };
  const [summaryResult, queueResult, settingsResult, recallFacets] = await Promise.all([
    db.rpc('qbank_srm_summary', params),
    db.rpc('qbank_srm_queue', { ...params, p_pyq_only: filters.scope === 'pyq', p_repeated_only: filters.scope === 'repeated', p_limit: RECALL_BATCH_SIZE }),
    optional(db.from('user_srm_settings').select('*').eq('user_id', state.user.id).maybeSingle(), 'srm'),
    platformIds ? resolveFacets({ platforms: platformIds, subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], pyq: '' }) : null,
  ]);
  if (generation !== recallGeneration || state.route !== 'recall') return;
  if (summaryResult.error || queueResult.error) {
    state.features.srm = false;
    return layout(`<div class="page-heading"><span class="eyebrow">RECALL</span><h1>Spaced repetition</h1></div>${featureNotice('Apply the deterministic SRM migration to activate Recall.')}`);
  }
  const summary = summaryResult.data || {};
  const queue = (queueResult.data || []).map((row) => ({ ...row, questionId: row.question_id, isUsable: true }));
  assertValidation(validateSrmQueue(queue), 'Recall queue');
  state.recallQueue = queue;
  const settings = settingsResult.data || { timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata', new_daily_limit: 20, review_daily_limit: 40 };
  const visibleSubjects = filters.platform_id
    ? state.meta.subjects.filter((subject) => recallFacets.subjects.has(String(subject.id)))
    : state.meta.subjects;
  layout(`<div class="page-heading"><span class="eyebrow">RECALL</span><h1>Review what matters, when it matters</h1><p>Due questions are ranked by overdue time, PYQ value, repeated errors and your study flags.</p></div>
  <section class="recall-summary">${metricStrip([['Due now', summary.due_now ?? 0], ['Overdue', summary.overdue ?? 0], ['PYQ due', summary.pyq_due ?? 0], ['Repeated mistakes', summary.repeated_due ?? 0], ['Reviewed today', summary.reviewed_today ?? 0], ['Retention today', summary.retention_today == null ? '—' : `${summary.retention_today}%`]])}</section>
  <section class="card recall-start"><form id="recall-filter-form" class="recall-filter-row"><div class="field"><label>Platform</label><select name="platform_id"><option value="">All due</option>${state.meta.platforms.map((item) => `<option value="${e(item.id)}" ${filters.platform_id === item.id ? 'selected' : ''}>${e(item.name)}</option>`).join('')}</select></div><div class="field"><label>Subject</label><select name="subject_id"><option value="">All subjects</option>${visibleSubjects.map((item) => `<option value="${e(item.id)}" ${filters.subject_id === item.id ? 'selected' : ''}>${e(item.name)}</option>`).join('')}</select></div><div class="field"><label>Queue</label><select name="scope"><option value="all" ${filters.scope === 'all' ? 'selected' : ''}>All Due</option><option value="pyq" ${filters.scope === 'pyq' ? 'selected' : ''}>PYQ Due</option><option value="repeated" ${filters.scope === 'repeated' ? 'selected' : ''}>Repeated Mistakes</option></select></div><button class="button secondary" type="submit">Apply</button></form><div class="recall-primary-action"><div><b>${queue.length} ready in this batch</b><span class="subtle">Up to 20 questions per batch. Remaining due items stay queued.</span></div><button class="button large" data-action="start-recall" ${queue.length ? '' : 'disabled'}>Start Recall</button>${recallTimerSetting()}</div></section>
  <section class="card recall-queue-card"><div class="section-heading"><div><span class="eyebrow">DUE QUEUE</span><h2>Today’s prioritized reviews</h2></div></div>${queue.length ? `<ol class="recall-queue">${queue.slice(0, 12).map((row) => `<li><div><b>${e(row.reason.replaceAll('_', ' '))}</b><small>${row.is_pyq ? 'PYQ · ' : ''}${row.consecutive_incorrect ? `${row.consecutive_incorrect} consecutive wrong · ` : ''}${row.overdue_seconds >= 86400 ? `${Math.floor(row.overdue_seconds / 86400)}d overdue` : row.overdue_seconds > 0 ? 'Due now' : 'Scheduled now'}</small></div><span class="pill">${e(row.srm_state)}</span></li>`).join('')}</ol>${queue.length > 12 ? `<p class="subtle">+ ${queue.length - 12} more in today’s queue</p>` : ''}` : '<div class="empty">Nothing is due in this selection.</div>'}</section>
  <section class="card recall-settings"><details><summary>Daily load and how Recall works</summary><div class="recall-info"><p><b>Incorrect</b> returns sooner. <b>Correct but unsure</b> gets short reinforcement. <b>Correct and sure</b> earns a longer interval. Repeated mistakes and due PYQs rank higher, without changing accuracy.</p><form id="recall-settings-form" class="recall-filter-row"><input type="hidden" name="timezone_name" value="${e(settings.timezone_name)}" /><div class="field"><label>New/day</label><select name="new_daily_limit">${[10,20,40].map((value) => `<option ${Number(settings.new_daily_limit) === value ? 'selected' : ''}>${value}</option>`).join('')}<option value="custom" ${![10,20,40].includes(Number(settings.new_daily_limit)) ? 'selected' : ''}>Custom</option></select></div><div class="field"><label>Review/day</label><select name="review_daily_limit">${[10,20,40,60].map((value) => `<option ${Number(settings.review_daily_limit) === value ? 'selected' : ''}>${value}</option>`).join('')}<option value="custom" ${![10,20,40,60].includes(Number(settings.review_daily_limit)) ? 'selected' : ''}>Custom</option></select></div><div class="field"><label>Custom new</label><input type="number" name="custom_new" min="1" max="500" value="${e(settings.new_daily_limit)}" /></div><div class="field"><label>Custom reviews</label><input type="number" name="custom_review" min="1" max="500" value="${e(settings.review_daily_limit)}" /></div><button class="button secondary" type="submit">Save limits</button></form></div></details></section>`);
  document.querySelector('#recall-filter-form').onsubmit = (event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget)); state.recallFilters = value; recall(); };
  document.querySelector('#recall-filter-form [name="platform_id"]').onchange = () => { const form = document.querySelector('#recall-filter-form'); state.recallFilters = { ...filters, platform_id: form.elements.platform_id.value, subject_id: '' }; recall(); };
  document.querySelector('#recall-settings-form').onsubmit = async (event) => {
    event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
    const newLimit = value.new_daily_limit === 'custom' ? value.custom_new : value.new_daily_limit;
    const reviewLimit = value.review_daily_limit === 'custom' ? value.custom_review : value.review_daily_limit;
    const saved = await db.rpc('qbank_srm_update_settings', { p_timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || value.timezone_name || 'Asia/Kolkata', p_new_daily_limit: Number(newLimit), p_review_daily_limit: Number(reviewLimit) });
    if (saved.error) return toast(saved.error.message, 'error'); toast('Recall limits saved.'); recall();
  };
}

const TEST_PRESETS = {
  mixed: ['Mixed Test', 'Combine multiple platforms, subjects and topics.'],
  subject: ['Subject Test', 'Choose one or more subjects, then relevant topics.'],
  topic: ['Topic / Subtopic Test', 'Build through the learning hierarchy.'],
  revision: ['Revision Test', 'Incorrect, bookmarked, marked, recall-due or slow questions.'],
  pyq: ['PYQ Test', 'Filter trusted PYQ metadata by platform, year and subject.'],
  coreBtr: ['Core BTR', 'Browse the original Core BTR sections and collections.'],
  grand: ['Grand Test', 'Choose a platform for a timed Grand Test or source review.'],
  custom: ['Custom Test', 'Expose every applicable filter.'],
};

async function tests() {
  layout(`<div class="page-heading"><span class="eyebrow">TEST</span><h1>Choose a test type</h1><p>Start with intent, then narrow the question pool.</p></div><section class="preset-grid">${Object.entries(TEST_PRESETS).map(([id, item]) => `<button class="card preset-card" data-action="choose-preset" data-preset="${id}"><b>${studyIcon(id==='revision'?'retry':id==='grand'?'chart':'book')}${e(item[0])}</b><span>${e(item[1])}</span></button>`).join('')}</section><section id="test-builder-slot"></section><section class="card section-card"><div class="section-heading"><div><span class="eyebrow">CONTINUE</span><h2>Recent sessions</h2></div><a href="#/history">History</a></div><div id="resume-tests" class="empty">Loading…</div></section>`);
  const resumeHost = document.querySelector('#resume-tests');
  const user=state.user?.id;
  const result = await db.rpc('qbank_session_history_light',{p_limit:4,p_offset:0,p_include_unfinished:true});
  if (!resumeHost.isConnected||state.user?.id!==user) return;
  resumeHost.innerHTML = result.error?e(result.error.message):result.data?.length?sessionHistoryRows(result.data)+'<a class="button secondary" href="#/history">View History</a>':'<div class="empty">No sessions yet.</div>';

}

const gtMode = createGTExamMode({ db, e, richHtml, safeUrl, decodePayloadObject, layout });
const grandTests = createGrandTests({ db, e, richHtml, safeUrl, decodePayloadObject, layout, startGT: (host,test) => gtMode.setup(host,test,()=>grandTests.showCatalog(host)) });

let testBuilderGeneration=0;
async function showTestBuilder(preset) {
  const generation=++testBuilderGeneration,userId=state.user?.id;
  grandTests.cancel(); gtMode.cancel();
  const item = TEST_PRESETS[preset] || TEST_PRESETS.custom; const revision = preset === 'revision';
  const slot = document.querySelector('#test-builder-slot');
  if (preset === 'grand') { grandTests.showCatalog(slot); return; }
  if (preset === 'pyq') { slot.innerHTML = '<section class="card builder-card"><div class="empty">Loading PYQ subjects and tests…</div></section>'; showPyqCatalog(); return; }
  if (preset === 'coreBtr') { slot.innerHTML = '<section class="card builder-card"><div class="empty">Loading Core BTR sections and collections…</div></section>'; showCoreBtrCatalog(); return; }
  slot.innerHTML='<div class="card study-loading" role="status">Loading test filters…</div>';
  await loadMeta(false,'full');
  if(generation!==testBuilderGeneration||state.user?.id!==userId||!slot.isConnected)return;
  slot.innerHTML = `<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">${e(item[0])}</span><h2>Configure this test</h2></div><button class="button ghost compact" data-action="close-builder">Close</button></div><form id="test-form" class="stack" data-preset="${e(preset)}"><div class="filters">${filterFields({ revision, sourceTests: true })}</div><div class="builder-footer"><div><b data-match-count>Counting available questions…</b><div class="subtle">Browse without timers, or preview this exact set before starting.</div></div><div class="row"><label class="inline-label">Questions <select name="count"><option>10</option><option>20</option><option selected>50</option><option>100</option><option value="all">All matching</option></select></label><button class="button secondary" name="intent" value="browse">Open questions</button><button class="button" name="intent" value="test">Preview ${e(item[0])}</button></div></div></form></section>`;
  const form = document.querySelector('#test-form'); if (preset === 'pyq') form.elements.pyq.value = 'yes'; setupDependentFilters(form);
  form.onsubmit = async (event) => {
    event.preventDefault(); const filters = readFilters(form);
    if (['subject', 'topic'].includes(preset) && !filters.subjects.length) return toast('Choose at least one subject.');
    if (preset === 'topic' && !filters.topics.length && !filters.subtopics.length) return toast('Choose at least one topic or subtopic.');
    const definition = { mode: 'test', preset, title: item[0], filters, requested: form.elements.count.value, autoSubmit: true, origin: '#/tests' };
    try { if (event.submitter?.value === 'browse') await openQuestionSet(definition); else await createSession(definition); }
    catch (error) { toast(error.message || 'Could not create test.', 'error'); }
  };
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function marrowPyqs(){
 layout('<div class="page-heading"><span class="eyebrow">MARROW PYQs</span><h1>Marrow PYQs</h1><p>Trusted PYQ source · separate from ordinary Marrow QBank.</p><a href="#/qbank">All study sources</a></div><section id="test-builder-slot"><div class="card empty">Loading Marrow PYQ subjects and tests…</div></section>');
 await showPyqCatalog('marrow');
}

async function showPyqCatalog(platformScope='') {
  const slot = document.querySelector('#test-builder-slot'); if (!slot) return;
  if (!state.pyqCatalog) {
    const result = await db.rpc('qbank_pyq_catalog');
    if (result.error) { slot.innerHTML = `<section class="card notice"><b>PYQ catalog unavailable.</b><p>${e(result.error.message)}</p></section>`; return; }
    state.pyqCatalog = result.data || [];
  }
  const bySubject = new Map();
  state.pyqCatalog.filter(row=>!platformScope||String(row.platform).toLowerCase()===platformScope).forEach((row) => { if (!bySubject.has(row.subject)) bySubject.set(row.subject, new Map()); const exams = bySubject.get(row.subject); if (!exams.has(row.exam)) exams.set(row.exam, []); exams.get(row.exam).push(row); });
  slot.innerHTML = `<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">PYQS</span><h2>Choose subject, exam and year</h2><div class="row"><button class="button compact" data-action="start-catalog-selection" data-kind="pyq">Start selected tests</button><button class="button secondary compact" data-action="browse-catalog-selection" data-kind="pyq">Browse selected</button></div><p class="subtle">Only the selected test’s questions are loaded.</p></div><button class="button ghost compact" data-action="close-builder">Close</button></div><div class="pyq-catalog">${[...bySubject.entries()].map(([subject, exams]) => `<details><summary><b>${e(subject)}</b><span>${[...exams.values()].flat().reduce((sum, row) => sum + Number(row.question_count || 0), 0)} questions</span></summary>${[...exams.entries()].map(([exam, tests]) => `<div class="pyq-exam"><h3>${e(exam)}</h3><div class="list">${tests.map((test) => `<div class="pyq-test-row"><div><label><input type="checkbox" name="catalog-tests" value="${e(test.test_id)}"> <b>${e(test.year)} · ${e(test.title)}</b></label><small>${Number(test.question_count || 0)} questions</small></div><div class="row"><button class="button secondary compact" data-action="open-pyq-test" data-test="${e(test.test_id)}" data-title="${e(`${subject} · ${exam} ${test.year}`)}">Browse</button><button class="button compact" data-action="start-pyq-test" data-test="${e(test.test_id)}" data-title="${e(`${subject} · ${exam} ${test.year}`)}">Start test</button></div></div>`).join('')}</div></div>`).join('')}</details>`).join('')}</div></section>`;
}

async function openSelectedPyqTest(target, start) {
  const definition = { mode: 'test', preset: 'pyq', title: target.dataset.title || 'PYQ test',
    filters: { platforms: state.route==='marrow-pyqs' ? state.meta.platforms.filter(p=>p.name.toLowerCase()==='marrow').map(p=>p.id) : [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [target.dataset.test], statuses: ['all'], exams: [], years: [], sessions: [], pyq: 'yes' },
    requested: 'all', autoSubmit: true, origin: state.route==='marrow-pyqs' ? '#/marrow-pyqs' : '#/tests' };
  if (start) await createSession(definition); else await openQuestionSet(definition);
}

async function showCoreBtrCatalog() {
  const slot = document.querySelector('#test-builder-slot'); if (!slot) return;
  if (!state.coreBtrCatalog) {
    const result = await db.rpc('qbank_core_btr_catalog');
    if (result.error) { slot.innerHTML = `<section class="card notice"><b>Core BTR catalog unavailable.</b><p>${e(result.error.message)}</p></section>`; return; }
    state.coreBtrCatalog = result.data || [];
  }
  const bySection = new Map();
  state.coreBtrCatalog.forEach((row) => {
    if (!bySection.has(row.section)) bySection.set(row.section, new Map());
    const collections = bySection.get(row.section);
    if (!collections.has(row.collection_type)) collections.set(row.collection_type, []);
    collections.get(row.collection_type).push(row);
  });
  const labels = { TOPIC_TEST: 'Topic tests', ALL_QBANK_EXCLUDING_PYQ: 'All QBank excluding PYQs', CORE_BTR_PYQ: 'Core BTR PYQs', ZV_RECOMMENDED: 'ZV Recommended' };
  slot.innerHTML = `<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">CORE BTR</span><h2>Original source folders</h2><div class="row"><button class="button compact" data-action="start-catalog-selection" data-kind="coreBtr">Start selected tests</button><button class="button secondary compact" data-action="browse-catalog-selection" data-kind="coreBtr">Browse selected</button></div><p class="subtle">Metadata loads first. Questions are fetched only for the selected collection.</p></div><button class="button ghost compact" data-action="close-builder">Close</button></div><div class="pyq-catalog">${[...bySection.entries()].map(([section, collections]) => `<details><summary><b>${e(section)}</b><span>${[...collections.values()].flat().reduce((sum, row) => sum + Number(row.question_count || 0), 0)} memberships</span></summary>${[...collections.entries()].map(([type, tests]) => `<div class="pyq-exam"><h3>${e(labels[type] || type)}</h3><div class="list">${tests.map((test) => `<div class="pyq-test-row"><div><label><input type="checkbox" name="catalog-tests" value="${e(test.test_id)}"> <b>${e(test.title)}</b></label><small>${Number(test.question_count || 0)} questions</small></div><div class="row"><button class="button secondary compact" data-action="open-core-btr-test" data-test="${e(test.test_id)}" data-title="${e(`Core BTR · ${section} · ${test.title}`)}">Browse</button><button class="button compact" data-action="start-core-btr-test" data-test="${e(test.test_id)}" data-title="${e(`Core BTR · ${section} · ${test.title}`)}">Start test</button></div></div>`).join('')}</div></div>`).join('')}</details>`).join('')}</div></section>`;
}

async function openCatalogSelection(kind,start) {
 const ids=[...document.querySelectorAll('#test-builder-slot input[name="catalog-tests"]:checked')].map(i=>i.value);
 if(!ids.length)return toast('Select one or more source tests.');
 const definition={mode:'test',preset:kind,title:kind==='pyq'?'Selected PYQ tests':'Core BTR selected tests',filters:{platforms:state.route==='marrow-pyqs'?state.meta.platforms.filter(p=>p.name.toLowerCase()==='marrow').map(p=>p.id):[],source_tests:ids,pyq:kind==='pyq'?'yes':'',statuses:['all']},requested:'all',autoSubmit:true,origin:location.hash};
 if(start)await createSession(definition);else await openQuestionSet(definition);
}

async function openSelectedCoreBtrTest(target, start) {
  const definition = { mode: 'test', preset: 'coreBtr', title: target.dataset.title || 'Core BTR test',
    filters: { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [target.dataset.test], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '' },
    requested: 'all', autoSubmit: true, origin: '#/tests' };
  if (start) await createSession(definition); else await openQuestionSet(definition);
}

function activeQuestion() { return state.active?.questions?.[state.active.index]; }
function timerText(seconds) { const value = Math.max(0, Math.floor(Number(seconds) || 0)); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function questionMeta(question) {
  const subjects = byId(state.meta.subjects); const platforms = byId(state.meta.platforms);
  return [subjects.get(String(question.subject_id))?.name, platforms.get(String(question.platform_id))?.name].filter(Boolean).map(e).join(' · ') || 'General';
}

function explanationBlock(question, answer, open) {
  const selected = selectedKeys(answer); const right = selected.length > 0 && isAnswerCorrect(question, answer);
  const concept=recallConcept(state.active,question.id);
  const expected = correctKeys(question).join(', ') || 'Not provided';
  const resultLabel = !selected.length ? `Correct answer: ${e(expected)}` : right ? 'Previously answered correctly' : `Previously answered incorrectly · Correct answer: ${e(expected)}`;
  const info = [question.source_collection, question.source_test_label, question.source_position ? `Question ${question.source_position}` : '', question.media_status && !['NO_MEDIA','MEDIA_REFERENCED'].includes(question.media_status) ? question.media_status.replaceAll('_', ' ') : ''].filter(Boolean).join(' · ');
  return `<div class="answer-panel ${right ? 'correct-panel' : 'wrong-panel'}"><div class="row"><b>${resultLabel}</b><button class="button ghost compact" data-action="toggle-explanation">${open ? 'Hide explanation' : 'View explanation'}</button></div>${concept?.primary_concept?`<p class="recall-concept"><b>Concept:</b> ${e(concept.primary_concept)}<br>${e(safeRecallMetadata(concept))}</p>`:''}${open ? `<div class="rich-content">${isCerebellum(question) ? richHtml(question.explanation_html)+cerebellumMedia(question,'explanation') : questionContent(question, 'explanation') || '<p>No explanation is available for this question.</p>'}</div>${info ? `<details class="question-info"><summary>Question info</summary><p>${e(info)}</p></details>` : ''}` : ''}</div>`;
}

function renderQuestion(question, answer, reveal) {
  const correct = new Set(correctKeys(question)); const selected = new Set(selectedKeys(answer)); const multiple = correct.size > 1;
  const mediaNotice = isCerebellum(question) ? cerebellumNotice(question) : question.media_status && !['NO_MEDIA', 'MEDIA_REFERENCED'].includes(question.media_status) ? `<div class="notice">Referenced media is not available in this import.</div>` : '';
  return `<div class="question-stem rich-content">${isCerebellum(question) ? richHtml(question.question_text)+cerebellumMedia(question,'question') : questionContent(question, 'question')}</div>${mediaNotice}<div class="options" role="group" aria-label="Answer choices">${question.options.map((option) => {
    const key = String(option.option_key).toUpperCase(); const classes = ['option'];
    if (selected.has(key)) classes.push('selected'); if (reveal && correct.has(key)) classes.push('correct'); if (reveal && selected.has(key) && !correct.has(key)) classes.push('wrong');
    return `<button class="${classes.join(' ')}" data-action="answer" data-key="${e(key)}" ${reveal ? 'disabled' : ''}><b>${e(option.option_key)}.</b><span class="rich-content">${richHtml(option.option_text)}</span></button>`;
  }).join('')}</div>${multiple && !reveal && ['practice', 'recall'].includes(state.active.kind) ? `<button class="button" data-action="submit-multi-answer" ${selected.size ? '' : 'disabled'}>Submit selected answers</button>` : ''}${reveal ? explanationBlock(question, answer, state.active.explanationOpen) : ''}`;
}

function feedbackControls(answer, reveal, wrong) {
  if (!reveal || state.active?.completedReview) return '';
  if (state.active?.preset === 'active-recall-v2') return activeRecallFeedback(answer,wrong);
  const confidence = wrong ? '' : `<div><span class="field-label">How confident were you?</span><div class="segmented"><button data-action="confidence" data-value="sure" class="${answer.confidence === 'sure' ? 'active' : ''}" ${answer.attemptRecorded ? 'disabled' : ''}>SURE</button><button data-action="confidence" data-value="unsure" class="${answer.confidence === 'unsure' ? 'active' : ''}" ${answer.attemptRecorded ? 'disabled' : ''}>GUESSED / UNSURE</button></div><small class="subtle">If skipped, correct answers use the safe “unsure” schedule.</small></div>`;
  const mistake = wrong ? `<div><span class="field-label">What happened? <small>Optional</small></span><div class="reason-chips">${[['didnt_know', "Didn't know"], ['forgot', 'Forgot'], ['misread', 'Misread'], ['confused_options', 'Confused options'], ['overthought', 'Overthought'], ['silly_mistake', 'Silly mistake'], ['guess', 'Guess']].map(([value, label]) => `<button data-action="error-reason" data-value="${value}" class="${answer.error_reason === value ? 'active' : ''}">${label}</button>`).join('')}</div></div>` : '';
  const schedule = answer.srmFeedback ? `<div class="srm-next"><b>Next review: ${e(srmIntervalLabel(answer.srmFeedback.interval_minutes, answer.srmFeedback.due_at))}</b><span>${e(String(answer.srmFeedback.state || 'learning').replaceAll('_', ' '))}</span></div>` : '';
  return `<div class="learning-feedback">${confidence}${mistake}${schedule}</div>`;
}

function mountQuestionHistory(active, question) {
  if (!active.history || active.history.userId !== state.user?.id) active.history=createQuestionHistory(db,state.user?.id);
  const cache=active.history, userId=state.user?.id;
  const paint=()=>{
    if(state.active!==active||state.user?.id!==userId||activeQuestion()?.id!==question.id||active.solvingVisible===false)return;
    const node=document.querySelector('[data-question-history]');
    if(node)node.textContent=historyLabel(cache.get(question.id));
  };
  paint();
  void cache.load(active.questions,active.index).then(paint);
}

function renderActive() {
  const active = state.active; const question = activeQuestion(); if (!active || !question || active.solvingVisible === false) return;
  const reviewVisible=active.completedReview?new Set(reviewPositions(active)):null;
  if (question.restoreMedia && !question.mediaLoading && !question.mediaError) void recoverSnapshotMedia(active, question);
  const answer = active.answers[question.id]; const reveal = active.completedReview || answer?.timeout_reveal || ['practice', 'recall'].includes(active.kind) && Boolean(answer?.selected_option) && (correctKeys(question).length === 1 || answer.submitted);
  const answered = Object.values(active.answers).filter((item) => item?.selected_option).length;
  const browsing = active.kind === 'browse';
  const learning = active.learning.get(question.id) || {};
  const srmButton = learning.srm_active
    ? `<button class="button ghost active-control" data-action="srm-remove">In Recall</button>${active.preset==='active-recall-v2'?'':'<button class="button ghost" data-action="srm-reset">Reset Recall</button>'}`
    : '<button class="button ghost" data-action="srm-add">Add to Recall</button>';
  const timerRunning = !browsing && (active.kind !== 'recall' || active.target_seconds_per_question !== 0) && !active.completedReview && active.status === 'in_progress';
  const timerShouldTick = timerRunning && (active.kind === 'test' || (!answer?.selected_option && !answer?.timeout_reveal && active.questionTimeRemainingSeconds !== 0));
  const palette = active.questions.slice(0, 500).map((item, index) => {
    if(reviewVisible&&!reviewVisible.has(index))return '';
    const itemAnswer = active.answers[item.id]; const selected = Boolean(itemAnswer?.selected_option);
    const known = selected && (active.completedReview || ['practice', 'recall'].includes(active.kind));
    const base = known ? (isAnswerCorrect(item, itemAnswer) ? 'correct' : 'incorrect') : selected ? 'answered' : 'unattempted';
    const bookmark = active.bookmarks.has(item.id); const marked = active.marked.has(item.id);
    const hit = Boolean(item.is_hit_list || active.learning.get(item.id)?.is_hit_list);
    const badges = `${bookmark ? '<i class="status-badge bookmark" aria-hidden="true">★</i>' : ''}${marked ? '<i class="status-badge review" aria-hidden="true">!</i>' : ''}${hit ? '<i class="status-badge hit" aria-hidden="true">H</i>' : ''}`;
    return `<button data-action="jump" data-index="${index}" class="palette-item ${base} ${index === active.index ? 'current' : ''}" aria-label="Question ${index + 1}${bookmark ? ', bookmarked' : ''}${marked ? ', marked for review' : ''}"><span>${index + 1}</span>${badges}</button>`;
  }).join('');
  const smartReason=recallConcept(active,question.id);
  const tools = browsing ? '' : `<section class="card question-tools"><span class="eyebrow">QUESTION TOOLS</span><button class="tool-button bookmark-tool ${active.bookmarks.has(question.id) ? 'active' : ''}" data-action="bookmark" aria-pressed="${active.bookmarks.has(question.id)}"><span>${active.bookmarks.has(question.id) ? '★' : '☆'}</span>${active.bookmarks.has(question.id) ? 'Bookmarked' : 'Bookmark'}</button><button class="tool-button review-tool ${active.marked.has(question.id) ? 'active' : ''}" data-action="mark" aria-pressed="${active.marked.has(question.id)}"><span>!</span>${active.marked.has(question.id) ? 'Marked for review' : 'Mark for review'}</button>${active.completedReview?'':srmButton}<button class="tool-button" data-action="note"><span>＋</span>Note</button><button class="tool-button" data-action="report"><span>⚑</span>Report</button></section>`;
  layout(`<section class="question-header ${active.preset==='active-recall-v2'?'active-recall-session':''}"><div><span class="pill">${browsing ? 'Browse' : active.completedReview ? 'Review' : active.kind === 'recall' ? 'Recall' : active.kind === 'test' ? e(TEST_PRESETS[active.preset]?.[0] || 'Test') : 'Practice'}</span><h1>${e(!reveal&&isRecallSelection(active)?'Recall practice':active.title || 'Question set')}</h1></div>${browsing ? `<div class="row"><button class="button" data-action="preview-browsed-set">Start test with these exact questions</button><button class="button secondary" data-action="back-to-origin">Back</button></div>` : active.kind === 'recall' ? `<div class="timer-cluster">${recallTimerSetting(active.target_seconds_per_question ?? 50)}${timerRunning ? '<div><span>QUESTION TIMER</span><b id="question-timer"></b><span id="recall-timeout" role="status"></span></div>' : ''}<a class="button secondary" href="#/recall" data-action="exit-recall">Exit Recall</a></div>` : timerRunning ? `<div class="timer-cluster"><div><span>QUESTION TIMER</span><b id="question-timer">00:50</b></div><div><span>TOTAL TIMER</span><b id="total-timer">${timerText(active.questions.length * TARGET_SECONDS)}</b></div><button class="button secondary compact" data-action="toggle-timers" ${answer?.selected_option||active.timerBusy?'disabled':''}>${sharedClock(active).manualPaused?'Resume':'Pause'}</button>${sharedClock(active).paused?'<span class="pill">PAUSED</span>':''}</div>` : ''}</section><div class="question-layout ${active.preset==='active-recall-v2'?'active-recall-session':''}"><section class="card question-card"><div class="question-topline"><span>Question ${active.index + 1} of ${active.questions.length}</span><span class="question-context">${questionMeta(question)}</span></div><div class="progress" data-qb-kind="${active.kind}" data-qb-reveal="${reveal ? 1 : 0}" data-qb-timeout="${answer?.timeout_reveal ? 1 : 0}"><i style="width:${((active.index + 1) / active.questions.length) * 100}%"></i></div>${smartReason&&!active.completedReview?`<p class="smart-recall-reason">${e(safeRecallMetadata(smartReason))}</p><details class="smart-recall-why"><summary>Why this question?</summary><ul>${[...new Set([safeRecallMetadata(smartReason),...(smartReason.reasons||[])])].map(reason=>`<li>${e(reason)}</li>`).join('')}</ul></details>`:''}${question.mediaLoading ? '<p role="status" class="subtle">Loading original media…</p>' : question.mediaError ? '<p class="media-unavailable">Could not load original media. <button class="button ghost compact" data-action="retry-media">Retry images</button></p>' : ''}${active.completedReview&&active.kind!=='browse'?`<div class="row review-status-filters">${['all','incorrect','correct','unattempted'].map(f=>`<button class="button secondary compact" data-action="review-filter" data-value="${f}" aria-pressed="${(active.reviewFilter||'all')===f}">${f[0].toUpperCase()+f.slice(1)}</button>`).join('')}</div><p class="pill">${!answer?.selected_option?'Unattempted':isAnswerCorrect(question,answer)?'Correct':'Incorrect'} · Selected: ${e(answer?.selected_option||'—')} · Correct: ${e(correctKeys(question).join(', '))}</p>`:''}<small class="question-history subtle" data-question-history aria-live="polite"></small>${renderQuestion(question, answer, reveal)}${!reveal&&active.preset==='active-recall-v2'&&activeRecallUnit()?.primary_concept&&active.arOptionsFor!==question.id?'<div class="recall-retrieve-prompt"><p>Retrieve the diagnosis, mechanism or next step before looking at the choices.</p><textarea aria-label="Your retrieval" placeholder="Recall it in your own words (optional; not saved)"></textarea><button class="button" data-action="ar-options">Show answer choices</button></div>':''}${browsing ? '' : feedbackControls(answer || {}, reveal, Boolean(answer?.selected_option) && !isAnswerCorrect(question, answer))}<div class="question-actions"><button class="button secondary" data-action="previous" ${active.index === 0 ? 'disabled' : ''}>← Previous</button><button class="button" data-action="next">${active.index === active.questions.length - 1 ? (browsing ? 'Back' : active.completedReview ? 'Back to results' : 'Finish') : 'Next →'}</button></div></section><aside class="question-sidebar">${tools}<section class="card palette-card"><div class="section-heading"><div><span class="eyebrow">NAVIGATOR</span><h3>Questions</h3></div><span>${answered}/${active.questions.length}</span></div><div class="status-legend" aria-label="Question status legend"><span class="correct">Correct</span><span class="incorrect">Incorrect</span><span class="review">Review</span><span class="bookmark">Bookmarked</span><span class="unattempted">Unattempted</span></div><div class="palette">${palette}</div>${active.questions.length > 500 ? '<p class="subtle">Palette shows the first 500 positions; Previous/Next continues through all questions.</p>' : ''}${active.kind === 'test' && !active.completedReview ? `<p class="subtle">${active.questions.length - answered} unanswered</p><button class="button danger full" data-action="submit">Submit test</button>` : ''}</section></aside></div>`);
  if(!reveal&&active.preset==='active-recall-v2'&&activeRecallUnit()?.primary_concept&&active.arOptionsFor!==question.id){document.querySelectorAll('[data-action=answer],[data-action=submit-multi-answer]').forEach(el=>el.hidden=true);}
  mountQuestionHistory(active, question);
  if (timerRunning) updateActiveTimerDisplay();
  bindCerebellumMedia(question, root, () => !reveal && !sharedClock(active).manualPaused);
  if (!active.completedReview && sharedClock(active).manualPaused) document.querySelectorAll('[data-action=answer],[data-action=next],[data-action=previous],[data-action=jump],[data-action=submit-multi-answer]').forEach(el=>el.disabled=true);
  if (timerShouldTick && !sharedClock(active).paused) startActiveTimers(); else stopActiveTimer();
}

function stopActiveTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

function totalTimerLimit(active) { return active.kind === 'recall' ? Infinity : active.questions.length * TARGET_SECONDS * 1000; }
function questionTimerLimit(active) { return active.kind === 'recall' ? (active.target_seconds_per_question === 0 ? Infinity : (active.target_seconds_per_question ?? 50) * 1000) : TARGET_SECONDS * 1000; }
function sharedClock(active) {
 if (!active.timer_state) active.timer_state=initialClock(active.index,active.questionStartedAt||Date.now());
 if (active.kind === 'recall') active.timer_state.questionLimitMs = questionTimerLimit(active);
 return active.timer_state;
}
function totalTimeUsed(active,at=Date.now()){return readClock(sharedClock(active),at,totalTimerLimit(active)).totalUsedMs;}
function totalTimeRemaining(active,at=Date.now()){return Math.ceil(Math.max(0,totalTimerLimit(active)-totalTimeUsed(active,at))/1000);}
function pauseTotalTimer(active,at=Date.now()){active.timer_state=freezeClock(sharedClock(active),at,totalTimerLimit(active));}
function resumeTotalTimer(active,at=Date.now()){if(!sharedClock(active).manualPaused)active.timer_state=runClock(sharedClock(active),at);}
function questionTimeRemaining(active,answer=null,at=Date.now()){return Math.ceil(Math.max(0,questionTimerLimit(active)-readClock(sharedClock(active),at,totalTimerLimit(active)).questionUsedMs)/1000);}
function answeredQuestionTimeRemaining(answer){return Math.max(0,Number(answer?.question_time_remaining_seconds??(TARGET_SECONDS-Number(answer?.time_spent_seconds||0))));}
function pauseAttemptTimers(active,at=Date.now()){pauseTotalTimer(active,at);active.questionTimeRemainingSeconds=questionTimeRemaining(active,null,at);stopActiveTimer();persistTimer(active);}
const timerWrites=new Map();
function timerKey(active){return `qbank-clock-v1:${state.user?.id}:${active.id}`;}
function persistTimer(active=state.active,remote=true){
 if(!active?.id||active.kind==='browse'||active.status!=='in_progress')return Promise.resolve();
 active.timer_state=checkpointClock(sharedClock(active),Date.now(),totalTimerLimit(active));
 const snapshot={...active.timer_state,position:active.index,...(active.kind === 'recall' ? {recallSeconds:active.target_seconds_per_question ?? 50} : {})};active.timer_state=snapshot;
 try{localStorage.setItem(timerKey(active),JSON.stringify(snapshot));}catch{}
 if(!remote || active.kind === 'recall')return Promise.resolve();
 const id=active.id,userId=state.user.id;
 const write=(timerWrites.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{const r=await db.from('test_sessions').update({timer_state:snapshot}).eq('id',id).eq('user_id',userId);if(r.error)throw r.error;});
 timerWrites.set(id,write);return write.catch(error=>toast('Timer saved on this device; cloud sync failed: '+error.message,'error'));
}
async function toggleAttemptPause(){
 const active=state.active;if(!active||active.completedReview||active.timerBusy)return;
 active.timerBusy=true;
 if(sharedClock(active).manualPaused)active.timer_state=runClock(sharedClock(active));else active.timer_state=freezeClock(sharedClock(active),Date.now(),totalTimerLimit(active),true);
 stopActiveTimer();renderActive();await persistTimer(active);active.timerBusy=false;renderActive();
}
function updateActiveTimerDisplay(at=Date.now()){
 const active=state.active;if(!active)return;
 const q=document.querySelector('#question-timer'),t=document.querySelector('#total-timer');
 const remaining = questionTimeRemaining(active,null,at);
 if(q && q.textContent !== timerText(remaining))q.textContent=timerText(remaining);if(t && t.textContent !== timerText(totalTimeRemaining(active,at)))t.textContent=timerText(totalTimeRemaining(active,at));
 const timeout=document.querySelector('#recall-timeout');
 if(timeout){const expired=remaining===0;timeout.textContent=expired?'Time’s up — continue when ready':'';q?.classList.toggle('timer-expired',expired);}
}
function startActiveTimers(){
 stopActiveTimer();const active=state.active;if(!active||sharedClock(active).paused)return;
 let lastCloud=Date.now();
 const tick=()=>{
  if(state.active!==active||active.completedReview||active.status!=='in_progress'){stopActiveTimer();return;}
  const wasPaused=sharedClock(active).paused;persistTimer(active,false);updateActiveTimerDisplay();
  if(Date.now()-lastCloud>=15000){lastCloud=Date.now();persistTimer(active);}
  if(sharedClock(active).paused){stopActiveTimer();if(!wasPaused)persistTimer(active);}
  if(totalTimeRemaining(active)===0&&active.kind==='test'&&active.auto_submit)submitActive(true);
  if(active.kind==='practice'&&questionTimeRemaining(active)===0){const q=activeQuestion(),a=active.answers[q?.id];const done=a?.selected_option&&(a.submitted||correctKeys(q).length===1);if(q&&!done&&!a?.timeout_reveal){active.answers[q.id]={...(a||{}),selected_option:a?.selected_option||'',submitted:Boolean(a?.selected_option),timeout_reveal:true,time_spent_seconds:TARGET_SECONDS};active.explanationOpen=true;pauseAttemptTimers(active);renderActive();return;}} /*qb-custom*/
 };
 tick();if(!sharedClock(active).paused)state.timer=setInterval(tick,250);
}
function elapsedOnQuestion(at=Date.now()){return Math.floor(readClock(sharedClock(state.active),at,totalTimerLimit(state.active)).questionUsedMs/1000);}

async function recordAttempt(question, answer) {
  const active=state.active,userId=state.user?.id;
  if (!active || active.completedReview || !userId) return null;
  if (!answer?.selected_option || answer.attemptRecorded) return answer?.srmFeedback || null;
  answer.client_event_id ||= crypto.randomUUID();
  const mode = active.kind === 'recall' ? 'recall' : active.kind === 'test' ? 'test' : 'qbank';
  const confidence = answer.confidence || null;
  const args = { p_question_id: question.id, p_selected_option: answer.selected_option, p_mode: mode, p_event_id: answer.client_event_id, p_test_session_id: active.id || null, p_time_spent_seconds: answer.time_spent_seconds || 0, p_confidence: confidence, p_error_reason: answer.error_reason || null };
  const isV2 = active.preset === 'active-recall-v2';
  // Persist the stable event ID and actual answer time before attempting sync.
  await saveActiveAnswer(question.id);
  const result = await db.rpc(isV2 ? 'qbank_active_recall_record' : 'qbank_record_attempt_v2', isV2 ? {p_question_id:question.id,p_selected_option:answer.selected_option,p_event_id:answer.client_event_id,p_test_session_id:active.id||null,p_time_spent_seconds:answer.time_spent_seconds||0,p_strength:answer.retrieval_strength||(isAnswerCorrect(question,answer)?(confidence==='sure'?'strong':'partial'):'failed'),p_error_reason:answer.error_reason||null}:args);
  if (state.active !== active || state.user?.id !== userId) return null;
  if (!result.error) {
    active.history?.set(question.id,result.data?.history);
    answer.confidence = confidence; answer.attemptRecorded = true; answer.srmFeedback = isV2 ? {...result.data,relearn:!isAnswerCorrect(question,answer)||answer.retrieval_strength==='failed'} : result.data;
    const learning = active.learning.get(question.id) || { user_id: userId, question_id: question.id };
    active.learning.set(question.id, { ...learning, srm_active: result.data?.active, srm_state: result.data?.state, srm_due_at: result.data?.due_at, srm_interval_minutes: result.data?.interval_minutes });
    await saveActiveAnswer(question.id);
    invalidateLearnerCaches();
    return result.data;
  }
  // Never fall back to a non-idempotent insert on a missing RPC. Keep the event for retry.
  toast(`Answer sync failed: ${result.error.message}`, 'error');
  return null;
}

async function ensureAttemptRecorded(question, answer) {
  if (!answer?.selected_option || answer.attemptRecorded || state.active.completedReview || ['browse','test'].includes(state.active.kind)) return;
  await recordAttempt(question, answer);
  if (!answer.attemptRecorded) throw new Error('Answer sync is pending. Please retry before continuing.');
}

const answerWrites = new Map();
async function saveActiveAnswer(questionId) {
  const active = state.active;
  if (!active?.id || !state.features.sessions || active.completedReview || active.status !== 'in_progress') return;
  const answer = active.answers[questionId] || {}; const question = active.questions.find((q) => q.id === questionId);
  if(answer.selected_option)answer.answered_at ||= new Date().toISOString();
  const value = { session_id: active.id, question_id: questionId, selected_option: answer.selected_option || null, marked_for_review: active.marked.has(questionId), answered_at: answer.selected_option ? answer.answered_at || new Date().toISOString() : null, is_correct: answer.selected_option ? isAnswerCorrect(question, answer) : null, time_spent_seconds: answer.time_spent_seconds || 0, confidence: answer.confidence || null, error_reason: answer.error_reason || null, client_event_id: answer.client_event_id || null };
  const key = `${active.id}:${questionId}`, signature = JSON.stringify(value), previous = answerWrites.get(key);
  if (previous?.signature === signature) return previous.promise;
  const position = active.index, started = active.questionStartedAt, userId = state.user.id;
  const promise = (async () => {
    if (previous) await previous.promise.catch(() => {});
    if (state.user?.id !== userId || active.status !== 'in_progress' || active.completedReview) return;
    const saved = await optional(db.from('test_answers').upsert(value, { onConflict: 'session_id,question_id' }), 'sessions');
    if (saved.error) throw saved.error;
    if (active.kind !== 'recall') await optional(db.from('test_sessions').update({ current_position: position, last_question_started_at: new Date(started).toISOString(), updated_at: new Date().toISOString() }).eq('id', active.id).eq('user_id', userId), 'sessions');
  })();
  answerWrites.set(key, {signature, promise});
  try { await promise; } catch (error) { if (answerWrites.get(key)?.promise === promise) answerWrites.delete(key); throw error; }
}

async function selectAnswer(key) {
  if (!essentialMediaReady(activeQuestion(), root)) return toast('Wait for the question image to load. If it fails, skip this question until the source image is recovered.');
  const active = state.active; const question = activeQuestion(); if (!active || active.completedReview || active.submitting || active.status !== 'in_progress' || sharedClock(active).manualPaused) return;
  const existing = active.answers[question.id]; const multiple = correctKeys(question).length > 1;
  if (['practice', 'recall'].includes(active.kind) && existing?.selected_option && (!multiple || existing.submitted)) return;
  const selectedAt = Date.now();
  const selection = new Set(selectedKeys(existing));
  if (multiple) { if (selection.has(key)) selection.delete(key); else selection.add(key); }
  const selectedOption = multiple ? [...selection].sort().join(',') : key;
  if (selectedOption && !existing?.selected_option && active.kind !== 'test') pauseAttemptTimers(active, selectedAt);
  if (!selectedOption && existing?.selected_option) {
    const remaining = questionTimeRemaining(active, existing, selectedAt);
    active.questionTimeRemainingSeconds = null;
    active.questionStartedAt = selectedAt - (TARGET_SECONDS - remaining) * 1000;
    resumeTotalTimer(active, selectedAt);
  }
  const answer = { ...(existing || {}), client_event_id: existing?.client_event_id || crypto.randomUUID(), selected_option: selectedOption, answered_at: new Date(selectedAt).toISOString(), time_spent_seconds: existing?.selected_option ? existing.time_spent_seconds : elapsedOnQuestion(selectedAt), question_time_remaining_seconds: selectedOption ? questionTimeRemaining(active, null, selectedAt) : null };
  active.answers[question.id] = answer;
  const answerRoute = location.hash;
  active.explanationOpen = active.kind === 'practice';
  // Answer feedback is local; persistence must not delay the selected/correct state.
  renderActive();
  if (['practice', 'recall'].includes(active.kind) && !multiple && !existing?.selected_option && !isAnswerCorrect(question, answer) && active.preset !== 'active-recall-v2') await recordAttempt(question, answer);
  await saveActiveAnswer(question.id);
  if (state.active === active && activeQuestion()?.id === question.id && location.hash === answerRoute) renderActive();
}

async function submitMultiAnswer() {
  const question = activeQuestion(); const answer = state.active?.answers?.[question?.id];
  if (!question || !answer?.selected_option || !['practice', 'recall'].includes(state.active.kind)) return;
  const active = state.active, answerRoute = location.hash;
  answer.submitted = true; active.explanationOpen = active.kind === 'practice'; renderActive();
  if (!isAnswerCorrect(question, answer) && active.preset !== 'active-recall-v2') await recordAttempt(question, answer);
  await saveActiveAnswer(question.id);
  if (state.active === active && activeQuestion()?.id === question.id && location.hash === answerRoute) renderActive();
}

async function navigateActive(index) {
  const active = state.active; const current = activeQuestion();
  if (!active || active.submitting) return;
  if (active.completedReview) {
    const positions=reviewPositions(active);
    const direction=index>=active.index?1:-1;
    const next=direction>0?positions.find(i=>i>=index):positions.findLast(i=>i<=index);
    if(next===undefined){if(direction>0)resultScreen();return;}
    active.index=next;active.explanationOpen=true;renderActive();return;
  }
  if(active.navigationBusy || sharedClock(active).manualPaused)return;
  active.navigationBusy = true;
  const originalRoute = state.route;
  try {
  const navigationAt = Date.now();
  if (active.kind !== 'browse') pauseTotalTimer(active, navigationAt);
  stopActiveTimer();
  if (current && active.kind !== 'browse') { const answer = active.answers[current.id] || {}; if (!answer.selected_option) answer.time_spent_seconds = Math.max(answer.time_spent_seconds || 0, elapsedOnQuestion(navigationAt)); active.answers[current.id] = answer; await ensureAttemptRecorded(current, answer); await saveActiveAnswer(current.id); }
  if (state.active !== active || state.route !== originalRoute || active.solvingVisible === false) return;
  active.index = Math.max(0, Math.min(index, active.questions.length - 1)); active.questionStartedAt = active.kind === 'browse' ? null : Date.now();
  const destinationAnswer = active.answers[active.questions[active.index]?.id];
  active.questionTimeRemainingSeconds = destinationAnswer?.selected_option ? answeredQuestionTimeRemaining(destinationAnswer) : null;
  if(active.kind!=='browse'){active.timer_state={...sharedClock(active),position:active.index,questionUsedMs:destinationAnswer?.selected_option?(active.kind === 'recall' ? Number(destinationAnswer.time_spent_seconds || 0) : TARGET_SECONDS-answeredQuestionTimeRemaining(destinationAnswer))*1000:0,paused:true};}
  if (active.kind !== 'browse' && (active.kind === 'test' || !destinationAnswer?.selected_option)) resumeTotalTimer(active, active.questionStartedAt);
  active.explanationOpen = active.kind === 'practice';
  await persistTimer(active);
  if (state.active === active && state.route === originalRoute) renderActive();
  if (active.id) await optional(db.from('test_sessions').update({ current_position: active.index, last_question_started_at: new Date().toISOString() }).eq('id', active.id).eq('user_id', state.user.id), 'sessions');

  } finally { active.navigationBusy = false; }
}

async function toggleBookmark() {
  const question = activeQuestion(); const active = state.active;
  const bookmarked = !active.bookmarks.has(question.id);
  let result = await db.rpc('qbank_set_bookmark', { p_question_id: question.id, p_bookmarked: bookmarked });
  if (result.error && /function .* does not exist|schema cache/i.test(result.error.message)) {
    result = await db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, bookmarked }, { onConflict: 'user_id,question_id' });
    if (!result.error) {
      const mirror = bookmarked
        ? await db.from('bookmarks').upsert({ user_id: state.user.id, question_id: question.id }, { onConflict: 'user_id,question_id' })
        : await db.from('bookmarks').delete().eq('user_id', state.user.id).eq('question_id', question.id);
      if (mirror.error) {
        await db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, bookmarked: !bookmarked }, { onConflict: 'user_id,question_id' });
        result = mirror;
      }
    }
  }
  if (result.error) return toast(result.error.message, 'error');
  bookmarked ? active.bookmarks.add(question.id) : active.bookmarks.delete(question.id);
  const learning = active.learning.get(question.id) || { user_id: state.user.id, question_id: question.id };
  active.learning.set(question.id, { ...learning, bookmarked });
  invalidateLearnerCaches();
  toast(bookmarked ? 'Bookmarked' : 'Bookmark removed');
  await saveActiveAnswer(question.id); renderActive();
}

async function toggleMark() {
  const question = activeQuestion(); const active = state.active; const marked = !active.marked.has(question.id);
  const result = await optional(db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, marked_for_review: marked, revision: marked }, { onConflict: 'user_id,question_id' }), 'learning');
  if (result.error) return toast(result.error.message, 'error');
  marked ? active.marked.add(question.id) : active.marked.delete(question.id); invalidateLearnerCaches(); await saveActiveAnswer(question.id); renderActive();
}

async function updateAnswerMetadata(field, value) {
  const question = activeQuestion(); const answer = state.active.answers[question.id]; if (!answer || state.active.completedReview) return;
  if (field === 'confidence' && answer.attemptRecorded) return;
  answer[field] = answer[field] === value ? null : value;
  if (field === 'confidence' && answer[field] && isAnswerCorrect(question, answer)) await recordAttempt(question, answer);
  if(state.active.preset==='active-recall-v2'&&field==='error_reason'&&answer.attemptRecorded){const result=await db.from('active_recall_retrievals').update({error_reason:answer.error_reason}).eq('user_id',state.user.id).eq('event_id',answer.client_event_id).eq('question_id',question.id);if(result.error)toast(result.error.message,'error');}
  await saveActiveAnswer(question.id);
  const column = field === 'confidence' ? 'last_confidence' : 'last_error_reason';
  await optional(db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, [column]: answer[field] }, { onConflict: 'user_id,question_id' }), 'learning');
  renderActive();
}

async function updateQuestionSrm(action) {
  const question = activeQuestion(); if (!question || state.active?.completedReview) return;
  if ((action === 'remove' || action === 'reset') && !confirm(`${action === 'remove' ? 'Remove this knowledge unit from Active Recall? Question history is preserved.' : 'Reset Recall progress for this question? Attempt history will be preserved.'}`)) return;
  const result = await db.rpc(action==='reset'?'qbank_srm_manual':'qbank_active_recall_manual', { p_question_id: question.id, p_action: action, p_event_id: crypto.randomUUID() });
  if (result.error) return toast(result.error.message, 'error');
  const current = state.active.learning.get(question.id) || { user_id: state.user.id, question_id: question.id };
  state.active.learning.set(question.id, { ...current, srm_active: result.data?.active, srm_state: result.data?.state, srm_due_at: result.data?.due_at, srm_interval_minutes: result.data?.interval_minutes });
  const answer = state.active.answers[question.id];
  if (answer) {
    if (action === 'remove') delete answer.srmFeedback;
    else answer.srmFeedback = { state: result.data?.state, due_at: result.data?.due_at, interval_minutes: result.data?.interval_minutes };
  }
  toast(action === 'add' ? 'Added to Recall' : action === 'remove' ? 'Removed from Recall' : 'Recall progress reset'); renderActive();
}

function modal(title, body, submitLabel = 'Save') {
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal"><div class="modal card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="section-heading"><h2 id="modal-title">${e(title)}</h2><button class="button ghost compact" data-action="close-modal" type="button">Close</button></div><form id="modal-form" class="stack">${body}<button class="button">${e(submitLabel)}</button></form></div></div>`);
  document.querySelector('#modal input, #modal textarea, #modal select')?.focus();
}

async function noteModal() {
  const question = activeQuestion(); const { data } = await optional(db.from('question_notes').select('*').eq('user_id', state.user.id).eq('question_id', question.id).maybeSingle());
  modal('Personal note', `<div class="field"><label>Your private note</label><textarea name="body" placeholder="Key takeaway, memory aid, or doubt…">${e(data?.body || '')}</textarea></div>`);
  document.querySelector('#modal-form').onsubmit = async (event) => {
    event.preventDefault(); const body = new FormData(event.currentTarget).get('body').trim();
    const result = !body ? await db.from('question_notes').delete().eq('user_id', state.user.id).eq('question_id', question.id) : await db.from('question_notes').upsert({ user_id: state.user.id, question_id: question.id, body }, { onConflict: 'user_id,question_id' });
    if (result.error) return toast(result.error.message, 'error'); document.querySelector('#modal')?.remove(); toast(body ? 'Note saved' : 'Note removed');
  };
}

function reportModal() {
  const question = activeQuestion();
  modal('Report question', `<div class="field"><label>What needs attention?</label><select name="reason"><option value="wrong_answer">Wrong answer</option><option value="wrong_explanation">Wrong explanation</option><option value="ambiguous">Ambiguous question</option><option value="poor_quality">Poor-quality question</option><option value="broken_image">Broken image</option><option value="other">Other</option></select></div><div class="field"><label>Details (optional)</label><textarea name="details"></textarea></div>`, 'Send report');
  document.querySelector('#modal-form').onsubmit = async (event) => { event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget)); const result = await db.from('question_reports').insert({ user_id: state.user.id, question_id: question.id, ...payload }); if (result.error) return toast(result.error.message, 'error'); document.querySelector('#modal')?.remove(); toast('Thank you — report saved.'); };
}

async function resumeSession(id) {
  const resumeUser=state.user?.id;
  const existingActive = state.active?.id === id ? state.active : null;
  loading('Restoring your exact session…');
  try {
    const sessionResult = await db.from('test_sessions').select('*').eq('id', id).eq('user_id', state.user.id).single(); if (sessionResult.error) throw sessionResult.error;
    const [itemsResult, answersResult] = await Promise.all([paged(()=>db.from('test_session_questions').select('*').eq('session_id', id).order('position')).then(data=>({data})), paged(()=>db.from('test_answers').select('*').eq('session_id', id).order('question_id')).then(data=>({data}))]);
    if (itemsResult.error) throw itemsResult.error;
    if (answersResult.error) throw answersResult.error;
    const questions = (itemsResult.data || []).map((item) => ({ id: item.question_id, ...item.question_snapshot, options: item.question_snapshot.options || [], restoreMedia: item.question_snapshot.media_status !== 'NO_MEDIA' && (!Array.isArray(item.question_snapshot.question_images) || !Array.isArray(item.question_snapshot.explanation_images)) }));
    const answers = Object.fromEntries((answersResult.data || []).map((answer) => [answer.question_id, answer]));
    if (existingActive) for (const [questionId, answer] of Object.entries(existingActive.answers || {})) {
      if (answers[questionId] && answer.question_time_remaining_seconds != null) answers[questionId].question_time_remaining_seconds = answer.question_time_remaining_seconds;
    }
    const personal = await loadPersonalState(questions.map((question) => question.id)); const session = sessionResult.data;
    if(session.preset==='active-recall-v2'){
      const ids=Object.values(answers).map(a=>a.client_event_id).filter(Boolean),retrievals=[];
      for(let i=0;i<ids.length;i+=200){const r=await db.from('active_recall_retrievals').select('event_id,strength,is_correct,mastery,interval_minutes').eq('user_id',state.user.id).in('event_id',ids.slice(i,i+200));if(r.error)throw r.error;retrievals.push(...(r.data||[]));}
      const byEvent=new Map(retrievals.map(r=>[r.event_id,r]));
      for(const answer of Object.values(answers)){const r=byEvent.get(answer.client_event_id);if(r){answer.attemptRecorded=true;answer.retrieval_strength=r.strength;answer.srmFeedback={state:r.mastery,interval_minutes:r.interval_minutes,relearn:!r.is_correct||r.strength==='failed'};}}
    }

    if(state.user?.id!==resumeUser)return;
    assertValidation(validateResumeSnapshot({ session, storedRows: itemsResult.data || [], questions, answers: answersResult.data || [] }), 'Resume');
    assertValidation(validateQuestionStateBindings({ questions, answers, bookmarks: personal.bookmarks, marked: personal.marked }), 'Resumed question state');
    const resumedAt = Date.now();
    const resumedIndex = Math.min(session.current_position || 0, Math.max(questions.length - 1, 0));
    const resumedAnswer = answers[questions[resumedIndex]?.id];
    let localClock;try{localClock=JSON.parse(localStorage.getItem(`qbank-clock-v1:${state.user.id}:${id}`));}catch{}
    const candidates=[session.timer_state,localClock,existingActive?.timer_state].filter(c=>c?.version===1&&c.position===resumedIndex);
    let restoredClock=candidates.sort((a,b)=>b.savedAt-a.savedAt)[0];
    if(!restoredClock){const used=Object.values(answers).reduce((n,a)=>n+Number(a.time_spent_seconds||0)*1000,0);restoredClock={...initialClock(resumedIndex,resumedAt),totalUsedMs:used,questionUsedMs:Number(resumedAnswer?.time_spent_seconds||0)*1000,paused:Boolean(resumedAnswer?.selected_option)};}
    if (session.mode === 'recall' && [0,50,55].includes(restoredClock.recallSeconds)) session.target_seconds_per_question = restoredClock.recallSeconds;
    if (session.mode === 'recall') { restoredClock.questionLimitMs = session.target_seconds_per_question === 0 ? Infinity : (session.target_seconds_per_question ?? 50) * 1000; restoredClock.startedAt = resumedAt; restoredClock.paused = Boolean(resumedAnswer?.selected_option); }
    restoredClock=checkpointClock(restoredClock,resumedAt,session.mode === 'recall' ? Infinity : questions.length*50000);
    state.active = { ...session, solvingVisible: true, kind: ['practice', 'recall'].includes(session.mode) ? session.mode : 'test', questions, index: resumedIndex, answers, bookmarks: personal.bookmarks, marked: personal.marked, learning: personal.learning, questionStartedAt: resumedAt, questionTimeRemainingSeconds: resumedAnswer?.selected_option ? answeredQuestionTimeRemaining(resumedAnswer) : null, timer_state: restoredClock, explanationOpen: false, completedReview: session.status !== 'in_progress' };
    if (state.active.completedReview) { resultScreen(); return; }
    await persistTimer(state.active);
    renderActive();
  } catch (error) { toast(error.message || 'Could not resume session.', 'error'); location.hash = '#/home'; }
}

async function submitActive(timedOut = false) {
  const active = state.active; if (!active || active.completedReview || active.submitting || active.status !== 'in_progress') return;
  const answeredRows = Object.values(active.answers).filter((a) => a?.selected_option); const unanswered = active.questions.length - answeredRows.length;
  if (!timedOut && !confirm(`Finish this ${active.kind}? ${unanswered} question${unanswered === 1 ? '' : 's'} unanswered.`)) return;
  const submitUser=state.user?.id;
  active.submitting=true;
  try {
  await Promise.all([...answerWrites.entries()].filter(([key])=>key.startsWith(active.id+':')).map(([,write])=>write.promise));
  pauseTotalTimer(active);await persistTimer(active);
  stopActiveTimer(); const current = activeQuestion(); if (current) { const currentAnswer = active.answers[current.id]; await ensureAttemptRecorded(current, currentAnswer); await saveActiveAnswer(current.id); }
  let completed = null;
  if (active.id) { const result = await db.rpc('submit_test_session', { p_session_id: active.id, p_timed_out: timedOut }); if (result.error) return toast(result.error.message, 'error'); completed = result.data; }
  if (Array.isArray(completed)) completed = completed[0] || null;
  active.status = completed?.status || (timedOut ? 'timed_out' : 'completed');
  if(state.active!==active||state.user?.id!==submitUser)return;
  // Test outcomes are recorded atomically by submit_test_session.
  if (active.kind === 'test') { active.history=null; invalidateLearnerCaches(); }
  if (Array.isArray(completed)) completed = completed[0] || null;
  const totalCorrect = completed?.total_correct ?? active.questions.filter((q) => isAnswerCorrect(q, active.answers[q.id])).length;
  state.active = { ...active, ...(completed || {}), total_questions: completed?.total_questions ?? active.questions.length, total_correct: totalCorrect, incorrect_count: completed?.incorrect_count ?? answeredRows.length - totalCorrect, unanswered_count: completed?.unanswered_count ?? unanswered, total_time_seconds: completed?.total_time_seconds ?? Math.floor(totalTimeUsed(active)/1000), timed_out: completed?.timed_out ?? timedOut, status: completed?.status ?? (timedOut ? 'timed_out' : 'completed'), completedReview: false };
  resultScreen();
  } finally { active.submitting=false;if(state.active?.id===active.id)state.active.submitting=false; }
}

function reviewPositions(active) {
 return active.questions.flatMap((q,i)=>{const a=active.answers[q.id],status=!a?.selected_option?'unattempted':isAnswerCorrect(q,a)?'correct':'incorrect';return !active.reviewFilter||active.reviewFilter==='all'||active.reviewFilter===status?[i]:[];});
}
function startCompletedReview(filter='all') {
 const active=state.active;const previous=active.reviewFilter;active.reviewFilter=filter;
 const positions=reviewPositions(active);
 if(!positions.length){active.reviewFilter=previous;toast('No questions match this review filter.');return;}
 active.completedReview=true;
 active.index=positions[0];active.explanationOpen=true;stopActiveTimer();renderActive();
}

function resultScreen() {
  const active = state.active; const answered = Object.values(active.answers).filter((answer) => answer?.selected_option).length;
  const average = answered ? Math.round(Object.values(active.answers).reduce((sum, answer) => sum + (answer?.time_spent_seconds || 0), 0) / answered) : 0;
  layout(`<div class="page-heading"><span class="eyebrow">${active.timed_out ? 'TIME EXPIRED' : 'COMPLETED'}</span><h1>${e(active.title || 'Result')}</h1><p>${[...new Set(active.questions.map(q=>questionMeta(q)))].join(' · ')} · ${e(active.questions[0]?.source_test_label||active.title||'')}</p><small>${date(active.completed_at||new Date())} · Time ${timerText(active.total_time_seconds||0)}</small></div><section class="result-grid"><div class="card metric"><span>Score</span><b>${active.total_correct}/${active.total_questions}</b></div><div class="card metric"><span>Accuracy</span><b>${pct(active.total_correct, answered)}</b></div><div class="card metric"><span>Incorrect</span><b>${active.incorrect_count}</b></div><div class="card metric"><span>Unanswered</span><b>${active.unanswered_count}</b></div><div class="card metric"><span>Average time</span><b>${average}s</b></div></section><section class="card result-actions"><div class="row"><button class="button" data-action="review-result">Review Test</button><button class="button secondary" data-action="review-mistakes">Review incorrect</button><a class="button secondary" href="#/tests">Return to Tests</a><a class="button ghost" href="#/history">History</a></div></section>`);
}

async function legacyHistory() {
  const result = await optional(db.from('test_sessions').select('*').eq('user_id', state.user.id).neq('status', 'in_progress').order('completed_at', { ascending: false }).limit(100), 'sessions');
  layout(`<div class="page-heading"><span class="eyebrow">TEST HISTORY</span><h1>Completed sessions</h1><p>Every result leads back to its original question set.</p></div><section class="card">${result.data?.length ? `<ul class="history-list">${result.data.map((session) => `<li><div><b>${e(session.title || session.preset || 'Test')}</b><div class="subtle">${date(session.completed_at)} · ${session.total_questions} questions · ${session.total_correct} correct · ${session.incorrect_count ?? '—'} incorrect</div></div><div class="row"><span class="pill">${pct(session.total_correct, session.total_correct + (session.incorrect_count || 0))}</span><button class="button secondary" data-action="resume" data-id="${e(session.id)}">Open result</button></div></li>`).join('')}</ul>` : '<div class="empty">No completed sessions yet.</div>'}</section>`);
}

async function review() {
  const reviewUser=state.user?.id,reviewGeneration=recallGeneration;
  const now = new Date().toISOString();
  const learning = await optional(paged(() => db.from('user_question_state').select('question_id,last_is_correct,wrong,bookmarked,marked_for_review,revision,srm_active,srm_due_at,personally_difficult,last_time_seconds,questions(id,platform_id,subject_id,is_pyq)').eq('user_id', reviewUser).order('question_id'),500).then(data=>({data})).catch(error=>({error})), 'learning');
  if(state.user?.id!==reviewUser||recallGeneration!==reviewGeneration||state.route!=='review')return;
  const rows = learning.data || [];
  const selected = state.reviewFilters || { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], pyq: '' };
  const marrowId=state.meta.platforms.find(p=>p.name.toLowerCase()==='marrow')?.id;
  const sourceItems=state.meta.platforms.flatMap(p=>p.id===marrowId?[{id:p.id+':qbank',name:'Marrow QBank'},{id:p.id+':pyq',name:'Marrow PYQs'}]:[p]);
  const sourceKey=q=>q?.platform_id===marrowId?marrowId+(q.is_pyq?':pyq':':qbank'):q?.platform_id;
  const sourceAllowed=new Set(rows.filter(r=>!selected.study_sources?.length||selected.study_sources.includes(sourceKey(r.questions))).map(r=>r.question_id));
  const learningQuestionIds = [...new Set(rows.map((row) => String(row.question_id)))];
  const hasPopulationFilter = ['platforms','subjects','systems','topics','subtopics','source_tests'].some((key) => selected[key]?.length) || Boolean(selected.pyq);
  const validIds = new Set(hasPopulationFilter ? await matchingQuestionIds({ ...selected, question_ids: learningQuestionIds, statuses: ['all'], year: '', search: '', source: '' }) : learningQuestionIds);
  if(state.user?.id!==reviewUser||recallGeneration!==reviewGeneration||state.route!=='review')return;
  for(const id of validIds)if(!sourceAllowed.has(id))validIds.delete(id);
  const categories = [
    ['incorrect', 'Incorrect', rows.filter((x) => x.last_is_correct === false || x.wrong), 'Mistakes awaiting 3 SURE-correct answers since the last wrong answer.'],
    ['correct', 'Correct', rows.filter((x) => x.last_is_correct === true), 'Questions whose current learning state is correct.'],
    ['bookmarked', 'Bookmarked', rows.filter((x) => x.bookmarked), 'Questions saved for later.'],
    ['marked', 'Marked for Review', rows.filter((x) => x.marked_for_review || x.revision), 'Questions explicitly marked.'],
    ['recall_due', 'Recall Due', rows.filter((x) => x.srm_active && x.srm_due_at && x.srm_due_at <= now), 'Questions currently due in the deterministic Recall queue.'],
    ['difficult', 'Personally Difficult', rows.filter((x) => x.personally_difficult), 'Questions flagged as difficult.'],
    ['slow', 'Slow >50s', rows.filter((x) => Number(x.last_time_seconds) > TARGET_SECONDS), 'Questions whose latest relevant time exceeded 50 seconds.'],
  ];
  const taxonomyRows = rows.map(row=>row.questions?{...row.questions,study_source:sourceKey(row.questions)}:null).filter(Boolean);
  const taxonomyByQuestion = new Map(taxonomyRows.map((item) => [String(item.id), item]));
  const groupRows = (ids, field, items, status, title) => {
    const groups = new Map(); ids.forEach((id) => { const key = taxonomyByQuestion.get(String(id))?.[field]; if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(id); } });
    const names = byId(items);
    return [...groups].sort((a, b) => b[1].length - a[1].length).map(([id, questionIds]) => `<li><span><b>${e(names.get(String(id))?.name || 'Unclassified')}</b><small>${questionIds.length} question${questionIds.length === 1 ? '' : 's'}</small></span>${actionSetButtons({ mode: 'test', preset: 'revision', title: `${title} · ${names.get(String(id))?.name || 'Unclassified'}`, filters: { ...selected, statuses: ['all'], pyq: '', year: '', search: '', source: '' }, questionIds }, 'Start revision test')}</li>`).join('');
  };
  const cards = categories.map(([status, title, categoryRows, description]) => {
    const questionIds = [...new Set(categoryRows.map((row) => String(row.question_id)).filter((id) => validIds.has(id)))];
    return `<article class="card review-detail"><div class="section-heading"><div><span class="eyebrow">${e(title)}</span><b class="review-count">${questionIds.length}</b><p>${e(description)}</p></div>${actionSetButtons({ mode: 'test', preset: 'revision', title: `${title} revision`, filters: { ...selected, statuses: ['all'], pyq: '', year: '', search: '', source: '' }, questionIds }, 'Start revision test')}</div>${questionIds.length ? `<details><summary>By subject</summary><ul class="action-list">${groupRows(questionIds, 'subject_id', state.meta.subjects, status, title)}</ul></details><details><summary>By platform</summary><ul class="action-list">${groupRows(questionIds, 'study_source', sourceItems, status, title)}</ul></details>` : ''}</article>`;
  }).join('');
  layout(`<div class="page-heading"><span class="eyebrow">REVIEW</span><h1>Everything worth revisiting</h1><p>Filter the review population, then browse or test the exact same question IDs.</p></div>${!state.features.learning ? featureNotice('Apply the learning-interface migration for accurate consolidated review counts.') : ''}<section class="card builder-card"><form id="review-filter-form" class="stack"><div class="filters">${multiPicker('study_sources', 'Study sources', sourceItems)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics)}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics)}</div><div class="row"><button class="button">Apply review filters</button><button type="button" class="button ghost" data-action="clear-review-filters">Clear</button></div></form></section><section class="review-stack">${cards}</section><section class="card section-card"><div class="section-heading"><h2>Test history</h2><a class="button secondary" href="#/history">Open history</a></div></section>`);
  const form = document.querySelector('#review-filter-form');
  if (state.meta.sourceTests.length) form.querySelector('.filters')?.insertAdjacentHTML('beforeend', `${multiPicker('source_tests', 'Source Tests', state.meta.sourceTests)}<div class="field"><label>PYQ</label><select name="pyq"><option value="">All questions</option><option value="yes">PYQ only</option><option value="no">Non-PYQ</option></select></div>`);
  for (const level of ['study_sources', 'platforms', 'subjects', 'systems', 'topics', 'subtopics', 'source_tests']) (selected[level] || []).forEach((id) => { const input = form.querySelector(`input[name="${level}"][value="${CSS.escape(String(id))}"]`); if (input) input.checked = true; });
  if (form.elements.pyq) form.elements.pyq.value = selected.pyq || '';
  setupDependentFilters(form);
  form.onsubmit = (event) => { event.preventDefault(); const filters = readFilters(form); state.reviewFilters = filters; review(); };
}

const ANALYTICS_STATUSES = [['all', 'All'], ['new', 'Unattempted'], ['attempted', 'Attempted'], ['incorrect', 'Incorrect'], ['correct', 'Correct'], ['bookmarked', 'Bookmarked'], ['marked', 'Marked for Review'], ['recall_due', 'Recall Due']];
const ANALYTICS_EXAM_LABELS = { inicet: 'INI-CET', neet_pg: 'NEET PG' };

function analyticsStatusPicker() {
  return `<fieldset class="field wide status-field"><legend>Question status</legend><div class="chip-checks">${ANALYTICS_STATUSES.map(([value, label]) => `<label><input type="checkbox" name="statuses" value="${value}" ${value === 'all' ? 'checked' : ''} /> <span>${e(label)}</span></label>`).join('')}</div></fieldset>`;
}

function analyticsMetadataFields(capabilities) {
  const examItems = capabilities.exams.map((id) => ({ id, name: ANALYTICS_EXAM_LABELS[id] || id.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }));
  return `<div class="field"><label>PYQ</label><select name="pyq"><option value="">All questions</option><option value="yes">PYQ only</option><option value="no">Non-PYQ</option></select></div>${examItems.length ? multiPicker('exams', 'Exams', examItems) : ''}${capabilities.years.length ? multiPicker('years', 'Exam years', capabilities.years.map((value) => ({ id: value, name: value }))) : ''}${capabilities.sessions.length ? multiPicker('sessions', 'Exam sessions', capabilities.sessions.map((value) => ({ id: value, name: value }))) : ''}<div class="field analytics-srm-ready"><label>SRM</label><select name="srm" disabled><option value="">Available when SRM state exists</option></select></div>`;
}

async function fetchAnalyticsModel(questionIds) {
  const attempts = []; const learning = [];
  const allowed = new Set(questionIds.map(String));
  if (questionIds.length > 1000) {
    let attemptRows;
    try { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at,time_spent_seconds,confidence').eq('user_id', state.user.id).order('answered_at', { ascending: false })); }
    catch { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).order('answered_at', { ascending: false })); }
    attempts.push(...attemptRows.filter((row) => allowed.has(String(row.question_id))));
    const stateRows = await optional(paged(() => db.from('user_question_state').select('question_id,bookmarked,marked_for_review,revision,srm_active,srm_due_at,srm_state,srm_consecutive_incorrect,srm_total_reviews,last_time_seconds,last_confidence').eq('user_id', state.user.id)), 'learning');
    learning.push(...(stateRows.data || stateRows || []).filter((row) => allowed.has(String(row.question_id))));
  }
  for (let index = 0; index < questionIds.length && questionIds.length <= 1000; index += 200) {
    const chunk = questionIds.slice(index, index + 200);
    let attemptRows;
    try { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at,time_spent_seconds,confidence').eq('user_id', state.user.id).in('question_id', chunk).order('answered_at', { ascending: false })); }
    catch { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).in('question_id', chunk).order('answered_at', { ascending: false })); }
    attempts.push(...attemptRows);
    const stateRows = await optional(db.from('user_question_state').select('question_id,bookmarked,marked_for_review,revision,srm_active,srm_due_at,srm_state,srm_consecutive_incorrect,srm_total_reviews,last_time_seconds,last_confidence').eq('user_id', state.user.id).in('question_id', chunk), 'learning');
    learning.push(...(stateRows.data || []));
  }
  attempts.sort((a, b) => new Date(b.answered_at || 0) - new Date(a.answered_at || 0));
  const latest = new Map(); const attemptsByQuestion = new Map();
  attempts.forEach((row) => { const id = String(row.question_id); if (!latest.has(id)) latest.set(id, row); if (!attemptsByQuestion.has(id)) attemptsByQuestion.set(id, []); attemptsByQuestion.get(id).push(row); });
  return { attempts, latest, attemptsByQuestion, learning: new Map(learning.map((row) => [String(row.question_id), row])) };
}

function analyticsMetric(questionIds, model) {
  const ids = [...new Set(questionIds.map(String))]; const attempts = ids.flatMap((id) => model.attemptsByQuestion.get(id) || []);
  const attempted = ids.filter((id) => model.latest.has(id));
  const correct = attempted.filter((id) => model.latest.get(id)?.is_correct === true);
  const incorrect = attempted.filter((id) => model.latest.get(id)?.is_correct === false);
  const unattempted = ids.filter((id) => !model.latest.has(id));
  const bookmarked = ids.filter((id) => model.learning.get(id)?.bookmarked === true);
  const marked = ids.filter((id) => model.learning.get(id)?.marked_for_review === true || model.learning.get(id)?.revision === true);
  const now = Date.now(); const recallDue = ids.filter((id) => { const learning = model.learning.get(id); return learning?.srm_active && learning.srm_due_at && new Date(learning.srm_due_at).getTime() <= now; });
  const timed = attempts.filter((row) => row.time_spent_seconds != null);
  const latestTime = (id) => Number(model.latest.get(id)?.time_spent_seconds ?? model.learning.get(id)?.last_time_seconds ?? 0);
  const slow = attempted.filter((id) => latestTime(id) > TARGET_SECONDS);
  const verySlow = attempted.filter((id) => latestTime(id) > TARGET_SECONDS * 2);
  const fastWrong = incorrect.filter((id) => latestTime(id) > 0 && latestTime(id) < 30);
  const slowWrong = incorrect.filter((id) => latestTime(id) > 75);
  const wrongCount = (id) => (model.attemptsByQuestion.get(id) || []).filter((row) => row.is_correct === false).length;
  const repeatedIncorrect = ids.filter((id) => wrongCount(id) >= 2);
  const wrongThree = ids.filter((id) => wrongCount(id) >= 3);
  const recovered = correct.filter((id) => wrongCount(id) > 0);
  const pyq = ids.filter((id) => state.analyticsPyqSet.has(id));
  return { ids, attempted, correct, incorrect, unattempted, bookmarked, marked, recallDue, attempts: attempts.length, coverage: pct(attempted.length, ids.length), latestAccuracy: pct(correct.length, attempted.length), latestAccuracyValue: attempted.length ? correct.length / attempted.length : null, attemptAccuracy: pct(attempts.filter((row) => row.is_correct).length, attempts.length), averageTime: timed.length ? Math.round(timed.reduce((sum, row) => sum + Number(row.time_spent_seconds || 0), 0) / timed.length) : null, slow, verySlow, fastWrong, slowWrong, repeatedIncorrect, wrongThree, recovered, pyq };
}

function analyticsStatusIds(questionIds, statuses, model) {
  const metric = analyticsMetric(questionIds, model);
  const selected = new Set(statuses || []); if (!selected.size || selected.has('all')) return metric.ids;
  const populations = { new: metric.unattempted, attempted: metric.attempted, incorrect: metric.incorrect, correct: metric.correct, bookmarked: metric.bookmarked, marked: metric.marked, recall_due: metric.recallDue };
  return metric.ids.filter((id) => [...selected].some((status) => (populations[status] || []).includes(id)));
}

function analyticsActionButton({ title, questionIds, filters, label, secondary = false, open = false }) {
  const ids = [...new Set((questionIds || []).map(String))];
  if (!ids.length) return '';
  const token = registerActionSet({ mode: 'test', preset: 'analytics', title, filters: { ...filters, statuses: ['all'] }, questionIds: ids, origin: '#/analytics' });
  return `<button class="button ${secondary ? 'secondary ' : ''}compact" data-action="${open ? 'open-action-set' : 'preview-action-set'}" data-set="${e(token)}">${e(label)}</button>`;
}

function analyticsActionButtons(population) {
  const ids = [...new Set(population.questionIds.map(String))];
  if (!ids.length) return '<span class="subtle">No questions match this selection.</span>';
  const token = registerActionSet({ mode: 'test', preset: 'analytics', title: population.title, filters: { ...population.filters, statuses: ['all'] }, questionIds: ids, origin: '#/analytics' });
  return `<button class="button secondary compact" data-action="open-action-set" data-set="${e(token)}">Review Questions</button><button class="button compact" data-action="preview-action-set" data-set="${e(token)}">Start Test</button>`;
}

function analyticsPopulationControls(population) {
  return `<div class="analytics-population-controls"><div class="row">${analyticsActionButtons(population)}</div></div>`;
}

function analyticsGroups(level) {
  return state.analyticsView?.groups?.get(level) || [];
}

async function loadAnalyticsGroups(levels, filters, model) {
  const entries = await Promise.all(levels.map(async (level) => [level, await resolvePopulationGroups(filters, level)]));
  entries.forEach(([level, groups]) => state.analyticsView.groups.set(level, groups.map((group) => ({ ...group, metric: analyticsMetric(group.questionIds, model) }))));
}

async function renderAnalyticsBreakdown(level, page = 1) {
  const holder = document.querySelector('#analytics-breakdown-selected'); if (!holder || !state.analyticsView) return;
  if (!state.analyticsView.groups.has(level)) {
    holder.innerHTML = '<div class="empty">Loading breakdown…</div>';
    await loadAnalyticsGroups([level], state.analyticsView.filters, state.analyticsView.model);
    if (!holder.isConnected) return;
  }
  const groups = analyticsGroups(level); const visible = groups.slice(0, page * 50);
  holder.innerHTML = visible.length ? visible.map((group) => {
    const metric = group.metric; const enough = metric.attempted.length >= 5; const weak = enough && metric.latestAccuracyValue < .6;
    return `<details class="analytics-breakdown-row"><summary><span><b>${e(group.name)}</b>${weak ? '<span class="pill weak-pill">Weak</span>' : !enough && metric.attempted.length ? '<span class="pill neutral-pill">Not enough data</span>' : ''}</span><span class="breakdown-performance"><b>${metric.latestAccuracy}</b><small>${metric.attempted.length} / ${metric.ids.length} attempted · ${metric.coverage} coverage · ${metric.incorrect.length} wrong · ${metric.averageTime == null ? '—' : `${metric.averageTime}s`} avg</small></span></summary><div class="analytics-row-detail"><div class="compact-stats"><span>Total attempts <b>${metric.attempts}</b></span><span>Bookmarked <b>${metric.bookmarked.length}</b></span><span>Marked <b>${metric.marked.length}</b></span><span>Repeatedly incorrect <b>${metric.repeatedIncorrect.length}</b></span>${metric.pyq.length ? `<span>PYQ <b>${metric.pyq.length}</b></span>` : ''}</div>${analyticsPopulationControls({ title: group.name, questionIds: group.questionIds, filters: state.analyticsView.filters })}</div></details>`;
  }).join('') + (visible.length < groups.length ? `<button class="button secondary" data-action="analytics-more" data-level="${e(level)}" data-page="${page + 1}">Show next ${Math.min(50, groups.length - visible.length)}</button>` : '') : '<div class="empty">No mapped entries in this population.</div>';
}

function analyticsAttentionRows(questionIds, model) {
  const mapping = new Map(state.meta.questionTaxonomy.map((question) => [String(question.id), question]));
  const definitions = [['subject_id', state.meta.subjects, false], ['source_test_ids', state.meta.sourceTests, true]];
  const pyqSet = new Set(filterAnalyticsPopulation(state.meta.questionTaxonomy, { pyq: 'yes' }));
  const rows = [];
  for (const [field, items, nested] of definitions) {
    const names = byId(items); const groups = new Map();
    questionIds.forEach((id) => {
      const value = mapping.get(String(id))?.[field]; const keys = nested ? value || [] : [value];
      keys.filter(Boolean).forEach((key) => { if (!groups.has(String(key))) groups.set(String(key), []); groups.get(String(key)).push(String(id)); });
    });
    groups.forEach((ids, id) => {
      const metric = analyticsMetric(ids, model); const pyqMetric = analyticsMetric(ids.filter((value) => pyqSet.has(value)), model);
      const priority = analyticsStudyPriority({ isPyq: pyqMetric.incorrect.length > 0, currentIncorrect: metric.incorrect.length, repeatedIncorrect: metric.repeatedIncorrect.length, slowIncorrect: metric.slowWrong.length, attempted: metric.attempted.length, available: metric.ids.length, latestAccuracy: metric.latestAccuracyValue, bookmarked: metric.bookmarked.length, marked: metric.marked.length });
      const meaningful = metric.repeatedIncorrect.length || pyqMetric.incorrect.length || (metric.attempted.length >= 5 && metric.latestAccuracyValue < .7);
      if (meaningful) rows.push({ id, name: names.get(id)?.name || 'Unclassified', metric, pyqMetric, priority });
    });
  }
  return rows.sort((a, b) => b.priority.score - a.priority.score || b.metric.attempted.length - a.metric.attempted.length).slice(0, 5);
}

function analyticsTrend(model) {
  const weeks = new Map();
  model.attempts.forEach((row) => {
    const stamp = new Date(row.answered_at || 0); if (!Number.isFinite(stamp.getTime())) return;
    const start = new Date(stamp); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const key = start.toISOString().slice(0, 10); if (!weeks.has(key)) weeks.set(key, new Map());
    const current = weeks.get(key).get(String(row.question_id));
    if (!current || new Date(row.answered_at) > new Date(current.answered_at)) weeks.get(key).set(String(row.question_id), row);
  });
  return [...weeks].sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([week, rows]) => {
    const values = [...rows.values()]; const correct = values.filter((row) => row.is_correct === true).length;
    return { week, attempted: values.length, accuracy: values.length ? Math.round(correct / values.length * 100) : 0 };
  });
}

function analyticsSelectionLabel(filters) {
  const parts = [];
  if (filters.platforms?.length) parts.push(filters.platforms.map((id) => state.meta.platforms.find((row) => row.id === id)?.name).filter(Boolean).join(' + '));
  if (filters.subjects?.length) parts.push(filters.subjects.map((id) => state.meta.subjects.find((row) => row.id === id)?.name).filter(Boolean).join(' + '));
  if (filters.pyq === 'yes') parts.push('PYQ'); if (filters.pyq === 'no') parts.push('Non-PYQ');
  return parts.join(' / ') || 'All usable questions';
}

function snapshotMetric(row = {}) {
  const available = Number(row.available || 0); const attempted = Number(row.attempted || 0);
  const latestCorrect = Number(row.latest_correct || 0); const totalAttempts = Number(row.total_attempts || 0);
  const attemptCorrect = Number(row.attempt_correct || 0); const timedAttempts = Number(row.timed_attempts || 0);
  return { ...row, available, attempted, latestCorrect, latestIncorrect: Number(row.latest_incorrect || 0),
    totalAttempts, coverage: pct(attempted, available), latestAccuracy: pct(latestCorrect, attempted),
    attemptAccuracy: pct(attemptCorrect, totalAttempts), averageTime: timedAttempts ? Math.round(Number(row.timed_seconds || 0) / timedAttempts) : null };
}

function lazyAnalyticsAction({ title, filters, label, secondary = false }) {
  const token = registerActionSet({ mode: 'test', preset: 'analytics', title, filters, questionIds: null, requested: 'all', origin: '#/analytics' });
  return `<button class="button ${secondary ? 'secondary ' : ''}compact" data-action="open-action-set" data-set="${e(token)}">${e(label)}</button>`;
}

async function analyticsSnapshot() {
  if (state.analyticsSnapshot) return state.analyticsSnapshot;
  const started = performance.now(); const result = await db.rpc('qbank_analytics_snapshot');
  if (result.error) throw result.error;
  state.analyticsSnapshot = { ...result.data, client_ms: Math.round(performance.now() - started) };
  return state.analyticsSnapshot;
}

function renderAnalyticsSnapshot(snapshot) {
  const overall = snapshotMetric(snapshot.overall); const pyq = snapshotMetric(snapshot.pyq);
  const subjects = (snapshot.subjects || []).map((row) => ({ ...snapshotMetric(row), id: String(row.subject_id), name: row.name }));
  const base = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '' };
  const wrong = lazyAnalyticsAction({ title: 'Current incorrect questions', filters: { ...base, statuses: ['incorrect'] }, label: 'Review Incorrect' });
  const bookmarks = lazyAnalyticsAction({ title: 'Bookmarked questions', filters: { ...base, statuses: ['bookmarked'] }, label: 'Open Bookmarks', secondary: true });
  const pyqWrong = lazyAnalyticsAction({ title: 'Incorrect PYQs', filters: { ...base, statuses: ['incorrect'], pyq: 'yes' }, label: 'Review Wrong PYQs', secondary: true });
  return `<section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">QBANK SNAPSHOT</span><h2>Coverage and current performance</h2><p class="subtle">Compact server summary · no question bodies or full-corpus ID list loaded.</p></div><span class="pill">${snapshot.client_ms} ms</span></div>${metricStrip([['Available', overall.available], ['Attempted', overall.attempted, overall.coverage], ['Latest accuracy', overall.latestAccuracy], ['Currently wrong', overall.latestIncorrect], ['Bookmarked', Number(overall.bookmarked || 0)], ['Marked', Number(overall.marked || 0)], ['Avg time', overall.averageTime == null ? '—' : `${overall.averageTime}s`]])}<div class="analytics-command-actions">${wrong}${bookmarks}</div></section>
  <section class="analytics-compact analytics-pyq"><div class="section-heading"><div><span class="eyebrow">PYQ PERFORMANCE</span><h2>Previous-year questions</h2></div><button class="button ghost compact" data-action="analytics-section" data-section="pyq">Open PYQ analytics</button></div>${metricStrip([['Available', pyq.available], ['Attempted', pyq.attempted, pyq.coverage], ['Latest accuracy', pyq.latestAccuracy], ['Currently wrong', pyq.latestIncorrect], ['Repeated', Number(pyq.repeated_incorrect || 0)], ['Recovered', Number(pyq.recovered || 0)]])}<div class="analytics-command-actions">${pyqWrong}</div></section>
  <section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">BY SUBJECT</span><h2>Combined learner state across every source</h2></div></div><div class="subject-list">${subjects.map((row) => `<article><div><b>${e(row.name)}</b><small>${row.attempted}/${row.available} attempted · ${row.latestAccuracy} accuracy · ${row.latestIncorrect} wrong · ${Number(row.bookmarked || 0)} bookmarked</small></div><button class="button secondary compact" data-action="analytics-subject" data-subject="${e(row.id)}">Open</button></article>`).join('')}</div></section>`;
}

async function legacyAnalytics() {
  loading('Calculating selected analytics…');
  const filters = state.analyticsFilters || { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '', srm: '' };
  const cascade = resolveTaxonomyCascade(state.meta.questionTaxonomy, filters);
  const capabilities = analyticsMetadataCapabilities(state.meta.questionTaxonomy, cascade.matchingQuestionIds);
  const normalizedFilters = {
    ...filters, ...cascade.selected,
    statuses: filters.statuses?.length ? filters.statuses : ['all'],
    exams: (filters.exams || []).filter((value) => capabilities.exams.includes(String(value))),
    years: (filters.years || []).filter((value) => capabilities.years.includes(String(value))),
    sessions: (filters.sessions || []).filter((value) => capabilities.sessions.includes(String(value))),
    year: '', search: '', source: '',
  };
  const overallIds = await matchingQuestionIds({ platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '', year: '', search: '', source: '' });
  const questionIds = await matchingQuestionIds(normalizedFilters);
  const model = await fetchAnalyticsModel(overallIds);
  const overallMetric = analyticsMetric(overallIds, model);
  const metric = analyticsMetric(questionIds, model);
  const pyqIds = filterAnalyticsPopulation(state.meta.questionTaxonomy, { pyq: 'yes' });
  const pyqMetric = analyticsMetric(pyqIds, model);
  const pyqWrong = analyticsActionQuestionIds(pyqMetric, 'review_wrong_pyqs');
  const pyqPractice = analyticsActionQuestionIds(pyqMetric, 'practice_pyqs');
  const pyqUnattempted = analyticsActionQuestionIds(pyqMetric, 'unattempted_pyqs');
  const repeatedMistakes = analyticsActionQuestionIds(overallMetric, 'review_repeated_mistakes');
  const topicSubtopicRedundant = analyticsTopicSubtopicRedundant({ questionIndex: state.meta.questionTaxonomy, topics: state.meta.topics, subtopics: state.meta.subtopics, questionIds });
  state.analyticsView = { questionIds, model, filters: normalizedFilters, groups: new Map(), topicSubtopicRedundant, capabilities };
  const combined = { title: 'Selected analytics population', questionIds, filters: normalizedFilters };
  const candidates = [['platform', 'Platform'], ['subject', 'Subject'], ['system', 'System'], ['topic', topicSubtopicRedundant ? 'Topic / Subtopic' : 'Topic'], ...(!topicSubtopicRedundant ? [['subtopic', 'Subtopic']] : []), ['source_test', 'Source Test'], ['pyq', 'PYQ'], ['exam', 'Exam'], ['year_session', 'Year / session']];
  const breakdowns = candidates.filter(([level]) => analyticsGroups(level).length > 1);
  if (!breakdowns.some(([level]) => level === state.analyticsBreakdown)) state.analyticsBreakdown = null;
  const attention = analyticsAttentionRows(overallIds, model); const trend = analyticsTrend(model);
  const allAnalyticsFilters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '' };
  const pyqFilters = { ...allAnalyticsFilters, pyq: 'yes' };
  const pyqActions = `${analyticsActionButton({ title: 'Wrong PYQs', questionIds: pyqWrong, filters: pyqFilters, label: 'Review Wrong PYQs', secondary: true, open: true })}${analyticsActionButton({ title: 'PYQ practice', questionIds: pyqPractice, filters: pyqFilters, label: 'Practice PYQs' })}<button class="button ghost compact" data-action="analyze-pyqs">Analyze PYQs</button>${analyticsActionButton({ title: 'Unattempted PYQs', questionIds: pyqUnattempted, filters: pyqFilters, label: 'Unattempted PYQs', secondary: true })}`;
  layout(`<div class="page-heading analytics-heading"><span class="eyebrow">ANALYTICS</span><h1>Your next best study move</h1><p>PYQs first, then weaknesses, repeated mistakes and honest coverage.</p></div>
  <section class="card analytics-pyq"><div class="section-heading"><div><span class="eyebrow">PYQ PERFORMANCE</span><h2>Previous-year question command center</h2><p class="subtle">Only questions supported by real PYQ source metadata are included.</p></div></div><div class="analytics-primary-metrics analytics-pyq-metrics"><div><span>PYQ available</span><b>${pyqMetric.ids.length}</b><small>usable questions</small></div><div><span>Attempted</span><b>${pyqMetric.attempted.length}</b><small>${pyqMetric.coverage} coverage</small></div><div><span>Latest accuracy</span><b>${pyqMetric.latestAccuracy}</b><small>newest answer per question</small></div><div><span>Currently incorrect</span><b>${pyqMetric.incorrect.length}</b><small>${pyqMetric.repeatedIncorrect.length} repeatedly incorrect</small></div></div><div class="analytics-secondary"><span>Bookmarked PYQs <b>${pyqMetric.bookmarked.length}</b></span><span>Marked PYQs <b>${pyqMetric.marked.length}</b></span><span>Average PYQ time <b>${pyqMetric.averageTime == null ? '—' : `${pyqMetric.averageTime}s`}</b></span></div><div class="analytics-command-actions">${pyqActions || '<span class="subtle">No PYQ actions are available yet.</span>'}</div></section>
  <section class="card analytics-summary" data-analytics-overall><div class="section-heading"><div><span class="eyebrow">OVERALL PERFORMANCE</span><h2>${overallMetric.attempted.length} of ${overallMetric.ids.length} questions covered</h2><p class="subtle">${overallMetric.coverage} coverage and ${overallMetric.latestAccuracy} latest-answer accuracy are separate signals.</p></div></div><div class="analytics-primary-metrics"><div><span>Coverage</span><b>${overallMetric.coverage}</b><small>${overallMetric.attempted.length} unique attempted</small></div><div><span>Latest-answer accuracy</span><b>${overallMetric.latestAccuracy}</b><small>current performance</small></div><div><span>Total attempts</span><b>${overallMetric.attempts}</b><small>${overallMetric.attemptAccuracy} attempt accuracy</small></div><div><span>Currently incorrect</span><b>${overallMetric.incorrect.length}</b><small>${overallMetric.repeatedIncorrect.length} repeated</small></div><div><span>Bookmarked</span><b>${overallMetric.bookmarked.length}</b><small>saved to revisit</small></div><div><span>Average time</span><b>${overallMetric.averageTime == null ? '—' : `${overallMetric.averageTime}s`}</b><small>50s training target</small></div>${overallMetric.recallDue.length ? `<div><span>Recall due</span><b>${overallMetric.recallDue.length}</b><small>existing recall state</small></div>` : ''}</div></section>
  <section class="card analytics-attention"><div class="section-heading"><div><span class="eyebrow">NEEDS ATTENTION</span><h2>Highest-value areas to revise next</h2><p class="subtle">PYQ mistakes receive extra study priority; raw accuracy is never changed.</p></div></div>${attention.length ? `<div class="attention-list">${attention.map((row) => `<article><div><b>${e(row.name)}</b><span class="priority-label">${e(row.priority.label)}</span><small>${row.metric.attempted.length}/${row.metric.ids.length} attempted · ${row.metric.latestAccuracy} latest accuracy · ${row.pyqMetric.incorrect.length} PYQs wrong · ${row.metric.repeatedIncorrect.length} repeated</small></div>${analyticsActionButton({ title: `${row.name} priority review`, questionIds: row.metric.incorrect.length ? row.metric.incorrect : row.metric.ids, filters: allAnalyticsFilters, label: row.metric.incorrect.length ? 'Review mistakes' : 'Practice', secondary: true, open: row.metric.incorrect.length > 0 })}</article>`).join('')}</div>` : '<div class="empty">Not enough data yet. Attempt at least 5 questions in an area to assess accuracy-based weakness.</div>'}<details class="analytics-more-details"><summary>How priority works</summary><p class="analytics-rule">Deterministic score: current wrong +4, repeated wrong +10, slow-and-wrong +2, bookmark +1, mark +2, low accuracy after 5 attempts up to +14, low coverage +2. A PYQ weakness adds +15, plus +4 per current PYQ mistake and +6 per repeated PYQ mistake.</p></details></section>
  <section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">ANALYZE A SUBSET</span><h2>Choose an exact question population</h2><p class="subtle">Within a filter: union. Across filters: intersection. Invalid descendants are removed.</p></div></div><form id="analytics-filter-form" class="stack"><div class="filters analytics-query-filters">${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics)}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics)}${analyticsStatusPicker()}${analyticsMetadataFields(capabilities)}</div><div class="builder-footer"><div><b>${metric.ids.length.toLocaleString()} questions selected</b><div class="subtle">No fallback questions are substituted when a combination has zero matches.</div></div><div class="row"><button class="button">Apply filters</button><button type="button" class="button ghost" data-action="clear-analytics-filters">Clear</button></div></div></form><div class="selected-analysis"><div class="section-heading"><div><span class="eyebrow">SELECTED ANALYSIS</span><h2>${e(analyticsSelectionLabel(normalizedFilters))}</h2></div>${analyticsPopulationControls(combined)}</div><div class="compact-stats"><span>Available <b>${metric.ids.length}</b></span><span>Attempted <b>${metric.attempted.length}</b></span><span>Coverage <b>${metric.coverage}</b></span><span>Latest correct <b>${metric.correct.length}</b></span><span>Latest incorrect <b>${metric.incorrect.length}</b></span><span>Latest accuracy <b>${metric.latestAccuracy}</b></span><span>Repeatedly incorrect <b>${metric.repeatedIncorrect.length}</b></span><span>Bookmarked <b>${metric.bookmarked.length}</b></span><span>Average time <b>${metric.averageTime == null ? '—' : `${metric.averageTime}s`}</b></span></div></div><div class="detailed-analytics"><div class="section-heading"><div><span class="eyebrow">BREAK DOWN BY</span><h2>One detail view at a time</h2></div></div>${breakdowns.length ? `<div class="field breakdown-selector"><label for="analytics-breakdown-select">Break down by</label><select id="analytics-breakdown-select"><option value="">Choose a breakdown</option>${breakdowns.map(([level, label]) => `<option value="${e(level)}" ${state.analyticsBreakdown === level ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></div><div id="analytics-breakdown-selected" class="analytics-breakdown-content">${state.analyticsBreakdown ? '' : '<div class="empty">Choose one useful breakdown. No rows are rendered by default.</div>'}</div>` : '<div id="analytics-breakdown-selected" class="empty">This selection has no useful multi-group breakdown.</div>'}</div></section>
  <section class="card analytics-mistakes"><div class="section-heading"><div><span class="eyebrow">MISTAKES / MASTERY</span><h2>What is changing in your knowledge</h2></div></div><div class="analytics-primary-metrics"><div><span>Currently incorrect</span><b>${overallMetric.incorrect.length}</b><small>newest answer wrong</small></div><div><span>Wrong ≥2 times</span><b>${overallMetric.repeatedIncorrect.length}</b><small>repeated mistakes</small></div><div><span>Wrong ≥3 times</span><b>${overallMetric.wrongThree.length}</b><small>highest remediation need</small></div><div><span>Recovered mistakes</span><b>${overallMetric.recovered.length}</b><small>previously wrong → now correct</small></div></div><div class="compact-stats"><span>PYQ currently incorrect <b>${pyqMetric.incorrect.length}</b></span><span>PYQ repeatedly incorrect <b>${pyqMetric.repeatedIncorrect.length}</b></span><span>Fast + wrong <b>${overallMetric.fastWrong.length}</b></span><span>Slow + wrong <b>${overallMetric.slowWrong.length}</b></span><span>Very slow &gt;100s <b>${overallMetric.verySlow.length}</b></span><span>Marked for review <b>${overallMetric.marked.length}</b></span></div><div class="analytics-command-actions">${analyticsActionButton({ title: 'Repeated mistakes', questionIds: repeatedMistakes, filters: allAnalyticsFilters, label: 'Review Repeated Mistakes', secondary: true, open: true })}${analyticsActionButton({ title: 'Wrong PYQs', questionIds: pyqWrong, filters: pyqFilters, label: 'Review Wrong PYQs', open: true })}</div></section>
  <section class="card analytics-trend"><div class="section-heading"><div><span class="eyebrow">RECENT TREND</span><h2>Latest-answer accuracy by recent week</h2><p class="subtle">Newest answer per question within each week.</p></div></div>${trend.length ? `<div class="trend-bars">${trend.map((row) => `<div><span>${e(date(`${row.week}T00:00:00Z`))}</span><div><i style="width:${row.accuracy}%"></i></div><b>${row.accuracy}%</b><small>${row.attempted} questions</small></div>`).join('')}</div>` : '<div class="empty">No attempts yet. Your recent trend will appear after you answer questions.</div>'}</section>`);
  const form = document.querySelector('#analytics-filter-form');
  if (state.meta.sourceTests.length) form.querySelector('.analytics-query-filters')?.insertAdjacentHTML('beforeend', multiPicker('source_tests', 'Source Tests', state.meta.sourceTests));
  form.querySelectorAll('input[name="statuses"]').forEach((input) => { input.checked = false; });
  for (const level of ['platforms', 'subjects', 'systems', 'topics', 'subtopics', 'source_tests', 'statuses', 'exams', 'years', 'sessions']) (normalizedFilters[level] || []).forEach((id) => { const input = form.querySelector(`input[name="${level}"][value="${CSS.escape(String(id))}"]`); if (input) input.checked = true; });
  form.elements.pyq.value = normalizedFilters.pyq || '';
  setupDependentFilters(form);
  form.onsubmit = (event) => { event.preventDefault(); state.analyticsFilters = readFilters(form); analytics(); };
  document.querySelector('#analytics-breakdown-select')?.addEventListener('change', (event) => { state.analyticsBreakdown = event.target.value || null; if (state.analyticsBreakdown) renderAnalyticsBreakdown(state.analyticsBreakdown, 1); else document.querySelector('#analytics-breakdown-selected').innerHTML = '<div class="empty">Choose one useful breakdown. No rows are rendered by default.</div>'; });
  if (state.analyticsBreakdown) renderAnalyticsBreakdown(state.analyticsBreakdown, 1);
}

function analyticsTabs() {
  const sections = [['overview', 'Overview'], ['pyq', 'PYQ Analytics'], ['subjects', 'Subject-wise'], ['explore', 'Explore']];
  return `<nav class="analytics-tabs" aria-label="Analytics sections">${sections.map(([id, label]) => `<button class="${state.analyticsSection === id ? 'active' : ''}" data-action="analytics-section" data-section="${id}">${e(label)}</button>`).join('')}</nav>`;
}

function metricStrip(items) {
  return `<div class="metric-strip">${items.map(([label, value, detail = '']) => `<div><span>${e(label)}</span><b>${e(value)}</b>${detail ? `<small>${e(detail)}</small>` : ''}</div>`).join('')}</div>`;
}

function analyticsSubjectGroups(questionIds, model) {
  return analyticsGroups('subject');
}

function analyticsMomentum(model) {
  const now = Date.now(); const windows = [new Map(), new Map()];
  model.attempts.forEach((row) => {
    const age = now - new Date(row.answered_at || 0).getTime(); const window = age >= 0 && age < 7 * 86400000 ? 0 : age >= 7 * 86400000 && age < 14 * 86400000 ? 1 : -1;
    if (window < 0) return; const id = String(row.question_id); const current = windows[window].get(id);
    if (!current || new Date(row.answered_at) > new Date(current.answered_at)) windows[window].set(id, row);
  });
  const summarize = (rows) => { const values = [...rows.values()]; const correct = values.filter((row) => row.is_correct === true).length; const timed = values.filter((row) => row.time_spent_seconds != null); return { questions: values.length, accuracy: values.length ? Math.round(correct / values.length * 100) : null, averageTime: timed.length ? Math.round(timed.reduce((sum, row) => sum + Number(row.time_spent_seconds || 0), 0) / timed.length) : null }; };
  const current = summarize(windows[0]); const previous = summarize(windows[1]);
  return { current, previous, delta: current.accuracy != null && previous.accuracy != null ? current.accuracy - previous.accuracy : null };
}

function overviewAttention(subjectGroups, pyqSet, overallMetric) {
  const rows = [];
  subjectGroups.forEach((group) => {
    const pyqMetric = analyticsMetric(group.questionIds.filter((id) => pyqSet.has(id)), state.analyticsView.model);
    if (pyqMetric.incorrect.length) {
      const priority = analyticsStudyPriority({ isPyq: true, currentIncorrect: pyqMetric.incorrect.length, repeatedIncorrect: pyqMetric.repeatedIncorrect.length, attempted: pyqMetric.attempted.length, available: pyqMetric.ids.length, latestAccuracy: pyqMetric.latestAccuracyValue });
      rows.push({ label: `${group.name} PYQs`, detail: `${pyqMetric.latestAccuracy} latest accuracy · ${pyqMetric.incorrect.length} wrong`, ids: pyqMetric.incorrect, filters: { pyq: 'yes' }, priority: priority.score });
    }
    if (group.metric.attempted.length >= 5 && group.metric.latestAccuracyValue < .6) rows.push({ label: group.name, detail: `${group.metric.latestAccuracy} latest accuracy · ${group.metric.coverage} coverage`, ids: group.metric.incorrect, filters: {}, priority: 12 + group.metric.incorrect.length });
  });
  if (overallMetric.repeatedIncorrect.length) rows.push({ label: 'Repeated mistakes', detail: `${overallMetric.repeatedIncorrect.length} questions wrong at least twice`, ids: overallMetric.repeatedIncorrect, filters: {}, priority: 18 });
  if (overallMetric.slowWrong.length) rows.push({ label: 'Slow + wrong questions', detail: `${overallMetric.slowWrong.length} questions took over 75 seconds`, ids: overallMetric.slowWrong, filters: {}, priority: 9 });
  return rows.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

function revisionQuestionIds(overallMetric, pyqMetric, subjectGroups, pyqSet) {
  const weakSubjectIds = new Set(subjectGroups.filter((group) => group.metric.attempted.length >= 5 && group.metric.latestAccuracyValue < .6).flatMap((group) => group.questionIds));
  const repeatedPyq = pyqMetric.repeatedIncorrect; const repeatedNonPyq = overallMetric.repeatedIncorrect.filter((id) => !pyqSet.has(id));
  const weakWrong = overallMetric.incorrect.filter((id) => weakSubjectIds.has(id));
  const bookmarkedWrong = overallMetric.incorrect.filter((id) => overallMetric.bookmarked.includes(id));
  const unattemptedWeakPyq = pyqMetric.unattempted.filter((id) => weakSubjectIds.has(id)).sort().slice(0, 20);
  return [...new Set([...pyqMetric.incorrect, ...repeatedPyq, ...repeatedNonPyq, ...weakWrong, ...bookmarkedWrong, ...overallMetric.slowWrong, ...overallMetric.fastWrong, ...unattemptedWeakPyq, ...overallMetric.recallDue])].slice(0, 60);
}

function renderAnalyticsOverview({ overallMetric, pyqMetric, subjectGroups, pyqSet, model }) {
  const attention = overviewAttention(subjectGroups, pyqSet, overallMetric); const revisionIds = revisionQuestionIds(overallMetric, pyqMetric, subjectGroups, pyqSet); const momentum = analyticsMomentum(model);
  const allFilters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '' };
  const revise = analyticsActionButton({ title: 'Priority revision', questionIds: revisionIds, filters: allFilters, label: 'Start Revision' });
  const mistakeActions = [
    ['Currently incorrect', overallMetric.incorrect, `${overallMetric.incorrect.length}`], ['Wrong ≥2 times', overallMetric.repeatedIncorrect, `${overallMetric.repeatedIncorrect.length}`], ['Wrong ≥3 times', overallMetric.wrongThree, `${overallMetric.wrongThree.length}`], ['Recovered mistakes', overallMetric.recovered, `${overallMetric.recovered.length}`], ['Fast + wrong', overallMetric.fastWrong, `${overallMetric.fastWrong.length}`], ['Slow + wrong', overallMetric.slowWrong, `${overallMetric.slowWrong.length}`],
  ];
  return `<section class="overview-revision"><div><span class="eyebrow">WHAT TO REVISE NOW</span><h2>${revisionIds.length} priority questions</h2><div class="revision-counts"><span>${pyqMetric.incorrect.length} Wrong PYQs</span><span>${overallMetric.repeatedIncorrect.length} Repeated mistakes</span><span>${overallMetric.incorrect.filter((id) => overallMetric.bookmarked.includes(id)).length} Bookmarked + wrong</span><span>${overallMetric.recallDue.length} Recall due</span></div></div>${revise || '<span class="subtle">No revision items yet.</span>'}</section>
  <section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">QBANK SNAPSHOT</span><h2>Coverage and current performance</h2></div></div>${metricStrip([['Coverage', `${overallMetric.attempted.length}/${overallMetric.ids.length}`, overallMetric.coverage], ['Latest accuracy', overallMetric.latestAccuracy, 'newest answer'], ['Wrong', overallMetric.incorrect.length], ['Repeated', overallMetric.repeatedIncorrect.length], ['Bookmarked', overallMetric.bookmarked.length], ['Avg time', overallMetric.averageTime == null ? '—' : `${overallMetric.averageTime}s`, `${overallMetric.attemptAccuracy} attempt accuracy`]])}</section>
  <section class="analytics-compact pyq-snapshot"><div><span class="eyebrow">PYQ SNAPSHOT</span><h2>PYQs</h2><p>${pyqMetric.ids.length} total · ${pyqMetric.attempted.length} attempted · ${pyqMetric.latestAccuracy} accuracy · ${pyqMetric.incorrect.length} wrong</p></div><button class="button compact" data-action="analytics-section" data-section="pyq">Open PYQ Analytics</button></section>
  <section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">NEEDS ATTENTION</span><h2>Highest-value study priorities</h2></div></div>${attention.length ? `<ol class="overview-attention">${attention.map((row) => `<li><div><b>${e(row.label)}</b><small>${e(row.detail)}</small></div>${analyticsActionButton({ title: row.label, questionIds: row.ids, filters: { ...allFilters, ...row.filters }, label: 'Review', secondary: true, open: true })}</li>`).join('')}</ol>` : '<div class="empty compact-empty">Not enough data yet. Attempt at least 5 questions to assess area-level weakness.</div>'}</section>
  <section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">MISTAKE PATTERNS</span><h2>Spot avoidable errors</h2></div><small class="subtle">Fast &lt;30s · Slow &gt;75s · target ~50s</small></div><div class="pattern-grid">${mistakeActions.map(([label, ids, value]) => `<button data-action="analytics-open-ids" data-label="${e(label)}" data-ids="${e(ids.join(','))}" ${ids.length ? '' : 'disabled'}><span>${e(label)}</span><b>${e(value)}</b></button>`).join('')}</div></section>
  <section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">RECENT MOMENTUM</span><h2>Last 7 days</h2></div></div>${metricStrip([['Questions', momentum.current.questions], ['Latest accuracy', momentum.current.accuracy == null ? '—' : `${momentum.current.accuracy}%`], ['vs previous 7d', momentum.delta == null ? '—' : `${momentum.delta >= 0 ? '+' : ''}${momentum.delta}%`], ['Avg time', momentum.current.averageTime == null ? '—' : `${momentum.current.averageTime}s`]])}</section>`;
}

function renderPyqAnalytics({ pyqMetric, pyqIds, subjectGroups, model }) {
  const pyqSubjects = subjectGroups.map((group) => ({ ...group, questionIds: group.questionIds.filter((id) => pyqIds.includes(id)) })).filter((group) => group.questionIds.length).map((group) => ({ ...group, metric: analyticsMetric(group.questionIds, model) }));
  pyqSubjects.forEach((group) => { group.priority = analyticsStudyPriority({ isPyq: true, currentIncorrect: group.metric.incorrect.length, repeatedIncorrect: group.metric.repeatedIncorrect.length, attempted: group.metric.attempted.length, available: group.metric.ids.length, latestAccuracy: group.metric.latestAccuracyValue }); });
  pyqSubjects.sort((a, b) => b.priority.score - a.priority.score || a.name.localeCompare(b.name));
  const selected = pyqSubjects.find((group) => group.id === state.analyticsSubjectId);
  if (!selected) {
    return `<section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">PYQ OVERALL</span><h2>Previous-year question performance</h2></div></div>${metricStrip([['Available', pyqMetric.ids.length], ['Attempted', pyqMetric.attempted.length, pyqMetric.coverage], ['Latest accuracy', pyqMetric.latestAccuracy], ['Currently wrong', pyqMetric.incorrect.length], ['Repeated', pyqMetric.repeatedIncorrect.length], ['Recovered', pyqMetric.recovered.length]])}</section><section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">BY SUBJECT</span><h2>PYQ revision priorities</h2></div></div><div class="subject-list">${pyqSubjects.slice(0, 5).map((group) => `<article><div><b>${e(group.name)}</b><small>${group.metric.ids.length} PYQs · ${group.metric.attempted.length} attempted · ${group.metric.latestAccuracy} accuracy · ${group.metric.incorrect.length} wrong · ${group.metric.repeatedIncorrect.length} repeated</small></div><button class="button secondary compact" data-action="analytics-pyq-subject" data-subject="${e(group.id)}">Open</button></article>`).join('')}</div>${pyqSubjects.length > 5 ? '<button class="button ghost compact" data-action="analytics-view-all-pyq-subjects">View all subjects</button>' : ''}</section>`;
  }
  const allowedBreakdowns = [['topic', 'By Topic'], ['exam', 'By Exam'], ['year_session', 'By Year / session'], ['source_test', 'Source Tests']].filter(([level]) => analyticsGroups(level).length);
  const breakdownRows = state.analyticsPyqBreakdown ? analyticsGroups(state.analyticsPyqBreakdown).slice(0, 50) : [];
  const filters = { platforms: [], subjects: [selected.id], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: 'yes' };
  return `<button class="text-button" data-action="analytics-pyq-back">← All PYQ subjects</button><section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">PYQ · ${e(selected.name)}</span><h2>${e(selected.name)} PYQs</h2></div></div>${metricStrip([['Available', selected.metric.ids.length], ['Attempted', selected.metric.attempted.length, selected.metric.coverage], ['Latest accuracy', selected.metric.latestAccuracy], ['Currently wrong', selected.metric.incorrect.length], ['Repeated', selected.metric.repeatedIncorrect.length], ['Recovered', selected.metric.recovered.length], ['Bookmarked', selected.metric.bookmarked.length], ['Avg time', selected.metric.averageTime == null ? '—' : `${selected.metric.averageTime}s`]])}<div class="analytics-command-actions">${analyticsActionButton({ title: `${selected.name} wrong PYQs`, questionIds: selected.metric.incorrect, filters, label: 'Wrong PYQs', open: true })}${analyticsActionButton({ title: `${selected.name} repeated PYQs`, questionIds: selected.metric.repeatedIncorrect, filters, label: 'Repeated PYQs', secondary: true, open: true })}${analyticsActionButton({ title: `${selected.name} unattempted PYQs`, questionIds: selected.metric.unattempted, filters, label: 'Unattempted PYQs', secondary: true })}</div></section><section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">DRILL DOWN</span><h2>Choose one real metadata view</h2></div></div><div class="breakdown-buttons">${allowedBreakdowns.map(([level, label]) => `<button class="button ${state.analyticsPyqBreakdown === level ? '' : 'secondary'} compact" data-action="analytics-pyq-breakdown" data-level="${e(level)}">${e(label)}</button>`).join('')}</div>${state.analyticsPyqBreakdown ? `<div class="compact-breakdown">${breakdownRows.map((row) => `<article><b>${e(row.name)}</b><span>${row.metric.attempted.length}/${row.metric.ids.length} attempted · ${row.metric.latestAccuracy} accuracy · ${row.metric.incorrect.length} wrong</span></article>`).join('') || '<div class="empty">No mapped data.</div>'}</div>` : '<div class="empty compact-empty">Choose a breakdown. Source Test names appear only here.</div>'}</section>`;
}

function renderSubjectAnalytics({ overallIds, subjectGroups, pyqSet, model }) {
  const selected = subjectGroups.find((group) => group.id === state.analyticsSubjectId);
  if (!selected) return `<section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">SUBJECT-WISE ANALYTICS</span><h2>Compare real imported subject performance</h2><p class="subtle">Coverage and current accuracy are shown separately.</p></div></div><div class="subject-list">${subjectGroups.sort((a, b) => a.name.localeCompare(b.name)).map((group) => { const pyq = analyticsMetric(group.questionIds.filter((id) => pyqSet.has(id)), model); return `<article><div><b>${e(group.name)}</b><small>${group.metric.coverage} coverage · ${group.metric.latestAccuracy} latest accuracy · ${pyq.latestAccuracy} PYQ accuracy · ${group.metric.incorrect.length} wrong · ${group.metric.repeatedIncorrect.length} repeated</small></div><button class="button secondary compact" data-action="analytics-subject" data-subject="${e(group.id)}">Open</button></article>`; }).join('')}</div></section>`;
  const platforms = analyticsGroups('platform').map((group) => ({ ...group, ids: group.questionIds }));
  const disagreement = analyticsPlatformDisagreement(platforms.map((row) => ({ attempted: row.metric.attempted.length, latestAccuracy: row.metric.latestAccuracyValue })));
  const pyqMetric = analyticsMetric(selected.questionIds.filter((id) => pyqSet.has(id)), model); const allFilters = { platforms: [], subjects: [selected.id], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '' };
  const canonical = [['system', 'By System'], ['topic', 'By Topic'], ['subtopic', 'By Subtopic']].filter(([level]) => analyticsGroups(level).length > 1);
  return `<button class="text-button" data-action="analytics-subject-back">← All subjects</button><section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">${e(selected.name.toUpperCase())} ANALYTICS</span><h2>All platforms</h2></div>${analyticsActionButton({ title: `${selected.name} mistakes`, questionIds: selected.metric.incorrect, filters: allFilters, label: 'Review Subject Mistakes', open: true })}</div>${metricStrip([['Coverage', selected.metric.coverage], ['Accuracy', selected.metric.latestAccuracy], ['Wrong', selected.metric.incorrect.length], ['Repeated', selected.metric.repeatedIncorrect.length], ['Recovered', selected.metric.recovered.length], ['PYQ accuracy', pyqMetric.latestAccuracy], ['Avg time', selected.metric.averageTime == null ? '—' : `${selected.metric.averageTime}s`]])}</section><section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">PLATFORM COMPARISON</span><h2>Is the weakness platform-dependent?</h2></div></div><div class="platform-list">${platforms.map((row) => `<article><div><b>${e(row.name)}</b><small>${row.metric.coverage} coverage · ${row.metric.latestAccuracy} accuracy · ${row.metric.incorrect.length} wrong · ${row.metric.attempted.length} attempted</small></div>${analyticsActionButton({ title: `${selected.name} · ${row.name} mistakes`, questionIds: row.metric.incorrect, filters: { ...allFilters, platforms: [row.id] }, label: 'Review mistakes', secondary: true, open: true })}</article>`).join('')}</div>${disagreement ? `<div class="study-signal"><b>Performance varies markedly across platforms</b><span>At least 5 questions were attempted on each compared platform and latest accuracy differs by 20+ percentage points.</span></div>` : '<p class="subtle">Platform disagreement requires at least 5 attempted questions on two platforms and a 20+ point accuracy gap.</p>'}</section>${canonical.length ? `<section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">CANONICAL TAXONOMY</span><h2>Mapped subject detail</h2></div></div>${canonical.map(([level, label]) => `<details><summary>${e(label)}</summary><div class="compact-breakdown">${analyticsGroups(level).slice(0, 20).map((row) => `<article><b>${e(row.name)}</b><span>${row.metric.coverage} coverage · ${row.metric.latestAccuracy} accuracy · ${row.metric.incorrect.length} wrong</span></article>`).join('')}</div></details>`).join('')}</section>` : ''}`;
}

async function renderAnalyticsExplore(overallIds, model) {
  const filters = state.analyticsFilters || { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '', srm: '' };
  const initialFacets = await resolveFacets(filters);
  const valid = (level, values) => (values || []).map(String).filter((value) => initialFacets[level]?.has?.(value) ?? true);
  const capabilities = { exams: initialFacets.exams, years: initialFacets.years, sessions: initialFacets.sessions };
  const normalizedFilters = { ...filters, platforms: valid('platforms', filters.platforms), subjects: valid('subjects', filters.subjects), systems: valid('systems', filters.systems), topics: valid('topics', filters.topics), subtopics: valid('subtopics', filters.subtopics), source_tests: valid('source_tests', filters.source_tests), statuses: filters.statuses?.length ? filters.statuses : ['all'], exams: valid('exams', filters.exams), years: valid('years', filters.years), sessions: valid('sessions', filters.sessions), year: '', search: '', source: '' };
  const questionIds = await matchingQuestionIds(normalizedFilters); const metric = analyticsMetric(questionIds, model);
  state.analyticsView = { questionIds, model, filters: normalizedFilters, groups: new Map(), topicSubtopicRedundant: false, capabilities };
  const counts = { platform: initialFacets.platforms.size, subject: initialFacets.subjects.size, system: initialFacets.systems.size, topic: initialFacets.topics.size, subtopic: initialFacets.subtopics.size, source_test: initialFacets.source_tests.size, exam: capabilities.exams.length, year_session: Math.max(capabilities.years.length, capabilities.sessions.length), pyq: normalizedFilters.pyq ? 1 : 2 };
  const candidates = [['platform', 'Platform'], ['subject', 'Subject'], ['system', 'System'], ['topic', 'Topic'], ['subtopic', 'Subtopic'], ['source_test', 'Source Test'], ['pyq', 'PYQ'], ['exam', 'Exam'], ['year_session', 'Year / session']]; const breakdowns = candidates.filter(([level]) => counts[level] > 1);
  if (!breakdowns.some(([level]) => level === state.analyticsBreakdown)) state.analyticsBreakdown = null;
  if (state.analyticsBreakdown) await loadAnalyticsGroups([state.analyticsBreakdown], normalizedFilters, model);
  return { html: `<section class="analytics-compact"><div class="section-heading"><div><span class="eyebrow">ANALYZE</span><h2>Choose what you want to analyze</h2></div></div><form id="analytics-filter-form" class="stack"><div class="filters analytics-query-filters">${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics)}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics)}${analyticsStatusPicker()}${analyticsMetadataFields(capabilities)}${state.meta.sourceTests.length ? multiPicker('source_tests', 'Source Tests', state.meta.sourceTests) : ''}</div><div class="builder-footer"><div><b>${metric.ids.length.toLocaleString()} questions selected</b><div class="subtle">No fallback questions are substituted.</div></div><div class="row"><button class="button">Apply filters</button><button type="button" class="button ghost" data-action="clear-analytics-filters">Clear</button></div></div></form><div class="selected-analysis"><div class="section-heading"><div><span class="eyebrow">SELECTED ANALYSIS</span><h2>${e(analyticsSelectionLabel(normalizedFilters))}</h2></div>${analyticsPopulationControls({ title: 'Selected analytics population', questionIds, filters: normalizedFilters })}</div>${metricStrip([['Available', metric.ids.length], ['Attempted', metric.attempted.length, metric.coverage], ['Latest accuracy', metric.latestAccuracy], ['Currently wrong', metric.incorrect.length], ['Repeated', metric.repeatedIncorrect.length], ['Recovered', metric.recovered.length], ['Bookmarked', metric.bookmarked.length], ['Avg time', metric.averageTime == null ? '—' : `${metric.averageTime}s`]])}</div><div class="detailed-analytics">${breakdowns.length ? `<div class="field breakdown-selector"><label for="analytics-breakdown-select">Break down by</label><select id="analytics-breakdown-select"><option value="">Choose a breakdown</option>${breakdowns.map(([level, label]) => `<option value="${e(level)}" ${state.analyticsBreakdown === level ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></div><div id="analytics-breakdown-selected">${state.analyticsBreakdown ? '' : '<div class="empty compact-empty">Choose one useful breakdown.</div>'}</div>` : '<div id="analytics-breakdown-selected" class="empty compact-empty">This selection has no useful multi-group breakdown.</div>'}</div></section>`, normalizedFilters };
}

async function advancedAnalytics() {
  loading('Calculating analytics…');
  if (state.analyticsSection === 'overview') {
    const snapshot = await analyticsSnapshot();
    layout(`<div class="page-heading analytics-heading"><span class="eyebrow">ANALYTICS</span><h1>Turn performance into a study plan</h1></div>${analyticsTabs()}<div class="analytics-view">${renderAnalyticsSnapshot(snapshot)}</div>`);
    return;
  }
  const allFilters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '', year: '', search: '', source: '' };
  const [overallPopulation, pyqPopulation, allFacets] = await Promise.all([
    resolvePopulation(allFilters, { includeIds: true, limit: null }),
    resolvePopulation({ ...allFilters, pyq: 'yes' }, { includeIds: true, limit: null }),
    resolveFacets(allFilters),
  ]);
  const overallIds = overallPopulation.questionIds; const pyqIds = pyqPopulation.questionIds;
  state.analyticsPyqSet = new Set(pyqIds);
  const model = await fetchAnalyticsModel(overallIds); const overallMetric = analyticsMetric(overallIds, model); const pyqMetric = analyticsMetric(pyqIds, model); const pyqSet = state.analyticsPyqSet;
  state.analyticsView = { questionIds: overallIds, model, filters: allFilters, groups: new Map(), topicSubtopicRedundant: false, capabilities: allFacets };
  await loadAnalyticsGroups(['subject'], allFilters, model);
  const subjectGroups = analyticsSubjectGroups(overallIds, model);
  let content; let explore = null;
  if (state.analyticsSection === 'pyq') {
    if (state.analyticsSubjectId) {
      const selected = subjectGroups.find((group) => group.id === state.analyticsSubjectId);
      const selectedIds = (selected?.questionIds || []).filter((id) => pyqSet.has(id));
      const filters = { ...allFilters, subjects: selected ? [selected.id] : [], pyq: 'yes' };
      state.analyticsView = { questionIds: selectedIds, model, filters, groups: new Map(), topicSubtopicRedundant: false, capabilities: await resolveFacets(filters) };
      await loadAnalyticsGroups(['topic', 'exam', 'year_session', 'source_test'], filters, model);
    }
    content = renderPyqAnalytics({ pyqMetric, pyqIds, subjectGroups, model });
  } else if (state.analyticsSection === 'subjects') {
    if (state.analyticsSubjectId) {
      const selected = subjectGroups.find((group) => group.id === state.analyticsSubjectId);
      const filters = { ...allFilters, subjects: selected ? [selected.id] : [] };
      state.analyticsView = { questionIds: selected?.questionIds || [], model, filters, groups: new Map(), topicSubtopicRedundant: false, capabilities: await resolveFacets(filters) };
      await loadAnalyticsGroups(['platform', 'system', 'topic', 'subtopic'], filters, model);
    }
    content = renderSubjectAnalytics({ overallIds, subjectGroups, pyqSet, model });
  }
  else if (state.analyticsSection === 'explore') { explore = await renderAnalyticsExplore(overallIds, model); content = explore.html; }
  else content = renderAnalyticsOverview({ overallMetric, pyqMetric, subjectGroups, pyqSet, model });
  layout(`<div class="page-heading analytics-heading"><span class="eyebrow">ANALYTICS</span><h1>Turn performance into a study plan</h1></div>${analyticsTabs()}<div class="analytics-view">${content}</div>`);
  if (state.analyticsSection === 'explore') {
    const form = document.querySelector('#analytics-filter-form');
    for (const level of ['platforms', 'subjects', 'systems', 'topics', 'subtopics', 'source_tests', 'statuses', 'exams', 'years', 'sessions']) (explore.normalizedFilters[level] || []).forEach((id) => { const input = form.querySelector(`input[name="${level}"][value="${CSS.escape(String(id))}"]`); if (input) input.checked = true; });
    form.querySelectorAll('input[name="statuses"]').forEach((input) => { input.checked = (explore.normalizedFilters.statuses || []).includes(input.value); });
    form.elements.pyq.value = explore.normalizedFilters.pyq || ''; setupDependentFilters(form); form.onsubmit = (event) => { event.preventDefault(); state.analyticsFilters = readFilters(form); analytics(); };
    document.querySelector('#analytics-breakdown-select')?.addEventListener('change', (event) => { state.analyticsBreakdown = event.target.value || null; if (state.analyticsBreakdown) renderAnalyticsBreakdown(state.analyticsBreakdown, 1); else document.querySelector('#analytics-breakdown-selected').innerHTML = '<div class="empty compact-empty">Choose one useful breakdown.</div>'; });
    if (state.analyticsBreakdown) renderAnalyticsBreakdown(state.analyticsBreakdown, 1);
  }
}

function taxonomyOptions(items, first) { return `<option value="">${e(first)}</option>${items.map((item) => `<option value="${e(item.id)}">${e(item.name)}</option>`).join('')}`; }
function taxonomyFields() { return `<div class="filters"><div class="field"><label>Platform (optional)</label><select name="platform_id">${taxonomyOptions(state.meta.platforms, 'My Content / no platform')}</select></div><div class="field"><label>Subject</label><select name="subject_id">${taxonomyOptions(state.meta.subjects, 'Choose subject')}</select></div><div class="field"><label>System (optional)</label><select name="system_id">${taxonomyOptions(state.meta.systems, 'No system')}</select></div><div class="field"><label>Topic</label><select name="topic_id">${taxonomyOptions(state.meta.topics, 'Choose topic')}</select></div><div class="field"><label>Subtopic</label><select name="subtopic_id">${taxonomyOptions(state.meta.subtopics, 'Choose subtopic')}</select></div></div>`; }

async function myBank() {
  const [questions, cards, notes] = await Promise.all([optional(db.from('questions').select('*', { count: 'exact', head: true }).eq('created_by', state.user.id), 'personal'), optional(db.from('recall_cards').select('*', { count: 'exact', head: true }).eq('user_id', state.user.id), 'personal'), optional(db.from('personal_notes').select('*', { count: 'exact', head: true }).eq('user_id', state.user.id), 'personal')]);
  layout(`<div class="page-heading"><span class="eyebrow">MY BANK</span><h1>Your own learning material</h1><p>Personal MCQs enter the same QBank and test engine as imported questions.</p></div>${!state.features.personal ? featureNotice('Apply the learning-interface migration to add personal MCQs, recall cards and notes.') : ''}<section class="result-grid"><div class="card metric"><span>My MCQs</span><b>${questions.count || 0}</b></div><div class="card metric"><span>Recall cards</span><b>${cards.count || 0}</b></div><div class="card metric"><span>Notes</span><b>${notes.count || 0}</b></div><div class="card metric"><span>Imported pool</span><b>Protected</b><small>never reset or deleted</small></div></section><section class="tab-row"><button class="button" data-action="my-bank-tab" data-tab="mcq">Add MCQ</button><button class="button secondary" data-action="my-bank-tab" data-tab="card">Add Recall Card</button><button class="button secondary" data-action="my-bank-tab" data-tab="note">Add Note</button><button class="button secondary" data-action="my-bank-tab" data-tab="reset">Reset Learning State</button></section><section id="my-bank-editor" class="card section-card"></section>`);
  showMyBankTab('mcq');
}

function showMyBankTab(tab) {
  const holder = document.querySelector('#my-bank-editor'); if (!holder) return;
  if (tab === 'mcq') holder.innerHTML = `<h2>Add a personal MCQ</h2><form id="personal-mcq-form" class="stack"><div class="field"><label>Question</label><textarea name="question_text" required></textarea></div><div class="filters">${['A', 'B', 'C', 'D'].map((key) => `<div class="field"><label>Option ${key}</label><input name="option_${key}" required /></div>`).join('')}</div><div class="field"><label>Correct answer</label><select name="correct_answer"><option>A</option><option>B</option><option>C</option><option>D</option></select></div><div class="field"><label>Explanation</label><textarea name="explanation_html"></textarea></div>${taxonomyFields()}<div class="filters"><div class="field"><label>Source (optional)</label><input name="source_reference" /></div><div class="field"><label>Personal tags</label><input name="tags" placeholder="comma separated" /></div></div><button class="button">Save MCQ</button></form>`;
  if (tab === 'card') holder.innerHTML = `<h2>Add a recall card / fact</h2><form id="recall-card-form" class="stack"><div class="field"><label>Front / prompt</label><textarea name="front" required></textarea></div><div class="field"><label>Back / answer</label><textarea name="back_html" required></textarea></div>${taxonomyFields()}<button class="button">Save recall card</button></form>`;
  if (tab === 'note') holder.innerHTML = `<h2>Add a note</h2><form id="personal-note-form" class="stack"><div class="field"><label>Title</label><input name="title" required /></div><div class="field"><label>Note</label><textarea name="body_html" required></textarea></div>${taxonomyFields()}<button class="button">Save note</button></form>`;
  if (tab === 'reset') holder.innerHTML = `<h2>Reset learning state</h2><p class="notice">Imported questions are never deleted. Bookmarks and notes are preserved by default.</p><form id="reset-form" class="stack"><div class="filters"><div class="field"><label>Scope</label><select name="scope"><option value="all">All learning progress</option><option value="subject">Subject</option><option value="topic">Topic</option><option value="subtopic">Subtopic</option></select></div><div class="field"><label>Subject</label><select name="subject_id">${taxonomyOptions(state.meta.subjects, 'Choose subject')}</select></div><div class="field"><label>Topic</label><select name="topic_id">${taxonomyOptions(state.meta.topics, 'Choose topic')}</select></div><div class="field"><label>Subtopic</label><select name="subtopic_id">${taxonomyOptions(state.meta.subtopics, 'Choose subtopic')}</select></div></div><label class="check-row"><input type="checkbox" name="remove_bookmarks" /> Also remove bookmarks</label><label class="check-row"><input type="checkbox" name="remove_notes" /> Also remove private notes</label><button class="button danger">Reset selected learning data</button></form>`;
  const form = holder.querySelector('form'); if (!form) return;
  if (form.id === 'personal-mcq-form') form.onsubmit = savePersonalMcq;
  if (form.id === 'recall-card-form') form.onsubmit = saveRecallCard;
  if (form.id === 'personal-note-form') form.onsubmit = savePersonalNote;
  if (form.id === 'reset-form') form.onsubmit = resetLearning;
}

async function savePersonalMcq(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
  const created = await db.from('questions').insert({ question_text: value.question_text, correct_answer: value.correct_answer, explanation_html: value.explanation_html || null, subject_id: value.subject_id || null, platform_id: value.platform_id || null, system_id: value.system_id || null, source_reference: value.source_reference || null, source_collection: 'My Content', created_by: state.user.id, content_origin: 'user', status: 'draft', is_pyq: false }).select().single();
  if (created.error) return toast(created.error.message, 'error');
  const options = ['A', 'B', 'C', 'D'].map((key) => ({ question_id: created.data.id, option_key: key, option_text: value[`option_${key}`] })); const saved = await db.from('question_options').insert(options); if (saved.error) return toast(saved.error.message, 'error');
  if (value.topic_id) await optional(db.from('question_topics').insert({ question_id: created.data.id, topic_id: value.topic_id }));
  if (value.subtopic_id) await optional(db.from('question_subtopics').insert({ question_id: created.data.id, subtopic_id: value.subtopic_id }), 'subtopics');
  if (value.tags?.trim()) for (const name of [...new Set(value.tags.split(',').map((tag) => tag.trim()).filter(Boolean))]) { const tag = await db.from('personal_tags').upsert({ user_id: state.user.id, name }, { onConflict: 'user_id,name' }).select().single(); if (!tag.error) await db.from('question_personal_tags').upsert({ user_id: state.user.id, question_id: created.data.id, tag_id: tag.data.id }); }
  toast('Personal MCQ saved and available under My Content.'); myBank();
}

async function saveRecallCard(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
  const result = await db.from('recall_cards').insert({ user_id: state.user.id, front: value.front, back_html: value.back_html, subject_id: value.subject_id || null, system_id: value.system_id || null, topic_id: value.topic_id || null, subtopic_id: value.subtopic_id || null }).select().single();
  if (result.error) return toast(result.error.message, 'error'); await db.from('recall_card_progress').insert({ user_id: state.user.id, card_id: result.data.id, due_at: new Date().toISOString() }); toast('Recall card saved and due now.'); myBank();
}

async function savePersonalNote(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
  const result = await db.from('personal_notes').insert({ user_id: state.user.id, title: value.title, body_html: value.body_html, subject_id: value.subject_id || null, topic_id: value.topic_id || null, subtopic_id: value.subtopic_id || null }); if (result.error) return toast(result.error.message, 'error'); toast('Note saved.'); myBank();
}

async function resetLearning(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget)); const scope = value.scope; const entity = value[`${scope}_id`];
  if (scope !== 'all' && !entity) return toast(`Choose a ${scope}.`);
  if (scope === 'all') { if (prompt('Type RESET to remove all personal learning progress. Imported questions remain untouched.') !== 'RESET') return; }
  else if (!confirm(`Reset learning state for this ${scope}? Imported questions remain untouched.`)) return;
  let questionIds = null;
  if (scope === 'subject') questionIds = (await paged(() => db.from('questions').select('id').eq('subject_id', entity))).map((row) => row.id);
  if (scope === 'topic') questionIds = unique((await db.from('question_topics').select('question_id').eq('topic_id', entity)).data);
  if (scope === 'subtopic') questionIds = unique((await db.from('question_subtopics').select('question_id').eq('subtopic_id', entity)).data);
  for (const table of ['question_attempts', 'user_question_state', 'review_queue']) { let query = db.from(table).delete().eq('user_id', state.user.id); if (questionIds) query = query.in('question_id', questionIds); const result = await optional(query); if (result.error && !result.missing) return toast(result.error.message, 'error'); }
  if (scope === 'all') { await optional(db.from('test_sessions').delete().eq('user_id', state.user.id)); await optional(db.from('recall_card_progress').delete().eq('user_id', state.user.id)); }
  if (value.remove_bookmarks) { let query = db.from('bookmarks').delete().eq('user_id', state.user.id); if (questionIds) query = query.in('question_id', questionIds); await query; }
  if (value.remove_notes) { let query = db.from('question_notes').delete().eq('user_id', state.user.id); if (questionIds) query = query.in('question_id', questionIds); await query; }
  toast('Selected learning state reset. Imported questions were preserved.'); myBank();
}

async function recordRecallResponse(value) {
  const question = activeQuestion();
  const result = await db.rpc('qbank_review_question', { p_question_id: question.id, p_response: value });
  if (result.error) return toast(result.error.message, 'error');
  toast(`Recall scheduled: ${value}.`);
}

const smartRecall=createSmartRecall({db,state,e,toast,prepareQuestionSet,readyScreen,returnHome:()=>home()});
const analyticsTabCache = new Map();
let analyticsTabGeneration = 0;
function activeRecallUnit() {return state.active?.filters?.active_recall_units?.find(u=>u.question_id===activeQuestion()?.id);}
function activeRecallFeedback(answer,wrong) {
 const unit=activeRecallUnit();
 const choices=wrong?[['failed',"DIDN’T KNOW"],['partial','PARTIAL'],['strong','KNEW IT']]:[['partial','UNSURE / GUESSED'],['strong','KNEW IT']];
 return `<div class="learning-feedback">${unit?.primary_concept?`<p><b>${e(unit.primary_concept)}</b></p>`:''}<span class="field-label">Retrieval strength</span><div class="segmented">${choices.map(([v,label])=>`<button data-action="ar-strength" data-value="${v}" ${answer.attemptRecorded?'disabled':''}>${label}</button>`).join('')}</div><small>${wrong?'A wrong answer remains a lapse, even if it feels familiar after reading the explanation.':'If skipped, the safe unsure schedule is used.'}</small>${wrong?`<details><summary>Classify mistake (optional)</summary><div class="reason-chips">${[['didnt_know',"Didn't know"],['forgot','Forgot'],['silly_mistake','Silly mistake'],['misread','Misread'],['confused_options','Confused options'],['overthought','Overthought'],['guess','Guess']].map(([v,label])=>`<button data-action="error-reason" data-value="${v}">${label}</button>`).join('')}</div></details>`:''}${answer.srmFeedback?`<p>Next retrieval: ${e(srmIntervalLabel(answer.srmFeedback.interval_minutes))} · ${e(answer.srmFeedback.state)}</p>`:''}${unit?'<button class="button ghost" data-action="ar-question-detail">Concept Details</button>':''}</div>`;
}
const activeRecall=createActiveRecall({db,state,e,layout,toast,legacy:()=>{window.history.replaceState({},'', '#/recall');state.route='recall';return legacyRecall();},
 startSession:async (rows,isCurrent)=>{
  const set=await prepareQuestionSet({mode:'recall',preset:'active-recall-v2',title:'Active Recall',filters:{platforms:[],subjects:[],systems:[],topics:[],subtopics:[],source_tests:[],statuses:['all'],active_recall_units:rows,active_recall_plan:rows.map((_,i)=>i),active_recall_cursor:0,active_recall_repeated:[]},questionIds:rows.map(u=>u.question_id),requested:'all',autoSubmit:false,origin:'#/home'});
  if(!isCurrent())return;state.pendingSet=set;await startPendingSession(isCurrent);
 },practice:async ids=>openQuestionSet({mode:'browse',preset:'active-recall-v2-history',title:'Previously encountered questions',filters:{},questionIds:ids,requested:'all',origin:'#/recall'})
});
async function recall(){return activeRecall.render();}
async function nextActiveRecall(){
 const active=state.active,q=activeQuestion(),answer=active.answers[q.id];
 if(!answer?.selected_option){toast('Answer this retrieval before continuing.');return;}
 await ensureAttemptRecorded(q,answer);if(!answer.attemptRecorded)return;
 const f=active.filters,plan=[...(f.active_recall_plan||active.questions.map((_,i)=>i))];let cursor=Number(f.active_recall_cursor||0);
 if(plan[cursor]!==active.index){const later=plan.findIndex((index,position)=>index===active.index&&position>=cursor);cursor=later>=0?later:plan.indexOf(active.index);}
 const repeated=[...(f.active_recall_repeated||[])];
 if(answer.srmFeedback?.relearn&&!repeated.includes(q.id)&&plan.length-cursor-1>=3){plan.splice(Math.min(cursor+4,plan.length),0,active.index);repeated.push(q.id);}
 if(cursor+1>=plan.length){await submitActive(false);return;}
 cursor++;const nextIndex=plan[cursor];
 await saveActiveAnswer(q.id);
 // The canonical attempt remains in question_attempts. Only the session's current answer is cleared for a fresh retrieval.
 if(plan.slice(0,cursor).includes(nextIndex)){delete active.answers[active.questions[nextIndex].id];await saveActiveAnswer(active.questions[nextIndex].id);}
 const updatedFilters={...f,active_recall_plan:plan,active_recall_cursor:cursor,active_recall_repeated:repeated};
 if(active.id){const saved=await db.from('test_sessions').update({filters:updatedFilters}).eq('id',active.id).eq('user_id',state.user.id);if(saved.error){toast(saved.error.message,'error');return;}}
 active.filters=updatedFilters;active.arOptionsFor=null;await navigateActive(nextIndex);
}
function sessionHistoryRows(rows){return `<ul class="history-list">${rows.map(s=>`<li><div><b>${e(s.subjects||'Subject unavailable')}</b><p>${e(s.platforms||'')} · ${e(s.modules||s.title||s.preset||'Session')}</p><small>${s.status==='in_progress'?`In progress · Question ${Number(s.current_position||0)+1}/${s.total_questions}`:`${s.total_correct||0}/${s.total_questions} · ${pct(s.total_correct||0,s.total_questions)}`} · ${date(s.completed_at||s.updated_at)}</small></div><button class="button secondary" data-action="resume" data-id="${e(s.id)}">${s.status==='in_progress'?'Resume':'Open result'}</button></li>`).join('')}</ul>`;}
async function history(page=0){
 const user=state.user?.id;layout('<div class="page-heading"><h1>Session history</h1></div><section class="card" id="history-page">Loading recent sessions…</section>');const host=document.querySelector('#history-page');
 const result=await db.rpc('qbank_session_history_light',{p_limit:20,p_offset:page*20,p_include_unfinished:true});if(!host.isConnected||state.user?.id!==user)return;
 host.innerHTML=result.error?e(result.error.message):`${sessionHistoryRows(result.data||[])}<div class="row">${page?`<button class="button secondary" data-action="history-page" data-page="${page-1}">Previous</button>`:''}${result.data?.length===20?`<button class="button secondary" data-action="history-page" data-page="${page+1}">Next</button>`:''}</div>`;
}
async function analytics(){
 const tab=state.analyticsSection||'overview';
 if((tab==='subjects'&&state.analyticsSubjectId)||!['overview','subjects','weaknesses','performance'].includes(tab)){await loadFullMeta();return advancedAnalytics();}
 const user=state.user?.id,g=++analyticsTabGeneration,key=`${user}:${tab}`;
 const tabs=[['overview','Overview'],['subjects','Subjects'],['weaknesses','Weaknesses'],['performance','Performance / History']];
 layout(`<div class="page-heading"><span class="eyebrow">ANALYTICS</span><h1>Your study progress</h1></div><nav class="analytics-tabs" aria-label="Analytics sections">${tabs.map(([id,label])=>`<button data-action="analytics-section" data-section="${id}" class="${tab===id?'active':''}">${label}</button>`).join('')}</nav><section class="card section-card" id="analytics-tab-content" role="status">Loading ${e(tab)}…</section><details class="card section-card"><summary>Advanced analysis and question filters</summary><button class="button secondary" data-action="analytics-section" data-section="pyq">PYQ analysis</button><button class="button secondary" data-action="analytics-section" data-section="explore">Explore filtered populations</button><a class="button ghost" href="#/review">Saved review lists</a></details>`);
 const host=document.querySelector('#analytics-tab-content'),started=performance.now();
 try{let value=analyticsTabCache.get(key);if(!value||Date.now()-value.at>60000){const r=await db.rpc('qbank_analytics_tab',{p_tab:tab,p_subject_id:null});if(r.error)throw r.error;value={data:r.data,at:Date.now()};if(state.user?.id===user)analyticsTabCache.set(key,value);}
 if(g!==analyticsTabGeneration||state.user?.id!==user||!host.isConnected)return;
 const d=value.data;
 if(tab==='overview')host.innerHTML=metricStrip([['Questions attempted',d.attempted],['Total attempts',d.attempts],['Attempt accuracy',pct(d.correct_attempts,d.attempts)],['Currently incorrect',d.currently_incorrect],['Bookmarked',d.bookmarked],['Marked for review',d.marked]])+'<p class="subtle">Your consolidated question history. Subject and weakness details load when opened.</p>';
 if(tab==='subjects')host.innerHTML=`<ul class="list">${d.map(r=>`<li><div><b>${e(r.subject)}</b><small>${r.attempted} questions · ${r.attempts} attempts · ${r.incorrect} currently incorrect</small></div><div><b>${pct(r.correct_attempts,r.attempts)}</b><button class="button secondary compact" data-action="analytics-subject" data-subject="${e(r.subject_id||'')}">Explore subject</button></div></li>`).join('')}</ul>`;
 if(tab==='weaknesses')host.innerHTML=`<p>Up to 30 encountered knowledge units, ordered by available importance and failures.</p><ul class="list">${d.map(u=>`<li><div><b>${e(u.primary_concept||'Question-level recall')}</b><small>${e(u.subject)} · ${u.incorrect} incorrect attempts${u.tier?` · ${e(u.tier)}`:''}</small></div><button class="button secondary" data-action="ar-details" data-id="${e(u.unit_key)}">Details</button></li>`).join('')}</ul>`;
 if(tab==='performance')host.innerHTML=sessionHistoryRows(d)+'<a class="button secondary" href="#/history">View full history</a>';
 host.dataset.loadMs=String(Math.round(performance.now()-started));
 }catch(err){if(g===analyticsTabGeneration&&host.isConnected)host.textContent=err.message;}
}

const globalImportance = createGlobalImportance({db,state,layout,e,toast,prepareQuestionSet,readyScreen});

async function render() {
  recallGeneration++;
  smartRecall.cancel();
  activeRecall.cancel();
  if (state.active) state.active.solvingVisible = false;
  if (state.active?.kind === 'recall') pauseTotalTimer(state.active);
  gtMode.cancel(); grandTests.cancel();
  persistTimer(state.active);
  stopActiveTimer(); state.route = route(); if (!state.user) return auth();
  try {
    if (state.route === 'analytics') return analytics();
    await loadMeta();
    if (['global-importance','importance-subject','importance-recall'].includes(state.route)) return globalImportance.render(); if (state.route === 'home') return home(); if (state.route === 'qbank') return qbank(); if (state.route === 'marrow-pyqs') return marrowPyqs(); if (state.route === 'tests') return tests(); if (state.route === 'recall') return recall(); if (state.route === 'review') return review(); if (state.route === 'analytics') return analytics(); if (state.route === 'grand-test-analytics') return grandTests.analytics(); if (state.route === 'grand-test-attempt') return gtMode.attempt(new URLSearchParams(location.hash.split('?')[1]).get('id')); if (state.route === 'my-bank' || state.route === 'manage') return myBank(); if (state.route === 'history') return history(); return home();
  } catch (error) { console.error(error); layout(`<div class="card notice"><b>Something went wrong.</b><p>${e(error.message || 'Please try again.')}</p><button class="button secondary" data-action="retry">Try again</button></div>`); }
}

function auth() {
  root.innerHTML = `<main class="shell auth"><section class="card"><span class="eyebrow">PRIVATE MEDICAL QBANK</span><h1>QBank Hub</h1><p class="subtle">Study, test, review and recall from one question pool.</p>${initError ? `<div class="notice">${e(initError)}</div>` : ''}<form id="auth-form" class="stack"><div class="field"><label for="auth-email">Email</label><input id="auth-email" required name="email" type="email" autocomplete="email" /></div><div class="field"><label for="auth-password">Password</label><input id="auth-password" required name="password" type="password" autocomplete="current-password" minlength="6" /></div><button class="button" ${db ? '' : 'disabled'}>Sign in</button><button class="button secondary" type="button" data-action="signup" ${db ? '' : 'disabled'}>Create account</button><button class="button ghost" type="button" data-action="reset-password" ${db ? '' : 'disabled'}>Reset password</button></form></section></main>`;
  document.querySelector('#auth-form').onsubmit = signIn;
}

async function signIn(event) {
  event.preventDefault();
  if (!db) return toast(initError, 'error');
  const value = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const { error } = await withAuthTimeout(db.auth.signInWithPassword(value));
    if (error) toast(error.message, 'error');
  } catch (error) {
    toast(error.message || 'Sign in did not complete. Please try again.', 'error');
  }
}
async function signUp() { const form = document.querySelector('#auth-form'); if (!form?.reportValidity()) return; const { data, error } = await db.auth.signUp(Object.fromEntries(new FormData(form))); if (error) return toast(error.message, 'error'); toast(data.session ? 'Account created.' : 'Account created. Check your email to confirm.'); }
async function resetPassword() { const email = document.querySelector('[name="email"]')?.value.trim(); if (!email) return toast('Enter your email first.'); const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin }); toast(error ? error.message : 'Password reset email sent.', error ? 'error' : ''); }

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]'); if (!target) return; const action = target.dataset.action;
  if (await activeRecall.handle(target)) return;
  const guarded = ['ar-strength', 'ar-options', 'answer', 'submit-multi-answer', 'previous', 'next', 'jump', 'bookmark', 'mark', 'confidence', 'error-reason', 'srm-add', 'srm-remove', 'srm-reset', 'start-recall', 'start-pending-test', 'resume', 'submit'].includes(action);
  if (guarded && state.actionBusy) return;
  if (guarded) state.actionBusy = true;
  try {
  if (action === 'exit-recall') { event.preventDefault(); await ensureAttemptRecorded(activeQuestion(),state.active.answers[activeQuestion()?.id]); pauseTotalTimer(state.active); persistTimer(state.active, false); stopActiveTimer(); state.active.solvingVisible = false; return goToHash('#/recall'); }
  if (action === 'toggle-timers') await toggleAttemptPause();
  if (action === 'signout') await db.auth.signOut(); if (action === 'signup') await signUp(); if (action === 'reset-password') await resetPassword(); if (action === 'retry') render();
  if (action === 'choose-preset') await showTestBuilder(target.dataset.preset); if (action === 'close-builder') testBuilderGeneration++;
  if (action === 'close-builder') { grandTests.cancel(); gtMode.cancel(); document.querySelector('#test-builder-slot').innerHTML = ''; }
  if (action === 'open-pyq-test') await openSelectedPyqTest(target, false); if (action === 'start-pyq-test') await openSelectedPyqTest(target, true);
  if (action === 'start-catalog-selection'||action === 'browse-catalog-selection') await openCatalogSelection(target.dataset.kind,action==='start-catalog-selection');
  if (action === 'open-core-btr-test') await openSelectedCoreBtrTest(target, false); if (action === 'start-core-btr-test') await openSelectedCoreBtrTest(target, true);
  if (action === 'answer') await selectAnswer(target.dataset.key); if (action === 'submit-multi-answer') await submitMultiAnswer(); if (action === 'previous') await navigateActive(state.active.index - 1);
  if (action === 'ar-strength') { const answer=state.active.answers[activeQuestion().id];if(answer&&!answer.attemptRecorded){answer.retrieval_strength=target.dataset.value;answer.confidence=target.dataset.value==='strong'?'sure':'unsure';await recordAttempt(activeQuestion(),answer);renderActive();}return;}
  if (action === 'ar-options') { state.active.arOptionsFor=activeQuestion().id;renderActive();return;}
  if (action === 'ar-question-detail') {const unit=activeRecallUnit();if(unit)await activeRecall.details(unit.unit_key);return;}
  if (action === 'next' && state.active.preset === 'active-recall-v2' && !state.active.completedReview) {await nextActiveRecall();return;}
  if (action === 'next') { if (state.active.index === state.active.questions.length - 1) { if (state.active.kind === 'browse') { goToHash(state.active.origin || '#/qbank'); return; } if (state.active.completedReview) return resultScreen(); return submitActive(false); } await navigateActive(state.active.index + 1); }
  if (action === 'jump') await navigateActive(Number(target.dataset.index)); if (action === 'bookmark') await toggleBookmark(); if (action === 'mark') await toggleMark();
  if (action === 'retry-media') { const question=activeQuestion(); question.mediaError=false; void recoverSnapshotMedia(state.active,question); }
  if (action === 'toggle-explanation') { state.active.explanationOpen = !state.active.explanationOpen; renderActive(); }
  if (action === 'confidence') await updateAnswerMetadata('confidence', target.dataset.value); if (action === 'error-reason') await updateAnswerMetadata('error_reason', target.dataset.value);
  if (action === 'srm-add') await updateQuestionSrm('add'); if (action === 'srm-remove') await updateQuestionSrm('remove'); if (action === 'srm-reset') await updateQuestionSrm('reset');
  if (action === 'continue-learning' && state.continueLearning) {
    const next=state.continueLearning;target.disabled=true;target.textContent='Preparing next QBank…';
    try {const set=await prepareQuestionSet({mode:'practice',preset:'qbank',title:`${next.subject} — ${next.title}`,filters:{platforms:[next.platform_id],subjects:[next.subject_id],source_tests:[next.source_test_id]},requested:'all',autoSubmit:false,origin:'#/home'});readyScreen(set);} catch(error){toast(error.message,'error');target.disabled=false;target.textContent='Open next QBank';}return;
  }
  if (action === 'note') await noteModal(); if (action === 'report') reportModal(); if (action === 'close-modal') document.querySelector('#modal')?.remove(); if (action === 'submit') await submitActive(false); if (action === 'resume') await resumeSession(target.dataset.id);
  if (action === 'start-pending-test') await startPendingSession();
  if (action === 'start-recall') await createSession({ mode: 'recall', preset: 'recall', title: 'Recall review', filters: { platforms: state.recallFilters.platform_id ? [state.recallFilters.platform_id] : [], subjects: state.recallFilters.subject_id ? [state.recallFilters.subject_id] : [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], pyq: state.recallFilters.scope === 'pyq' ? 'yes' : '', year: '', search: '', source: '' }, requested: 'all', autoSubmit: false, questionIds: state.recallQueue.map((row) => row.question_id), origin: '#/recall' });
  if (action === 'cancel-question-set') { const origin = state.pendingSet?.origin || '#/qbank'; state.pendingSet = null; goToHash(origin); }
  if (action === 'back-to-origin') goToHash(state.active?.origin || '#/qbank');
  if (action === 'preview-browsed-set') await createSession({ mode: state.active.testMode || 'test', preset: state.active.preset, title: state.active.title, filters: state.active.filters, questionIds: state.active.questionIds, requested: state.active.questionIds.length, autoSubmit: state.active.testMode !== 'practice', origin: state.active.origin });
  if (action === 'open-action-set' || action === 'preview-action-set') {
    const definition = state.actionSets.get(target.dataset.set); if (!definition) return toast('That question set expired. Please reopen this page.', 'error');
    if (action === 'open-action-set') await openQuestionSet(definition); else await createSession(definition);
  }
  if (action === 'clear-review-filters') { state.reviewFilters = null; await review(); }
  if (action === 'clear-analytics-filters') { state.analyticsFilters = null; state.analyticsBreakdown = null; await analytics(); }
  if (action === 'analyze-pyqs') { state.analyticsFilters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: 'yes' }; state.analyticsBreakdown = 'source_test'; await analytics(); }
  if (action === 'history-page') {await history(Number(target.dataset.page));return;}
  if (action === 'analytics-section') { state.analyticsSection = target.dataset.section; state.analyticsSubjectId = null; state.analyticsPyqBreakdown = null; state.analyticsBreakdown = null; await analytics(); }
  if (action === 'analytics-pyq-subject') { state.analyticsSubjectId = target.dataset.subject; state.analyticsPyqBreakdown = null; await analytics(); }
  if (action === 'analytics-pyq-back') { state.analyticsSubjectId = null; state.analyticsPyqBreakdown = null; await analytics(); }
  if (action === 'analytics-pyq-breakdown') { state.analyticsPyqBreakdown = target.dataset.level; await analytics(); }
  if (action === 'analytics-subject') { state.analyticsSection = 'subjects'; state.analyticsSubjectId = target.dataset.subject; await analytics(); }
  if (action === 'analytics-subject-back') { state.analyticsSubjectId = null; await analytics(); }
  if (action === 'analytics-open-ids') { const questionIds = String(target.dataset.ids || '').split(',').filter(Boolean); await openQuestionSet({ mode: 'test', preset: 'analytics', title: target.dataset.label || 'Analytics review', filters: { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], source_tests: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '' }, questionIds, origin: '#/analytics' }); }
  if (action === 'select-analytics-breakdown') { state.analyticsBreakdown = target.dataset.level; document.querySelectorAll('[data-action="select-analytics-breakdown"]').forEach((button) => { button.classList.toggle('secondary', button !== target); }); renderAnalyticsBreakdown(state.analyticsBreakdown, 1); }
  if (action === 'analytics-more') renderAnalyticsBreakdown(target.dataset.level, Number(target.dataset.page) || 1);
  if (action === 'review-result') startCompletedReview();
  if (action === 'review-filter') startCompletedReview(target.dataset.value);
  if (action === 'review-mistakes') startCompletedReview('incorrect');
  if (action === 'retake') await createSession({ mode: state.active.kind, preset: state.active.preset || 'retake', title: `${state.active.title || 'Test'} retake`, filters: state.active.filters || {}, questionIds: state.active.questions.map((question) => question.id), requested: state.active.questions.length, autoSubmit: state.active.kind === 'test', origin: '#/history' });
  if (action === 'my-bank-tab') showMyBankTab(target.dataset.tab);
  } catch (error) { toast(error.message || 'Could not save. Please try again.', 'error'); } finally { if (guarded) state.actionBusy = false; }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('[data-recall-timer]')) return;
  if (state.actionBusy) { event.target.value = String(state.active?.target_seconds_per_question ?? recallTimerSeconds()); return; }
  const seconds = Number(event.target.value); if (![0, 50, 55].includes(seconds)) return;
  try { localStorage.setItem(`qbank-recall-timer:${state.user?.id}`, String(seconds)); } catch {}
  const active = state.active;
  if (active?.kind === 'recall' && document.querySelector('.question-layout')) {
    active.target_seconds_per_question = seconds;
    active.timer_state = { ...initialClock(active.index), questionLimitMs: questionTimerLimit(active), paused: Boolean(active.answers[activeQuestion().id]?.selected_option) };
    active.questionTimeRemainingSeconds = null;
    persistTimer(active, false); renderActive();
    if (active.id) optional(db.from('test_sessions').update({target_seconds_per_question: seconds}).eq('id', active.id).eq('user_id', state.user.id), 'sessions');
  }
});

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelector('#modal')?.remove(); });
window.addEventListener('hashchange', render);
window.addEventListener('pagehide',()=>persistTimer(state.active,false));

async function bootstrap() {
  loading(); state.user = await requireUser();
  if (db) {
    db.auth.onAuthStateChange((_event, session) => {
      // bootstrap already renders the initial session; a duplicate render can erase GT selection.
      if (_event === 'INITIAL_SESSION') return;
      if (state.user?.id === session?.user?.id) return;
      smartRecall.cancel();
      state.user = session?.user || null;
      metadataRequests.clear(); facetCache.clear(); populationCache.clear(); answerWrites.clear();
      state.meta.fullLoaded = false; state.meta.subjects = []; state.meta.platforms = [];
      setTimeout(render, 0);
    });
    if (state.user) {
      try { await loadMeta(); } catch (error) { console.error('Startup metadata failed', error); }
    }
  }
  render();
}

bootstrap();
