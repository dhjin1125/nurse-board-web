import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_FEED_FILTERS } from './feed-defaults.js';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BriefcaseBusiness,
  Check, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, Clock3, Cloud, CloudOff,
  Copy, Download, Eye, EyeOff, ExternalLink, Factory, FileText, Filter, HeartPulse, Inbox,
  MapPin, MessageSquareText, RefreshCw, Search,
  Share2, Star, Stethoscope, SunMedium, WifiOff, X,
} from 'lucide-react';
import {
  createLocalStorageAdapter,
  hydrateSavedSnapshots, isJobSaved,
  hideJobSnapshot, hydrateHiddenSnapshots, isJobHidden,
  removeHiddenSnapshot, removeSavedSnapshot, saveJobSnapshot,
  updateRecentFilters, updateProfile, upsertNotification,
} from './user-state.js';
import { appliedJobIds, discoveryJobIds, discoverySeenIds, markJobViewed, filterDiscoveryJobs, advanceDiscoveryCheckpoint } from './discovery.js';
import { refreshHasPublished } from './refresh-status.js';
import {
  APPLICATION_TIER_META, APPLICATION_TIER_ORDER, DEPARTMENT_OPTIONS,
  WORK_PATTERN_OPTIONS, applicationTierFor, applicationTierGroupFor, cleanUnknown, deadlineInfo,
  departmentFor, employmentDisplay, experienceDisplay, facilityTypeFor, jobMatchesFilters, careRoleFor,
  LISTING_AGE_NEW_DAYS, LISTING_AGE_STALE_DAYS, listingAgeDaysFor, listingDateInfoFor,
  hiddenOpportunityFor, nonShiftAssessmentFor, sortJobs, workPatternFor,
} from './job-utils.js';
import {
  applyDetailEnrichment, readDetailEnrichmentCache, rememberDetailEnrichment, writeDetailEnrichmentCache,
} from './detail-enrichments.js';
import {
  detailSectionFingerprint, extractDetailFacts, extractTitleFacts, normalizeDetailSections,
  normalizeRecruitmentSteps, parseOrderedDetailSections, readableDetailBlocks,
} from './detail-sections.js';
import {
  companyReputationLinks, findCompanyReputation, readCompanyReputationCache,
  rememberCompanyReputation, requestCompanyReputation,
} from './company-reputation.js';
import {
  clearPendingSavedSyncMutations, clearSavedSyncToken, enqueueSavedSyncMutation,
  formatPairingCode, isValidPairingCode, normalizePairingCode,
  readPendingSavedSyncMutations, readSavedSyncToken, removePendingSavedSyncMutation,
  replaceSavedSnapshots, requestSavedSync, writeSavedSyncToken,
} from './saved-sync.js';
import { FEEDBACK_MESSAGE_MAX_LENGTH, submitFeedback } from './feedback.js';

const ALL_JOBS_EMPLOYMENT_FILTERS = ['전체'];
const EMPLOYMENT_FILTER_OPTIONS = [
  { value: '전체', label: '전체' },
  { value: '정규직', label: '정규직' },
  { value: '계약직', label: '계약직' },
  { value: '기간제', label: '기간제' },
  { value: '시간제', label: '시간제' },
  { value: '원문 확인', label: '확인 불가' },
];
const DEFAULT_FILTERS = DEFAULT_FEED_FILTERS;
const ALL_JOBS_DEFAULT_FILTERS = {
  ...DEFAULT_FILTERS,
  region: '전체',
  employment: ALL_JOBS_EMPLOYMENT_FILTERS,
  sort: '최신 등록순',
};
const JOB_SORT_VALUES = ['워라벨 우선', '최신 등록순', '마감 임박순'];
const JOB_LIST_PAGE_SIZE = 24;
const JOB_LIST_PREFETCH_MARGIN = '800px 0px';
const DETAIL_SESSION_CACHE_TTL_MS = 10 * 60 * 1000;
const DETAIL_SESSION_CACHE_MAX_ENTRIES = 50;
const COMPANY_REPUTATION_AUTO_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const NAV_ITEMS = [
  { id: 'all', label: '추천', longLabel: '추천 공고', icon: BriefcaseBusiness },
  { id: 'full', label: '전체', longLabel: '전체 공고', icon: ClipboardList },
  { id: 'saved', label: '저장', longLabel: '저장 공고', icon: Bookmark },
];
const cx = (...values) => values.filter(Boolean).join(' ');
const jobKey = (job) => job?.dedupeKey || job?.jobKey || job?.id || '';
const VIEW_PATHS = { all: '/', full: '/all-jobs', saved: '/saved' };
VIEW_PATHS.hidden = '/hidden';
const scrollWindowImmediately = (top = 0) => {
  const root = document.documentElement;
  const previousInlineBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  window.scrollTo({ top, left: 0, behavior: 'auto' });
  root.style.scrollBehavior = previousInlineBehavior;
};
const scrollWindowByImmediately = (top = 0) => {
  const root = document.documentElement;
  const previousInlineBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  window.scrollBy({ top, left: 0, behavior: 'auto' });
  root.style.scrollBehavior = previousInlineBehavior;
};
const jobListScope = (card) => card?.closest('[data-testid="overlooked-opportunities"]') ? 'overlooked' : 'primary';
const captureJobListScrollAnchor = () => {
  const cards = [...document.querySelectorAll('[data-testid="job-card"][data-job-key]')];
  const headerBottom = document.querySelector('.focus-header')?.getBoundingClientRect().bottom || 0;
  const anchor = cards.find((card) => {
    const rect = card.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > headerBottom && rect.top < window.innerHeight;
  });
  return {
    pathname: window.location.pathname,
    scrollY: window.scrollY,
    jobKey: anchor?.dataset.jobKey || '',
    listScope: jobListScope(anchor),
    viewportTop: anchor?.getBoundingClientRect().top ?? null,
  };
};
const restoreJobListScrollAnchor = (anchor) => {
  const matches = anchor?.jobKey
    ? [...document.querySelectorAll('[data-testid="job-card"][data-job-key]')]
      .filter((candidate) => candidate.dataset.jobKey === anchor.jobKey && candidate.getBoundingClientRect().height > 0)
    : [];
  const card = matches.find((candidate) => jobListScope(candidate) === anchor?.listScope) || matches[0];
  if (card && Number.isFinite(anchor?.viewportTop)) {
    const offset = card.getBoundingClientRect().top - anchor.viewportTop;
    if (Math.abs(offset) > 0.25) scrollWindowByImmediately(offset);
    return;
  }
  if (Number.isFinite(anchor?.scrollY)) scrollWindowImmediately(anchor.scrollY);
};
const viewFromPath = (pathname = window.location.pathname) => Object.entries(VIEW_PATHS).find(([, path]) => pathname === path)?.[0] || 'all';
const detailRouteId = (pathname = window.location.pathname) => {
  const match = pathname.match(/^\/recruitment\/([^/]+)\/?$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
};
const jobRouteId = (job) => String(job?.id || jobKey(job) || '');
const detailRequestKey = (job) => String(job?.url || jobKey(job) || jobRouteId(job));
const jobRouteIds = (job) => [job?.id, ...(job?.sourceIds || []), job?.jobKey, job?.dedupeKey, jobKey(job)].map((value) => String(value || '')).filter(Boolean);
const jobMatchesRoute = (job, id) => jobRouteIds(job).includes(String(id || ''));
const findRoutedJob = (id, jobs, reviewJobs, snapshots) => [...jobs, ...reviewJobs, ...Object.values(snapshots || {})].find((job) => jobMatchesRoute(job, id));
const withNurseFacets = (job) => ({ ...job, department: departmentFor(job), workPattern: workPatternFor(job), facilityType: facilityTypeFor(job) });
const sameFilterValue = (value, expected) => Array.isArray(value) && Array.isArray(expected)
  ? value.length === expected.length && value.every((item) => expected.includes(item))
  : value === expected;
const activeFilterCount = (filters, defaults = DEFAULT_FILTERS) => Object.entries(filters).filter(([key, value]) => !['query', 'region', 'sort'].includes(key) && !sameFilterValue(value, defaults[key])).length;
// 새로 열 때는 예전 검색어와 상세 필터를 끌고 오지 않습니다.
// 사용자가 현재 화면에서 직접 고른 조건만 유지하고, 재접속 시 워라벨 중심 기본 목록으로 돌아옵니다.
const filtersFromDefaults = (defaults, snapshot = {}) => Object.fromEntries(Object.entries(defaults).map(([key, defaultValue]) => {
  const value = snapshot?.[key];
  if (Array.isArray(defaultValue)) return [key, Array.isArray(value) ? [...value] : [...defaultValue]];
  return [key, typeof value === typeof defaultValue ? value : defaultValue];
}));
const filtersEqual = (left, right, defaults) => Object.keys(defaults).every((key) => sameFilterValue(left?.[key], right?.[key]));
const filterSnapshotForView = (targetView, recommendedFilters, fullFilters) => {
  if (targetView === 'all') return filtersFromDefaults(DEFAULT_FILTERS, recommendedFilters);
  if (targetView === 'full') return filtersFromDefaults(ALL_JOBS_DEFAULT_FILTERS, fullFilters);
  return null;
};
const historyFiltersForView = (targetView) => {
  if (typeof window === 'undefined') return null;
  const navigationType = window.performance?.getEntriesByType?.('navigation')?.[0]?.type;
  const returningThroughHistory = navigationType === 'back_forward' || window.performance?.navigation?.type === 2;
  if (!detailRouteId() && !returningThroughHistory) return null;
  const routeState = window.history.state || {};
  return routeState.listView === targetView ? routeState.listFilters : null;
};
const initialFilters = () => filtersFromDefaults(DEFAULT_FILTERS, historyFiltersForView('all'));
const initialAllJobsFilters = () => filtersFromDefaults(ALL_JOBS_DEFAULT_FILTERS, historyFiltersForView('full'));
function formatDate(value, { time = false } = {}) {
  if (!value) return '일정 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(date);
}

function formatFullDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' }).format(date).replace(/\s/g, ' ');
}

function formatPostedLabel(value, { full = false } = {}) {
  if (!value) return '';
  const formatted = full ? formatFullDate(value) : formatDate(value);
  return formatted.replace(/\s*(?:등록일|등록)\s*$/u, '').trim();
}

function listingAgeBadgeFor(job = {}) {
  const listingDate = listingDateInfoFor(job);
  const days = listingAgeDaysFor(job);
  if (!listingDate && days == null) {
    return {
      tone: 'unknown',
      value: '?',
      suffix: '등록일 미확인',
      title: '등록일을 확인할 수 없어 같은 티어에서 아래에 표시됩니다.',
    };
  }
  const tone = days <= LISTING_AGE_NEW_DAYS ? 'fresh' : days <= LISTING_AGE_STALE_DAYS ? 'recent' : 'stale';
  if (!listingDate) {
    return {
      tone,
      value: days === 0 ? '오늘' : `${days}일`,
      suffix: days === 0 ? '확인' : '전 확인',
      title: '등록일이 확인되지 않아 서비스 최초 확인 시점 기준입니다.',
    };
  }
  const ageLabel = days === 0 ? '오늘 등록' : `${days}일 전 등록`;
  return {
    tone,
    value: days === 0 ? '오늘' : `${days}일`,
    suffix: days === 0 ? '등록' : '전',
    title: `등록일 기준 ${ageLabel} 공고`,
  };
}

function formatDeadlineDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return firstKnown(value);
  const dateLabel = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  const hasTime = /T\d{2}:\d{2}/.test(String(value)) && !/T00:00/.test(String(value));
  if (!hasTime) return `${dateLabel}까지`;
  const timeLabel = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `${dateLabel} ${timeLabel}까지`;
}

function useDialog(active, onClose, { modal = true, focusOnOpen = true, restoreFocus = true } = {}) {
  const ref = useRef(null);
  const returnFocusRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    returnFocusRef.current = document.activeElement;
    const dialogElement = ref.current;
    const timer = focusOnOpen
      ? window.setTimeout(() => ref.current?.querySelector('button, input, select, textarea, a[href]')?.focus({ preventScroll: true }), 0)
      : null;
    const inerted = [];
    if (modal) {
      let dialogBranch = ref.current;
      while (dialogBranch?.parentElement) {
        const parent = dialogBranch.parentElement;
        for (const sibling of parent.children) if (sibling !== dialogBranch && sibling instanceof HTMLElement && !['SCRIPT', 'STYLE'].includes(sibling.tagName)) {
          inerted.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
        dialogBranch = parent;
        if (parent === document.body) break;
      }
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { closeRef.current(); return; }
      if (!modal || event.key !== 'Tab' || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable.at(-1);
      if (!ref.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('dialog-open');
    return () => {
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('dialog-open');
      inerted.forEach(([element, wasInert]) => { element.inert = wasInert; });
      const activeInsideDialog = dialogElement?.contains(document.activeElement);
      const canRestore = returnFocusRef.current?.isConnected
        && (document.activeElement === document.body || activeInsideDialog);
      if (restoreFocus && canRestore) {
        try {
          returnFocusRef.current.focus({ preventScroll: true });
        } catch {
          returnFocusRef.current.focus();
        }
      }
    };
  }, [active, focusOnOpen, modal, restoreFocus]);
  return ref;
}

function Brand({ compact = false }) {
  return <div className={cx('brand', compact && 'compact')} aria-label="Nurse Board"><span><HeartPulse aria-hidden="true" /></span><strong>NURSE<br className="desktop-only" /> BOARD</strong></div>;
}

function AppNavigation({ view, onChange, counts }) {
  return <nav className="primary-nav" aria-label="주요 메뉴">{NAV_ITEMS.map(({ id, label, longLabel, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => onChange(id)} aria-label={longLabel} aria-current={view === id ? 'page' : undefined} data-testid={`nav-${id}`}><Icon aria-hidden="true" /><span className="nav-long">{longLabel}</span><span className="nav-short">{label}</span>{counts[id] != null && <em>{counts[id]}</em>}</button>)}</nav>;
}

function FocusHeader({ view, onChange, counts, refreshing, savedSync, onSavedSync, onFeedback }) {
  const syncWorking = savedSync.phase === 'syncing';
  const syncConnected = savedSync.connected;
  return <header className="focus-header">
    <div className="focus-identity"><Brand compact /><div><span>Nurse Board</span><strong><span className="desktop-brand-label">간호사 채용 공고</span><span className="mobile-brand-label">널스보드</span></strong></div></div>
    <AppNavigation view={view} onChange={onChange} counts={counts} />
    <div className="focus-header-tools">
      <button type="button" className="feedback-menu-button" onClick={onFeedback} data-testid="feedback-menu" aria-label="피드백 남기기" title="피드백 남기기"><MessageSquareText aria-hidden="true" /><span>피드백</span></button>
      <button type="button" className={cx('hidden-menu-button', view === 'hidden' && 'active')} onClick={() => onChange('hidden')} data-testid="nav-hidden" aria-label={`숨긴 공고 메뉴${counts.hidden ? `, ${counts.hidden}개` : ''}`} title="숨긴 공고 보기"><EyeOff aria-hidden="true" /><span className="mobile-tool-label">숨김</span>{counts.hidden > 0 && <em>{counts.hidden > 99 ? '99+' : counts.hidden}</em>}</button>
      <button type="button" className={cx('focus-sync', (refreshing || syncWorking) && 'working', savedSync.phase === 'error' && 'error')} onClick={onSavedSync} data-testid="sync-settings" aria-label="스크랩 동기화 설정 열기">
        <span />
        <span className="mobile-tool-label">연결</span>
        <div><b>{syncWorking ? '스크랩 맞추는 중' : syncConnected ? '스크랩 동기화됨' : refreshing ? '새 공고 확인 중' : '기기 간 스크랩 연결'}</b><small>{savedSync.phase === 'error' ? '연결을 다시 확인해 주세요' : syncConnected ? '여러 기기에서 저장 공고 보기' : '휴대폰과 컴퓨터에서 함께 보기'}</small></div>
        {syncConnected ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
      </button>
    </div>
  </header>;
}

function DataTrustBar({ trust, onRetry }) {
  if (trust?.state !== 'unavailable') return null;
  return <aside className="data-trust-bar attention" role="status" data-testid="data-trust-bar"><WifiOff aria-hidden="true" /><div><b>공고 목록을 지금 확인하지 못했어요</b><span>저장한 공고는 그대로 남아 있습니다. 잠시 후 다시 시도해 주세요.</span></div><button onClick={onRetry}>다시 시도<RefreshCw /></button></aside>;
}

function SkeletonList() {
  return <div className="skeleton-list" aria-label="공고를 불러오는 중">{[0, 1, 2, 3].map((index) => <div className="job-skeleton" key={index}><i /><div><span /><span /><span /></div><b /><b /></div>)}</div>;
}

function EmptyState({ kind = 'empty', title, message, actionLabel, onAction }) {
  const Icon = kind === 'error' ? WifiOff : kind === 'saved' ? Bookmark : Inbox;
  return <div className={cx('empty-state', kind)} role={kind === 'error' ? 'alert' : 'status'}><span><Icon aria-hidden="true" /></span><h3>{title}</h3><p>{message}</p>{onAction && <button className="secondary-button" onClick={onAction}>{actionLabel}<ArrowRight /></button>}</div>;
}

function firstKnown(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      if (value.length) return value;
      continue;
    }
    const cleaned = cleanUnknown(value);
    if (cleaned !== '원문 확인') return cleaned;
  }
  return '';
}

function knownFact(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value.raw || value.text : value;
  const cleaned = cleanUnknown(raw);
  return cleaned === '원문 확인' ? '' : cleaned;
}

function detailSectionValues(sections) {
  return sections.reduce((values, section) => {
    if (!section.semanticKey || !section.value) return values;
    values[section.semanticKey] = [values[section.semanticKey], section.value].filter(Boolean).join('\n');
    return values;
  }, {});
}

function detailItems(value) {
  const values = Array.isArray(value) ? value.flatMap(detailItems) : String(value || '').split(/\n+|\s*[•●▪]\s*|\s+[·ㆍ]\s+/);
  return [...new Set(values.map((item) => String(item).replace(/^[-–—]\s*/, '').trim()).filter(Boolean))].slice(0, 80);
}

function groupedDetailItems(value) {
  const groups = [];
  let current = { title: '', items: [] };
  for (const item of detailItems(value)) {
    const groupTitle = item.match(/^\[([^\]]{1,40})]$/)?.[1]?.trim();
    if (groupTitle) {
      if (current.items.length) groups.push(current);
      current = { title: groupTitle, items: [] };
    } else current.items.push(item);
  }
  if (current.items.length) groups.push(current);
  return groups;
}

function groupReadableDetailBlocks(blocks) {
  const groups = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.type === 'bullet' && previous?.type === 'list') previous.items.push(block.text);
    else if (block.type === 'bullet') groups.push({ type: 'list', items: [block.text] });
    else if (block.type === 'field' && previous?.type === 'facts') previous.items.push(block);
    else if (block.type === 'field') groups.push({ type: 'facts', items: [block] });
    else groups.push(block);
  }
  return groups;
}

function ReadableDetailContent({ value, blocks = readableDetailBlocks(value) }) {
  const groups = groupReadableDetailBlocks(blocks);
  return <div className="detail-readable-content">{groups.map((group, index) => {
    if (group.type === 'list') return <ul className="detail-bullet-list" key={`list:${index}`}>{group.items.map((item, itemIndex) => <li key={`${item}:${itemIndex}`}>{item}</li>)}</ul>;
    if (group.type === 'facts') return <dl className="detail-inline-facts" key={`facts:${index}`}>{group.items.map((item, itemIndex) => <div key={`${item.label}:${item.value}:${itemIndex}`}><dt>{item.label}</dt><dd>{/^https?:\/\//iu.test(item.value) ? <a href={item.value} target="_blank" rel="noopener noreferrer">{item.value}</a> : item.value}</dd></div>)}</dl>;
    if (group.type === 'subheading') return <h4 key={`heading:${group.text}:${index}`}>{group.text}</h4>;
    if (group.type === 'note') return <p className="detail-source-note" key={`note:${group.text}:${index}`}>{group.text}</p>;
    if (group.type === 'fragment') return <p className="detail-source-fragments" key={`fragment:${index}`}>{group.items.map((item, itemIndex) => <span key={`${item}:${itemIndex}`}>{item}</span>)}</p>;
    return <p key={`text:${group.text}:${index}`}>{group.text}</p>;
  })}</div>;
}

function DetailTextBlock({ value, ordered = false, prose = false, preserveSource = false }) {
  const items = ordered ? normalizeRecruitmentSteps(value) : detailItems(value);
  if (!items.length) return null;
  const sourceText = Array.isArray(value) ? value.join('\n') : String(value || '');
  const fragmentedSource = !preserveSource && (items.length > 14 || sourceText.length > 1400);
  const readableBlocks = preserveSource || ordered ? [] : readableDetailBlocks(value);
  const structuredSource = !preserveSource && !ordered && items.length >= 3
    && (readableBlocks.some((block) => ['field', 'subheading', 'note'].includes(block.type))
      || /(?:^|\n)\s*(?:□|※|[-–—•●▪·ㆍ]|\[[^\]]+\]|\d{1,2}[.)]\s)/u.test(sourceText));
  if (fragmentedSource || structuredSource) return <ReadableDetailContent value={value} blocks={readableBlocks} />;
  if (prose) return <p className="detail-prose">{Array.isArray(value) ? value.join('\n') : String(value)}</p>;
  if (items.length === 1) return <p className="detail-prose">{items[0]}</p>;
  const groups = ordered ? [] : groupedDetailItems(value);
  if (groups.some(({ title }) => title)) return <div className="detail-list-groups">{groups.map((group, groupIndex) => <section className="detail-list-group" key={`${group.title}:${groupIndex}`}>{group.title && <h4>{group.title}</h4>}<ul className="detail-bullet-list">{group.items.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</ul></section>)}</div>;
  const List = ordered ? 'ol' : 'ul';
  return <List className={ordered ? 'detail-ordered-list' : 'detail-bullet-list'}>{items.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</List>;
}

function RecruitmentSection({ sectionId, sectionKey, title, value, ordered = false, prose = false }) {
  const items = ordered ? normalizeRecruitmentSteps(value) : detailItems(value);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [sectionId, value]);
  if (!items.length) return null;
  const sourceLength = Array.isArray(value) ? value.join('\n').length : String(value || '').length;
  const isLong = items.length > 14 || sourceLength > 1400;
  const contentId = `${sectionId}-content`;
  return <section className={cx('recruitment-section', `section-${sectionKey || 'custom'}`, isLong && 'is-long')} id={sectionId}>
    <h3>{title}</h3>{isLong && <span className="section-length-badge">긴 원문</span>}
    <div className={cx('recruitment-section-body', isLong && !expanded && 'is-collapsed')} id={contentId}><DetailTextBlock value={value} ordered={ordered} prose={prose} /></div>
    {isLong && <button type="button" className="section-expand" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((current) => !current)}>{expanded ? '내용 접기' : '전체 내용 펼치기'}<ChevronDown aria-hidden="true" /></button>}
  </section>;
}

const JobCard = memo(function JobCard({ job, profile, saved, onOpen, onToggleSave, onToggleHide, onPrefetch, compact = false, recommendationOverride, hiddenMode = false, savedMode = false, showListingAge = false, isUnseen = false, opportunityEvidence }) {
  const deadline = deadlineInfo(job);
  const experience = experienceDisplay(job);
  const department = departmentFor(job);
  const workPattern = workPatternFor(job);
  const nonShift = nonShiftAssessmentFor(job);
  const applicationTier = applicationTierFor(job, profile);
  const ScheduleIcon = ['confirmed', 'likely'].includes(nonShift.status) ? SunMedium : Clock3;
  const employment = employmentDisplay(job);
  const salary = knownFact(job.salary);
  const education = knownFact(job.education);
  const facts = [...new Set([
    careRoleFor(job) === 'pa' ? job.recruitmentScope === 'mixed' ? 'PA·전담 포함 · 부서별 조건 확인' : 'PA·전담 직무' : '',
    department !== '원문 확인' ? department : '',
    workPattern !== '원문 확인' ? workPattern : '',
    employment !== '원문 확인' ? employment : '',
    experience.value !== '원문 확인' ? experience.value : '',
    salary,
    education,
    facilityTypeFor(job),
  ].filter((value) => value && value !== '원문 확인'))].slice(0, 6);
  const secondaryFacts = new Set([education, facilityTypeFor(job)]);
  if (job.title?.includes(department) || nonShift.label.includes(department)) secondaryFacts.add(department);
  const publishedLabel = formatPostedLabel(job.publishedAt || job.postedAt);
  const seenLabel = publishedLabel ? '' : formatPostedLabel(job.firstSeenAt);
  const listingDate = listingDateInfoFor(job);
  const listingAgeDays = listingDate ? listingAgeDaysFor(job) : null;
  const listingAgeBadge = showListingAge ? listingAgeBadgeFor(job) : null;
  const workplaceHealth = department === '산업보건';
  const hideLabel = hiddenMode ? `${job.title} 숨김 해제` : `${job.title} 숨기기`;
  const HideIcon = hiddenMode ? Eye : EyeOff;
  const [leaving, setLeaving] = useState(false);
  const cardRef = useRef(null);
  const animateOutThen = (action) => {
    if (leaving) return;
    const el = cardRef.current;
    if (el) { el.style.height = `${el.offsetHeight}px`; void el.offsetHeight; }
    setLeaving(true);
    window.setTimeout(action, 230);
  };
  const handleToggleHide = () => animateOutThen(() => onToggleHide(job));
  const handleToggleSave = () => (savedMode && saved ? animateOutThen(() => onToggleSave(job)) : onToggleSave(job));
  return <article ref={cardRef} className={cx('job-card', `schedule-${nonShift.status}`, `application-tier-${applicationTier.tier}`, ['S', 'A'].includes(applicationTier.tier) && 'career-priority', compact && 'compact', job.missingFromFeed && 'missing', leaving && 'leaving')} data-testid="job-card" data-job-key={jobKey(job) || jobRouteId(job) || undefined} data-application-tier={applicationTier.tier}>
    <div className="job-card-actions">
      <button type="button" className={cx('save-button', saved && 'active')} onClick={handleToggleSave} aria-label={saved ? `${job.title} 저장 취소` : `${job.title} 저장`} aria-pressed={saved}><Star fill={saved ? 'currentColor' : 'none'} /></button>
      {onToggleHide && <button type="button" className={cx('hide-button', hiddenMode && 'restore')} onClick={handleToggleHide} aria-label={hideLabel} title={hideLabel} data-testid={hiddenMode ? 'unhide-job' : 'hide-job'}><HideIcon aria-hidden="true" /></button>}
    </div>
    <button className="job-card-main" onClick={() => onOpen(job)} onPointerEnter={() => onPrefetch?.(job)} onPointerDown={() => onPrefetch?.(job)} onFocus={() => onPrefetch?.(job)} data-testid="open-job-detail">
      <div className={cx('job-mark', workplaceHealth && 'health')}>{job.logo ? <img src={job.logo} alt="" /> : workplaceHealth ? <Factory /> : <Stethoscope />}</div>
      <div className="job-copy"><div className="job-kicker"><span className={cx('application-tier-badge', `tier-${applicationTier.tier}`)}><strong>{applicationTier.grade}</strong>{applicationTier.shortLabel !== applicationTier.grade && applicationTier.shortLabel}</span><span className={cx('schedule-badge', nonShift.status)} title={nonShift.detail} aria-label={`${nonShift.label}: ${nonShift.detail}`}><ScheduleIcon aria-hidden="true" />{nonShift.label}</span><span className="job-source-name">{job.source || '저장된 공고'}</span>{job.alternateSources?.length > 0 && <em>같은 공고 {job.alternateSources.length + 1}곳</em>}{job.missingFromFeed && <em>현재 목록에서 보이지 않음</em>}{showListingAge && isUnseen && <em className="discovery-unseen-badge" data-testid="unseen-job-badge">안 본 공고</em>}{listingAgeDays != null && listingAgeDays <= LISTING_AGE_NEW_DAYS && <em className="listing-fresh">새 공고</em>}{listingAgeDays != null && listingAgeDays > LISTING_AGE_STALE_DAYS && <em className="listing-stale">오래 게시된 공고</em>}</div><h3>{job.title || '제목을 확인해 주세요'}</h3><p>{job.company || '회사 정보 확인 필요'}</p>{opportunityEvidence && <div className="opportunity-evidence" aria-label="놓치기 아까운 후보 선정 근거"><b>후보 근거</b><span>{opportunityEvidence.reasons.join(' · ')}</span>{opportunityEvidence.cautions.length > 0 && <em>추가 확인: {opportunityEvidence.cautions.join(' · ')}</em>}</div>}<p className="career-priority-reason application-tier-reason"><b>{applicationTier.eligibility.label}</b><span>{applicationTier.reasons.join(' · ')}</span>{applicationTier.cautions[0] && <em>확인: {applicationTier.cautions[0]}</em>}</p><div className="job-facts">{facts.map((fact) => <span className={/확인 필요|원문에도.*미표기/.test(fact) ? 'unknown' : ''} data-secondary={secondaryFacts.has(fact) || undefined} key={fact}>{fact}</span>)}</div><div className="job-trust"><span className="job-source-mobile">{job.source || '저장된 공고'}</span>{listingAgeBadge && <em className={cx('listing-age-badge', `age-${listingAgeBadge.tone}`)} data-testid="listing-age" title={listingAgeBadge.title}><Clock3 aria-hidden="true" /><strong>{listingAgeBadge.value}</strong><span>{' '}{listingAgeBadge.suffix}</span></em>}{publishedLabel ? <em className="job-published-date">등록 {publishedLabel}</em> : seenLabel ? <em className="job-published-date seen">확인 {seenLabel}</em> : null}</div></div>
      <div className="job-primary-meta"><div className="job-meta region"><MapPin /> <span>{cleanUnknown(job.region) === '원문 확인' ? '지역 확인 필요' : cleanUnknown(job.region)}</span></div><div className={cx('job-meta', 'deadline', deadline.status)}><Clock3 /> <span>{deadline.label}</span></div></div><span className="open-detail" aria-hidden="true"><ArrowUpRight /></span>
    </button>
  </article>;
});

function JobList({ jobs, profile, state, loading, error, onOpen, onToggleSave, onToggleHide, onPrefetch, onRetry, emptyCopy, compact, recommendations, hiddenMode = false, savedMode = false, groupApplicationTiers = false, initialCollapsedTiers = [], showTierCollapseAll = false, pagingKey = '', pagination, onLoadMore, loadingMore, opportunityEvidenceByKey }) {
  const viewedIds = useMemo(() => new Set(discoverySeenIds(state)), [state.discovery]);
  const appliedIds = useMemo(() => new Set(appliedJobIds(state)), [state.applications, state.savedSnapshots]);
  const listModel = useMemo(() => {
    if (!groupApplicationTiers) return { orderedJobs: jobs, buckets: null };
    const buckets = Object.fromEntries(APPLICATION_TIER_ORDER.map((tier) => [tier, []]));
    for (const job of jobs) {
      const tier = applicationTierGroupFor(job, profile);
      (buckets[tier] || buckets.B).push(job);
    }
    return { orderedJobs: APPLICATION_TIER_ORDER.flatMap((tier) => buckets[tier]), buckets };
  }, [groupApplicationTiers, jobs, profile]);
  const [pageState, setPageState] = useState(() => ({ key: pagingKey, count: JOB_LIST_PAGE_SIZE }));
  const [collapsedTiers, setCollapsedTiers] = useState(() => Object.fromEntries(initialCollapsedTiers.map((tier) => [tier, true])));
  // 한 번 펼친 그룹은 DOM을 유지하고 hidden만 토글 — 수백 개 카드 언마운트가 프레임 단위로 쪼개져 '여러 번 닫히는' 것처럼 보이는 문제 방지
  const [mountedTiers, setMountedTiers] = useState(() => Object.fromEntries(APPLICATION_TIER_ORDER.filter((tier) => !initialCollapsedTiers.includes(tier)).map((tier) => [tier, true])));
  const toggleTier = (tier) => {
    setCollapsedTiers((current) => ({ ...current, [tier]: !current[tier] }));
    setMountedTiers((current) => (current[tier] ? current : { ...current, [tier]: true }));
  };
  const visibleCount = pagination ? jobs.length : pageState.key === pagingKey ? pageState.count : JOB_LIST_PAGE_SIZE;
  const visibleJobs = listModel.orderedJobs.slice(0, visibleCount);
  const total = pagination?.total ?? listModel.orderedJobs.length;
  const hasMore = pagination ? pagination.hasMore : visibleJobs.length < listModel.orderedJobs.length;
  const loadMoreRef = useRef(null);
  const loadNextPage = useCallback(() => {
    if (pagination) { if (!loadingMore) onLoadMore?.(); return; }
    setPageState((current) => {
      const currentCount = current.key === pagingKey ? current.count : JOB_LIST_PAGE_SIZE;
      const nextCount = Math.min(listModel.orderedJobs.length, currentCount + JOB_LIST_PAGE_SIZE);
      if (current.key === pagingKey && current.count === nextCount) return current;
      return { key: pagingKey, count: nextCount };
    });
  }, [listModel.orderedJobs.length, pagingKey, pagination, onLoadMore, loadingMore]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loadingMore || error || !('IntersectionObserver' in window)) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) loadNextPage();
    }, { rootMargin: JOB_LIST_PREFETCH_MARGIN });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadNextPage, loadingMore, error]);

  if (loading) return <SkeletonList />;
  if (error && !jobs.length) return <EmptyState kind="error" title="공고를 불러오지 못했어요" message="인터넷 연결을 확인한 뒤 다시 시도해 주세요." actionLabel="다시 확인" onAction={onRetry} />;
  if (!jobs.length) return <EmptyState title={emptyCopy?.title || '조건에 맞는 공고가 없습니다'} message={emptyCopy?.message || '검색어나 필터를 바꿔보세요.'} actionLabel={emptyCopy?.actionLabel} onAction={emptyCopy?.onAction} />;
  // 카드 key는 공고 고유값만 사용 — index를 섞으면 숨기기/저장 시 아래 카드 전체가 리마운트되어 화면이 깜빡임
  const seenKeys = new Set();
  const card = (job, index) => { const key = jobKey(job); let reactKey = key || jobRouteId(job) || job.id || job.url || `job-${index}`; if (seenKeys.has(reactKey)) reactKey = `${reactKey}:${index}`; seenKeys.add(reactKey); const ids = discoveryJobIds(job); const isUnseen = ids.length > 0 && !ids.some((id) => viewedIds.has(id)) && !ids.some((id) => appliedIds.has(id)); const opportunityEvidence = opportunityEvidenceByKey?.[key] || opportunityEvidenceByKey?.[job.id] || opportunityEvidenceByKey?.[job.dedupeKey]; return <JobCard key={reactKey} job={job} profile={profile} saved={isJobSaved(state, job)} onOpen={onOpen} onToggleSave={onToggleSave} onToggleHide={onToggleHide} onPrefetch={onPrefetch} compact={compact} recommendationOverride={recommendations?.[key]} hiddenMode={hiddenMode} savedMode={savedMode} showListingAge={groupApplicationTiers} isUnseen={isUnseen} opportunityEvidence={opportunityEvidence} />; };
  const nextPageSize = Math.min(JOB_LIST_PAGE_SIZE, total - visibleJobs.length);
  const progress = Math.round((visibleJobs.length / total) * 100);
  const pager = hasMore && <div className="job-list-pager" ref={loadMoreRef} data-testid="job-list-pager">
    <div className="job-list-pager-copy"><span><b>{visibleJobs.length}</b> / {total}건 표시</span><small>{error ? '다음 공고를 불러오지 못했어요. 다시 시도해 주세요.' : '아래로 내리면 다음 공고가 이어집니다'}</small></div>
    <div className="job-list-pager-track" role="progressbar" aria-label="화면에 표시한 공고" aria-valuemin="0" aria-valuemax={total} aria-valuenow={visibleJobs.length}><i style={{ width: `${progress}%` }} /></div>
    <button type="button" disabled={loadingMore} onClick={loadNextPage}>{loadingMore ? '불러오는 중' : `다음 ${nextPageSize}건 이어 보기`} <ChevronDown aria-hidden="true" /></button>
  </div>;
  if (!groupApplicationTiers) return <><div className="job-list">{visibleJobs.map((job, index) => card(job, index))}</div>{pager}</>;
  let remaining = visibleJobs.length;
  const grouped = APPLICATION_TIER_ORDER.map((tier) => {
    const tierJobs = listModel.buckets[tier];
    const visibleTierJobs = tierJobs.slice(0, Math.max(0, remaining));
    remaining -= visibleTierJobs.length;
    return { tier, meta: APPLICATION_TIER_META[tier], jobs: visibleTierJobs, total: pagination?.tiers?.[tier] ?? tierJobs.length };
  }).filter((group) => group.jobs.length > 0);
  const allGroupsCollapsed = grouped.length > 0 && grouped.every((group) => collapsedTiers[group.tier]);
  const toggleAllGroups = () => {
    const next = !allGroupsCollapsed;
    setCollapsedTiers(Object.fromEntries(APPLICATION_TIER_ORDER.map((tier) => [tier, next])));
    if (!next) setMountedTiers((current) => ({ ...current, ...Object.fromEntries(APPLICATION_TIER_ORDER.map((tier) => [tier, true])) }));
  };
  return <>{showTierCollapseAll && <div className="tier-collapse-tools"><span>등급별 공고</span><button type="button" onClick={toggleAllGroups} aria-expanded={!allGroupsCollapsed} data-testid="toggle-all-tiers">{allGroupsCollapsed ? '전체 펼치기' : '전체 접기'}<ChevronDown aria-hidden="true" /></button></div>}<div className="job-list application-tier-list" data-testid="application-tier-list">{grouped.map((group) => {
    const collapsed = Boolean(collapsedTiers[group.tier]);
    const panelId = `application-tier-panel-${group.tier}`;
    return <section className={cx('application-tier-section', `tier-${group.tier}`, collapsed && 'is-collapsed')} data-testid={`application-tier-group-${group.tier}`} key={group.tier}>
      <button type="button" className={cx('job-list-group', `tier-${group.tier}`)} data-testid={`tier-toggle-${group.tier}`} aria-expanded={!collapsed} aria-controls={panelId} onClick={() => toggleTier(group.tier)}>
        <span className="tier-group-grade">{group.meta.grade}</span><span className="tier-group-copy"><h3>{group.meta.label}</h3><p>{group.meta.description}</p><small className="tier-group-order">등록일 최신순 · 미확인 아래</small></span><b><span>{group.total}건</span><ChevronDown aria-hidden="true" /></b>
      </button>
      <div id={panelId} className="application-tier-cards" hidden={collapsed}>{(mountedTiers[group.tier] || !collapsed) && group.jobs.map((job, index) => card(job, index))}</div>
    </section>;
  })}</div>{pager}</>;
}

function EmploymentFilter({ value, onChange, inclusive = false }) {
  const selected = Array.isArray(value) ? value : [value || '전체'];
  const allSelected = selected.includes('전체');
  const toggle = (option) => {
    if (option === '전체') {
      onChange(['전체']);
      return;
    }
    const current = allSelected ? [] : selected.filter((item) => item !== '전체');
    const next = current.includes(option) ? current.filter((item) => item !== option) : [...current, option];
    const ordered = EMPLOYMENT_FILTER_OPTIONS
      .filter((item) => item.value !== '전체' && next.includes(item.value))
      .map((item) => item.value);
    onChange(ordered.length ? ordered : ['전체']);
  };
  return <fieldset className="employment-filter" aria-describedby="employment-filter-note">
    <legend>고용 형태</legend>
    <div className="employment-filter-options">
      {EMPLOYMENT_FILTER_OPTIONS.map((option) => <label key={option.value}>
        <input type="checkbox" checked={option.value === '전체' ? allSelected : !allSelected && selected.includes(option.value)} onChange={() => toggle(option.value)} />
        <span><Check aria-hidden="true" />{option.label}</span>
      </label>)}
    </div>
    <small id="employment-filter-note">{inclusive ? '계약직·기간제·시간제와 고용형태 미표기까지 모두 보여줘요.' : '추천 공고는 정규직과 고용형태 미표기를 기본으로 보여줘요.'}</small>
  </fieldset>;
}

function FilterFields({ filters, setFilters, jobs, inclusiveEmployment = false }) {
  const field = (name, label, options) => <label key={name}><span>{label}</span><div className="select-control"><select value={filters[name]} onChange={(event) => setFilters((current) => ({ ...current, [name]: event.target.value }))}>{options.map((option) => { const value = typeof option === 'string' ? option : option.value; const optionLabel = typeof option === 'string' ? option : option.label; return <option key={value} value={value}>{optionLabel}</option>; })}</select><ChevronDown aria-hidden="true" /></div></label>;
  const unknown = { value: '원문 확인', label: '정보 미표기' };
  return <div className="filter-fields">
    <div className="filter-select-grid filter-select-grid-primary">
      {field('department', '부서', ['전체', ...DEPARTMENT_OPTIONS, unknown])}
      {field('workPattern', '근무 형태', ['전체', ...WORK_PATTERN_OPTIONS, unknown])}
    </div>
    <EmploymentFilter value={filters.employment} onChange={(employment) => setFilters((current) => ({ ...current, employment }))} inclusive={inclusiveEmployment} />
    <div className="filter-select-grid filter-select-grid-secondary">
      {field('experience', '경력', ['전체', '신입·무관', '경력', unknown])}
      {field('deadline', '마감', ['전체', '오늘 마감', '3일 이내', '7일 이내', '상시채용', unknown])}
      {field('sort', '정렬', [
        ...(filters.sort === '처음 발견순' ? [{ value: '처음 발견순', label: '새 공고 · 최초 발견순' }] : []),
        { value: JOB_SORT_VALUES[0], label: '추천순' },
        { value: JOB_SORT_VALUES[1], label: '최신 등록순' },
        { value: JOB_SORT_VALUES[2], label: '마감 임박순' },
      ])}
    </div>
  </div>;
}

function FilterPanel({ open, onClose, filters, setFilters, jobs, defaults = DEFAULT_FILTERS, inclusiveEmployment = false }) {
  const ref = useDialog(open, onClose, { focusOnOpen: false });
  const reset = () => setFilters((current) => ({ ...defaults, employment: [...defaults.employment], query: current.query, region: current.region }));
  const active = activeFilterCount(filters, defaults);
  if (!open) return null;
  return <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="filter-sheet" ref={ref} role="dialog" aria-modal="true" aria-labelledby="filter-title"><div className="sheet-handle" /><div className="panel-title"><div><span>필요한 조건만 추가</span><h2 id="filter-title">공고 필터</h2></div><button className="icon-button" onClick={onClose} aria-label="필터 닫기"><X /></button></div><FilterFields filters={filters} setFilters={setFilters} jobs={jobs} inclusiveEmployment={inclusiveEmployment} /><details className="filter-discovery-note"><summary>추천·새 공고 분류 기준</summary><p>추천순은 S·A·B·C 등급 안에서 최근 등록 공고부터 보여주고, 기본 30일이 지난 공고는 제외합니다. 새 공고는 서비스 최초 발견 기준이며 실제 등록일과 다를 수 있어요. PA·전담은 업무로 분류하고 주간근무 여부는 별도 확인합니다.</p></details><div className="sheet-actions"><button className="secondary-button" onClick={reset}>조건 초기화</button><button className="primary-button" onClick={onClose}>{active ? `${active}개 조건 적용` : '공고 보기'}</button></div></section></div>;
}

const REGION_SCOPES = [
  { value: '서울', label: '서울만', note: '서울 공고', testId: 'region-seoul' },
  { value: '서울·경기', label: '서울·경기만', note: '기본', testId: 'region-seoul-gyeonggi' },
  { value: '전체', label: '전체 지역 보기', note: '지방 포함', testId: 'region-all' },
];

const JOB_SORT_OPTIONS = [
  { value: JOB_SORT_VALUES[0], label: '추천순', testId: 'sort-work-life' },
  { value: JOB_SORT_VALUES[1], label: '최신순', testId: 'sort-latest' },
  { value: JOB_SORT_VALUES[2], label: '마감순', testId: 'sort-deadline' },
];

function RegionScope({ value, onChange }) {
  return <div className="region-scope" role="group" aria-label="공고 지역 범위">
    {REGION_SCOPES.map((option) => <button type="button" key={option.value} className={value === option.value ? 'active' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)} data-testid={option.testId}><span>{option.label}</span><small>{option.note}</small></button>)}
  </div>;
}

function JobSortControl({ value, onChange }) {
  return <div className="job-sort-control" role="group" aria-label="공고 정렬">
    {JOB_SORT_OPTIONS.map((option) => <button type="button" key={option.value} className={value === option.value ? 'active' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)} data-testid={option.testId}>{option.label}</button>)}
  </div>;
}

const CARE_ROLES = [['all', '모든 관심직무'], ['pa', 'PA·전담'], ['outpatient', '외래'], ['health', '보건·산업간호']];
function MobileQuickFilters({ filters, setFilters, onCareRole }) {
  return <div className="mobile-quick-filters" aria-label="빠른 조건 선택">
    <label className="quick-select"><select aria-label="지역 선택" value={filters.region} onChange={(event) => setFilters((current) => ({ ...current, region: event.target.value }))}>{REGION_SCOPES.map(({ value }) => <option key={value} value={value}>{value === '전체' ? '전국' : value}</option>)}</select><ChevronDown aria-hidden="true" /></label>
    {onCareRole && <label className="quick-select"><select aria-label="직무 선택" value={filters.careRole || 'all'} onChange={(event) => onCareRole(event.target.value)}>{CARE_ROLES.map(([value, label]) => <option key={value} value={value}>{value === 'all' ? '전체 직무' : label}</option>)}</select><ChevronDown aria-hidden="true" /></label>}
  </div>;
}

function DiscoveryPanel({ discovery, mode, onMode, role, onRole }) {
  const firstVisitCountsMatch = discovery?.firstVisit
    && discovery.allCount != null
    && discovery.newCount === discovery.allCount
    && discovery.unseenCount === discovery.allCount;
  return <section className="discovery-panel" aria-label="새 공고 발견">
    <div className="discovery-intro"><span>나의 공고 브리핑</span><h1><span className="desktop-discovery-title">{mode === 'all' ? '등급별 최신 추천 공고' : discovery?.firstVisit ? '처음 만나는 공고부터' : '지난 방문 이후, 달라진 공고'}</span><span className="mobile-discovery-title">{mode === 'all' ? '나에게 맞는 공고' : mode === 'unseen' ? '아직 안 본 공고' : '새로 만나는 공고'}</span></h1><p className={cx(mode === 'all' && 'discovery-description', firstVisitCountsMatch && 'first-visit')}>{mode === 'all' ? <><span className="desktop-discovery-description">기존 S·A·B·C 등급 순서를 유지하고, 같은 등급 안에서는 최근 등록 공고부터 보여드려요. 기본 30일이 지난 공고는 제외합니다.</span><span className="mobile-discovery-description">{firstVisitCountsMatch ? '첫 방문이라 세 탭의 공고 수가 같을 수 있어요. 새 공고는 실제 등록일이 아닌 서비스 최초 발견 시점 기준이에요.' : '좋은 근무조건부터 살펴보세요'}</span></> : discovery?.firstVisit ? '첫 방문에는 아직 안 본 공고를 모아 보여드려요.' : `${formatDate(discovery?.since, { time: true })} 수집분 이후 처음 발견한 공고입니다.`}</p></div>
    <div className="discovery-tabs" role="group" aria-label="공고 확인 범위">{[['all', '전체 추천', 'allCount'], ['new', '새 공고', 'newCount'], ['unseen', '아직 안 본 공고', 'unseenCount']].map(([value, label, count]) => <button key={value} type="button" aria-pressed={mode === value} className={cx(mode === value && 'active')} onClick={() => onMode(value)} data-testid={`discovery-${value}`} aria-label={label}><span className="discovery-tab-label">{label}</span>{value === 'unseen' && <span className="mobile-unseen-label">안 본 공고</span>}<b>{discovery?.[count] ?? '—'}</b></button>)}</div>
    <div className="care-role-tabs" role="group" aria-label="관심 직무">{CARE_ROLES.map(([value, label]) => <button key={value} type="button" aria-pressed={role === value} onClick={() => onRole(value)} aria-label={label}><span className="care-role-label">{label}</span>{value === 'all' && <span className="care-role-mobile-label">전체 직무</span>}</button>)}</div>
    <details className="discovery-note"><summary>새 공고·직무 분류 기준</summary><p>새 공고는 서비스 최초 발견 기준이며 실제 등록일과 다를 수 있어요. PA·전담은 업무로 분류하고 주간근무 여부는 별도 확인합니다.</p></details>
  </section>;
}

function AllJobsView({ jobs, state, loading, error, refreshing, filters, setFilters, onOpen, onToggleSave, onToggleHide, onPrefetch, onRetry, onRefresh, mode = 'recommended', defaults = DEFAULT_FILTERS, pagination, onLoadMore, loadingMore, discoveryQuery, discovery, onDiscoveryMode, onCareRole }) {
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setMobileLayout(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  const [filterOpen, setFilterOpen] = useState(false);
  const [overlookedOpen, setOverlookedOpen] = useState(false);
  const visibleJobs = useMemo(() => jobs.filter((job) => !isJobHidden(state, job)), [jobs, state]);
  const localDiscovery = useMemo(() => {
    const matching = visibleJobs.filter((job) => jobMatchesFilters(job, filters));
    const ranked = sortJobs(matching, filters.sort, state.profile, { tierLatest: filters.sort === '워라벨 우선' && (!discoveryQuery || discoveryQuery.mode === 'all') });
    return filterDiscoveryJobs(ranked, discoveryQuery);
  }, [visibleJobs, filters, state.profile, discoveryQuery]);
  const overlookedCandidates = useMemo(() => {
    if (mode === 'full') return [];
    const applied = new Set(appliedJobIds(state));
    const scoreOf = (job) => Number.isFinite(job?.applicationTierGroupScore)
      ? job.applicationTierGroupScore
      : applicationTierFor(job, state.profile).score;
    return visibleJobs.flatMap((job) => {
      const evidence = hiddenOpportunityFor(job, state.profile);
      const ids = discoveryJobIds(job);
      if (!evidence || ids.some((id) => applied.has(id))) return [];
      return [{ job, evidence }];
    }).sort((a, b) => scoreOf(b.job) - scoreOf(a.job));
  }, [mode, visibleJobs, state.profile, state.applications, state.savedSnapshots]);
  const opportunityEvidenceByKey = useMemo(() => Object.fromEntries(overlookedCandidates.flatMap(({ job, evidence }) =>
    [jobKey(job), job.id, job.dedupeKey].filter(Boolean).map((key) => [key, evidence]))), [overlookedCandidates]);
  const discoveryMeta = discovery || localDiscovery.meta;
  const shown = useMemo(() => pagination ? visibleJobs : localDiscovery.jobs, [visibleJobs, pagination, localDiscovery]);
  const pagingKey = useMemo(() => `${mode}:${JSON.stringify(filters)}:${discoveryQuery?.mode}`, [filters, mode, discoveryQuery?.mode]);
  const active = activeFilterCount(filters, defaults);
  const nationwide = filters.region === '전체';
  const seoulOnly = filters.region === '서울';
  const fullCatalog = mode === 'full';
  const newFirst = !fullCatalog && discoveryQuery?.mode === 'new';
  const workLifeFirst = filters.sort === '워라벨 우선' && !newFirst;
  const JobsListHeading = 'h2';
  const recommendedCopy = nationwide
    ? { title: '전국 간호사 채용 공고', scope: '전국', empty: '검색어나 필터 조건을 줄여보세요.' }
    : seoulOnly
      ? { title: '서울 간호사 채용 공고', scope: '서울', empty: '검색어나 상세 필터를 지우거나 서울·경기로 넓혀보세요.' }
      : { title: '서울·경기 간호사 채용 공고', scope: '서울·경기', empty: '검색어나 상세 필터를 지우거나 전체 지역 보기를 선택해 보세요.' };
  const fullCopy = nationwide
    ? { eyebrow: '고용형태 제한 없이 한 번에', title: '전국 전체 채용 공고', scope: '전국', description: '보건관리자·산업간호사·임상 간호사를 계약직과 기간제까지 빠짐없이 보여드려요.', empty: '검색어나 상세 필터를 지우면 수집된 진행 중 공고를 모두 볼 수 있어요.' }
    : seoulOnly
      ? { eyebrow: '고용형태 제한 없이 한 번에', title: '서울 전체 채용 공고', scope: '서울', description: '서울의 간호 관련 공고를 고용형태와 추천 등급에 관계없이 모아 보여드려요.', empty: '검색어나 상세 필터를 지우거나 지역 범위를 넓혀보세요.' }
      : { eyebrow: '고용형태 제한 없이 한 번에', title: '서울·경기 전체 채용 공고', scope: '서울·경기', description: '서울·경기의 간호 관련 공고를 계약직과 기간제까지 모두 모아 보여드려요.', empty: '검색어나 상세 필터를 지우거나 전체 지역 보기를 선택해 보세요.' };
  const regionCopy = fullCatalog ? fullCopy : recommendedCopy;
  const overlookedPanel = !fullCatalog && !loading && <section className="content-panel overlooked-panel" aria-labelledby="overlooked-title" data-testid="overlooked-opportunities" data-expanded={overlookedOpen}>
      <div className="section-title list-title"><div><span>추천 목록에서 다시 찾았어요</span><h2 id="overlooked-title">놓치기 아까운 후보</h2></div><b className="result-count" role="status" aria-live="polite">{overlookedCandidates.length}건</b><button type="button" className="overlooked-toggle" aria-label={`놓치기 아까운 후보 ${overlookedOpen ? '접기' : '펼치기'}`} aria-expanded={overlookedOpen} aria-controls="overlooked-content" onClick={() => setOverlookedOpen((current) => !current)}><ChevronDown aria-hidden="true" /></button></div>
      <div className="overlooked-content" id="overlooked-content" hidden={!overlookedOpen}>{overlookedOpen && (overlookedCandidates.length > 0
        ? <JobList jobs={overlookedCandidates.map(({ job }) => job)} profile={state.profile} state={state} loading={false} onOpen={onOpen} onToggleSave={onToggleSave} onToggleHide={onToggleHide} onPrefetch={onPrefetch} pagingKey={`overlooked:${pagingKey}`} opportunityEvidenceByKey={opportunityEvidenceByKey} />
        : <p className="overlooked-empty" role="status">현재 불러온 추천 공고에서는 근거가 확인된 B·C 후보가 없습니다. 추천 목록을 더 불러오면 후보도 자동으로 추가됩니다.</p>)}</div>
    </section>;
  return <div className={cx('jobs-explorer', fullCatalog && 'full-catalog')}>
    {!fullCatalog && <DiscoveryPanel discovery={discoveryMeta} mode={discoveryQuery?.mode || 'new'} onMode={onDiscoveryMode} role={filters.careRole || 'all'} onRole={onCareRole} />}
    {fullCatalog
      ? <section className="jobs-focus-hero full-catalog-hero" aria-labelledby="jobs-page-title"><div className="jobs-focus-copy"><span>{regionCopy.eyebrow}</span><h1 id="jobs-page-title">{regionCopy.title}</h1><p>{regionCopy.description}</p></div><RegionScope value={filters.region} onChange={(region) => setFilters((current) => ({ ...current, region }))} /></section>
      : <section className="recommended-scope-row" aria-label="추천 공고 지역 선택"><RegionScope value={filters.region} onChange={(region) => setFilters((current) => ({ ...current, region }))} /></section>}
    <section className="search-row" aria-label="공고 검색"><div className="search-control"><Search /><input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="병원·회사·부서·직무 검색" aria-label="공고 검색어" />{filters.query && <button onClick={() => setFilters((current) => ({ ...current, query: '' }))} aria-label="검색어 지우기"><X /></button>}</div><button className="mobile-filter-button" onClick={() => setFilterOpen(true)} aria-label={`공고 필터 열기${active ? `, ${active}개 적용 중` : ''}`}><Filter /><span>필터</span>{active > 0 && <b>{active}</b>}</button><button className="refresh-button" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? '새 공고 확인 중' : '새 공고 확인'}><RefreshCw className={refreshing ? 'spin' : ''} /><span>{refreshing ? '확인 중' : '새 공고 확인'}</span></button></section>
    <MobileQuickFilters filters={filters} setFilters={setFilters} onCareRole={fullCatalog ? undefined : onCareRole} />
    <FilterPanel open={filterOpen} onClose={() => setFilterOpen(false)} filters={filters} setFilters={setFilters} jobs={visibleJobs} defaults={defaults} inclusiveEmployment={fullCatalog} />
    {!mobileLayout && overlookedPanel}
    <section className={cx('content-panel jobs-panel', !fullCatalog && 'recommended-jobs-panel')} data-testid="all-jobs-list"><div className="section-title list-title"><div><span>{regionCopy.scope} · {fullCatalog ? '모든 고용형태' : '진행 중인 공고'}</span><JobsListHeading>{fullCatalog ? '전체 공고' : newFirst ? discoveryMeta?.firstVisit ? '아직 확인하지 않은 공고' : '새로 발견한 공고' : discoveryQuery?.mode === 'unseen' ? '아직 안 본 공고' : '추천순 공고'}</JobsListHeading><p>{fullCatalog ? '추천 등급과 고용형태로 숨기지 않고, 진행 중인 공고를 최신 등록순으로 이어서 보여드립니다.' : newFirst ? '새로 발견한 공고만 모아 보여드립니다. 이전 공고까지 보려면 전체 추천을 선택하세요.' : workLifeFirst ? 'S·A·B·C 등급 순서는 유지하고, 같은 등급 안에서는 최근 등록 공고부터 보여드립니다.' : '제목을 누르면 자격요건, 근무조건과 지원 링크를 바로 확인할 수 있습니다.'}</p></div><div className="list-title-actions">{!newFirst && <JobSortControl value={filters.sort} onChange={(sort) => setFilters((current) => ({ ...current, sort }))} />}<b className="result-count" role="status" aria-live="polite">{pagination?.total ?? shown.length}건</b><button type="button" className="mobile-refresh-button" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? '새 공고 확인 중' : '새 공고 확인'} title="새 공고 확인"><RefreshCw className={refreshing ? 'spin' : ''} /></button></div></div><JobList pagination={pagination} onLoadMore={onLoadMore} loadingMore={loadingMore} jobs={shown} profile={state.profile} state={state} loading={loading} error={error} onOpen={onOpen} onToggleSave={onToggleSave} onToggleHide={onToggleHide} onPrefetch={onPrefetch} onRetry={onRetry} groupApplicationTiers={!fullCatalog && (workLifeFirst || newFirst || discoveryQuery?.mode === 'unseen')} showTierCollapseAll={!fullCatalog && (workLifeFirst || newFirst || discoveryQuery?.mode === 'unseen')} pagingKey={pagingKey} emptyCopy={newFirst ? { title: '새로 발견한 공고가 없어요', message: '현재 조건에서 새로 발견한 공고가 없습니다. 기존 공고를 새 공고처럼 반복하지 않아요.', actionLabel: '아직 안 본 공고 보기', onAction: () => onDiscoveryMode('unseen') } : { title: `${regionCopy.title}가 없습니다`, message: regionCopy.empty }} /></section>
    {mobileLayout && overlookedPanel}
  </div>;
}

function resolveSnapshotJobs(jobs, snapshots) {
  const current = new Map(jobs.flatMap((job) => [[job.id, job], [job.dedupeKey, job], [jobKey(job), job]].filter(([key]) => key)));
  return snapshots.map((snapshot) => current.get(snapshot.dedupeKey) || current.get(snapshot.id) || { ...snapshot, id: snapshot.id || snapshot.jobKey });
}

function SavedView({ jobs, state, loading, onOpen, onToggleSave, onToggleHide, onPrefetch, onNavigate }) {
  // 저장 목록은 마감 임박순 — 상시채용·마감 지남은 아래로
  const snapshots = resolveSnapshotJobs(jobs, Object.values(state.savedSnapshots).filter((snapshot) => !isJobHidden(state, snapshot)))
    .slice()
    .sort((left, right) => {
      const rank = (job) => { const days = deadlineInfo(job).days; return days == null ? 2 : days < 0 ? 3 : 1; };
      return rank(left) - rank(right) || (deadlineInfo(left).days ?? 0) - (deadlineInfo(right).days ?? 0);
    });
  return <section className="content-panel saved-panel"><div className="section-title"><div><span>관심 공고 모아보기</span><h1>저장한 공고</h1><p>관심 있는 공고를 저장해 두고 마감일과 상세 조건을 다시 확인할 수 있어요.</p></div><b>{snapshots.length}건</b></div><JobList jobs={snapshots} profile={state.profile} state={state} loading={loading && !snapshots.length} onOpen={onOpen} onToggleSave={onToggleSave} onToggleHide={onToggleHide} onPrefetch={onPrefetch} savedMode pagingKey="saved" emptyCopy={{ title: '저장한 공고가 없어요', message: '관심 있는 공고의 별표를 눌러 모아보세요.', actionLabel: '채용 공고 보기', onAction: () => onNavigate('all') }} /></section>;
}

function HiddenView({ jobs, state, loading, onOpen, onToggleSave, onToggleHide, onPrefetch, onNavigate }) {
  const snapshots = resolveSnapshotJobs(jobs, Object.values(state.hiddenSnapshots || {}).sort((left, right) => new Date(right.hiddenAt || right.snapshotUpdatedAt || 0) - new Date(left.hiddenAt || left.snapshotUpdatedAt || 0)));
  return <section className="content-panel hidden-panel"><div className="section-title"><div><button type="button" className="text-button hidden-back-button" onClick={() => onNavigate('all')} data-testid="hidden-back"><ArrowLeft aria-hidden="true" />추천 공고로 돌아가기</button><span>다시 보고 싶을 때</span><h1>숨긴 공고</h1><p>목록에서 숨긴 공고만 모았습니다. 눈 아이콘을 누르면 다시 표시됩니다.</p></div><b>{snapshots.length}건</b></div><div className="hidden-panel-note"><EyeOff aria-hidden="true" /><span><strong>숨긴 공고는 추천·전체·저장 목록에서 보이지 않습니다.</strong><small>여기서 공고를 확인하거나 눈 아이콘으로 언제든 숨김을 해제할 수 있어요.</small></span></div><JobList jobs={snapshots} profile={state.profile} state={state} loading={loading && !snapshots.length} onOpen={onOpen} onToggleSave={onToggleSave} onToggleHide={onToggleHide} onPrefetch={onPrefetch} hiddenMode emptyCopy={{ title: '숨긴 공고가 없어요', message: '보고 싶지 않은 공고에서 눈 모양 아이콘을 누르면 여기에 모입니다.', actionLabel: '공고 보러 가기', onAction: () => onNavigate('all') }} /></section>;
}

function SavedSyncPanel({ open, connected, pairingCode, pairingExpiresAt, status, savedCount, onClose, onCreatePairing, onRedeemPairing, onDisconnect, onSyncNow }) {
  const ref = useDialog(open, onClose, { focusOnOpen: false });
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft('');
    setCopied(false);
  }, [open, connected, pairingCode]);
  if (!open) return null;

  const busy = status.phase === 'syncing';
  const submit = async (event) => {
    event.preventDefault();
    const normalized = normalizePairingCode(draft);
    if (!isValidPairingCode(normalized)) return;
    await onRedeemPairing(normalized);
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(formatPairingCode(pairingCode));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return <div className="panel-backdrop saved-sync-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="side-panel saved-sync-panel" ref={ref} role="dialog" aria-modal="true" aria-labelledby="saved-sync-title" data-testid="saved-sync-panel">
      <div className="panel-title"><div><span>휴대폰 · 컴퓨터</span><h2 id="saved-sync-title">스크랩 동기화</h2></div><button className="icon-button" onClick={onClose} aria-label="스크랩 동기화 닫기"><X /></button></div>
      <div className="saved-sync-intro"><span className={cx('saved-sync-cloud', connected && 'connected')}>{connected ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}</span><div><b>{connected ? '이 기기는 계속 연결돼요' : '4자리로 한 번만 연결해요'}</b><p>{connected ? `저장 공고 ${savedCount}개를 자동으로 맞춥니다. 앱을 다시 열어도 연결이 유지됩니다.` : '스크랩이 있는 휴대폰에서 코드를 만들고, 컴퓨터에는 숫자 4자리만 입력하세요.'}</p></div></div>
      {connected ? <>
        {pairingCode ? <section className="saved-sync-code-card" aria-label="일회용 4자리 연결 코드"><span>다른 기기에 입력할 코드</span><div><code>{formatPairingCode(pairingCode)}</code><span className="saved-sync-code-actions"><button type="button" onClick={copyCode}><Copy aria-hidden="true" />{copied ? '복사됨' : '복사'}</button><button type="button" onClick={onCreatePairing} disabled={busy}><RefreshCw aria-hidden="true" />새 코드</button></span></div><small>{pairingExpiresAt ? `${formatDate(pairingExpiresAt, { time: true })}까지` : '10분 동안'} 한 번만 사용할 수 있습니다. 연결 후에는 다시 입력할 필요가 없습니다.</small></section> : <button type="button" className="primary-button saved-sync-create" onClick={onCreatePairing} disabled={busy}>{busy ? <RefreshCw className="spin" /> : <Cloud />}다른 기기 연결 코드 만들기</button>}
        <div className={cx('saved-sync-state', status.phase)} role="status"><span /> <b>{busy ? '스크랩을 맞추고 있어요' : status.phase === 'error' ? '지금은 서버에 연결하지 못했어요' : '자동 동기화 중'}</b><p>{status.phase === 'error' ? status.error : '저장하거나 삭제하면 바로 반영되고, 앱을 열 때도 새 내용을 확인합니다.'}</p></div>
        <div className="saved-sync-actions"><button type="button" className="secondary-button" onClick={onSyncNow} disabled={busy}><RefreshCw className={busy ? 'spin' : ''} />지금 동기화</button><button type="button" className="saved-sync-disconnect" onClick={onDisconnect} disabled={busy}>이 기기 연결 해제</button></div>
      </> : <>
        <button type="button" className="primary-button saved-sync-create" onClick={onCreatePairing} disabled={busy}>{busy ? <RefreshCw className="spin" /> : <Cloud />}이 기기에서 동기화 시작</button>
        <div className="saved-sync-divider"><span>다른 기기의 코드가 있다면</span></div>
        <form className="saved-sync-form" onSubmit={submit}><label htmlFor="saved-sync-code">4자리 연결 코드</label><div><input id="saved-sync-code" value={draft} onChange={(event) => setDraft(formatPairingCode(event.target.value))} placeholder="0000" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength="4" /><button type="submit" className="secondary-button" disabled={busy || !isValidPairingCode(draft)}>연결</button></div></form>
        {status.phase === 'error' && <p className="saved-sync-error" role="alert">{status.error}</p>}
        <p className="saved-sync-footnote">처음 연결할 때 양쪽 기기의 기존 스크랩을 합칩니다. 4자리 코드는 한 번만 쓰고, 이후에는 이 기기에서 자동으로 연결됩니다.</p>
      </>}
    </aside>
  </div>;
}

const FEEDBACK_OPTIONS = [
  { id: 'bug', label: '사용이 불편해요', short: '불편' },
  { id: 'data', label: '공고 정보가 달라요', short: '정보' },
  { id: 'idea', label: '이 기능이 필요해요', short: '제안' },
  { id: 'other', label: '그 밖의 의견', short: '기타' },
];

function FeedbackPanel({ open, onClose, view, job }) {
  const ref = useDialog(open, onClose, { focusOnOpen: false });
  const [category, setCategory] = useState('bug');
  const [message, setMessage] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [website, setWebsite] = useState('');
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);

  const reset = useCallback(() => {
    setCategory('bug');
    setMessage('');
    setIncludeContext(true);
    setWebsite('');
    setPhase('idle');
    setError('');
    setReceipt(null);
  }, []);
  useEffect(() => { if (open) reset(); }, [open, reset]);
  if (!open) return null;

  const selectedOption = FEEDBACK_OPTIONS.find((option) => option.id === category) || FEEDBACK_OPTIONS[0];
  const submit = async (event) => {
    event.preventDefault();
    const cleaned = message.trim();
    if (cleaned.length < 4 || phase === 'submitting') return;
    setPhase('submitting');
    setError('');
    try {
      const result = await submitFeedback({
        category,
        message: cleaned,
        website,
        ...(includeContext ? {
          context: {
            pagePath: window.location.pathname,
            viewport: window.innerWidth <= 760 ? 'mobile' : window.innerWidth <= 1024 ? 'tablet' : 'desktop',
            view,
            ...(job?.id ? { jobId: String(job.id) } : {}),
            ...(job?.source ? { jobSource: job.source } : {}),
          },
        } : {}),
      });
      setReceipt(result);
      setPhase('success');
    } catch (submitError) {
      setError(submitError.message || '피드백을 저장하지 못했습니다.');
      setPhase('error');
    }
  };

  return <div className="panel-backdrop feedback-backdrop" onMouseDown={(event) => event.target === event.currentTarget && phase !== 'submitting' && onClose()}>
    <aside className="side-panel feedback-panel" ref={ref} role="dialog" aria-modal="true" aria-labelledby="feedback-title" data-testid="feedback-panel">
      <div className="panel-title"><div><span>PRODUCT NOTE</span><h2 id="feedback-title">피드백 남기기</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={phase === 'submitting'} aria-label="피드백 닫기"><X /></button></div>
      {phase === 'success' ? <div className="feedback-success" role="status">
        <span><Check aria-hidden="true" /></span>
        <p>잘 접수됐어요</p>
        <h3>남겨주신 내용을 확인하고<br />다음 수정에 반영할게요.</h3>
        <div><small>{selectedOption.short}</small><p>{message}</p></div>
        <code>NOTE · {String(receipt?.id || '').slice(0, 8).toUpperCase()}</code>
        <div className="feedback-success-actions"><button type="button" className="secondary-button" onClick={reset}>하나 더 남기기</button><button type="button" className="primary-button" onClick={onClose}>닫기</button></div>
      </div> : <>
        <div className="feedback-intro"><span><MessageSquareText aria-hidden="true" /></span><div><b>써보면서 걸린 점을 편하게 적어주세요.</b><p>오류, 공고 정보 차이, 있었으면 하는 기능 모두 좋습니다. 이름이나 연락처는 받지 않아요.</p></div></div>
        <form className="feedback-form" onSubmit={submit}>
          <fieldset><legend>어떤 이야기인가요?</legend><div className="feedback-options">{FEEDBACK_OPTIONS.map((option) => <button type="button" key={option.id} className={category === option.id ? 'selected' : ''} aria-pressed={category === option.id} onClick={() => setCategory(option.id)}><span>{option.short}</span><b>{option.label}</b>{category === option.id && <Check aria-hidden="true" />}</button>)}</div></fieldset>
          <label className="feedback-message" htmlFor="feedback-message"><span>내용</span><textarea id="feedback-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={FEEDBACK_MESSAGE_MAX_LENGTH} rows="7" placeholder="어느 화면에서 무엇이 불편했는지 적어주시면 더 빨리 고칠 수 있어요." /><small className={message.length >= FEEDBACK_MESSAGE_MAX_LENGTH ? 'limit' : ''}>{message.length.toLocaleString('ko-KR')} / {FEEDBACK_MESSAGE_MAX_LENGTH.toLocaleString('ko-KR')}</small></label>
          <label className="feedback-context"><input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)} /><span><b>현재 화면 정보 함께 보내기</b><small>화면 경로와 기기 크기만 보내며, 저장 공고나 개인정보는 포함하지 않습니다.</small></span></label>
          <label className="feedback-honeypot" aria-hidden="true">웹사이트<input value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex="-1" autoComplete="off" /></label>
          {error && <p className="feedback-error" role="alert"><CircleAlert aria-hidden="true" />{error}</p>}
          <div className="feedback-actions"><small>보낸 내용은 비공개로 보관됩니다.</small><button type="submit" className="primary-button" disabled={phase === 'submitting' || message.trim().length < 4}>{phase === 'submitting' ? <><RefreshCw className="spin" />보내는 중</> : <>피드백 보내기<ArrowUpRight /></>}</button></div>
        </form>
      </>}
    </aside>
  </div>;
}

function CompanyReputationCard({ company, autoLookup = true }) {
  const links = useMemo(() => companyReputationLinks(company), [company]);
  const [record, setRecord] = useState(null);
  const [result, setResult] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [bridgeUnavailable, setBridgeUnavailable] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    const cached = findCompanyReputation(readCompanyReputationCache(), company);
    setRecord(cached);
    setResult(null);
    setPhase('idle');
    setError('');
    setBridgeUnavailable(false);
    let timer;
    const checkedAt = Date.parse(cached?.checkedAt || '');
    const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < COMPANY_REPUTATION_AUTO_REFRESH_MS;
    if (autoLookup && company && links.length && !fresh) timer = setTimeout(() => runLookup(), 600);
    return () => {
      clearTimeout(timer);
      requestRef.current += 1;
    };
  }, [autoLookup, company]);

  if (!company || !links.length) return null;

  const remember = (sources) => {
    const stored = rememberCompanyReputation(globalThis.localStorage, company, sources);
    if (stored) setRecord(stored);
  };
  const mergeSources = (current = [], incoming = []) => [...new Map([...current, ...incoming].map((source) => [source.id, source])).values()];
  const runLookup = async (selection) => {
    const requestId = ++requestRef.current;
    setPhase('loading');
    setError('');
    setBridgeUnavailable(false);
    try {
      const response = await requestCompanyReputation(company, { selection });
      if (requestId !== requestRef.current) return;
      const confirmed = response.sources.filter((source) => source.status === 'ok');
      if (confirmed.length) remember(confirmed);
      setResult((current) => selection ? {
        ...current,
        ...response,
        sources: mergeSources((current?.sources || []).filter((source) => source.id !== selection.sourceId), response.sources),
        candidates: (current?.candidates || []).filter((candidate) => candidate.id !== selection.sourceId),
      } : response);
      if (!response.ok && !response.candidates.length && response.error) setError(response.error);
    } catch (lookupError) {
      if (requestId === requestRef.current) {
        if (lookupError?.code === 'BRIDGE_UNAVAILABLE') setBridgeUnavailable(true);
        else setError(lookupError.message || '회사 평가를 확인하지 못했습니다.');
      }
    } finally {
      if (requestId === requestRef.current) setPhase('idle');
    }
  };
  const confirmCandidate = (candidate) => {
    if (Number.isFinite(candidate.rating) && Number.isInteger(candidate.reviewCount)) {
      remember([candidate]);
      setResult((current) => ({
        ...current,
        ok: true,
        sources: mergeSources((current?.sources || []).filter((source) => source.id !== candidate.id), [{ ...candidate, status: 'ok' }]),
        candidates: (current?.candidates || []).filter((item) => item.id !== candidate.id),
      }));
      return;
    }
    runLookup({ sourceId: candidate.id, url: candidate.url, companyName: candidate.companyName });
  };
  const rejectCandidate = (candidate) => {
    const link = links.find((item) => item.id === candidate.id);
    setResult((current) => ({
      ...current,
      sources: mergeSources(current?.sources || [], link ? [{ ...link, status: 'unavailable', message: '회사명이 일치하지 않아 직접 확인이 필요합니다.' }] : []),
      candidates: (current?.candidates || []).filter((item) => item.url !== candidate.url),
    }));
  };

  const currentSources = mergeSources((record?.sources || []).map((source) => ({ ...source, status: 'ok' })), (result?.sources || []).filter((source) => source.status === 'ok'));
  const rowSources = (record || result) ? links.map((link) => {
    const confirmed = currentSources.find((source) => source.id === link.id);
    const unavailable = result?.sources?.find((source) => source.id === link.id && source.status !== 'ok');
    return confirmed || unavailable || { ...link, status: 'unavailable', message: '아직 확인된 집계가 없습니다.' };
  }) : [];
  const checkedAt = currentSources.map((source) => source.checkedAt).filter(Boolean).sort().at(-1) || record?.checkedAt;
  const candidates = result?.candidates || [];

  return <section className="company-reputation-card" aria-labelledby="company-reputation-title" data-testid="company-reputation">
    <header className="company-reputation-head">
      <span className="company-reputation-icon"><MessageSquareText aria-hidden="true" /></span>
      <div><span>회사 분위기 참고</span><h3 id="company-reputation-title">직원 평가</h3><p>{company}의 평점과 리뷰 수만 확인합니다.</p></div>
      <button type="button" className="company-reputation-check" onClick={() => runLookup()} disabled={phase === 'loading'}>{phase === 'loading' ? <><RefreshCw className="spin" aria-hidden="true" />확인 중</> : <><RefreshCw aria-hidden="true" />{error ? '다시 확인' : bridgeUnavailable ? '평가 확인' : '새로 확인'}</>}</button>
    </header>

    {rowSources.length > 0 && <div className="company-reputation-sources" aria-live="polite">{rowSources.map((source) => <article className={cx('company-reputation-source', source.status === 'ok' && 'available')} key={source.id}>
      <div className="company-reputation-source-name"><span>{source.id === 'jobplanet' ? 'JP' : 'BL'}</span><b>{source.name}</b></div>
      {source.status === 'ok' ? <div className="company-reputation-score"><strong>{source.rating.toFixed(1)}</strong><span><b><Star fill="currentColor" aria-hidden="true" />5점 만점</b><small>리뷰 {source.reviewCount.toLocaleString('ko-KR')}개</small></span></div> : <p>{source.message || '사이트에서 직접 확인해 주세요.'}</p>}
      <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`${source.name}에서 ${company} 평가 보기`}>{source.status === 'ok' ? '출처' : '직접 확인'}<ExternalLink aria-hidden="true" /></a>
    </article>)}</div>}

    {candidates.length > 0 && <div className="company-reputation-candidates" role="status"><div><CircleAlert aria-hidden="true" /><span><b>같은 회사가 맞는지 확인해 주세요</b><p>이름이 비슷한 회사는 확인 전까지 저장하지 않습니다.</p></span></div>{candidates.map((candidate) => <div className="company-reputation-candidate" key={`${candidate.id}:${candidate.url}`}><span><small>{candidate.name}에서 찾음</small><b>{candidate.companyName || '회사명 확인 필요'}</b>{Number.isFinite(candidate.rating) && <em>{candidate.rating.toFixed(1)}점 · 리뷰 {candidate.reviewCount.toLocaleString('ko-KR')}개</em>}</span><div><button type="button" onClick={() => rejectCandidate(candidate)}>아니에요</button><button type="button" onClick={() => confirmCandidate(candidate)} disabled={phase === 'loading'}>이 회사가 맞아요</button></div></div>)}</div>}

    {error && <div className="company-reputation-error" role="alert"><CircleAlert aria-hidden="true" /><span><b>자동 확인을 마치지 못했어요</b><p>{error}</p></span></div>}
    {!record && !result && <div className="company-reputation-empty"><p>{error ? '자동 확인이 안 되면 각 사이트에서 바로 확인할 수 있어요.' : bridgeUnavailable ? '현재 브라우저에서는 아래 공개 페이지에서 직접 확인할 수 있어요.' : phase === 'loading' ? '공개 평점을 확인하고 있어요. 리뷰 내용은 표시하거나 저장하지 않습니다.' : !autoLookup ? '공고 세부정보를 먼저 확인한 뒤 직원 평가를 불러옵니다.' : '공개 평점을 곧 확인합니다. 리뷰 내용은 표시하거나 저장하지 않습니다.'}</p><div>{links.map((link) => <a href={link.url} target="_blank" rel="noopener noreferrer" key={link.id}>{link.name}<ExternalLink aria-hidden="true" /></a>)}</div></div>}
    {checkedAt && <footer><span>평점 확인 기준</span><time dateTime={checkedAt}>{formatDate(checkedAt, { time: true })}</time></footer>}
  </section>;
}

function ApplicationTierSummary({ job, profile }) {
  const assessment = applicationTierFor(job, profile);
  return <section className={cx('application-tier-summary', `tier-${assessment.tier}`)} aria-labelledby="application-tier-title" data-testid="application-tier-summary">
    <header><span className="application-tier-grade">{assessment.grade}</span><div><small>지원 우선순위</small><h3 id="application-tier-title">{assessment.label}</h3><p>공고 매력도 <b>{assessment.score}점</b> · {assessment.eligibility.label}</p></div></header>
  </section>;
}

function JobDetail({ job, open, state, detail, detailLoading, routeLoading = false, routeError = '', onClose, onRetry, onRouteRetry, onToggleSave, onToggleHide, onShare }) {
  const ref = useDialog(open, onClose);
  const [activeTab, setActiveTab] = useState('summary');
  const [detailSlow, setDetailSlow] = useState(false);
  useEffect(() => { setActiveTab('summary'); }, [job, open]);
  useEffect(() => { if (open) ref.current?.scrollTo({ top: 0, behavior: 'auto' }); }, [job?.id, job?.jobKey, open]);
  useEffect(() => {
    setDetailSlow(false);
    if (!open || (!detailLoading && !routeLoading)) return undefined;
    const timer = window.setTimeout(() => setDetailSlow(true), 4_000);
    return () => window.clearTimeout(timer);
  }, [detailLoading, routeLoading, job?.id, job?.jobKey, open]);
  if (!open) return null;

  if (!job) {
    return <div className="detail-backdrop">
      <section className="detail-sheet posting-sheet" ref={ref} role="dialog" aria-modal="true" aria-labelledby="route-detail-title" data-testid="job-detail-route-state">
        <div className="detail-page-topbar posting-topbar"><span>공고 상세</span><button className="detail-close" onClick={onClose} aria-label="상세 닫기"><X /><span>목록으로</span></button></div>
        <div className="posting-route-state">
          {routeLoading ? <>
            <section className={cx('posting-overview-loading', detailSlow && 'slow')} role="status" aria-live="polite" data-testid="route-detail-progress">
              {detailSlow ? <Clock3 aria-hidden="true" /> : <RefreshCw className="spin" aria-hidden="true" />}
              <div><span>공고 상세 연결 중</span><h2 id="route-detail-title">{detailSlow ? '서버 응답을 기다리고 있어요' : '공고 정보를 준비하고 있어요'}</h2><p>{detailSlow ? '연결은 계속 진행 중입니다. 잠시만 더 기다려 주세요.' : '해당 공고를 찾은 뒤 제목과 기본 정보를 먼저 보여드릴게요.'}</p></div>
            </section>
            <ol className="posting-route-steps" aria-label="공고 상세 불러오기 단계">
              <li className="active"><span>1</span><div><b>공고 목록 연결</b><small>서버에서 최신 공고를 받고 있어요</small></div></li>
              <li><span>2</span><div><b>해당 공고 찾기</b><small>주소의 공고 번호를 확인해요</small></div></li>
              <li><span>3</span><div><b>원문 세부정보 확인</b><small>기본 정보부터 먼저 표시해요</small></div></li>
            </ol>
          </> : <section className="posting-route-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <div><span>공고 상세</span><h2 id="route-detail-title">공고를 찾지 못했어요</h2><p>{routeError || '수집 목록에서 이 공고가 보이지 않습니다. 잠시 후 다시 확인해 주세요.'}</p>{onRouteRetry && <button type="button" onClick={onRouteRetry}>다시 불러오기</button>}</div>
          </section>}
        </div>
      </section>
    </div>;
  }

  const saved = isJobSaved(state, job);
  const hidden = isJobHidden(state, job);
  const deadline = deadlineInfo(job);
  const experience = experienceDisplay(job, detail || {});
  const rawDescription = firstKnown(detail?.description, job.description);
  const descriptionKind = detail?.descriptionKind || job.descriptionKind || '';
  const originalText = ['content', 'jobPosting'].includes(descriptionKind) ? rawDescription : '';
  const officialSourceUrl = typeof detail?.officialSourceUrl === 'string' && /^https:\/\//iu.test(detail.officialSourceUrl) ? detail.officialSourceUrl : '';
  const sourceImages = Array.isArray(detail?.sourceImages)
    ? [...new Set(detail.sourceImages.filter((url) => typeof url === 'string' && /^https:\/\//iu.test(url)))].slice(0, 12)
    : [];
  const renderedSourceImage = (url) => {
    if (!String(job.id || '').startsWith('saramin-')) return url;
    try {
      const recIdx = new URL(job.url).searchParams.get('rec_idx');
      if (!/^\d{1,12}$/u.test(recIdx || '')) return url;
      const proxy = new URL('/api/saramin-image', window.location.origin);
      proxy.searchParams.set('rec_idx', recIdx);
      proxy.searchParams.set('url', url);
      return proxy.href;
    } catch { return url; }
  };
  const attachments = Array.isArray(detail?.attachments)
    ? detail.attachments.filter((attachment) => attachment?.name && typeof attachment?.url === 'string' && /^https:\/\//iu.test(attachment.url)).slice(0, 8)
    : [];
  const originalAvailable = Boolean(originalText || sourceImages.length);
  const apiDetailSections = normalizeDetailSections(detail?.sections);
  const parsedDetailSections = parseOrderedDetailSections(rawDescription);
  const sourceDetailSections = apiDetailSections.length ? apiDetailSections : parsedDetailSections;
  const hasVerifiedSourceSections = detail?.detailVerified === true && apiDetailSections.length > 0;
  const jobNarrativeFallback = (value) => hasVerifiedSourceSections ? '' : value;
  const parsedDescription = detailSectionValues(sourceDetailSections);
  const extractedFacts = extractDetailFacts(rawDescription || sourceDetailSections.map(({ value }) => value).join('\n'));
  const titleFacts = extractTitleFacts(job.title);
  const info = {
    location: firstKnown(detail?.location, extractedFacts.location, job.location),
    employment: firstKnown(titleFacts.employment, detail?.employment, job.employmentType, job.employment, extractedFacts.employment),
    education: firstKnown(detail?.education, job.education),
    salary: firstKnown(extractedFacts.salary, detail?.salary, job.salary),
    workHours: firstKnown(detail?.workHours, extractedFacts.workHours, titleFacts.workHours, job.workHours),
    duties: firstKnown(parsedDescription.duties, detail?.duties, jobNarrativeFallback(job.duties)),
    qualifications: firstKnown(parsedDescription.qualifications, detail?.qualifications, jobNarrativeFallback(job.qualifications)),
    preferredQualifications: firstKnown(parsedDescription.preferredQualifications, detail?.preferredQualifications, jobNarrativeFallback(job.preferredQualifications)),
    workConditions: firstKnown(parsedDescription.workConditions, detail?.workConditions, jobNarrativeFallback(job.workConditions)),
    recruitmentProcess: firstKnown(parsedDescription.recruitmentProcess, detail?.recruitmentProcess, jobNarrativeFallback(job.recruitmentProcess)),
    applicationMethod: firstKnown(parsedDescription.applicationMethod, detail?.applicationMethod, jobNarrativeFallback(job.applicationMethod)),
    otherInformation: firstKnown(parsedDescription.otherInformation, detail?.otherInformation, jobNarrativeFallback(job.otherInformation)),
    deadlineText: firstKnown(parsedDescription.deadlineText, detail?.deadlineText, jobNarrativeFallback(job.deadlineText)),
    headcount: firstKnown(detail?.headcount, extractedFacts.headcount, jobNarrativeFallback(job.headcount)),
    subway: firstKnown(detail?.subway, job.subway),
    welfare: detailItems(parsedDescription.benefits || detail?.welfare || jobNarrativeFallback(job.welfare))
      .filter((item) => cleanUnknown(item) !== '원문 확인' && !/^(?:마감일 및 지원방법|마감일|지원방법|\d{4}[.-]\d{1,2}[.-]\d{1,2})$/u.test(item.trim())),
  };
  const trackedJob = {
    ...job,
    experience: detail?.experience || job.experience,
    experienceDomain: experience.domain,
    experienceEvidence: experience.evidence,
    education: info.education || job.education,
    employment: info.employment || job.employment,
    salary: info.salary || job.salary,
    workHours: info.workHours || job.workHours,
    workPattern: detail?.workPattern || job.workPattern,
    workConditions: info.workConditions || job.workConditions,
    location: info.location || job.location,
    duties: info.duties || job.duties,
    qualifications: info.qualifications || job.qualifications,
    preferredQualifications: info.preferredQualifications || job.preferredQualifications,
    description: rawDescription || job.description,
    detailCheckedAt: detail?.detailCheckedAt || job.detailCheckedAt,
    detailVerified: detail?.detailVerified || job.detailVerified,
    officialSourceUrl: officialSourceUrl || job.officialSourceUrl,
    sourceImages,
    attachments,
  };
  const alternates = [{ source: officialSourceUrl ? '공식 채용 페이지' : job.source, url: officialSourceUrl || job.url }, ...(officialSourceUrl ? [{ source: job.source, url: job.url }] : []), ...(job.alternateSources || [])]
    .filter((item, index, array) => item?.url && array.findIndex((candidate) => candidate.url === item.url) === index);
  const publishedLabel = formatPostedLabel(job.publishedAt || job.postedAt, { full: true });
  const region = firstKnown(info.location, job.region, job.location);
  const detailFacetJob = { ...trackedJob, title: [job.title, info.duties, info.workConditions, info.workHours].filter(Boolean).join(' ') };
  const explicitDepartment = firstKnown(detail?.department, job.department);
  const preciseDepartment = explicitDepartment && !DEPARTMENT_OPTIONS.includes(explicitDepartment) ? explicitDepartment : '';
  const department = firstKnown(preciseDepartment, departmentFor({ title: job.title }), explicitDepartment, departmentFor(detailFacetJob));
  const explicitWorkPattern = firstKnown(detail?.workPattern, job.workPattern);
  const preciseWorkPattern = explicitWorkPattern && !WORK_PATTERN_OPTIONS.includes(explicitWorkPattern) ? explicitWorkPattern : '';
  const workPattern = firstKnown(preciseWorkPattern, workPatternFor(detailFacetJob));
  const awaitingVerifiedDetail = detailLoading && detail?.detailVerified !== true;
  const criticalValue = (value) => {
    const cleaned = cleanUnknown(value);
    return cleaned === '원문 확인' ? '공고에서 확인 필요' : cleaned;
  };
  const summaryFacts = [
    { label: '근무 부서', value: criticalValue(department) },
    { label: '근무 형태', value: criticalValue(workPattern) },
    { label: '근무지', value: criticalValue(region) },
    { label: '근무 시간', value: criticalValue(info.workHours) },
    { label: '급여', value: criticalValue(info.salary) },
    { label: '경력', value: experience.value },
    { label: '고용 형태', value: criticalValue(info.employment) },
    { label: '마감', value: criticalValue(info.deadlineText || (deadline.status === 'unknown' ? '' : deadline.label)) },
  ];
  const workDetails = [
    info.workConditions,
    info.workHours && `근무시간: ${info.workHours}`,
    info.salary && `급여: ${info.salary}`,
    info.headcount && `모집인원: ${info.headcount}`,
    info.subway && `교통: ${info.subway}`,
    ...info.welfare,
  ].filter(Boolean);
  const hasConfirmedBody = Boolean(sourceDetailSections.length || info.duties || info.qualifications || info.preferredQualifications || info.recruitmentProcess || info.applicationMethod || info.otherInformation || rawDescription || workDetails.length || sourceImages.length || attachments.length);
  const fallbackDocumentSections = [
    { key: 'duties', title: '담당업무', value: info.duties },
    { key: 'qualifications', title: '자격요건', value: info.qualifications },
    { key: 'preferredQualifications', title: '우대사항', value: info.preferredQualifications },
    { key: 'work', title: '근무조건·복지', value: workDetails },
    { key: 'recruitmentProcess', title: '전형절차', value: info.recruitmentProcess, ordered: true },
    { key: 'applicationMethod', title: '지원방법', value: info.applicationMethod },
    { key: 'otherInformation', title: '기타사항', value: info.otherInformation },
  ].filter(({ value }) => detailItems(value).length);
  const canUseSourceSections = !['meta', 'fallback'].includes(descriptionKind)
    && (apiDetailSections.length > 0 || sourceDetailSections.length >= 2 || (sourceDetailSections[0]?.semanticKey === 'introduction' && String(rawDescription).length >= 300));
  let documentSections = fallbackDocumentSections;
  if (canUseSourceSections) {
    documentSections = sourceDetailSections.filter(({ semanticKey }) => semanticKey !== 'deadlineText');
    const presentKeys = new Set(documentSections.map(({ semanticKey, key: sectionKey }) => semanticKey || sectionKey).filter(Boolean));
    const presentFingerprints = new Set(documentSections.map(({ value }) => detailSectionFingerprint(value)).filter(Boolean));
    const supplementalWork = [
      info.workConditions,
      info.subway && `교통: ${info.subway}`,
    ].filter(Boolean);
    const supplementalSections = [
      { key: 'duties', title: '담당업무', value: info.duties },
      { key: 'qualifications', title: '자격요건', value: info.qualifications },
      { key: 'preferredQualifications', title: '우대사항', value: info.preferredQualifications },
      { key: 'workConditions', title: '근무조건', value: supplementalWork },
      { key: 'recruitmentProcess', title: '전형절차', value: info.recruitmentProcess, ordered: true },
      { key: 'applicationMethod', title: '지원방법', value: info.applicationMethod },
      { key: 'otherInformation', title: '기타사항', value: info.otherInformation, prose: true },
      { key: 'benefits', title: '혜택 및 복지', value: info.welfare },
    ];
    for (const section of supplementalSections) {
      const fingerprint = detailSectionFingerprint(Array.isArray(section.value) ? section.value.join('\n') : section.value);
      if (!detailItems(section.value).length || presentKeys.has(section.key) || presentFingerprints.has(fingerprint)) continue;
      documentSections.push(section);
      presentKeys.add(section.key);
      presentFingerprints.add(fingerprint);
    }
  } else {
    const hasNarrativeSection = documentSections.some(({ key: sectionKey }) => sectionKey !== 'work');
    if (rawDescription && (!hasNarrativeSection || ['meta', 'fallback'].includes(descriptionKind))) {
      documentSections.unshift({ key: 'description', title: descriptionKind === 'meta' ? '공고 안내' : '공고 내용', value: rawDescription, prose: true });
    }
  }
  const sectionNavItems = documentSections.map((section, index) => ({
    id: `posting-section-${index}`,
    label: section.title,
    sectionKey: section.semanticKey || section.key || 'custom',
  }));
  const headerFacts = [...new Set([department, workPattern, info.workHours, firstKnown(job.region, region), info.employment, deadline.label]
    .map((value) => cleanUnknown(value))
    .filter((value) => value && value !== '원문 확인'))].slice(0, 6);
  const detailNotice = detail?.detailBodyAvailable === false ? '일부 상세 조건은 원문에서 확인해 주세요.' : '';
  const deadlineDetail = info.deadlineText || formatDeadlineDate(job.deadlineAt);

  return <div className="detail-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="detail-sheet posting-sheet" ref={ref} role="dialog" aria-modal="true" aria-labelledby="detail-title" data-testid="job-detail">
      <div className="detail-page-topbar posting-topbar"><span>공고 상세</span><div className="posting-topbar-actions"><button type="button" className="posting-share" onClick={() => onShare(job)} aria-label="공고 공유"><Share2 aria-hidden="true" /><span>공유</span></button><button className="detail-close" onClick={onClose} aria-label="상세 닫기"><X /><span>목록으로</span></button></div></div>
      <header className="posting-header">
        <h2 id="detail-title">{job.title}</h2>
        <div className="posting-meta">{job.company && <span>{job.company}</span>}{job.source && <span>{job.source}</span>}{publishedLabel && <span>{publishedLabel} 등록</span>}{Number.isFinite(job.viewCount) && <span>조회 {job.viewCount}</span>}</div>
        {headerFacts.length > 0 && <div className="posting-header-facts" aria-label="공고 핵심 조건">{headerFacts.map((fact) => <span className={fact === deadline.label ? deadline.status : undefined} key={fact}>{fact}</span>)}</div>}
      </header>
      <nav className="posting-tabs" aria-label="공고 상세 보기" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'summary'} aria-controls="posting-summary-panel" className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>공고 요약</button>
        {originalAvailable && <button type="button" role="tab" aria-selected={activeTab === 'original'} aria-controls="posting-original-panel" className={activeTab === 'original' ? 'active' : ''} onClick={() => setActiveTab('original')}>{sourceImages.length ? '공식 원문' : '원문 내용'}</button>}
      </nav>
      <div className="posting-layout">
        <div className="posting-main">
          {activeTab === 'summary' ? <div id="posting-summary-panel" role="tabpanel">
            {job.missingFromFeed && <div className="feed-missing"><CircleAlert />현재 수집 목록에서는 보이지 않지만 저장 당시 원문 링크는 보존되어 있습니다.</div>}
            {awaitingVerifiedDetail && <aside className={cx('posting-detail-progress', detailSlow && 'slow')} role="status" aria-live="polite" data-testid="detail-progress">{detailSlow ? <Clock3 aria-hidden="true" /> : <RefreshCw className="spin" aria-hidden="true" />}<div><b>{detailSlow ? '원문 확인이 조금 오래 걸리고 있어요' : '원문 세부정보 확인 중'}</b><p>{detailSlow ? '아래 목록 정보와 원문 링크를 먼저 이용할 수 있습니다.' : '목록에서 확인된 정보를 먼저 보여드리고, 추가 내용만 채우고 있습니다.'}</p></div></aside>}
            {summaryFacts.length > 0 && <><ApplicationTierSummary job={trackedJob} profile={state.profile} /><section className="posting-overview" aria-labelledby="detail-summary-title"><div className="posting-overview-heading"><div><span>{awaitingVerifiedDetail ? '목록에서 먼저 확인' : '한눈에 보기'}</span><h3 id="detail-summary-title">먼저 확인할 조건</h3></div><p>{awaitingVerifiedDetail ? '원문 확인이 끝나면 추가 정보만 갱신됩니다.' : '원문에서 확인되지 않은 항목은 따로 표시했습니다.'}</p></div><dl className="posting-facts" data-testid="detail-facts">{summaryFacts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd className={value === '공고에서 확인 필요' ? 'unknown' : undefined}>{value}</dd></div>)}</dl></section></>}
            {attachments.some(attachment => attachment.extractionStatus && attachment.extractionStatus !== 'extracted') && <p className="posting-source-notice">첨부파일의 상세 조건은 원문에서 확인해 주세요.</p>}
            {detail?.error && !hasConfirmedBody && <div className="posting-fetch-error" role="alert"><span>상세 내용을 불러오지 못했습니다.</span>{onRetry && <button onClick={onRetry}>다시 시도</button>}</div>}
            {detailNotice && <aside className="posting-source-notice" role="status"><CircleAlert aria-hidden="true" /><div><p>{detailNotice}</p>{detail?.detailOrigin === 'feed-fallback' && onRetry && <button type="button" className="text-button" onClick={onRetry} disabled={detailLoading}>상세 다시 확인</button>}</div></aside>}
            {attachments.length > 0 && <section className="posting-attachments" aria-labelledby="posting-attachments-title" data-testid="official-attachments"><div><span>공식 자료</span><h3 id="posting-attachments-title">첨부파일</h3><p>채용공고와 직무기술서를 원문으로 확인할 수 있습니다.</p></div><ul>{attachments.map((attachment) => <li key={attachment.url}><a href={attachment.url} target="_blank" rel="noopener noreferrer"><FileText aria-hidden="true" /><span><b>{attachment.name}</b><small>{attachment.type || 'FILE'}</small></span><Download aria-hidden="true" /></a></li>)}</ul></section>}
            {sectionNavItems.length > 1 && <nav className="posting-section-nav" aria-label="공고 내용 바로가기"><span>내용 바로가기</span><div>{sectionNavItems.map((item) => <button type="button" key={item.id} onClick={() => ref.current?.querySelector(`#${item.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{item.label}</button>)}</div></nav>}
            {documentSections.length > 0 && <div className="posting-sections" data-testid="detail-sections">{documentSections.map((section, index) => <RecruitmentSection key={`${section.key}:${section.title}:${index}`} sectionId={`posting-section-${index}`} sectionKey={section.semanticKey || section.key} title={section.title} value={section.value} ordered={section.ordered} prose={section.prose} />)}</div>}
            {awaitingVerifiedDetail && documentSections.length === 0 && <section className="posting-sections-pending" aria-label="원문 상세 내용 확인 중"><span /><span /><span /></section>}
            <CompanyReputationCard company={job.company} autoLookup={!awaitingVerifiedDetail} />
          </div> : <div id="posting-original-panel" role="tabpanel" className={cx('posting-original', sourceImages.length && 'has-source-images')}>
            {!sourceImages.length && (sourceDetailSections.length > 0
              ? <div className="posting-sections">{sourceDetailSections.map((section, index) => <RecruitmentSection key={`original:${section.key}:${section.title}:${index}`} sectionId={`posting-original-section-${index}`} sectionKey={section.semanticKey || section.key} title={section.title} value={section.value} ordered={section.ordered} prose={section.prose} />)}</div>
              : originalText ? <DetailTextBlock value={originalText} /> : null)}
            {sourceImages.length > 0 && <section className="posting-source-images" aria-labelledby="posting-source-images-title"><header><span>공식 채용공고</span><h3 id="posting-source-images-title">이미지 원문</h3><p>이미지를 누르면 원본 크기로 열립니다.</p></header><div>{sourceImages.map((url, index) => { const displayUrl = renderedSourceImage(url); return <a href={displayUrl} target="_blank" rel="noopener noreferrer" key={url}><img src={displayUrl} loading="lazy" alt={`${job.company || '채용처'} ${job.title} 원문 ${index + 1}쪽`} /></a>; })}</div></section>}
          </div>}

          {activeTab === 'summary' && alternates.length > 1 && <section className="alternate-sources posting-alternates"><h3>같은 공고를 볼 수 있는 다른 채용처</h3><div>{alternates.map((item) => <a href={item.url} target="_blank" rel="noopener noreferrer" key={item.url}>{item.source || '채용 사이트'}<ExternalLink /></a>)}</div></section>}
        </div>
        <aside className="posting-side" aria-label="공고 지원 작업"><div className="posting-cta"><div className={cx('posting-deadline', deadline.status)} data-testid="posting-deadline"><span>지원 마감</span><strong>{deadline.label}</strong>{deadlineDetail && cleanUnknown(deadlineDetail) !== '원문 확인' && deadlineDetail !== deadline.label && <small>{deadlineDetail}</small>}</div><div className="posting-actions"><button className={cx('detail-save', saved && 'active')} onClick={() => onToggleSave(trackedJob)} aria-label={saved ? '공고 저장됨, 누르면 저장 취소' : '공고 저장'}><Star fill={saved ? 'currentColor' : 'none'} /><span>{saved ? '저장됨' : '저장'}</span></button>{onToggleHide && <button type="button" className={cx('detail-hide', hidden && 'active')} onClick={() => { onToggleHide(trackedJob); if (!hidden) onClose(); }} aria-label={hidden ? '숨긴 공고 다시 표시' : '공고 숨기기'} data-testid="detail-hide-job">{hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}<span>{hidden ? '숨김 해제' : '숨기기'}</span></button>}{officialSourceUrl || job.url ? <a href={officialSourceUrl || job.url} target="_blank" rel="noopener noreferrer" data-testid="apply-original">{officialSourceUrl ? '공식 페이지에서 보기' : '채용 사이트에서 보기'} <ExternalLink /></a> : <span className="disabled-action">원문 링크 없음</span>}</div></div></aside>
      </div>
    </section>
  </div>;
}

export default function App() {
  const adapterRef = useRef(null);
  if (!adapterRef.current) adapterRef.current = createLocalStorageAdapter(window.localStorage);
  const detailEnrichmentCacheRef = useRef(null);
  const [state, setState] = useState(() => adapterRef.current.load());
  const discoverySinceRef = useRef(state.discovery?.lastCheckedAt || null);
  const [discoveryMode, setDiscoveryMode] = useState('all');
  const [seenIds, setSeenIds] = useState(() => discoverySeenIds(state));
  const [view, setView] = useState(() => viewFromPath());
  const [jobs, setJobs] = useState([]);
  const [reviewJobs, setReviewJobs] = useState([]);
  const [feedMeta, setFeedMeta] = useState({});
  const [loadingMore, setLoadingMore] = useState(false);
  const feedMetaRef = useRef(feedMeta);
  feedMetaRef.current = feedMeta;
  const jobsRequestSequenceRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pendingRefreshRef = useRef(null);
  const [error, setError] = useState('');
  const [liveMessage, setLiveMessage] = useState('');
  const [liveAction, setLiveAction] = useState(null);
  const [filters, setFilters] = useState(() => ({ ...initialFilters(), careRole: state.profile?.preferredCareRole || 'all' }));
  const [allJobsFilters, setAllJobsFilters] = useState(() => initialAllJobsFilters());
  const [selectedJob, setSelectedJob] = useState(null);
  const [activeDetailRouteId, setActiveDetailRouteId] = useState(() => detailRouteId());
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savedSyncToken, setSavedSyncToken] = useState(() => readSavedSyncToken(window.localStorage));
  const [savedSyncPairingCode, setSavedSyncPairingCode] = useState('');
  const [savedSyncPairingExpiresAt, setSavedSyncPairingExpiresAt] = useState(null);
  const [savedSyncOpen, setSavedSyncOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [savedSyncStatus, setSavedSyncStatus] = useState(() => ({
    phase: readSavedSyncToken(window.localStorage) ? 'syncing' : 'off',
    lastSyncedAt: null,
    error: '',
  }));
  const detailRequestRef = useRef(0);
  const detailResponseCacheRef = useRef(new Map());
  const detailRequestFlightsRef = useRef(new Map());
  const jobsRequestFlightRef = useRef(null);
  const feedLoadedRef = useRef(false);
  const routedDetailFlightRef = useRef(null);
  const attemptedDetailRoutesRef = useRef(new Set());
  const pendingListScrollRestoreRef = useRef(null);
  const viewRef = useRef(view);
  const filtersRef = useRef(filters);
  const allJobsFiltersRef = useRef(allJobsFilters);
  const stateRef = useRef(state);
  const savedSyncTokenRef = useRef(savedSyncToken);
  const savedSyncFlightRef = useRef(null);
  const applicationTierProfileKey = [
    ...(state.profile?.regionCodes || []),
    '|',
    ...(state.profile?.careerDomains || []),
  ].join(':');
  filtersRef.current = filters;
  allJobsFiltersRef.current = allJobsFilters;
  stateRef.current = state;
  savedSyncTokenRef.current = savedSyncToken;
  const discoveryQuery = useMemo(() => ({ mode: discoveryMode, since: discoverySinceRef.current, seen: seenIds, applied: appliedJobIds(state) }), [discoveryMode, seenIds, state.applications, state.savedSnapshots]);
  const feedQueryKey = JSON.stringify({
    filters: view === 'full' ? allJobsFilters : view === 'all' ? filters : {},
    profile: { regionCodes: state.profile?.regionCodes, careerDomains: state.profile?.careerDomains },
    hidden: ['all', 'full'].includes(view) ? Object.values(state.hiddenSnapshots || {}).flatMap(j => [j.id, j.dedupeKey]).filter(Boolean).sort() : [],
    ...(view === 'all' ? { discovery: discoveryQuery } : {}),
    ...(!['all', 'full'].includes(view) ? { ids: [...Object.values(state.savedSnapshots || {}), ...Object.values(state.hiddenSnapshots || {})].flatMap(j => [j.id, j.dedupeKey]).concat(state.meta?.pendingLegacySavedIds || []).filter(Boolean).sort() } : {}),
  });
  const feedQueryRef = useRef(feedQueryKey);
  feedQueryRef.current = feedQueryKey;
  const prevFeedQueryRef = useRef(feedQueryKey);

  const commit = useCallback((updater) => {
    setState((current) => {
      const next = adapterRef.current.save(typeof updater === 'function' ? updater(current) : updater);
      stateRef.current = next;
      return next;
    });
  }, []);
  const changeDiscoveryMode = (mode) => {
    setSeenIds(discoverySeenIds(stateRef.current));
    setDiscoveryMode(mode);
  };
  const changeCareRole = (careRole) => {
    setFilters(current => ({ ...current, careRole }));
    commit(current => updateProfile(current, { preferredCareRole: careRole }));
  };
  const setRecommendedFilters = (updater) => {
    const current = { ...filtersRef.current, ...(discoveryMode === 'new' ? { sort: '처음 발견순' } : {}) };
    const next = typeof updater === 'function' ? updater(current) : updater;
    if (next.sort === '처음 발견순') setFilters({ ...next, sort: '워라벨 우선' });
    else {
      if (discoveryMode === 'new') setDiscoveryMode('all');
      setFilters(next);
    }
  };
  const updateSeenForRefresh = useCallback(() => {
    const seen = discoverySeenIds(stateRef.current);
    const query = JSON.parse(feedQueryRef.current);
    if (query.discovery) {
      query.discovery.seen = seen;
      feedQueryRef.current = JSON.stringify(query);
      // This is a quiet refresh, not a navigation/filter replacement. Keep
      // existing rows mounted until the matching response arrives.
      feedLoadedRef.current = feedQueryRef.current;
    }
    setSeenIds(seen);
  }, []);
  const applySavedSyncRecord = useCallback((record) => {
    if (!record?.savedSnapshots) return;
    setState((current) => {
      const next = adapterRef.current.save(replaceSavedSnapshots(current, record.savedSnapshots));
      stateRef.current = next;
      return next;
    });
  }, []);
  const performSavedSync = useCallback(async ({ pull = true } = {}) => {
    const token = savedSyncTokenRef.current;
    if (!token) return null;
    if (savedSyncFlightRef.current) return savedSyncFlightRef.current;

    const flight = (async () => {
      setSavedSyncStatus((current) => ({ ...current, phase: 'syncing', error: '' }));
      try {
        let latest = null;
        let shouldPull = pull;
        while (savedSyncTokenRef.current === token) {
          const mutation = readPendingSavedSyncMutations(window.localStorage, token)[0];
          if (mutation) {
            latest = await requestSavedSync(token, {
              action: mutation.action,
              payload: mutation.action === 'save' ? { snapshot: mutation.snapshot } : { jobKey: mutation.jobKey },
            });
            removePendingSavedSyncMutation(window.localStorage, token);
            continue;
          }
          if (shouldPull) {
            shouldPull = false;
            latest = await requestSavedSync(token);
            continue;
          }
          break;
        }
        if (savedSyncTokenRef.current === token) {
          if (latest) applySavedSyncRecord(latest);
          writeSavedSyncToken(window.localStorage, token);
          setSavedSyncStatus({ phase: 'synced', lastSyncedAt: new Date().toISOString(), error: '' });
        }
        return latest;
      } catch (syncError) {
        if (savedSyncTokenRef.current === token) {
          setSavedSyncStatus((current) => ({ ...current, phase: 'error', error: syncError.message || '스크랩 동기화에 실패했습니다.' }));
        }
        return null;
      }
    })();
    savedSyncFlightRef.current = flight;
    try {
      return await flight;
    } finally {
      if (savedSyncFlightRef.current === flight) savedSyncFlightRef.current = null;
    }
  }, [applySavedSyncRecord]);
  const acceptSavedSyncConnection = useCallback((record) => {
    const token = writeSavedSyncToken(window.localStorage, record.token);
    savedSyncTokenRef.current = token;
    setSavedSyncToken(token);
    setSavedSyncPairingCode(record.pairingCode || '');
    setSavedSyncPairingExpiresAt(record.expiresAt || null);
    applySavedSyncRecord(record);
    setSavedSyncStatus({ phase: 'synced', lastSyncedAt: new Date().toISOString(), error: '' });
  }, [applySavedSyncRecord]);
  const createSavedSyncPairing = useCallback(async () => {
    const currentToken = savedSyncTokenRef.current;
    setSavedSyncStatus((current) => ({ ...current, phase: 'syncing', error: '' }));
    setSavedSyncPairingCode('');
    setSavedSyncPairingExpiresAt(null);
    try {
      if (currentToken) {
        await performSavedSync({ pull: false });
        if (readPendingSavedSyncMutations(window.localStorage, currentToken).length) {
          throw new Error('대기 중인 스크랩을 먼저 동기화하지 못했습니다. 인터넷 연결을 확인해 주세요.');
        }
      }
      const record = await requestSavedSync(currentToken, { action: 'create-pairing', payload: { savedSnapshots: stateRef.current.savedSnapshots } });
      acceptSavedSyncConnection(record);
      return true;
    } catch (syncError) {
      setSavedSyncStatus((current) => ({ ...current, phase: 'error', error: syncError.message || '4자리 연결 코드를 만들지 못했습니다.' }));
      return false;
    }
  }, [acceptSavedSyncConnection, performSavedSync]);
  const redeemSavedSyncPairing = useCallback(async (requestedCode) => {
    const pairingCode = normalizePairingCode(requestedCode);
    if (!isValidPairingCode(pairingCode)) {
      setSavedSyncStatus({ phase: 'error', lastSyncedAt: null, error: '숫자 4자리를 확인해 주세요.' });
      return false;
    }
    setSavedSyncStatus((current) => ({ ...current, phase: 'syncing', error: '' }));
    try {
      const record = await requestSavedSync('', { action: 'redeem-pairing', payload: { pairingCode, savedSnapshots: stateRef.current.savedSnapshots } });
      acceptSavedSyncConnection(record);
      return true;
    } catch (syncError) {
      setSavedSyncStatus({ phase: 'error', lastSyncedAt: null, error: syncError.message || '4자리 연결 코드로 연결하지 못했습니다.' });
      return false;
    }
  }, [acceptSavedSyncConnection]);
  const disconnectSavedSync = useCallback(() => {
    if (!window.confirm('이 기기의 동기화 연결을 해제할까요? 서버와 다른 기기의 스크랩은 지워지지 않습니다.')) return;
    const token = savedSyncTokenRef.current;
    clearSavedSyncToken(window.localStorage);
    clearPendingSavedSyncMutations(window.localStorage, token);
    savedSyncTokenRef.current = '';
    setSavedSyncToken('');
    setSavedSyncPairingCode('');
    setSavedSyncPairingExpiresAt(null);
    setSavedSyncStatus({ phase: 'off', lastSyncedAt: null, error: '' });
  }, []);
  const applyRememberedDetails = useCallback((items) => (Array.isArray(items) ? items : [])
    .map((job) => {
      if (job.presentation) return job;
      detailEnrichmentCacheRef.current ||= readDetailEnrichmentCache(window.localStorage);
      return applyDetailEnrichment(job, detailEnrichmentCacheRef.current);
    }), []);
  const assignApplicationTierGroups = useCallback((items) => (Array.isArray(items) ? items : [])
    .map((job) => {
      const assessment = applicationTierFor(job, stateRef.current.profile);
      if (job.applicationTierGroup === assessment.tier && job.applicationTierGroupScore === assessment.score) return job;
      return { ...job, applicationTierGroup: assessment.tier, applicationTierGroupScore: assessment.score };
    }), []);
  const requestJobDetail = useCallback(async (job, { force = false, purpose = 'detail-open' } = {}) => {
    if (!job?.url) throw new Error('저장된 원문 링크가 없습니다.');
    const key = detailRequestKey(job);
    if (!key) throw new Error('상세 정보를 확인할 공고 식별자가 없습니다.');

    const responseCache = detailResponseCacheRef.current;
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.cachedAt <= DETAIL_SESSION_CACHE_TTL_MS && !force) {
      responseCache.delete(key);
      responseCache.set(key, cached);
      return cached.data;
    }
    if (cached) responseCache.delete(key);

    const flights = detailRequestFlightsRef.current;
    if (!force && flights.has(key)) return flights.get(key);

    const flight = (async () => {
      const response = await fetch('/api/job-detail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: job.url, job, purpose, ...(force ? { refresh: true } : {}) }),
        signal: AbortSignal.timeout(force ? 30_000 : 10_000),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('상세 정보 응답을 확인하지 못했습니다.');
      }
      if (!response.ok) throw new Error(data.error || '상세 정보를 불러오지 못했습니다.');
      responseCache.set(key, { data, cachedAt: Date.now() });
      while (responseCache.size > DETAIL_SESSION_CACHE_MAX_ENTRIES) {
        responseCache.delete(responseCache.keys().next().value);
      }
      return data;
    })();
    flights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  }, []);
  const prefetchDetail = useCallback((job) => {
    if (!job?.url) return;
    void requestJobDetail(job, { purpose: 'intent-prefetch' }).catch(() => {});
  }, [requestJobDetail]);
  const resetDetail = useCallback(() => {
    detailRequestRef.current += 1;
    setSelectedJob(null);
    setDetail(null);
    setDetailLoading(false);
  }, []);
  const navigate = useCallback((nextView) => {
    const nextPath = VIEW_PATHS[nextView] || VIEW_PATHS.all;
    const listFilters = filterSnapshotForView(nextView, filtersRef.current, allJobsFiltersRef.current);
    const nextRouteState = { nurseBoard: true, view: nextView, scrollY: 0, ...(listFilters ? { listView: nextView, listFilters } : {}) };
    if (window.location.pathname !== nextPath) window.history.pushState(nextRouteState, '', nextPath);
    else if (!window.history.state?.nurseBoard) window.history.replaceState({ ...(window.history.state || {}), ...nextRouteState }, '', nextPath);
    viewRef.current = nextView;
    setView(nextView);
    setActiveDetailRouteId('');
    resetDetail();
    window.requestAnimationFrame(() => scrollWindowImmediately(0));
  }, [resetDetail]);

  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => {
    if (detailRouteId()) return;
    const listFilters = filterSnapshotForView(view, filters, allJobsFilters);
    if (!listFilters) return;
    window.history.replaceState({ ...(window.history.state || {}), nurseBoard: true, view, listView: view, listFilters }, '', `${window.location.pathname}${window.location.search}${window.location.hash}`);
  }, [view, filters, allJobsFilters]);
  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return undefined;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);
  useEffect(() => {
    const pending = pendingListScrollRestoreRef.current;
    if (selectedJob || !pending) return undefined;
    let settleFrame = 0;
    const unlockFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        if (pendingListScrollRestoreRef.current !== pending) return;
        restoreJobListScrollAnchor(pending);
        pendingListScrollRestoreRef.current = null;
      });
    });
    return () => {
      window.cancelAnimationFrame(unlockFrame);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
    };
  }, [jobs, reviewJobs, selectedJob]);
  useEffect(() => {
    if (!savedSyncToken) return undefined;
    const sync = () => { void performSavedSync(); };
    const syncWhenVisible = () => { if (document.visibilityState === 'visible') sync(); };
    sync();
    const timer = window.setInterval(sync, 20_000);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', syncWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', syncWhenVisible);
    };
  }, [savedSyncToken, performSavedSync]);
  useEffect(() => {
    if (!savedSyncPairingExpiresAt) return undefined;
    const delay = new Date(savedSyncPairingExpiresAt).getTime() - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) {
      setSavedSyncPairingCode('');
      setSavedSyncPairingExpiresAt(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setSavedSyncPairingCode('');
      setSavedSyncPairingExpiresAt(null);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [savedSyncPairingExpiresAt]);

  const loadJobs = useCallback(async ({ quiet = false, append = false } = {}) => {
    const queryKey = feedQueryRef.current;
    if (jobsRequestFlightRef.current?.key === queryKey) return jobsRequestFlightRef.current.promise;
    const sequence = ++jobsRequestSequenceRef.current;
    const params = new URLSearchParams({ limit: String(JOB_LIST_PAGE_SIZE) });
    for (const [key, value] of Object.entries(JSON.parse(queryKey))) params.set(key, JSON.stringify(value));
    if (append && feedMetaRef.current.pagination) {
      params.set('offset', String(feedMetaRef.current.pagination.nextOffset));
      params.set('version', feedMetaRef.current.pagination.version);
    }
    const flight = (async () => {
      if (append) setLoadingMore(true);
      else if (!quiet) setLoading(true);
      try {
        const response = await fetch(`/api/jobs?${params}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
        const data = await response.json();
        if (sequence !== jobsRequestSequenceRef.current || queryKey !== feedQueryRef.current) return;
        if (!response.ok) throw new Error(data.error || `공고 요청 실패 (${response.status})`);
        const incoming = assignApplicationTierGroups(applyRememberedDetails(data.jobs));
        setJobs(current => append && data.pagination?.offset > 0
          ? [...new Map([...current, ...incoming].map(job => [job.id, job])).values()] : incoming);
        setReviewJobs(assignApplicationTierGroups(applyRememberedDetails(Array.isArray(data.reviewJobs) ? data.reviewJobs : Array.isArray(data.needsReviewJobs) ? data.needsReviewJobs : Array.isArray(data.needsReview) ? data.needsReview : [])));
        setFeedMeta(data);
        const pendingRefresh = pendingRefreshRef.current;
        if (pendingRefresh && refreshHasPublished(data, pendingRefresh.startedAt)) {
          pendingRefreshRef.current = null;
          setRefreshing(false);
          setLiveMessage(data.refresh?.error ? '수집 중 일부 오류가 있었습니다. 출처별 상태를 확인해 주세요.' : '최신 수집 결과를 화면에 반영했습니다.');
        } else if (!pendingRefresh) setRefreshing(Boolean(data.refreshing ?? data.refresh?.inProgress));
        if (!append && !data.refresh?.inProgress) commit(current => advanceDiscoveryCheckpoint(current, data));
        setError(data.error || '');
        feedLoadedRef.current = queryKey;
        return data;
      } catch (requestError) {
        if (sequence !== jobsRequestSequenceRef.current || queryKey !== feedQueryRef.current) return;
        setError(requestError.message || '로컬 서버 연결을 확인해 주세요.');
      } finally {
        if (sequence === jobsRequestSequenceRef.current && queryKey === feedQueryRef.current) { setLoading(false); setLoadingMore(false); }
      }
    })();
    jobsRequestFlightRef.current = { key: queryKey, promise: flight };
    try { return await flight; }
    finally { if (jobsRequestFlightRef.current?.promise === flight) jobsRequestFlightRef.current = null; }
  }, [applyRememberedDetails, assignApplicationTierGroups, commit]);
  const loadMoreJobs = useCallback(() => loadJobs({ append: true, quiet: true }), [loadJobs]);

  useEffect(() => {
    // 숨기기·저장 등 부가 정보만 바뀐 경우 목록을 유지한 채 조용히 재동기화 — 카드가 사라지고 스켈레톤이 뜨는 깜빡임 방지
    const prevQueryKey = prevFeedQueryRef.current;
    prevFeedQueryRef.current = feedQueryKey;
    if (activeDetailRouteId || feedLoadedRef.current === feedQueryKey) return undefined;
    let metadataOnly = false;
    try {
      const stripVolatile = (raw) => {
        const query = JSON.parse(raw);
        delete query.hidden;
        delete query.ids;
        if (query.discovery) delete query.discovery.applied;
        return JSON.stringify(query);
      };
      metadataOnly = stripVolatile(prevQueryKey) === stripVolatile(feedQueryKey);
    } catch {}
    if (metadataOnly) {
      const quietTimer = window.setTimeout(() => { void loadJobs({ quiet: true }); }, 300);
      return () => window.clearTimeout(quietTimer);
    }
    setLoading(true);
    setJobs([]);
    setReviewJobs([]);
    setError('');
    setFeedMeta(current => ({ ...current, pagination: undefined }));
    const timer = window.setTimeout(() => { void loadJobs(); }, 150);
    return () => window.clearTimeout(timer);
  }, [activeDetailRouteId, loadJobs, feedQueryKey]);
  useEffect(() => {
    setJobs((current) => assignApplicationTierGroups(current));
    setReviewJobs((current) => assignApplicationTierGroups(current));
  }, [applicationTierProfileKey, assignApplicationTierGroups]);
  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = window.setInterval(() => {
      if (pendingRefreshRef.current && Date.now() - pendingRefreshRef.current.requestedAt > 150_000) {
        pendingRefreshRef.current = null;
        setRefreshing(false);
        setLiveMessage('수집 결과 반영이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.');
        return;
      }
      void loadJobs({ quiet: true });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshing, loadJobs]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && !detailRouteId()) { updateSeenForRefresh(); void loadJobs({ quiet: true }); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadJobs, updateSeenForRefresh]);
  useEffect(() => {
    if (!jobs.length) return;
    setState((current) => adapterRef.current.save(hydrateHiddenSnapshots(hydrateSavedSnapshots(current, jobs), jobs)));
  }, [jobs]);
  useEffect(() => { const timer = window.setTimeout(() => commit((current) => updateRecentFilters(current, filters)), 200); return () => window.clearTimeout(timer); }, [filters, commit]);
  useEffect(() => { if (!liveMessage) return undefined; const timer = window.setTimeout(() => { setLiveMessage(''); setLiveAction(null); }, 3600); return () => window.clearTimeout(timer); }, [liveMessage]);

  const refresh = async () => {
    if (pendingRefreshRef.current) return;
    updateSeenForRefresh();
    pendingRefreshRef.current = { startedAt: new Date().toISOString(), requestedAt: Date.now() };
    setRefreshing(true);
    setLiveMessage('새 공고를 수집하고 있습니다. 기존 공고는 계속 볼 수 있습니다.');
    try {
      const response = await fetch('/api/refresh', { method: 'POST', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok && response.status !== 409) throw new Error(data.error || '새로고침을 시작하지 못했습니다.');
      if (data.snapshot) {
        pendingRefreshRef.current = null;
        const refreshed = await loadJobs({ quiet: true });
        setRefreshing(false);
        setLiveMessage(!refreshed ? '수집 후 목록을 불러오지 못했습니다. 다시 확인해 주세요.' : refreshed.refresh?.error ? '수집 중 일부 오류가 있었습니다. 출처별 상태를 확인해 주세요.' : '새 공고 수집을 완료했습니다.');
        return;
      }
      pendingRefreshRef.current.startedAt = data.refresh?.startedAt || pendingRefreshRef.current.startedAt;
      setRefreshing(true);
      setLiveMessage('새 공고 수집을 시작했습니다. 기존 공고는 계속 볼 수 있습니다.');
      window.setTimeout(() => loadJobs({ quiet: true }), 500);
    } catch (refreshError) {
      pendingRefreshRef.current = null;
      setRefreshing(false);
      setLiveMessage(refreshError.message);
      // Even when collection is rejected, reconcile the newly acknowledged
      // viewed IDs with the existing published feed and its pagination.
      void loadJobs({ quiet: true });
    }
  };

  const toggleSaved = useCallback((job) => {
    const enrichedJob = withNurseFacets(job);
    const current = stateRef.current;
    const removing = isJobSaved(current, enrichedJob);
    const key = jobKey(enrichedJob);
    if (removing && current.applications[key]) {
      setLiveMessage('지원 상태가 연결된 저장 공고입니다.');
      return;
    }
    let next;
    if (!removing) {
      next = saveJobSnapshot(current, enrichedJob);
      const deadline = deadlineInfo(enrichedJob);
      if (deadline.days != null && [3, 1, 0].includes(deadline.days)) next = upsertNotification(next, { id: `deadline:${key}:${deadline.days}`, type: 'deadline', title: deadline.days === 0 ? '오늘 마감하는 저장 공고' : `마감 D-${deadline.days}`, message: `${enrichedJob.company} · ${enrichedJob.title}`, jobKey: key, scheduledAt: enrichedJob.deadlineAt, data: { view: 'saved' } });
    } else {
      next = removeSavedSnapshot(current, enrichedJob);
    }
    const persisted = adapterRef.current.save(next);
    stateRef.current = persisted;
    setState(persisted);
    if (removing) {
      setLiveMessage('저장을 해제했습니다.');
      setLiveAction({ label: '실행 취소', run: () => toggleSaved(enrichedJob) });
    }

    const token = savedSyncTokenRef.current;
    if (!token) return;
    const savedSnapshot = persisted.savedSnapshots[key] || Object.values(persisted.savedSnapshots)
      .find((snapshot) => [snapshot.jobKey, snapshot.dedupeKey, snapshot.id].includes(key));
    if (!removing && !savedSnapshot) return;
    enqueueSavedSyncMutation(window.localStorage, token, removing
      ? { action: 'remove', jobKey: key }
      : { action: 'save', snapshot: savedSnapshot });
    void performSavedSync({ pull: false });
  }, [performSavedSync]);

  const toggleHidden = useCallback((job) => {
    const enrichedJob = withNurseFacets(job);
    const current = stateRef.current;
    const hidden = isJobHidden(current, enrichedJob);
    const next = hidden
      ? removeHiddenSnapshot(current, enrichedJob)
      : hideJobSnapshot(current, enrichedJob);
    const persisted = adapterRef.current.save(next);
    stateRef.current = persisted;
    setState(persisted);
    setLiveMessage(hidden ? '숨긴 공고를 다시 표시했습니다.' : '공고를 숨겼습니다.');
    setLiveAction(hidden ? null : { label: '실행 취소', run: () => toggleHidden(enrichedJob) });
  }, []);

  const loadDetail = useCallback(async (job, { force = false } = {}) => {
    const requestId = ++detailRequestRef.current;
    setSelectedJob(job); setDetail(null); setDetailLoading(true);
    try {
      let isSaramin = false;
      let isCaseManager = false;
      try {
        const hostname = new URL(job.url).hostname;
        isSaramin = hostname === 'www.saramin.co.kr';
        isCaseManager = hostname === 'www.casemanager.or.kr';
      } catch {}
      const refreshOriginal = force || isSaramin;
      let data = await requestJobDetail(job, { force: refreshOriginal, purpose: force ? 'detail-retry' : 'detail-open' });
      if (isCaseManager && !refreshOriginal
        && (!data.detailVerified || !data.department || !data.qualifications || !data.applicationMethod)) {
        data = await requestJobDetail(job, { force: true, purpose: 'detail-open' });
      }
      if (detailRequestRef.current === requestId) {
        if (job.presentation) {
          // The shared server cache owns enrichment for current API responses.
          // Opening one detail must not reprocess or persist the entire feed.
          setSelectedJob(data.detailVerified ? {
            ...job, ...data, id: job.id, title: job.title, company: job.company, url: job.url, presentation: undefined,
          } : job);
          setDetail(data);
          return;
        }
        detailEnrichmentCacheRef.current ||= readDetailEnrichmentCache(window.localStorage);
        const nextCache = rememberDetailEnrichment(detailEnrichmentCacheRef.current, job, data);
        detailEnrichmentCacheRef.current = nextCache;
        writeDetailEnrichmentCache(window.localStorage, nextCache);
        const enrichedJob = assignApplicationTierGroups([applyDetailEnrichment(job, nextCache)])[0];
        const updateSelected = (current) => current.map((item) => detailRequestKey(item) === detailRequestKey(job) ? enrichedJob : item);
        setJobs(updateSelected);
        setReviewJobs(updateSelected);
        setSelectedJob(enrichedJob);
        setDetail(data);
      }
    } catch (detailError) { if (detailRequestRef.current === requestId) setDetail({ error: detailError.message }); }
    finally { if (detailRequestRef.current === requestId) setDetailLoading(false); }
  }, [applyRememberedDetails, requestJobDetail, assignApplicationTierGroups]);

  const loadRoutedDetail = useCallback(async (id) => {
    if (attemptedDetailRoutesRef.current.has(id) || routedDetailFlightRef.current === id) return;
    routedDetailFlightRef.current = id;
    attemptedDetailRoutesRef.current.add(id);
    const requestId = ++detailRequestRef.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/job?id=${encodeURIComponent(id)}`, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json();
      if (!response.ok || !data.job) throw new Error(data.error || '공고를 불러오지 못했습니다.');
      if (detailRequestRef.current !== requestId || detailRouteId() !== id) return;
      let routedDetail = data.detail;
      let isSaramin = false;
      let isCaseManager = false;
      try {
        const hostname = new URL(data.job.url).hostname;
        isSaramin = hostname === 'www.saramin.co.kr';
        isCaseManager = hostname === 'www.casemanager.or.kr';
      } catch {}
      if (isSaramin || isCaseManager) {
        try {
          routedDetail = await requestJobDetail(data.job, { force: isSaramin, purpose: 'detail-open' });
          if (isCaseManager && (!routedDetail?.detailVerified || !routedDetail.department || !routedDetail.qualifications || !routedDetail.applicationMethod)) {
            routedDetail = await requestJobDetail(data.job, { force: true, purpose: 'detail-open' });
          }
        } catch {}
        if (detailRequestRef.current !== requestId || detailRouteId() !== id) return;
      }
      setSelectedJob(data.job);
      commit(current => markJobViewed(current, data.job));
      setDetail(routedDetail);
      setDetailLoading(false);
      setError('');
      detailResponseCacheRef.current.set(detailRequestKey(data.job), { data: routedDetail, cachedAt: Date.now() });
    } catch (requestError) {
      if (detailRequestRef.current !== requestId || detailRouteId() !== id) return;
      // Older servers and saved postings can still resolve through the feed.
      if (!feedLoadedRef.current) await loadJobs();
      else setError(requestError.message);
    } finally {
      if (routedDetailFlightRef.current === id) routedDetailFlightRef.current = null;
      if (detailRequestRef.current === requestId) setLoading(false);
    }
  }, [loadJobs, commit, requestJobDetail]);

  const openDetail = useCallback((job, { historyMode = 'push' } = {}) => {
    const id = jobRouteId(job);
    if (!id) return;
    commit(current => markJobViewed(current, job));
    if (historyMode === 'push') {
      const returnView = viewRef.current;
      const returnUrl = VIEW_PATHS[returnView] || VIEW_PATHS.all;
      const scrollAnchor = captureJobListScrollAnchor();
      const listFilters = filterSnapshotForView(returnView, filtersRef.current, allJobsFiltersRef.current);
      const listState = listFilters ? { listView: returnView, listFilters } : {};
      window.history.replaceState({ ...(window.history.state || {}), nurseBoard: true, view: returnView, scrollY: scrollAnchor.scrollY, scrollAnchor, ...listState }, '', `${window.location.pathname}${window.location.search}${window.location.hash}`);
      window.history.pushState({ nurseBoard: true, nurseBoardDetail: true, directEntry: false, detailId: id, view: returnView, returnUrl, scrollY: scrollAnchor.scrollY, scrollAnchor, ...listState }, '', `/recruitment/${encodeURIComponent(id)}`);
    }
    setActiveDetailRouteId(id);
    loadDetail(job);
  }, [loadDetail, commit]);

  const shareJob = useCallback(async (job) => {
    const url = window.location.href;
    const title = job?.title || '간호 채용 공고';
    const text = job?.company ? `${job.company} · ${title}` : title;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url });
        setLiveMessage('공고를 공유했어요.');
        return;
      } catch (shareError) {
        if (shareError?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setLiveMessage('공고 링크를 복사했어요. 원하는 곳에 붙여넣어 주세요.');
    } catch {
      setLiveMessage('공고 링크를 복사하지 못했어요. 주소창에서 링크를 복사해 주세요.');
    }
  }, []);

  const closeDetail = useCallback(() => {
    const routeState = window.history.state || {};
    if (detailRouteId() && routeState.nurseBoardDetail && !routeState.directEntry) {
      window.history.back();
      return;
    }
    const nextView = VIEW_PATHS[routeState.view] ? routeState.view : 'all';
    const nextPath = Object.values(VIEW_PATHS).includes(routeState.returnUrl) ? routeState.returnUrl : VIEW_PATHS[nextView];
    const listFilters = filterSnapshotForView(nextView, filtersRef.current, allJobsFiltersRef.current);
    window.history.replaceState({ nurseBoard: true, view: nextView, scrollY: 0, ...(listFilters ? { listView: nextView, listFilters } : {}) }, '', nextPath);
    viewRef.current = nextView;
    setView(nextView);
    setActiveDetailRouteId('');
    resetDetail();
    window.requestAnimationFrame(() => scrollWindowImmediately(0));
  }, [resetDetail]);

  useEffect(() => {
    const restoreListFilters = (targetView, routeState) => {
      if (routeState.listView !== targetView || !routeState.listFilters) return;
      if (targetView === 'all') {
        const next = filtersFromDefaults(DEFAULT_FILTERS, routeState.listFilters);
        if (!filtersEqual(filtersRef.current, next, DEFAULT_FILTERS)) {
          filtersRef.current = next;
          setFilters(next);
        }
      } else if (targetView === 'full') {
        const next = filtersFromDefaults(ALL_JOBS_DEFAULT_FILTERS, routeState.listFilters);
        if (!filtersEqual(allJobsFiltersRef.current, next, ALL_JOBS_DEFAULT_FILTERS)) {
          allJobsFiltersRef.current = next;
          setAllJobsFilters(next);
        }
      }
    };
    const syncRoute = (event) => {
      const routeId = detailRouteId();
      setActiveDetailRouteId(routeId);
      const routeState = event?.state || window.history.state || {};
      if (!routeId) {
        const nextView = VIEW_PATHS[routeState.view] ? routeState.view : viewFromPath();
        const canonicalPath = VIEW_PATHS[nextView] || VIEW_PATHS.all;
        if (!routeState.nurseBoard || window.location.pathname !== canonicalPath) window.history.replaceState({ ...routeState, nurseBoard: true, view: nextView }, '', canonicalPath);
        restoreListFilters(nextView, routeState);
        if (event?.type === 'popstate' && Number.isFinite(routeState.scrollY)) {
          pendingListScrollRestoreRef.current = routeState.scrollAnchor || { scrollY: routeState.scrollY };
        }
        viewRef.current = nextView;
        setView(nextView);
        resetDetail();
        return;
      }

      const detailState = routeState.nurseBoardDetail ? routeState : { ...routeState, nurseBoard: true, nurseBoardDetail: true, directEntry: true, detailId: routeId, view: 'all', returnUrl: VIEW_PATHS.all, scrollY: 0 };
      if (!routeState.nurseBoardDetail) window.history.replaceState(detailState, '', `${window.location.pathname}${window.location.search}${window.location.hash}`);
      const returnView = VIEW_PATHS[detailState.view] ? detailState.view : 'all';
      restoreListFilters(returnView, detailState);
      viewRef.current = returnView;
      setView(returnView);
      const routedJob = findRoutedJob(routeId, jobs, reviewJobs, {
        ...state.savedSnapshots,
        ...(state.hiddenSnapshots || {}),
      });
      if (!jobMatchesRoute(selectedJob, routeId)) {
        if (routedJob) loadDetail(routedJob);
        else void loadRoutedDetail(routeId);
      }
    };
    const onPopState = (event) => syncRoute(event);
    window.addEventListener('popstate', onPopState);
    syncRoute();
    return () => window.removeEventListener('popstate', onPopState);
  }, [jobs, reviewJobs, state.savedSnapshots, state.hiddenSnapshots, selectedJob, loadDetail, loadRoutedDetail, resetDetail]);

  useEffect(() => {
    document.title = selectedJob?.title
      ? `${selectedJob.title} | Nurse Board`
      : view === 'full' ? '전체 간호사 채용 공고 | Nurse Board' : view === 'saved' ? '저장한 공고 | Nurse Board' : view === 'hidden' ? '숨긴 공고 | Nurse Board' : '추천 간호사 채용 공고 | Nurse Board';
  }, [selectedJob, view]);

  const savedCount = Object.keys(state.savedSnapshots).length;
  const hiddenCount = Object.keys(state.hiddenSnapshots || {}).length;
  const counts = useMemo(() => ({
    all: feedMeta.pagination ? view === 'all' ? feedMeta.pagination.total : undefined : jobs.filter((job) => !isJobHidden(state, job) && jobMatchesFilters(job, filters)).length,
    full: feedMeta.pagination ? view === 'full' ? feedMeta.pagination.total : undefined : jobs.filter((job) => !isJobHidden(state, job) && jobMatchesFilters(job, allJobsFilters)).length,
    saved: savedCount,
    hidden: hiddenCount,
  }), [jobs, state.hiddenSnapshots, filters, allJobsFilters, savedCount, hiddenCount, feedMeta.pagination, view]);
  const unresolvedRouteJob = activeDetailRouteId && !selectedJob
    ? findRoutedJob(activeDetailRouteId, jobs, reviewJobs, {
      ...state.savedSnapshots,
      ...(state.hiddenSnapshots || {}),
    })
    : null;
  const routeDetailLoading = Boolean(activeDetailRouteId && !selectedJob && (loading || unresolvedRouteJob));

  return <div className="app-shell jobs-focus-shell">
    <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
    <FocusHeader view={view} onChange={navigate} counts={counts} refreshing={refreshing} savedSync={{ ...savedSyncStatus, connected: Boolean(savedSyncToken) }} onSavedSync={() => setSavedSyncOpen(true)} onFeedback={() => setFeedbackOpen(true)} />
    <main id="main-content">
      <DataTrustBar trust={feedMeta.dataTrust} onRetry={refresh} />
      {view === 'all' && <AllJobsView discoveryQuery={discoveryQuery} discovery={feedMeta.discovery} onDiscoveryMode={changeDiscoveryMode} onCareRole={changeCareRole} pagination={feedMeta.pagination} onLoadMore={loadMoreJobs} loadingMore={loadingMore} jobs={jobs} state={state} loading={loading} error={error} refreshing={refreshing} filters={discoveryMode === 'new' ? { ...filters, sort: '처음 발견순' } : filters} setFilters={setRecommendedFilters} onOpen={openDetail} onToggleSave={toggleSaved} onToggleHide={toggleHidden} onPrefetch={prefetchDetail} onRetry={loadJobs} onRefresh={refresh} />}
      {view === 'full' && <AllJobsView pagination={feedMeta.pagination} onLoadMore={loadMoreJobs} loadingMore={loadingMore} jobs={jobs} state={state} loading={loading} error={error} refreshing={refreshing} filters={allJobsFilters} setFilters={setAllJobsFilters} onOpen={openDetail} onToggleSave={toggleSaved} onToggleHide={toggleHidden} onPrefetch={prefetchDetail} onRetry={loadJobs} onRefresh={refresh} mode="full" defaults={ALL_JOBS_DEFAULT_FILTERS} />}
      {view === 'saved' && <SavedView jobs={jobs} state={state} loading={loading} onOpen={openDetail} onToggleSave={toggleSaved} onToggleHide={toggleHidden} onPrefetch={prefetchDetail} onNavigate={navigate} />}
      {view === 'hidden' && <HiddenView jobs={jobs} state={state} loading={loading} onOpen={openDetail} onToggleSave={toggleSaved} onToggleHide={toggleHidden} onPrefetch={prefetchDetail} onNavigate={navigate} />}
      <footer className="app-footer" style={{display:"flex",flexDirection:"column",gap:8}}><span>추천·전체는 최근 30일 공고 · 저장한 공고는 유지</span><span>운영 노드오프 · 대표 진동현 · 사업자등록번호 502-60-03676</span><span>인천광역시 · <a href="mailto:jin@nodeoff.kr">jin@nodeoff.kr</a> · <a href="https://nodeoff.kr" target="_blank" rel="noopener noreferrer">회사 홈페이지 ↗</a></span><small>© 2026 노드오프</small></footer>
    </main>
    <JobDetail job={selectedJob} open={Boolean(selectedJob || activeDetailRouteId)} state={state} detail={detail} detailLoading={detailLoading} routeLoading={routeDetailLoading} routeError={error} onClose={closeDetail} onRetry={() => selectedJob && loadDetail(selectedJob, { force: true })} onRouteRetry={() => loadJobs()} onToggleSave={toggleSaved} onToggleHide={toggleHidden} onShare={shareJob} />
    <SavedSyncPanel open={savedSyncOpen} connected={Boolean(savedSyncToken)} pairingCode={savedSyncPairingCode} pairingExpiresAt={savedSyncPairingExpiresAt} status={savedSyncStatus} savedCount={savedCount} onClose={() => setSavedSyncOpen(false)} onCreatePairing={createSavedSyncPairing} onRedeemPairing={redeemSavedSyncPairing} onDisconnect={disconnectSavedSync} onSyncNow={() => performSavedSync()} />
    <FeedbackPanel open={feedbackOpen} onClose={() => setFeedbackOpen(false)} view={view} job={selectedJob} />
    {liveMessage && <div className="status-toast" role="status"><span>{liveMessage}</span>{liveAction && <button type="button" className="status-toast-action" onClick={() => { liveAction.run(); setLiveMessage(''); setLiveAction(null); }}>{liveAction.label}</button>}</div>}
  </div>;
}
