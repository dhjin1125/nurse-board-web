const SAVED_KEY = 'aiBoard.saved.v1';
const HIDDEN_KEY = 'aiBoard.hidden.v1';
const SEEN_KEY = 'aiBoard.lastSeenSuccessAt.v1';

const state = {
  jobs: [],
  reviewJobs: [],
  sourceStatus: [],
  sources: [],
  linkSources: [],
  lastSuccessAt: null,
  refresh: { inProgress: false },
  tab: 'all',
  filters: { q: '', role: '', region: '', employment: '', experience: '', deadline: 'active', sort: 'tier' },
  collapsedTiers: {},
};

const $ = (sel) => document.querySelector(sel);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

const store = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  write(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};
const savedMap = () => store.read(SAVED_KEY, {});
const hiddenSet = () => new Set(store.read(HIDDEN_KEY, []));

const jobKey = (job) => job.dedupeKey || job.id;

function compact(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

const REGION_NAMES = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const jobRegion = (job) => job.regionInfo?.group
  || (String(job.region || '').match(new RegExp(REGION_NAMES.join('|'))) || [null])[0]
  || ({ 11: '서울', 26: '부산', 27: '대구', 28: '인천', 29: '광주', 30: '대전', 31: '울산', 36: '세종', 41: '경기', 51: '강원', 43: '충북', 44: '충남', 52: '전북', 46: '전남', 47: '경북', 48: '경남', 50: '제주' })[job.regionCode]
  || null;
const jobRemote = (job) => job.regionInfo?.remote || /재택|원격|리모트|remote/i.test(`${job.region || ''} ${job.title || ''}`);
const REGION_PRESETS = [
  ['metro', '서울·경기'],
  ['metro-all', '수도권(인천 포함)'],
  ['remote', '원격·재택'],
];
const EXP_OPTIONS = [
  ['', '경력 전체'],
  ['junior', '신입 가능'],
  ['신입', '신입'],
  ['경력무관', '경력무관'],
  ['experienced', '경력'],
  ['intern', '인턴·체험'],
  ['unknown', '확인 필요'],
];

const TIER_META = {
  S: { order: 0, label: '최우선 지원', description: '직무·기업·고용·지역 조건이 좋은 공고' },
  A: { order: 1, label: '적극 검토', description: '조건 대부분이 좋은 공고' },
  B: { order: 2, label: '조건 확인', description: '고용형태·경력·기업 정보 확인 필요' },
  C: { order: 3, label: '후순위', description: '근거나 조건이 아쉬운 공고' },
};
const TIER_ORDER = ['S', 'A', 'B', 'C'];
const jobTier = (job) => job.aiTier?.tier || 'C';

function experienceMatch(job, filter) {
  const info = job.experienceInfo || { category: 'unknown', label: '' };
  if (filter === 'junior') return info.category === 'junior';
  if (filter === 'experienced') return info.category === 'experienced';
  if (filter === 'intern') return info.category === 'intern';
  if (filter === 'unknown') return info.category === 'unknown';
  return info.label === filter || (filter === '신입' && /^신입/.test(info.label));
}

function deadlineMeta(job) {
  const status = job.deadlineStatus || 'unknown';
  if (status === 'expired') return { label: '마감', cls: 'deadline-expired', open: false };
  if (status === 'today') return { label: '오늘 마감', cls: 'deadline-soon', open: true };
  if (status === 'closing-soon') return { label: `D-${job.daysRemaining}`, cls: 'deadline-soon', open: true };
  if (status === 'upcoming') return { label: `${job.deadlineAt || job.deadline} 마감`, cls: 'deadline-open', open: true };
  if (status === 'open') return { label: job.deadline || '상시채용', cls: 'deadline-open', open: true };
  return { label: job.deadline || '원문 확인', cls: '', open: true };
}

function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
}

/* ── 필터·정렬 ─────────────────────────── */
function matchesFilters(job) {
  const f = state.filters;
  if (f.q) {
    const q = compact(f.q);
    const hay = compact(`${job.title} ${job.company} ${(job.roleTags || []).join(' ')}`);
    if (!hay.includes(q)) return false;
  }
  if (f.role && !(job.roleTags || []).includes(f.role)) return false;
  if (f.region === 'metro' && !['서울', '경기'].includes(jobRegion(job))) return false;
  if (f.region === 'metro-all' && !['서울', '경기', '인천'].includes(jobRegion(job))) return false;
  if (f.region === 'remote' && !jobRemote(job)) return false;
  if (f.region && !['metro', 'metro-all', 'remote'].includes(f.region) && jobRegion(job) !== f.region) return false;
  if (f.employment && (job.employmentType || job.employment || '') !== f.employment) return false;
  if (f.experience && !experienceMatch(job, f.experience)) return false;
  const dm = deadlineMeta(job);
  if (f.deadline === 'active' && !dm.open) return false;
  if (f.deadline === 'today' && !(job.deadlineStatus === 'today' || job.deadlineStatus === 'closing-soon')) return false;
  if (f.deadline === 'open' && job.deadlineStatus !== 'open') return false;
  return true;
}

function sortJobs(jobs) {
  const sorted = [...jobs];
  const by = state.filters.sort;
  if (by === 'deadline') {
    sorted.sort((a, b) => {
      const rank = (j) => j.deadlineStatus === 'expired' ? 2 : j.deadlineAt ? 0 : 1;
      return rank(a) - rank(b) || String(a.deadlineAt || '9999').localeCompare(String(b.deadlineAt || '9999'));
    });
  } else if (by === 'published') {
    sorted.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
      || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  } else if (by === 'tier') {
    sorted.sort((a, b) => (TIER_META[jobTier(a)].order - TIER_META[jobTier(b)].order)
      || ((b.aiTier?.score || 0) - (a.aiTier?.score || 0))
      || String(a.deadlineAt || '9999').localeCompare(String(b.deadlineAt || '9999'))
      || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  } else {
    sorted.sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  }
  return sorted;
}

/* ── 렌더링 ─────────────────────────── */
const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>';
const ICON_HIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
const ICON_UNHIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';

function jobRow(job) {
  const key = jobKey(job);
  const saved = savedMap();
  const hidden = hiddenSet();
  const dm = deadlineMeta(job);
  const tier = jobTier(job);
  const tierMeta = TIER_META[tier];
  const scale = job.companyScale;
  const exp = job.experienceInfo;
  const metaParts = [...new Set([
    job.region && !/미표기|원문 확인|정보 확인/.test(job.region) ? job.region : null,
    job.employmentType || job.employment || null,
    exp && exp.label !== '확인 필요' ? exp.label : (!exp ? (job.experienceLevel || job.experience || null) : null),
  ].filter((p) => p && !/미표기|원문 확인|정보 확인/.test(p)))];
  const kicker = [
    `<span class="tier-badge tier-${tier}" title="${esc(tierMeta.label)}">${tier} · ${esc(tierMeta.label)}</span>`,
    job.profileFit?.score >= 16 ? '<span class="kicker-chip fit">커리어 적합</span>' : null,
    scale && scale.id !== 'unknown' ? `<span class="kicker-chip scale-${scale.id}">${esc(scale.label)}</span>` : null,
    exp && exp.label !== '확인 필요' ? `<span class="kicker-chip">${esc(exp.label)}</span>` : null,
    job.salaryInfo?.label ? `<span class="kicker-chip">${esc(job.salaryInfo.label)}</span>` : null,
    jobRemote(job) ? '<span class="kicker-chip">원격·재택</span>' : null,
    job._isNew ? '<span class="kicker-chip new">신규</span>' : null,
  ].filter(Boolean).join('');
  const tierNote = job.aiTier && (job.aiTier.reasons?.length || job.aiTier.cautions?.length)
    ? `<div class="job-tier-note">${esc((job.aiTier.reasons || []).join(' · '))}${job.aiTier.cautions?.length ? ` <em>확인: ${esc(job.aiTier.cautions.join(' · '))}</em>` : ''}</div>`
    : '';
  const tags = [
    ...(job.roleTags || []).map((t) => `<span class="tag">${esc(t)}</span>`),
    `<span class="tag source">${esc(job.source || '수집원')}</span>`,
    ...(job.duplicateCount ? [`<span class="tag source" title="${esc((job.alternateSources || []).map((s) => s.source).join(', '))}">+${job.duplicateCount}개 중복</span>`] : []),
    ...(job.needsReview ? ['<span class="tag source">미분류</span>'] : []),
  ].join('');
  const isSaved = Boolean(saved[key]);
  const isHidden = hidden.has(key);
  const li = document.createElement('li');
  li.className = `job-row tier-${tier}`;
  li.innerHTML = `
    <div class="job-main">
      <div class="job-kicker">${kicker}</div>
      <a class="job-title" href="${esc(job.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(job.title)}</a>
      <div class="job-company">${esc(job.company || '')}</div>
      <div class="job-meta">
        ${metaParts.map((p) => `<span>${esc(p)}</span>`).join('')}
        <span class="${dm.cls}">${esc(dm.label)}</span>
        ${job.publishedAt ? `<span>등록 ${esc(fmtDate(job.publishedAt))}</span>` : ''}
      </div>
      ${tierNote}
      <div class="job-tags">${tags}</div>
    </div>
    <div class="job-actions">
      <button type="button" class="icon-btn ${isSaved ? 'saved' : ''}" data-act="save" title="${isSaved ? '저장 해제' : '저장'}" aria-label="${isSaved ? '저장 해제' : '저장'}">${ICON_SAVE}</button>
      <button type="button" class="icon-btn" data-act="hide" title="${isHidden ? '숨김 해제' : '숨김'}" aria-label="${isHidden ? '숨김 해제' : '숨김'}">${isHidden ? ICON_UNHIDE : ICON_HIDE}</button>
    </div>`;
  li.querySelector('[data-act="save"]').addEventListener('click', () => toggleSave(job));
  li.querySelector('[data-act="hide"]').addEventListener('click', () => toggleHide(job));
  return li;
}

function toggleSave(job) {
  const saved = savedMap();
  const key = jobKey(job);
  if (saved[key]) delete saved[key];
  else saved[key] = { ...job, savedAt: new Date().toISOString() };
  store.write(SAVED_KEY, saved);
  render();
}

function toggleHide(job) {
  const hidden = hiddenSet();
  const key = jobKey(job);
  if (hidden.has(key)) hidden.delete(key);
  else {
    hidden.add(key);
    const saved = savedMap();
    if (saved[key]) { delete saved[key]; store.write(SAVED_KEY, saved); }
  }
  store.write(HIDDEN_KEY, [...hidden]);
  render();
}

function buildSelect(select, label, values, current) {
  const options = [`<option value="">${esc(label)}</option>`]
    .concat(values.map((v) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`));
  select.innerHTML = options.join('');
  select.value = current;
}

function renderControls() {
  const all = [...state.jobs, ...state.reviewJobs];
  const roles = [...new Set(all.flatMap((j) => j.roleTags || []))].sort();
  const regions = REGION_NAMES.filter((r) => all.some((j) => jobRegion(j) === r));
  const employments = [...new Set(all.map((j) => j.employmentType || j.employment).filter(Boolean))].sort();
  buildSelect($('#roleSelect'), '직무 전체', roles, state.filters.role);
  const regionSel = $('#regionSelect');
  regionSel.innerHTML = [`<option value="">지역 전체</option>`]
    .concat(REGION_PRESETS.map(([v, l]) => `<option value="${v}" ${v === state.filters.region ? 'selected' : ''}>${l}</option>`))
    .concat(regions.map((r) => `<option value="${esc(r)}" ${r === state.filters.region ? 'selected' : ''}>${esc(r)}</option>`)).join('');
  regionSel.value = state.filters.region;
  buildSelect($('#employmentSelect'), '고용형태 전체', employments, state.filters.employment);
  const expSel = $('#experienceSelect');
  expSel.innerHTML = EXP_OPTIONS.map(([v, l]) => `<option value="${esc(v)}" ${v === state.filters.experience ? 'selected' : ''}>${esc(l)}</option>`).join('');
  expSel.value = state.filters.experience;
  const deadlineSel = $('#deadlineSelect');
  deadlineSel.innerHTML = [
    ['active', '진행 중'], ['all', '마감 포함'], ['today', '오늘·임박'], ['open', '상시·채용시'],
  ].map(([v, l]) => `<option value="${v}" ${v === state.filters.deadline ? 'selected' : ''}>${l}</option>`).join('');
  deadlineSel.value = state.filters.deadline;
  $('#sortSelect').value = state.filters.sort;
}

function visibleJobs() {
  const hidden = hiddenSet();
  if (state.tab === 'saved') {
    const saved = savedMap();
    return sortJobs(Object.values(saved).filter(matchesFilters));
  }
  if (state.tab === 'hidden') {
    const byKey = new Map([...state.jobs, ...state.reviewJobs].map((j) => [jobKey(j), j]));
    return sortJobs([...hidden].map((k) => byKey.get(k)).filter(Boolean).filter(matchesFilters));
  }
  const base = state.tab === 'review' ? state.reviewJobs : state.jobs;
  return sortJobs(base.filter((job) => !hidden.has(jobKey(job))).filter(matchesFilters));
}

function render() {
  const tabs = ['all', 'review', 'saved', 'hidden', 'sources'];
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });
  $('#countAll').textContent = state.jobs.length;
  $('#countReview').textContent = state.reviewJobs.length;
  $('#countSaved').textContent = Object.keys(savedMap()).length;
  $('#countHidden').textContent = hiddenSet().size;

  const listEl = $('#jobList');
  const emptyEl = $('#emptyState');
  const metaEl = $('#listMeta');
  const sourcesEl = $('#sourcesPanel');

  if (state.tab === 'sources') {
    listEl.innerHTML = '';
    emptyEl.hidden = true;
    metaEl.textContent = '';
    sourcesEl.hidden = false;
    renderSources(sourcesEl);
    return;
  }
  sourcesEl.hidden = true;

  const visible = visibleJobs();
  listEl.innerHTML = '';
  if (state.filters.sort === 'tier' && state.tab === 'all') {
    const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
    for (const job of visible) (byTier[jobTier(job)] || byTier.C).push(job);
    for (const tier of TIER_ORDER) {
      const group = byTier[tier];
      if (!group.length) continue;
      const meta = TIER_META[tier];
      const collapsed = Boolean(state.collapsedTiers[tier]);
      const header = document.createElement('li');
      header.className = `tier-header tier-${tier}${collapsed ? ' is-collapsed' : ''}`;
      header.innerHTML = `<button type="button" class="tier-toggle" aria-expanded="${!collapsed}">
        <span class="tier-grade">${tier}</span>
        <span class="tier-copy"><strong>${esc(meta.label)}</strong><small>${esc(meta.description)}</small></span>
        <span class="tier-count">${group.length}건 <span class="tier-chevron">${collapsed ? '▾' : '▴'}</span></span>
      </button>`;
      header.querySelector('button').addEventListener('click', () => {
        state.collapsedTiers[tier] = !collapsed;
        render();
      });
      listEl.appendChild(header);
      if (!collapsed) for (const job of group) listEl.appendChild(jobRow(job));
    }
  } else {
    for (const job of visible) listEl.appendChild(jobRow(job));
  }

  const labels = { all: 'AI 공고', review: '미분류 공고', saved: '저장한 공고', hidden: '숨긴 공고' };
  metaEl.textContent = visible.length ? `${labels[state.tab]} ${visible.length}건` : '';
  emptyEl.hidden = visible.length > 0;
  if (!visible.length) {
    if (!state.jobs.length && !state.reviewJobs.length && state.tab === 'all') {
      emptyEl.innerHTML = state.refresh?.inProgress
        ? '공고를 수집하고 있습니다. 잠시만 기다려 주세요.'
        : '<strong>아직 수집된 공고가 없습니다</strong>상단의 새로고침을 눌러 채용처에서 공고를 가져오세요.';
    } else if (state.tab === 'saved') {
      emptyEl.innerHTML = '<strong>저장한 공고가 없습니다</strong>공고 행의 저장 버튼을 누르면 여기에 모입니다.';
    } else if (state.tab === 'hidden') {
      emptyEl.innerHTML = '<strong>숨긴 공고가 없습니다</strong>숨긴 공고는 여기서 다시 확인할 수 있습니다.';
    } else {
      emptyEl.innerHTML = '<strong>조건에 맞는 공고가 없습니다</strong>검색어나 조건을 바꿔 보세요.';
    }
  }
}

function sourceStatusText(entry) {
  const status = entry.collectionStatus || entry.status;
  if (status === 'success') return { label: '수집 성공', cls: 'ok' };
  if (status === 'empty') return { label: '결과 없음', cls: 'ok' };
  if (status === 'error') return { label: '수집 실패', cls: 'err' };
  if (status === 'needs_review') return { label: '이전 데이터 유지', cls: 'err' };
  return { label: '수집 전', cls: '' };
}

function renderSources(el) {
  const urlById = new Map(state.sources.map((s) => [s.id, s.url]));
  const cards = state.sourceStatus.map((s) => {
    const st = sourceStatusText(s);
    const url = s.url || urlById.get(s.id) || '#';
    return `<div class="source-card">
      <a class="name" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>
      <div class="status">
        <span class="${st.cls}">${st.label}</span>
        <span>공고 ${s.count || 0}건</span>
        ${s.lastSuccessAt ? `<span>${esc(fmtDateTime(s.lastSuccessAt))} 수집</span>` : '<span>수집 기록 없음</span>'}
      </div>
      ${s.error ? `<div class="error-msg">${esc(s.error)}</div>` : ''}
    </div>`;
  }).join('');
  const links = state.linkSources.map((s) => `
    <a class="link-card" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
      <div class="name">${esc(s.name)}</div>
      <div class="note">${esc(s.note || '')}</div>
    </a>`).join('');
  el.innerHTML = `
    <h2>자동 수집원 ${state.sourceStatus.length}곳</h2>
    <div class="source-grid">${cards || '<div class="note">아직 수집 기록이 없습니다.</div>'}</div>
    <h2>직접 확인 링크</h2>
    <div class="link-grid">${links}</div>`;
}

function renderStatus() {
  const el = $('#collectStatus');
  if (state.refresh?.inProgress) {
    const secs = state.refresh.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(state.refresh.startedAt)) / 1000)) : 0;
    el.textContent = `공고 수집 중… ${secs}초`;
    return;
  }
  if (state.lastSuccessAt) {
    el.textContent = `마지막 수집 ${fmtDateTime(state.lastSuccessAt)} · AI 공고 ${state.jobs.length}건`
      + (state.newCount ? ` · 신규 ${state.newCount}건` : '');
  } else {
    el.textContent = '로컬 전용 · 아직 수집 전';
  }
}

/* ── 데이터 로드·새로고침 ─────────────── */
let pollTimer = null;
let statusTimer = null;

async function loadJobs() {
  const res = await fetch('/api/jobs', { cache: 'no-store' });
  if (!res.ok) throw new Error('목록을 불러오지 못했습니다.');
  const data = await res.json();
  state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  state.reviewJobs = Array.isArray(data.needsReviewJobs) ? data.needsReviewJobs : [];
  state.sourceStatus = Array.isArray(data.sourceStatus) ? data.sourceStatus : [];
  state.sources = Array.isArray(data.sources) ? data.sources : [];
  state.linkSources = Array.isArray(data.linkSources) ? data.linkSources : [];
  state.lastSuccessAt = data.lastSuccessAt || null;
  state.refresh = data.refresh || { inProgress: false };
  // 지난 확인 시점 이후 처음 수집된 공고를 '신규'로 표시한다.
  const prevSeenAt = store.read(SEEN_KEY, null)?.at || null;
  state.newCount = 0;
  if (prevSeenAt) {
    const boundary = Date.parse(prevSeenAt);
    for (const job of [...state.jobs, ...state.reviewJobs]) {
      job._isNew = Number.isFinite(Date.parse(job.firstSeenAt || '')) && Date.parse(job.firstSeenAt) > boundary;
      if (job._isNew) state.newCount += 1;
    }
  }
  if (state.lastSuccessAt && state.lastSuccessAt !== prevSeenAt) {
    store.write(SEEN_KEY, { at: state.lastSuccessAt });
  }
  renderStatus();
  renderControls();
  render();
}

function setRefreshUi(inProgress) {
  const btn = $('#refreshBtn');
  btn.disabled = inProgress;
  $('#refreshLabel').textContent = inProgress ? '수집 중…' : '새로고침';
  btn.querySelector('svg').classList.toggle('spin', inProgress);
}

async function pollUntilDone() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/refresh/status', { cache: 'no-store' });
      const refresh = await res.json();
      state.refresh = refresh;
      renderStatus();
      if (!refresh.inProgress) {
        clearInterval(pollTimer); pollTimer = null;
        setRefreshUi(false);
        await loadJobs();
      }
    } catch { /* 다음 폴링에서 재시도 */ }
  }, 2000);
}

async function triggerRefresh() {
  setRefreshUi(true);
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) {
      setRefreshUi(false);
      $('#collectStatus').textContent = body.error || '잠시 후 다시 시도해 주세요.';
      return;
    }
    if (!res.ok) throw new Error(body.error || '수집 요청에 실패했습니다.');
    state.refresh = body.refresh || { inProgress: true };
    renderStatus();
    pollUntilDone();
  } catch (error) {
    setRefreshUi(false);
    $('#collectStatus').textContent = String(error.message || error);
  }
}

/* ── 이벤트 ─────────────────────────── */
$('#refreshBtn').addEventListener('click', triggerRefresh);
$('#searchInput').addEventListener('input', (e) => { state.filters.q = e.target.value.trim(); render(); });
$('#roleSelect').addEventListener('change', (e) => { state.filters.role = e.target.value; render(); });
$('#regionSelect').addEventListener('change', (e) => { state.filters.region = e.target.value; render(); });
$('#employmentSelect').addEventListener('change', (e) => { state.filters.employment = e.target.value; render(); });
$('#experienceSelect').addEventListener('change', (e) => { state.filters.experience = e.target.value; render(); });
$('#deadlineSelect').addEventListener('change', (e) => { state.filters.deadline = e.target.value; render(); });
$('#sortSelect').addEventListener('change', (e) => { state.filters.sort = e.target.value; render(); });
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => { state.tab = btn.dataset.tab; render(); });
});

statusTimer = setInterval(renderStatus, 5000);
loadJobs().catch((error) => {
  $('#collectStatus').textContent = String(error.message || error);
});
