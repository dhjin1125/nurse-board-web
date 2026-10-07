import express from 'express';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { registerIwinvRelay } from './lib/api-relay.mjs';
import iconv from 'iconv-lite';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import fs from 'node:fs';
import { createJobService } from './lib/job-service.mjs';
import { createJobDetailService, readDetailCache, writeDetailCache } from './lib/job-detail-service.mjs';
import { prepareJobForDisplay } from './lib/job-presentation.mjs';
import { registerJobRoutes } from './lib/job-routes.mjs';
import { createNurscapeImportCors, createNurscapeImportHandler } from './lib/nurscape-import.mjs';
import { registerAiJobRoutes } from './lib/ai-job-routes.mjs';
import { createBlobJsonStore } from './lib/blob-json-store.mjs';
import { createPublishedFeed } from './lib/published-feed.mjs';
import { createSavedSyncStore, registerSavedSyncRoutes } from './lib/saved-sync.mjs';
import { createCompanyReputationLookup, registerCompanyReputationRoute } from './lib/company-reputation.mjs';
import { createFeedbackStore, registerFeedbackRoutes } from './lib/feedback.mjs';
import { classifyExperienceDomain } from './lib/experience-domain.mjs';
import { extractDetailFacts, normalizeDetailSections, parseOrderedDetailSections } from './src/detail-sections.js';
import { ATTACHMENT_LIMITS, extractOfficialAttachmentText } from './lib/official-attachments.mjs';

try {
  process.loadEnvFile?.(fileURLToPath(new URL('./.env', import.meta.url)));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const app = express();
const NURSCAPE_CACHE = new URL('./data/nurscape-import.json', import.meta.url);
const JOB_CACHE = fileURLToPath(new URL('./data/jobs-cache.json', import.meta.url));
const DETAIL_CACHE = fileURLToPath(new URL('./data/job-details.json', import.meta.url));
const SAVED_SYNC_DIRECTORY = fileURLToPath(new URL('./data/saved-sync/', import.meta.url));
const FEEDBACK_DIRECTORY = fileURLToPath(new URL('./data/feedback/', import.meta.url));
const DIST_ROOT = fileURLToPath(new URL('./dist/', import.meta.url));
const DIST_INDEX = fileURLToPath(new URL('./dist/index.html', import.meta.url));
const BLOB_READ_WRITE_TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const BLOB_STORAGE_ENABLED = Boolean(BLOB_READ_WRITE_TOKEN);
const IWINV_RELAY_TOKEN = String(process.env.IWINV_RELAY_TOKEN || '').trim();
const WORK24_AUTH_KEY = String(process.env.WORK24_AUTH_KEY || '').trim();
const IS_COLLECTOR = process.env.IWINV_COLLECTOR === 'true';
const IS_VERCEL = Boolean(process.env.VERCEL) && !IS_COLLECTOR;
const publishedFeed = IS_COLLECTOR && BLOB_STORAGE_ENABLED ? createPublishedFeed({ token: BLOB_READ_WRITE_TOKEN }) : null;
const publishedFeedReader = IS_VERCEL && BLOB_STORAGE_ENABLED ? createPublishedFeed({ token: BLOB_READ_WRITE_TOKEN }) : null;
const configuredManualRefreshCooldownMs = Number(process.env.MANUAL_REFRESH_COOLDOWN_MS || 0);
const MANUAL_REFRESH_COOLDOWN_MS = IS_COLLECTOR
  ? Math.max(5 * 60_000, Number.isFinite(configuredManualRefreshCooldownMs) ? configuredManualRefreshCooldownMs : 0)
  : (Number.isFinite(configuredManualRefreshCooldownMs) ? configuredManualRefreshCooldownMs : 0);

function validIwinvOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

const IWINV_API_ORIGIN = IS_VERCEL ? validIwinvOrigin(process.env.IWINV_API_ORIGIN) : '';
if (IS_COLLECTOR && !IWINV_RELAY_TOKEN) {
  throw new Error('IWINV_RELAY_TOKEN is required for the IWINV collector');
}
if (IS_COLLECTOR && !BLOB_STORAGE_ENABLED) {
  throw new Error('BLOB_READ_WRITE_TOKEN is required for the IWINV collector');
}

function readSeedJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const jobCacheSeed = readSeedJson(JOB_CACHE, { version: 1, savedAt: null, sources: {} });
const nurscapeCacheSeed = readSeedJson(NURSCAPE_CACHE, { updatedAt: null, sourceUpdatedAt: null, jobs: [] });
const jobCacheStore = BLOB_STORAGE_ENABLED
  ? createBlobJsonStore({ pathname: 'nurse-board/jobs-cache.json', seed: jobCacheSeed, token: BLOB_READ_WRITE_TOKEN })
  : null;
const nurscapeCacheStore = BLOB_STORAGE_ENABLED
  ? createBlobJsonStore({ pathname: 'nurse-board/nurscape-import.json', seed: nurscapeCacheSeed, token: BLOB_READ_WRITE_TOKEN })
  : null;
const detailCacheStore = BLOB_STORAGE_ENABLED
  ? createBlobJsonStore({ pathname: 'nurse-board/job-details.json', seed: { version: 1, entries: {} }, token: BLOB_READ_WRITE_TOKEN })
  : null;
const savedSyncStore = createSavedSyncStore({
  token: BLOB_READ_WRITE_TOKEN,
  directory: SAVED_SYNC_DIRECTORY,
});
const companyReputationLookup = createCompanyReputationLookup();
const feedbackStore = createFeedbackStore({
  token: BLOB_READ_WRITE_TOKEN,
  directory: FEEDBACK_DIRECTORY,
});
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function secretMatches(actual, expected) {
  const actualBytes = Buffer.from(String(actual || ''));
  const expectedBytes = Buffer.from(String(expected || ''));
  return actualBytes.length === expectedBytes.length
    && expectedBytes.length > 0
    && timingSafeEqual(actualBytes, expectedBytes);
}

if (IS_COLLECTOR) {
  app.use('/api', (req, res, next) => {
    if (!secretMatches(req.get('authorization'), `Bearer ${IWINV_RELAY_TOKEN}`)) {
      return res.status(401).json({ error: '허용되지 않은 수집 서버 요청입니다.' });
    }
    return next();
  });
}

registerIwinvRelay(app, { origin: IWINV_API_ORIGIN, token: IWINV_RELAY_TOKEN, localReads: Boolean(publishedFeedReader) });

if (IS_COLLECTOR) {
  app.get('/api/healthz', (_req, res) => res.json({ status: 'ok', live: true }));
}
const NURSE_SOURCE = 'https://www.nursejob.co.kr/recruit/list.php?tch=nurse&m=new';
const NURSEJOB_MAX_PAGES = 10;
const ZIGHANG_API = 'https://api.zighang.com/api/recruitments';
const ZIGHANG_SOURCE = 'https://zighang.com/';
const ZIGHANG_MAX_PAGES = 10;
const NMC_SOURCE = 'https://www.nmc.or.kr/nmc/board/B0000007/';
const NMC_SEARCH_KEYWORDS = Object.freeze(['간호사', '간호직']);
const BOHUN_SOURCE = 'https://www.bohun.or.kr/main/na/ntt/selectNttList.do?bbsId=1158&mi=37030&rcrut=medical';
const BOHUN_SEARCHES = Object.freeze([
  { rcrut: 'medical', mi: '37030', keyword: '간호사' },
  { rcrut: 'medical', mi: '37030', keyword: '간호직' },
  { rcrut: 'care', mi: '37031', keyword: '간호사' },
  { rcrut: 'care', mi: '37031', keyword: '간호직' },
]);
const SARAMIN_SEARCH = 'https://www.saramin.co.kr/zf_user/search?searchType=search&searchword=';
export const SARAMIN_SEARCH_KEYWORDS = Object.freeze([
  '보건관리자',
  '산업간호사',
  '상근 간호사',
  '외래 간호사',
  '검진 간호사',
  'CRC 간호사',
]);
const MEDICALJOB_SEARCH = 'https://www.medicaljob.co.kr/job/list.asp';
export const MEDICALJOB_SEARCH_KEYWORDS = Object.freeze([
  '상근',
  '외래',
  '검진',
  'CRC',
]);
export const WORK24_SEARCH_KEYWORDS = Object.freeze([
  '상근 간호사',
  '외래 간호사',
  '검진 간호사',
  'CRC 간호사',
  '연구간호사',
  '산업간호사',
]);
const WORK24_OPEN_API = 'https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do';
const WORK24_HTML_SEARCH = 'https://www.work24.go.kr/wk/a/b/1200/retriveDtlEmpSrchListInPost.do';
const KEYWORD = '보건관리자';
const JOBKOREA_SOURCE = `https://www.jobkorea.co.kr/Search/?stext=${encodeURIComponent(KEYWORD)}`;
const CATCH_SOURCE = `https://www.catch.co.kr/Search/SearchList?Keyword=${encodeURIComponent(KEYWORD)}`;
const ALIO_SOURCE = `https://job.alio.go.kr/recruit.do?keyword=${encodeURIComponent(KEYWORD)}&pageSet=50&ing=2`;
const EXTRA_SOURCES = {
  zighang: ZIGHANG_SOURCE,
  nmc: NMC_SOURCE,
  bohun: BOHUN_SOURCE,
  nurselink: 'https://nurse-link.co.kr/jobs?jobCategoryIds=26',
  kaohn: 'https://www.kaohn.or.kr/board/bbs81_1',
  kisanhyup: 'https://kisanhyup.co.kr/bbs/board.php?bo_table=bd_num7',
  snuh: 'https://recruit.snuh.org/main.do',
  amc: 'https://recruit.amc.seoul.kr/recruit/career/list.do',
  samsung: 'https://www.samsunghospital.com/home/recruit/recruitInfo/recruitNotice.do',
  medicaljob: 'https://www.medicaljob.co.kr/job/',
  hospitaljob: 'https://www.byeongwonjob.com/cms/s01.php',
  cmc: 'https://recruit.cmcnu.or.kr/index.do',
  wanted: `https://www.wanted.co.kr/search?query=${encodeURIComponent(KEYWORD)}&tab=position`,
  snubh: 'https://snubh.recruiter.co.kr/appsite/company/getMainView',
  ncc: 'https://ncc.recruiter.co.kr/appsite/company/getMainView',
  rnjob: 'https://rnjob.koreanursing.or.kr/recruit/getJobOpenning.do',
  casemanager: 'https://www.casemanager.or.kr/bbs/board.php?bo_table=recruit_people',
  yuhs: 'https://yuhs.recruiter.co.kr/appsite/company/getMainView',
  eumc: 'https://eumc.applyin.co.kr/jobs?itemsPerPage=100',
  kumc: 'https://api-recruiter.recruiter.co.kr/position/v1/jobflex',
  khmc: 'https://recruit.incruit.com/khmc/job/',
  kuh: 'https://www.kuh.ac.kr/recruit/apply/noticeList.do',
  nursenet: 'https://nursenet.co.kr/jobs',
  paik: 'https://paik.recruiter.co.kr/appsite/company/getMainView',
  hallym: 'https://recruit.hallym.or.kr/hrt_p10_list.jsp?inggbn=ing&movePage=1',
  smc: 'https://api-recruiter.recruiter.co.kr/position/v1/jobflex',
  incruit: 'https://search.incruit.com/list/search.asp',
};

const CMC_INSTITUTIONS = [
  { path: 'cmcseoul', company: '서울성모병원', region: '서울' },
  { path: 'cmcsungmo', company: '여의도성모병원', region: '서울' },
  { path: 'cmcep', company: '은평성모병원', region: '서울' },
  { path: 'cmcujb', company: '의정부성모병원', region: '경기' },
  { path: 'cmcbucheon', company: '부천성모병원', region: '경기' },
  { path: 'cmcvincent', company: '성빈센트병원', region: '경기' },
];

const DETAIL_HOSTS = new Set([
  'www.nursejob.co.kr', 'nursejob.co.kr', 'www.saramin.co.kr', 'www.jobkorea.co.kr',
  'www.catch.co.kr', 'www.work24.go.kr', 'job.alio.go.kr', 'nurse-link.co.kr',
  'www.kaohn.or.kr', 'kisanhyup.co.kr', 'recruit.snuh.org', 'recruit.amc.seoul.kr',
  'www.samsunghospital.com', 'www.medicaljob.co.kr', 'www.byeongwonjob.com',
  'recruit.cmcnu.or.kr', 'www.wanted.co.kr', 'snubh.recruiter.co.kr',
  'ncc.recruiter.co.kr', 'rnjob.koreanursing.or.kr', 'job.nurscape.net',
  'recruit.nurscape.net', 'www.casemanager.or.kr', 'yuhs.recruiter.co.kr',
  'eumc.applyin.co.kr', 'kumc.recruiter.co.kr', 'recruit.incruit.com',
  'www.kuh.ac.kr', 'recruit.hallym.or.kr', 'zighang.com', 'www.nmc.or.kr',
  'www.bohun.or.kr', 'nursenet.co.kr', 'paik.recruiter.co.kr',
  'smc.recruiter.co.kr', 'job.incruit.com',
]);

const DETAIL_CONTENT_SELECTORS = {
  'www.saramin.co.kr': '.user_content',
  'www.jobkorea.co.kr': 'main',
  'www.catch.co.kr': '.recr_pop_inner3',
  'www.work24.go.kr': '.cont_wrap .scroll',
  'nurse-link.co.kr': 'main',
  'www.kaohn.or.kr': '.member_form_tb',
  'kisanhyup.co.kr': '.view-content',
  'recruit.snuh.org': '#content, .viewContent',
  'recruit.amc.seoul.kr': 'td.viewContent',
  'www.samsunghospital.com': '.rec_editor_renew25',
  'www.medicaljob.co.kr': 'td.css_apply',
  'www.byeongwonjob.com': '#template_content',
  'recruit.cmcnu.or.kr': '#temper',
  'www.wanted.co.kr': 'main',
  'snubh.recruiter.co.kr': '#viewSmartEditorContent',
  'ncc.recruiter.co.kr': '#viewSmartEditorContent',
  'rnjob.koreanursing.or.kr': '.view_w',
  'www.casemanager.or.kr': '#bo_v_con',
  'yuhs.recruiter.co.kr': '#viewSmartEditorContent',
  'eumc.applyin.co.kr': 'main',
  'kumc.recruiter.co.kr': 'main',
  'recruit.incruit.com': 'main, .inner-box',
  'www.kuh.ac.kr': '#content',
  'recruit.hallym.or.kr': '.career_detail .context',
  'www.nmc.or.kr': '.board_view, .post_view, .board_detail, .contents',
  'www.bohun.or.kr': '.bbsV_cont, .bbsV_atchmnfl',
  'nursenet.co.kr': 'main',
  'paik.recruiter.co.kr': '#viewSmartEditorContent, .view_detail, main',
  'smc.recruiter.co.kr': 'main',
  'job.incruit.com': '.job_info_detail, .section_view_jobdetail, #incruit_contents',
};

const NURSEJOB_OFFICIAL_DETAIL_PATHS = new Map([
  ['recruit.hallym.or.kr', /^\/hrt_p20_detail\.jsp$/u],
]);

const DETAIL_FIELD_ALIASES = {
  duties: ['담당업무', '담당 업무', '직무내용', '업무내용', '주요업무', '주요 업무', '근무내용', '모집내용'],
  qualifications: ['자격요건', '자격 요건', '지원자격', '지원 자격', '지원조건', '지원 조건', '응시자격', '응시요건', '필수요건', '필수 조건', '지원자격 및 우대사항', '면허/자격증', '자격면허'],
  preferredQualifications: ['우대사항', '우대요건', '우대조건', '우대 조건'],
  workConditions: ['근무조건', '근무 조건', '근로조건', '근로 조건', '근무환경'],
  recruitmentProcess: ['전형절차', '전형 절차', '전형 절차 및 안내 사항', '채용절차', '채용 절차', '전형방법', '전형일정', '채용일정', '채용과정'],
  applicationMethod: ['지원방법', '지원 방법', '접수방법', '접수 방법', '지원 방식', '지원기간 및 방법', '접수기간 및 방법', '제출서류'],
  otherInformation: ['기타사항', '유의사항', '안내사항', '참고사항', '개인정보 처리방침', '서류반환정책', '문의사항', '문의', '기타 안내'],
  deadlineText: ['마감기한', '접수마감', '지원마감', '접수기간', '지원기간', '서류접수기간'],
  experience: ['경력', '경력조건'], education: ['학력', '학력조건'],
  employment: ['고용형태', '채용형태', '근무형태'], salary: ['급여', '급여조건', '임금조건'],
  workHours: ['근무시간', '근무요일/시간', '근무요일 및 시간'], welfare: ['복리후생', '복지'],
  headcount: ['모집인원', '채용인원'], location: ['근무지', '근무 예정지', '근무지역'],
};

const DETAIL_DOCUMENT_FIELDS = [
  ['duties', DETAIL_FIELD_ALIASES.duties],
  ['qualifications', DETAIL_FIELD_ALIASES.qualifications],
  ['preferredQualifications', DETAIL_FIELD_ALIASES.preferredQualifications],
  ['workConditions', DETAIL_FIELD_ALIASES.workConditions],
  ['recruitmentProcess', DETAIL_FIELD_ALIASES.recruitmentProcess],
  ['applicationMethod', DETAIL_FIELD_ALIASES.applicationMethod],
  ['otherInformation', DETAIL_FIELD_ALIASES.otherInformation],
  ['deadlineText', DETAIL_FIELD_ALIASES.deadlineText],
];

export function parseNurseJob(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('.nurse_box .basic_box').each((_, node) => {
    const scope = $(node);
    const company = scope.find('.b_t_company').first().text().replace(/\s+/g, ' ').trim();
    const title = scope.find('.b_t_subject').first().text().replace(/\s+/g, ' ').trim();
    const region = scope.find('.b_i_area li').first().text().trim();
    const deadline = scope.find('.b_i_time li').first().text().trim() || '공고 확인';
    const experience = scope.find('.b_i_skill').first().text().replace(/\s+/g, ' ').trim() || '경력 미표기';
    const logoPath = scope.find('.basic_logo img').first().attr('src') || '';
    const href = scope.find('a[href*="r_idx="]').first().attr('href') || '';
    const id = href.match(/r_idx=(\d+)/)?.[1];
    if (company && title && id && !jobs.some((job) => job.id === `nursejob-${id}`)) {
      jobs.push({ id: `nursejob-${id}`, company, title, region: region || '지역 미표기', deadline, experience, logo: logoPath ? new URL(logoPath, 'https://www.nursejob.co.kr').href : '', source: '널스잡', category: 'clinical', url: `https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=${id}` });
    }
  });
  $('table.info_table tr[id^="l_"]').each((_, node) => {
    const scope = $(node);
    const id = scope.attr('id')?.replace('l_', '');
    const company = scope.find('.name').text().replace(/\s+/g, ' ').trim();
    const title = scope.find('.title').text().replace(/\s+/g, ' ').trim();
    const region = scope.find('.stxt').first().text().trim().split(/\s+/)[0] || '지역 미표기';
    const dateText = scope.find('.date').text().replace(/\s+/g, ' ').trim();
    const publishedAt = dateText.match(/(.*?)\s*등록/)?.[1]?.trim() || '';
    const deadline = dateText.match(/D-\d+|채용시|상시채용|\d{2}-\d{2}\s*\([^)]+\)/)?.[0] || '공고 확인';
    const existing = jobs.find((job) => job.id === `nursejob-${id}`);
    if (existing && publishedAt && !existing.publishedAt) existing.publishedAt = publishedAt;
    if (company && title && id && !existing) jobs.push({ id: `nursejob-${id}`, company, title, region, deadline, publishedAt, source: '널스잡', category: 'clinical', url: `https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=${id}` });
  });
  return jobs;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values || []);
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function nurseJobPageUrl(page) {
  const url = new URL(NURSE_SOURCE);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.href;
}

function nurseJobAvailablePages(html, maxPages) {
  const $ = cheerio.load(html);
  let lastPage = 1;
  $('a[href*="page="]').each((_, link) => {
    try {
      const page = Number(new URL($(link).attr('href') || '', NURSE_SOURCE).searchParams.get('page'));
      if (Number.isInteger(page) && page > lastPage) lastPage = page;
    } catch {}
  });
  return Math.max(1, Math.min(maxPages, lastPage));
}

export async function collectNurseJobJobs({
  fetcher = fetchText,
  maxPages = NURSEJOB_MAX_PAGES,
  concurrency = 3,
} = {}) {
  const pageLimit = Math.max(1, Math.min(20, Number(maxPages) || NURSEJOB_MAX_PAGES));
  const firstHtml = await fetcher(nurseJobPageUrl(1));
  const availablePages = nurseJobAvailablePages(firstHtml, pageLimit);
  const remainingPages = Array.from({ length: Math.max(0, availablePages - 1) }, (_, index) => index + 2);
  const remainingHtml = await mapWithConcurrency(remainingPages, concurrency, (page) => fetcher(nurseJobPageUrl(page)));
  const byId = new Map();
  for (const job of [firstHtml, ...remainingHtml].flatMap(parseNurseJob)) byId.set(job.id, job);
  return [...byId.values()];
}

function zighangListUrl(page, size = 100) {
  const url = new URL(ZIGHANG_API);
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(size));
  url.searchParams.append('depthOnes', '의료_보건');
  url.searchParams.append('depthTwos', '간호사');
  url.searchParams.append('regions', '서울');
  url.searchParams.append('regions', '경기');
  url.searchParams.set('sortCondition', 'LATEST');
  url.searchParams.set('orderCondition', 'DESC');
  return url.href;
}

function zighangCareer(item) {
  const min = Number(item?.careerMin);
  const rawMax = Number(item?.careerMax);
  const max = rawMax >= 100 ? Number.POSITIVE_INFINITY : rawMax;
  if (!Number.isFinite(min) && !Number.isFinite(max)) return '경력 미표기';
  if ((!min || min === 0) && (!max || max === 0 || max === Number.POSITIVE_INFINITY)) return '경력무관';
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min) return `경력 ${min}~${max}년`;
  if (Number.isFinite(min) && min > 0) return `경력 ${min}년 이상`;
  if (Number.isFinite(max) && max > 0) return `경력 ${max}년 이하`;
  return '경력무관';
}

function zighangDeadline(item) {
  const endDate = String(item?.endDate || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (endDate) return endDate;
  const type = String(item?.deadlineType || '').replace(/\s+/g, '');
  if (/채용시/.test(type)) return '채용시';
  if (/상시/.test(type)) return '상시채용';
  return '원문 확인';
}

function zighangCreatedAt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  // 직행 returns local Korean time without an offset. Make the source
  // timezone explicit so a UTC collector does not move the posting to the
  // following KST date.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) return `${text}+09:00`;
  return text;
}

function zighangDedupeKey(job) {
  return `${job.company}\n${job.title}`.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]+/gu, '');
}

export function parseZighangJobs(payload) {
  const items = payload?.data?.content;
  if (!Array.isArray(items)) return [];
  const byPosting = new Map();
  for (const item of items) {
    const id = String(item?.id || '').trim();
    const company = String(item?.company?.name || '').replace(/\s+/g, ' ').trim();
    const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
    const nursingCategory = Array.isArray(item?.depthTwos) && item.depthTwos.includes('간호사');
    const explicitNurseRole = /(간호\s*사|간호직|간호원|산업\s*간호|보건\s*관리(?:자|직)|\bRN\b)/i.test(title);
    if (!id || !company || !title || !nursingCategory || !explicitNurseRole || /간호\s*조무|조무사/.test(title)) continue;
    const job = {
      id: `zighang-${id}`,
      company,
      title,
      region: Array.isArray(item.regions) && item.regions.length ? item.regions.join(' · ') : '지역 미표기',
      deadline: zighangDeadline(item),
      experience: zighangCareer(item),
      employment: Array.isArray(item.employeeTypes) ? item.employeeTypes.join(' · ') : '',
      education: Array.isArray(item.educations) ? item.educations.join(' · ') : '',
      postedAt: zighangCreatedAt(item.createdAt),
      affiliate: String(item.affiliate || '').trim(),
      keywords: Array.isArray(item.keywords) ? item.keywords.filter(Boolean).slice(0, 12) : [],
      role: [title, ...(Array.isArray(item.keywords) ? item.keywords : [])].join(' '),
      source: '직행',
      category: /(보건\s*관리|산업\s*간호|사업장|EHS)/i.test(title) ? 'health' : 'clinical',
      url: `https://zighang.com/recruitment/${id}`,
    };
    const dedupeKey = zighangDedupeKey(job);
    if (!byPosting.has(dedupeKey)) byPosting.set(dedupeKey, job);
  }
  return [...byPosting.values()];
}

export async function collectZighangJobs({
  fetcher = fetchJson,
  maxPages = ZIGHANG_MAX_PAGES,
  concurrency = 3,
} = {}) {
  const first = await fetcher(zighangListUrl(0));
  if (!Array.isArray(first?.data?.content)) throw new Error('직행 채용 API 응답 형식이 바뀌었습니다.');
  const reportedPages = Math.max(1, Number(first?.data?.totalPages) || 1);
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || ZIGHANG_MAX_PAGES, reportedPages));
  const remainingPages = Array.from({ length: pageLimit - 1 }, (_, index) => index + 1);
  const remaining = await mapWithConcurrency(remainingPages, concurrency, (page) => fetcher(zighangListUrl(page)));
  const byPosting = new Map();
  for (const job of [first, ...remaining].flatMap(parseZighangJobs)) {
    const key = zighangDedupeKey(job);
    if (!byPosting.has(key)) byPosting.set(key, job);
  }
  return [...byPosting.values()];
}

export function parseNmcJobs(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('.post_title button[onclick*="/nmc/board/B0000007/"]').each((_, button) => {
    const scope = $(button);
    const row = scope.closest('tr');
    const title = scope.text().replace(/\s+/g, ' ').trim();
    const status = row.find('.post_status').text().replace(/\s+/g, ' ').trim();
    const path = (scope.attr('onclick') || '').match(/["'](\/nmc\/board\/B0000007\/\d+)["']/)?.[1] || '';
    const id = path.match(/(\d+)$/)?.[1] || '';
    const period = row.text().match(/((?:19|20)\d{2}-\d{2}-\d{2})\s*~\s*((?:19|20)\d{2}-\d{2}-\d{2})/);
    const employment = row.find('td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get()
      .find((value) => /^(?:무기계약직|계약직|정규직|공무직|기간제|인턴)$/.test(value)) || '';
    if (!id || !title || !/(간호\s*사|간호직|간호원)/.test(title) || /간호\s*조무|조무사/.test(title) || status !== '공고') return;
    jobs.push({
      id: `nmc-${id}`,
      company: '국립중앙의료원',
      title,
      region: '서울',
      deadline: period?.[2] || '원문 확인',
      postedAt: period?.[1] || '',
      employment,
      source: '국립중앙의료원',
      category: 'clinical',
      url: new URL(path, NMC_SOURCE).href,
    });
  });
  return jobs;
}

export async function collectNmcJobs({ fetcher = fetchText, keywords = NMC_SEARCH_KEYWORDS } = {}) {
  const settled = await Promise.allSettled([...new Set(keywords)].map(async (keyword) => {
    const url = new URL(NMC_SOURCE);
    url.searchParams.set('searchOption', 'pstTtl');
    url.searchParams.set('searchKeyword', keyword);
    url.searchParams.set('currentPage', '1');
    return parseNmcJobs(await fetcher(url.href));
  }));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled').flatMap((result) => result.value);
  if (!settled.some((result) => result.status === 'fulfilled')) throw new Error('국립중앙의료원 채용판을 확인하지 못했습니다.');
  return [...new Map(fulfilled.map((job) => [job.id, job])).values()];
}

const BOHUN_RESULT_NOTICE_PATTERN = /(?:최종\s*)?합격|발표|결과|안내|서류\s*전형|면접|필기|등록|임용|취소|변경|연장|재공고/;

function bohunCompany(title) {
  const bracketed = [...String(title).matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].trim());
  return bracketed.findLast((name) => name && name !== '한국보훈복지의료공단') || '한국보훈복지의료공단';
}

function bohunRegion(value) {
  const text = String(value || '');
  if (/중앙보훈병원|서울/.test(text)) return '서울';
  if (/수원|남양주|경기/.test(text)) return '경기';
  return text.match(/인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/)?.[0] || '지역 미표기';
}

export function parseBohunJobs(html, { mi = '37030', rcrut = 'medical' } = {}) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('a.nttInfoBtn[data-id]').each((_, link) => {
    const scope = $(link);
    const id = String(scope.attr('data-id') || '').trim();
    const rawTitle = scope.text().replace(/\s+/g, ' ').trim();
    const title = rawTitle.replace(/^(?:\[[^\]]+\]\s*)+/, '').trim();
    if (!id || !title || !/(간호\s*사|간호직|간호원|산업\s*간호|보건\s*관리(?:자|직))/.test(title)
      || /간호\s*조무|조무사/.test(title) || BOHUN_RESULT_NOTICE_PATTERN.test(title)) return;
    const rowText = scope.closest('tr').text().replace(/\s+/g, ' ').trim();
    const publishedAt = rowText.match(/(?:19|20)\d{2}[.]\d{2}[.]\d{2}/)?.[0]?.replaceAll('.', '-') || '';
    const company = bohunCompany(rawTitle);
    const url = new URL('https://www.bohun.or.kr/main/na/ntt/selectNttInfo.do');
    url.searchParams.set('mi', mi);
    url.searchParams.set('bbsId', '1158');
    url.searchParams.set('bbsSysId', 'main');
    url.searchParams.set('nttSn', id);
    jobs.push({
      id: `bohun-${id}`,
      company,
      title,
      region: bohunRegion(`${company} ${title}`),
      deadline: '원문 확인',
      postedAt: publishedAt,
      source: '보훈의료공단',
      category: /(보건\s*관리|산업\s*간호)/.test(title) ? 'health' : 'clinical',
      url: url.href,
      board: rcrut,
    });
  });
  return jobs;
}

export async function collectBohunJobs({
  fetcher = fetchText,
  searches = BOHUN_SEARCHES,
  now = new Date(),
  maxAgeDays = 21,
} = {}) {
  const settled = await Promise.allSettled(searches.map(async ({ rcrut, mi, keyword }) => {
    const url = new URL('https://www.bohun.or.kr/main/na/ntt/selectNttList.do');
    url.searchParams.set('bbsId', '1158');
    url.searchParams.set('mi', mi);
    url.searchParams.set('rcrut', rcrut);
    const html = await fetcher(url.href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: url.href },
      body: new URLSearchParams({ currPage: '1', rcrut, searchType: 'sj', searchValue: keyword, listCo: '50' }),
    });
    return parseBohunJobs(html, { mi, rcrut });
  }));
  if (!settled.some((result) => result.status === 'fulfilled')) throw new Error('보훈의료공단 채용판을 확인하지 못했습니다.');
  const observedAt = now instanceof Date ? now : new Date(now);
  const oldestAllowed = observedAt.getTime() - Math.max(1, Number(maxAgeDays) || 21) * 86_400_000;
  const byId = new Map();
  for (const job of settled.filter((result) => result.status === 'fulfilled').flatMap((result) => result.value)) {
    const publishedMs = Date.parse(job.postedAt || '');
    if (!Number.isFinite(publishedMs) || publishedMs < oldestAllowed || publishedMs > observedAt.getTime() + 86_400_000) continue;
    if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

export function parseSaramin(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('.item_recruit').each((_, node) => {
    const scope = $(node);
    const rawId = String(scope.attr('value') || '');
    const titleLink = scope.find('.job_tit a').first();
    const title = titleLink.text().replace(/\s+/g, ' ').trim();
    const company = scope.find('.corp_name a').first().text().replace(/\s+/g, ' ').trim();
    const conditions = scope.find('.job_condition span').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
    const region = scope.find('.job_condition span').first().find('a').first().text().trim() || conditions[0] || '지역 미표기';
    const deadline = scope.find('.job_date .date').first().text().replace(/\s+/g, '').trim() || '공고 확인';
    const sectors = scope.find('.job_sector a').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 5);
    const badge = scope.find('.area_badge .badge').first().text().replace(/\s+/g, ' ').trim();
    const postedAt = scope.find('.job_sector .job_day').first().text().replace(/\s+/g, ' ').trim();
    const href = titleLink.attr('href') || '';
    if (rawId && title && company) jobs.push({ id: `saramin-${rawId}`, company, title, region, deadline, experience: conditions[1] || '경력 미표기', education: conditions[2] || '학력 미표기', employment: conditions[3] || '고용형태 미표기', sectors, badge, postedAt, source: '사람인', category: 'health', url: new URL(href, 'https://www.saramin.co.kr').href });
  });
  return jobs;
}

export async function collectSaraminJobs({ fetcher = fetchText, keywords = SARAMIN_SEARCH_KEYWORDS, previousJobs = [] } = {}) {
  const requestedKeywords = [...new Set((Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword || '').trim()).filter(Boolean))];
  if (!requestedKeywords.length) return [];

  const settled = await Promise.allSettled(requestedKeywords.map(async (keyword) => ({
    keyword,
    jobs: parseSaramin(await fetcher(`${SARAMIN_SEARCH}${encodeURIComponent(keyword)}`)),
  })));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!fulfilled.length) throw new Error('사람인 검색을 모두 확인하지 못했습니다.');

  const failedKeywords = new Set(settled.flatMap((result, index) => result.status === 'rejected' ? [requestedKeywords[index]] : []));
  const byId = new Map();
  for (const { keyword, jobs } of fulfilled) {
    for (const job of jobs) {
      const previous = byId.get(job.id);
      byId.set(job.id, {
        ...(previous || {}),
        ...job,
        searchKeywords: [...new Set([...(previous?.searchKeywords || []), keyword])],
      });
    }
  }

  // 일부 검색만 실패하면 그 검색에서 보던 이전 공고를 유지해 목록이 갑자기 사라지지 않게 합니다.
  if (failedKeywords.size) {
    for (const previous of Array.isArray(previousJobs) ? previousJobs : []) {
      const previousKeywords = Array.isArray(previous.searchKeywords) ? previous.searchKeywords : [];
      const belongsToFailedSearch = !previousKeywords.length || previousKeywords.some((keyword) => failedKeywords.has(keyword));
      if (!belongsToFailedSearch || !previous?.id) continue;
      const current = byId.get(previous.id);
      if (!current) byId.set(previous.id, {
        ...previous,
        searchKeywords: previousKeywords.length ? previousKeywords : [...failedKeywords],
      });
      else byId.set(previous.id, {
        ...current,
        searchKeywords: [...new Set([
          ...(current.searchKeywords || []),
          ...previousKeywords.filter((keyword) => failedKeywords.has(keyword)),
        ])],
      });
    }
  }
  return [...byId.values()];
}

export function parseNurseDetail(html) {
  const $ = cheerio.load(html);
  let data = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try { const parsed = JSON.parse($(el).html()); if (parsed?.['@type'] === 'JobPosting') data = parsed; } catch {}
  });
  const clean = (value, limit = 1600) => normalizeDetailText(value, limit);
  const description = clean(data.description, 16_000);
  const sections = parseOrderedDetailSections(description);
  const documentSections = parseDetailDocumentText(description);
  const field = (label, limit = 1600) => {
    const target = $('dd').filter((_, el) => $(el).find('.tit').first().text().trim() === label).first();
    target.find('.tit').remove();
    return clean(target.html() || target.text(), limit);
  };
  const welfare = $('.newwelfare_list .con').map((_, el) => clean($(el).text())).get().filter(Boolean);
  return {
    experience: clean(data.experienceRequirements) || field('경력'),
    education: clean(data.educationRequirements) || field('학력'),
    employment: clean(data.employmentType) || field('고용형태'),
    salary: clean(data.baseSalary?.value?.value ? `${data.baseSalary.value.value} ${data.baseSalary.value.unitText || ''}` : '') || field('급여'),
    workHours: clean(data.workHours) || field('근무시간'),
    duties: field('담당업무') || documentSections.duties, qualifications: clean(data.qualifications) || field('면허/자격증') || documentSections.qualifications,
    preferredQualifications: field('우대사항') || documentSections.preferredQualifications, workConditions: field('근무조건') || documentSections.workConditions,
    recruitmentProcess: field('전형절차') || documentSections.recruitmentProcess, applicationMethod: field('지원방법') || documentSections.applicationMethod,
    otherInformation: field('기타사항', 2200) || documentSections.otherInformation, deadlineText: clean(data.validThrough, 500) || field('마감기한', 500) || documentSections.deadlineText,
    headcount: field('모집인원'), subway: field('전철역'), description, descriptionKind: description ? 'jobPosting' : '', sections, welfare,
  };
}

function hallymTableMatrix($, table) {
  const activeRowspans = new Map();
  return $(table).find('tr').map((_, row) => {
    const values = [];
    let column = 0;
    const consumeRowspans = () => {
      while (activeRowspans.has(column)) {
        const span = activeRowspans.get(column);
        values[column] = span.value;
        span.remaining -= 1;
        if (span.remaining <= 0) activeRowspans.delete(column);
        column += 1;
      }
    };
    consumeRowspans();
    $(row).children('th, td').each((__, cell) => {
      consumeRowspans();
      const value = nodeDetailText($, cell, 8000);
      const colspan = Math.max(1, Number($(cell).attr('colspan')) || 1);
      const rowspan = Math.max(1, Number($(cell).attr('rowspan')) || 1);
      for (let offset = 0; offset < colspan; offset += 1) {
        values[column + offset] = value;
        if (rowspan > 1) activeRowspans.set(column + offset, { value, remaining: rowspan - 1 });
      }
      column += colspan;
    });
    consumeRowspans();
    return [values];
  }).get();
}

function hallymGroupedLines(value) {
  const lines = normalizeDetailText(value, 12_000).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const groups = [];
  for (const line of lines) {
    const startsItem = /^(?:\d+[.)]|[-–—•※*])/u.test(line);
    if (!groups.length || startsItem) groups.push(line);
    else groups[groups.length - 1] = `${groups.at(-1)} ${line}`.replace(/\s+/g, ' ').trim();
  }
  return groups;
}

function hallymQualificationText(value) {
  const output = [];
  for (const line of hallymGroupedLines(value)) {
    const heading = line.match(/^\*\s*(.+)$/u)?.[1];
    if (heading) {
      output.push(`□ ${heading}`);
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s*(.+)$/u)?.[1];
    if (numbered) {
      output.push(`• ${numbered}`);
      continue;
    }
    if (/^\(아래\s+중/u.test(line)) {
      output.push(`※ ${line.replace(/^\(|\)$/g, '')}`);
      continue;
    }
    if (/^\(단[,，]/u.test(line) && output.at(-1)?.startsWith('• ')) {
      output[output.length - 1] = `${output.at(-1)} ${line}`;
      continue;
    }
    output.push(`• ${line.replace(/^[-–—•※]\s*/u, '')}`);
  }
  return output.join('\n');
}

function hallymSectionParagraphs($, context) {
  const sections = new Map();
  let current = '';
  $(context).children().each((_, node) => {
    if (node.tagName !== 'p') return;
    const line = normalizeDetailText($(node).text(), 4000);
    if (!line) return;
    const heading = line.match(/^(\d+)\.\s*(.+)$/u);
    if (heading) {
      current = heading[1];
      sections.set(current, { title: heading[2].trim(), lines: [] });
      return;
    }
    if (current) sections.get(current).lines.push(line);
  });
  return sections;
}

function cleanHallymListLine(value) {
  return normalizeDetailText(value, 4000)
    .replace(/^\s*(?:\d+[.)]|[-–—•])\s*/u, '')
    .replace(/^\.\s*/, '')
    .trim();
}

function nurseJobOfficialDetailUrl(html, sourceUrl) {
  const $ = cheerio.load(html);
  for (const node of $('a[href]').toArray()) {
    try {
      const candidate = new URL($(node).attr('href'), sourceUrl);
      const allowedPath = NURSEJOB_OFFICIAL_DETAIL_PATHS.get(candidate.hostname);
      if (candidate.protocol === 'https:' && !candidate.port && !candidate.username && !candidate.password && allowedPath?.test(candidate.pathname)) return candidate;
    } catch {}
  }
  return null;
}

export function parseHallymDetail(html, sourceUrl = '') {
  const $ = cheerio.load(html);
  const context = $('.career_detail .context').first();
  if (!context.length) return {};

  const title = normalizeDetailText($('.career_detail .tit').first().text(), 300);
  const publishedAt = normalizeDetailText(context.find('#gesi').first().text(), 300).match(/게시일\s*[:：]\s*(\d{4}[.-]\d{2}[.-]\d{2})/u)?.[1]?.replace(/\./g, '-');
  const table = context.find('table').first();
  const matrix = table.length ? hallymTableMatrix($, table) : [];
  const headers = (matrix[0] || []).map((value) => value.replace(/\s+/g, ' ').trim());
  const headerIndex = (pattern) => headers.findIndex((header) => pattern.test(header));
  const roleIndex = headerIndex(/^직종$/u);
  const departmentIndex = headerIndex(/진료과/u);
  const fieldIndex = headerIndex(/^분야$/u);
  const headcountIndex = headerIndex(/채용\s*인원/u);
  const qualificationIndex = headerIndex(/응시자격/u);
  const recruitmentRows = matrix.slice(1).map((row) => ({
    role: normalizeDetailText(row[roleIndex], 200),
    department: normalizeDetailText(row[departmentIndex], 300),
    field: normalizeDetailText(row[fieldIndex], 300),
    headcount: normalizeDetailText(row[headcountIndex], 100),
    qualification: normalizeDetailText(row[qualificationIndex], 8000),
  })).filter((row) => row.department || row.field);
  const uniqueRecruitmentRows = recruitmentRows.filter((row, index, rows) => rows.findIndex((candidate) => candidate.department === row.department && candidate.field === row.field) === index);
  const roles = [...new Set(uniqueRecruitmentRows.map((row) => row.role).filter(Boolean))];
  const recruitmentLines = [
    ...(roles.length ? roles.map((role) => `□ ${role}`) : []),
    ...uniqueRecruitmentRows.map((row) => `• ${[row.department, row.field].filter(Boolean).join(' · ')}`),
  ];
  if (uniqueRecruitmentRows.some((row) => /^0\s*명$/u.test(row.headcount))) {
    recruitmentLines.push("※ 채용 인원은 공식 공고에서 각 분야 ‘0명’으로 표기되어 있습니다. 정확한 인원은 지원 전에 확인해 주세요.");
  } else {
    recruitmentLines.push(...uniqueRecruitmentRows.filter((row) => row.headcount).map((row) => `• ${row.department || row.field} 채용 인원: ${row.headcount}`));
  }

  const qualification = hallymQualificationText(recruitmentRows.find((row) => row.qualification)?.qualification || '');
  const numberedSections = hallymSectionParagraphs($, context);
  const recruitmentNotes = hallymGroupedLines((numberedSections.get('1')?.lines || []).join('\n'));
  const employmentLine = recruitmentNotes.find((line) => /모집형태\s*[:：]/u.test(line)) || '';
  const workPatternStart = recruitmentNotes.findIndex((line) => /근무형태\s*[:：]/u.test(line));
  const workPatternLines = workPatternStart >= 0
    ? recruitmentNotes.slice(workPatternStart, recruitmentNotes.findIndex((line, index) => index > workPatternStart && /^※/u.test(line)) < 0 ? undefined : recruitmentNotes.findIndex((line, index) => index > workPatternStart && /^※/u.test(line)))
    : [];
  const applicationCaution = recruitmentNotes.find((line) => /자기소개서/u.test(line)) || '';
  const employment = confirmedEmployment(employmentLine) || '정규직';
  const workPatternSource = workPatternLines.join(' ').replace(/^※\s*근무형태\s*[:：]\s*/u, '').trim();
  const workPattern = /3\s*교대/u.test(workPatternSource) && /주근제/u.test(workPatternSource)
    ? '3교대·주근제(부서별)'
    : /3\s*교대/u.test(workPatternSource) ? '3교대'
      : /2\s*교대/u.test(workPatternSource) ? '2교대'
        : /주근제/u.test(workPatternSource) ? '주근제' : '';
  const workConditions = [
    employment && `고용 형태\n${employment}`,
    workPatternSource && `근무 형태\n${workPatternSource}`,
  ].filter(Boolean).join('\n');

  const scheduleLines = hallymGroupedLines((numberedSections.get('2')?.lines || []).join('\n'));
  const deadlineLine = scheduleLines.find((line) => /접수기간\s*[:：]/u.test(line)) || '';
  const applicationLine = scheduleLines.find((line) => /접수방법\s*[:：]/u.test(line)) || '';
  const deadlineText = deadlineLine.replace(/^\d+[.)]\s*접수기간\s*[:：]\s*/u, '').trim();
  const applicationText = applicationLine.replace(/^\d+[.)]\s*접수방법\s*[:：]\s*/u, '').trim();
  const recruitmentProcess = scheduleLines
    .filter((line) => /(?:서류전형|면접\s*전형)/u.test(line) && !/(?:접수기간|접수방법)/u.test(line))
    .map(cleanHallymListLine)
    .join('\n');
  const officialUrl = sourceUrl ? new URL(sourceUrl).href : '';
  const applicationMethod = [
    deadlineText && `접수 기간\n${deadlineText}`,
    applicationText && `접수 방법\n${applicationText}`,
    officialUrl && `공식 채용공고\n${officialUrl}`,
  ].filter(Boolean).join('\n');

  const documents = hallymGroupedLines((numberedSections.get('3')?.lines || []).join('\n'))
    .map((line) => `• ${cleanHallymListLine(line)}`).join('\n');
  const otherInformation = hallymGroupedLines((numberedSections.get('4')?.lines || []).join('\n'))
    .map((line) => `• ${cleanHallymListLine(line)}`).join('\n');
  const privacyLines = hallymGroupedLines((numberedSections.get('5')?.lines || []).join('\n'));
  const inquiryLine = privacyLines.find((line) => /문의처\s*[:：]/u.test(line)) || '';
  const privacy = privacyLines.filter((line) => line !== inquiryLine).map((line) => `• ${cleanHallymListLine(line)}`).join('\n');
  const inquiry = inquiryLine.replace(/^[-–—•]?\s*문의처\s*[:：]\s*/u, '').trim();

  const clinicalMonths = qualification.match(/임상경력\s*(\d+)개월\s*이상/u)?.[1];
  const supportMonths = qualification.match(/진료지원업무\s*경력\s*(\d+)개월\s*이상/u)?.[1];
  const experience = clinicalMonths
    ? `임상경력 ${clinicalMonths}개월 이상${supportMonths ? ` (진료지원업무 ${supportMonths}개월 이상 포함)` : ''} 또는 전문간호사`
    : '';
  const department = uniqueRecruitmentRows.length > 1 ? `복수 진료과(${uniqueRecruitmentRows.length}개 분야)` : uniqueRecruitmentRows[0]?.field || uniqueRecruitmentRows[0]?.department || '';
  const salary = /급여는\s*본원\s*내규/u.test(otherInformation) ? '병원 내규에 따름' : '';

  const sections = normalizeDetailSections([
    { key: 'duties', title: '모집 분야', content: recruitmentLines.join('\n'), kind: 'mixed' },
    { key: 'qualifications', title: '자격요건', content: qualification, kind: 'mixed' },
    { key: 'workConditions', title: '근무조건', content: workConditions, kind: 'mixed' },
    { key: 'recruitmentProcess', title: '전형일정', content: recruitmentProcess, kind: 'ordered' },
    { key: 'documents', title: '제출서류', content: documents, kind: 'list' },
    { key: 'applicationMethod', title: '지원방법', content: applicationMethod, kind: 'mixed' },
    { key: 'custom', title: '지원서 작성 유의사항', content: applicationCaution.replace(/^※\s*/, ''), kind: 'prose' },
    { key: 'otherInformation', title: '기타사항', content: otherInformation, kind: 'mixed' },
    { key: 'custom', title: '개인정보·중복지원 안내', content: privacy, kind: 'mixed' },
    { key: 'custom', title: '문의처', content: inquiry, kind: 'mixed' },
  ]);
  const description = sections.map((section) => `${section.title}\n${section.value}`).join('\n\n').slice(0, 20_000);
  return Object.fromEntries(Object.entries({
    title, publishedAt, experience, employment, salary, workPattern, department,
    duties: recruitmentLines.join('\n'), qualifications: qualification, workConditions,
    recruitmentProcess, applicationMethod, otherInformation, deadlineText,
    description, descriptionKind: description ? 'content' : '', sections, officialUrl,
  }).filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value)));
}

function normalizeDetailText(value, limit = 6000) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => normalizeDetailText(item, limit)).filter(Boolean).join(' · ').slice(0, limit);
  if (typeof value === 'object') return structuredValueText(value).slice(0, limit);
  const raw = String(value).replace(/\u200b|\ufeff/g, '');
  let text = raw;
  if (/<[a-z!/][\s\S]*>/i.test(raw) || /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.test(raw)) {
    const $fragment = cheerio.load(`<div id="detail-fragment">${raw}</div>`);
    $fragment('script, style, noscript, svg').remove();
    $fragment('br').replaceWith('\n');
    $fragment('p, li, tr, td, th, div, h1, h2, h3, h4').each((_, el) => $fragment(el).append('\n'));
    text = $fragment('#detail-fragment').text();
  }
  return text.replace(/\r/g, '').replace(/[ \t\u00a0\u2007\u202f]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function structuredValueText(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return normalizeDetailText(value);
  if (Array.isArray(value)) return [...new Set(value.map(structuredValueText).filter(Boolean))].join(' · ');
  const preferred = ['name', 'credentialCategory', 'value', 'minValue', 'maxValue', 'unitText', 'monthsOfExperience', 'description'];
  return [...new Set(preferred.flatMap((key) => key in value ? [structuredValueText(value[key])] : []).filter(Boolean))].join(' · ');
}

function findJobPosting(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findJobPosting(item); if (found) return found; }
    return null;
  }
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.includes('JobPosting')) return value;
  for (const nested of Object.values(value)) { const found = findJobPosting(nested); if (found) return found; }
  return null;
}

function formatSalary(value) {
  if (!value) return '';
  if (typeof value !== 'object') return normalizeDetailText(value, 300);
  const amount = value.value && typeof value.value === 'object' ? value.value : value;
  const values = amount.value != null ? [amount.value] : [amount.minValue, amount.maxValue].filter((item) => item != null);
  if (!values.length || values.every((item) => Number(item) === 0)) return '';
  const range = values.join(' ~ ');
  return [value.currency, range, amount.unitText].filter(Boolean).join(' ').trim();
}

function formatEmployment(value) {
  const labels = { FULL_TIME: '정규직', PART_TIME: '시간제', CONTRACTOR: '계약직', TEMPORARY: '기간제', INTERN: '인턴', PER_DIEM: '일용직', VOLUNTEER: '자원봉사' };
  return structuredValueText(value).split(' · ').filter(Boolean).map((item) => labels[item.toUpperCase()] || item).join(' · ');
}

function confirmedEmployment(value) {
  const formatted = formatEmployment(value);
  const classified = employmentFromText(formatted);
  if (classified) return classified;
  return /^(?:공무직|자원봉사|프리랜서)$/.test(formatted) ? formatted : '';
}

function formatLocation(value) {
  const locations = Array.isArray(value) ? value : value ? [value] : [];
  return locations.map((location) => {
    const address = location?.address || location;
    if (typeof address !== 'object') return normalizeDetailText(address, 300);
    return [address.addressRegion, address.addressLocality, address.streetAddress].filter(Boolean).join(' ');
  }).filter(Boolean).join(' · ');
}

function nodeDetailText($, node, limit = 6000) {
  const clone = $(node).clone();
  clone.find('script, style, noscript, svg, form').remove();
  clone.find('br').replaceWith('\n');
  clone.find('p, li, tr, td, th, div, h1, h2, h3, h4').each((_, el) => $(el).append('\n'));
  return normalizeDetailText(clone.text(), limit);
}

function labelMatches(text, aliases) {
  const label = normalizeDetailText(text, 120).replace(/\s*[:·-]\s*$/, '');
  return aliases.some((alias) => label === alias || label === `${alias} 조건`);
}

function extractLabeledValue($, aliases, limit = 1200) {
  let result = '';
  $('th, dt').each((_, el) => {
    if (!labelMatches($(el).text(), aliases)) return;
    const valueNode = el.tagName === 'dt' ? $(el).next('dd') : $(el).nextAll('td').first();
    const value = nodeDetailText($, valueNode, limit);
    if (value && value !== '-') { result = value; return false; }
  });
  if (result) return result;
  $('strong, b, label, span').each((_, el) => {
    const label = normalizeDetailText($(el).clone().children().remove().end().text(), 120);
    if (!labelMatches(label, aliases)) return;
    const parentText = nodeDetailText($, $(el).parent(), limit);
    const labelIndex = parentText.indexOf(label);
    const value = (labelIndex >= 0 ? parentText.slice(labelIndex + label.length) : parentText).replace(/^\s*[:：·•\-–—]?\s*/, '').trim();
    if (value.length > 1 && value.length <= limit) { result = value; return false; }
  });
  return result;
}

function extractHeadingSection($, aliases, limit = 1600) {
  let result = '';
  const headingSelector = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  $(headingSelector).each((_, el) => {
    if (!labelMatches($(el).text(), aliases)) return;
    const parts = [];
    let sibling = $(el).next();
    while (sibling.length && !sibling.is(headingSelector)) {
      const value = nodeDetailText($, sibling, Math.max(0, limit - parts.join('\n').length));
      if (value && value !== '-') parts.push(value);
      sibling = sibling.next();
    }
    const value = normalizeDetailText(parts.join('\n'), limit);
    if (value) { result = value; return false; }
  });
  return result;
}

function extractDetailSection($, aliases, limit = 1600) {
  return extractLabeledValue($, aliases, limit) || extractHeadingSection($, aliases, limit);
}

function parseDetailDocumentText(value) {
  const lines = normalizeDetailText(value, 6000).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const sections = {};
  let currentKey = '';
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*(?:\d+[.)]|[-–—•●▪·ㆍ])\s*/, '').replace(/^[^\p{L}\p{N}\[]+/u, '').replace(/^\[|\]$/g, '').trim();
    const separatorIndex = line.search(/[:：]/);
    const possibleLabel = (separatorIndex >= 0 ? line.slice(0, separatorIndex) : line).replace(/\s+/g, ' ').trim();
    const field = DETAIL_DOCUMENT_FIELDS.find(([, aliases]) => labelMatches(possibleLabel, aliases));
    if (field) {
      currentKey = field[0];
      if (!sections[currentKey]) sections[currentKey] = [];
      const remainder = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : '';
      if (remainder) sections[currentKey].push(remainder);
      continue;
    }
    if (currentKey) sections[currentKey].push(rawLine);
  }
  return Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, normalizeDetailText(items.join('\n'), key === 'otherInformation' ? 2200 : 1600)]).filter(([, text]) => text));
}

function extractContentText($, hostname) {
  const selector = hostname === 'www.jobkorea.co.kr' && $('#detail-content').length
    ? '#detail-content'
    : DETAIL_CONTENT_SELECTORS[hostname];
  if (!selector) return '';
  const texts = [];
  $(selector).each((_, node) => {
    const text = nodeDetailText($, node, 16_000);
    if (text.length < 40) return;
    if (texts.some((existing) => existing.includes(text))) return;
    const containedIndex = texts.findIndex((existing) => text.includes(existing));
    if (containedIndex >= 0) texts.splice(containedIndex, 1, text); else texts.push(text);
  });
  return texts.join('\n\n').slice(0, 16_000);
}

function splitBenefits(value) {
  const text = normalizeDetailText(value, 1600);
  if (!text) return [];
  const parts = text.split(/\n|\s*[•●▪]\s*/).map((item) => item.replace(/^[-·]\s*/, '').trim()).filter(Boolean);
  return [...new Set(parts)].slice(0, 12);
}

export function parseGenericJobDetail(html, sourceUrl) {
  const $ = cheerio.load(html);
  let posting = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (posting) return;
    try { posting = findJobPosting(JSON.parse($(el).html())); } catch {}
  });
  const hostname = new URL(sourceUrl).hostname;
  const sourceImages = [];
  if (hostname === 'www.saramin.co.kr') {
    $('.user_content img[src]').each((_, element) => {
      if (sourceImages.length >= 12) return;
      try {
        const imageUrl = new URL($(element).attr('src'), sourceUrl);
        if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== 'pds.saramin.co.kr' || imageUrl.port || imageUrl.username || imageUrl.password) return;
        if (!imageUrl.pathname.startsWith('/recruit/recruit/') || !/\.(?:jpe?g|png|webp)$/iu.test(imageUrl.pathname)) return;
        if (!sourceImages.includes(imageUrl.href)) sourceImages.push(imageUrl.href);
      } catch {}
    });
  }
  const content = extractContentText($, hostname);
  const metaDescription = normalizeDetailText($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'), 1800);
  const postingDescription = normalizeDetailText(posting?.description, 16_000);
  const preferEmbeddedContent = hostname === 'www.jobkorea.co.kr' && content.length >= 40;
  const description = preferEmbeddedContent ? content : postingDescription || content || metaDescription;
  const descriptionKind = preferEmbeddedContent || (!postingDescription && content) ? 'content' : postingDescription ? 'jobPosting' : metaDescription ? 'meta' : '';
  const sections = parseOrderedDetailSections(description);
  const sectionDetails = Object.fromEntries(sections.map((section) => [section.semanticKey || section.key, section.value]));
  const documentSections = parseDetailDocumentText(description);
  const sourceFacts = extractDetailFacts(description);
  const legacyTableSource = hostname === 'www.medicaljob.co.kr';
  const postingDuties = normalizeDetailText(posting?.responsibilities, 1600);
  const postingQualifications = normalizeDetailText(posting?.qualifications || posting?.skills, 1600);
  const postingPreferredQualifications = normalizeDetailText(posting?.preferredQualifications, 1600);
  const extractedDuties = sectionDetails.duties || (preferEmbeddedContent ? documentSections.duties : '') || extractDetailSection($, DETAIL_FIELD_ALIASES.duties) || documentSections.duties;
  const extractedQualifications = sectionDetails.qualifications || (preferEmbeddedContent ? documentSections.qualifications : '') || extractDetailSection($, DETAIL_FIELD_ALIASES.qualifications) || documentSections.qualifications;
  const extractedPreferredQualifications = sectionDetails.preferredQualifications || (preferEmbeddedContent ? documentSections.preferredQualifications : '') || extractDetailSection($, DETAIL_FIELD_ALIASES.preferredQualifications) || documentSections.preferredQualifications;
  const duties = preferEmbeddedContent ? extractedDuties || postingDuties : postingDuties || extractedDuties;
  const qualifications = preferEmbeddedContent ? extractedQualifications || postingQualifications : postingQualifications || extractedQualifications;
  const preferredQualifications = preferEmbeddedContent ? extractedPreferredQualifications || postingPreferredQualifications : postingPreferredQualifications || extractedPreferredQualifications;
  const workConditions = sectionDetails.workConditions || extractDetailSection($, DETAIL_FIELD_ALIASES.workConditions) || documentSections.workConditions;
  const recruitmentProcess = sectionDetails.recruitmentProcess
    || (legacyTableSource ? '' : extractDetailSection($, DETAIL_FIELD_ALIASES.recruitmentProcess) || documentSections.recruitmentProcess);
  const applicationMethod = sectionDetails.applicationMethod || extractDetailSection($, DETAIL_FIELD_ALIASES.applicationMethod) || documentSections.applicationMethod;
  const otherInformation = sectionDetails.otherInformation || extractDetailSection($, DETAIL_FIELD_ALIASES.otherInformation, 2200) || documentSections.otherInformation;
  const deadlineText = normalizeDetailText(posting?.validThrough, 300) || sectionDetails.deadlineText || extractDetailSection($, DETAIL_FIELD_ALIASES.deadlineText, 500) || documentSections.deadlineText;
  const welfareText = structuredValueText(posting?.jobBenefits || posting?.incentiveCompensation) || sectionDetails.benefits
    || (legacyTableSource ? '' : extractDetailSection($, DETAIL_FIELD_ALIASES.welfare, 1600));
  const employment = confirmedEmployment(posting?.employmentType || extractLabeledValue($, DETAIL_FIELD_ALIASES.employment, 120) || sourceFacts.employment);
  const detail = {
    experience: structuredValueText(posting?.experienceRequirements) || extractLabeledValue($, DETAIL_FIELD_ALIASES.experience, 120),
    education: structuredValueText(posting?.educationRequirements) || extractLabeledValue($, DETAIL_FIELD_ALIASES.education, 120),
    employment,
    salary: formatSalary(posting?.baseSalary) || sourceFacts.salary || extractLabeledValue($, DETAIL_FIELD_ALIASES.salary, 300),
    workHours: normalizeDetailText(posting?.workHours, 700) || sourceFacts.workHours || extractLabeledValue($, DETAIL_FIELD_ALIASES.workHours, 700),
    duties, qualifications, preferredQualifications, workConditions, recruitmentProcess, applicationMethod, otherInformation, deadlineText, welfare: splitBenefits(welfareText),
    headcount: (() => {
      const value = normalizeDetailText(posting?.totalJobOpenings, 100) || sourceFacts.headcount || extractLabeledValue($, DETAIL_FIELD_ALIASES.headcount, 100);
      return /^0\s*명$/u.test(value) ? '' : value;
    })(),
    location: (legacyTableSource ? sourceFacts.location : '') || formatLocation(posting?.jobLocation) || sourceFacts.location || extractLabeledValue($, DETAIL_FIELD_ALIASES.location, 500),
    description, descriptionKind, sections,
    sourceImages,
  };
  return Object.fromEntries(Object.entries(detail).filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value)));
}

function parseCaseManagerDetail(html, sourceUrl) {
  const generic = parseGenericJobDetail(html, sourceUrl);
  const text = normalizeDetailText(generic.description, 16_000).replace(/\s+/g, ' ').trim();
  const section = (start, end) => {
    const from = text.search(start);
    if (from < 0) return '';
    const remainder = text.slice(from).replace(start, '').trim();
    const to = remainder.search(end);
    return (to < 0 ? remainder : remainder.slice(0, to)).trim();
  };
  const capture = (source, pattern) => source.match(pattern)?.[1]?.trim().replace(/\s+/g, ' ') || '';
  const overview = section(/1\.\s*모집에\s*관한\s*사항/u, /2\.\s*전형절차/u);
  const process = section(/2\.\s*전형절차/u, /3\.\s*전형일정/u);
  const documents = section(/4\.\s*입증자료\s*제출\(등록\)\s*안내/u, /5\.\s*특전/u);
  const benefits = section(/5\.\s*특전/u, /6\.\s*기타사항/u);
  const otherInformation = section(/6\.\s*기타사항/u, /인제대학교\s*일산백병원\s*$/u);
  const department = capture(overview, /나\.\s*근무부서\s*:\s*(.+?)(?=\s+(?:다\.|라\.|마\.|바\.)\s|$)/u);
  const workHours = capture(overview, /[-–—]\.?\s*근무\s*형태\s*:\s*(.+?)(?=\s+[-–—]\.?\s*|\s+[마바]\.\s|$)/u);
  const duties = capture(overview, /[-–—]\.?\s*근무\s*내용\s*:\s*(.+?)(?=\s+마\.\s|\s+바\.\s|$)/u);
  const qualifications = capture(overview, /[-–—]\.?\s*\[필수\]\s*(.+?)(?=\s+[-–—]\.?\s*\[우대\]|\s+바\.\s|$)/u);
  const preferredQualifications = capture(overview, /[-–—]\.?\s*\[우대\]\s*(.+?)(?=\s+바\.\s|$)/u);
  const employment = confirmedEmployment(capture(overview, /[-–—]\.?\s*고용\s*형태\s*:\s*(.+?)(?=\s+[-–—]\.?\s*|\s+[마바]\.\s|$)/u));
  const salary = capture(overview, /급여는\s*(.+?)(?=\s+[-–—]\.?\s*임용|\s+2\.\s*전형절차|$)/u);
  const deadline = capture(text, /((?:19|20)\d{2}년\s*\d{1,2}월\s*\d{1,2}일\s*\([^)]*\)\s*[~～]\s*(?:19|20)\d{2}년\s*\d{1,2}월\s*\d{1,2}일\s*\([^)]*\)\s*까지)/u);
  const applicationMethod = [
    capture(section(/3\.\s*전형일정/u, /4\.\s*입증자료/u), /가\.\s*원서접수\s*\(([^)]*)\)/u),
    deadline,
    capture(text, /(https:\/\/paik\.recruiter\.co\.kr)/u),
  ].filter(Boolean).join(' · ');
  const workConditions = salary ? `급여: ${salary}` : '';
  const sections = [
    { key: 'duties', semanticKey: 'duties', title: '모집 내용', value: [department && `근무부서: ${department}`, workHours && `근무형태: ${workHours}`, duties && `근무내용: ${duties}`, generic.headcount && `모집인원: ${generic.headcount}`].filter(Boolean).join('\n') },
    { key: 'qualifications', semanticKey: 'qualifications', title: '필수 자격요건', value: qualifications },
    { key: 'preferredQualifications', semanticKey: 'preferredQualifications', title: '우대사항', value: preferredQualifications },
    { key: 'workConditions', semanticKey: 'workConditions', title: '급여', value: workConditions },
    { key: 'recruitmentProcess', semanticKey: 'recruitmentProcess', title: '전형절차', value: process },
    { key: 'applicationMethod', semanticKey: 'applicationMethod', title: '접수기간·방법', value: applicationMethod },
    { key: 'documents', semanticKey: 'documents', title: '제출서류', value: documents },
    { key: 'benefits', semanticKey: 'benefits', title: '특전', value: benefits },
    { key: 'otherInformation', semanticKey: 'otherInformation', title: '기타사항', value: otherInformation },
  ].filter(({ value }) => value);
  return {
    ...generic,
    department,
    workPattern: workHours,
    workHours,
    duties,
    qualifications,
    preferredQualifications,
    employment: employment || generic.employment,
    salary,
    workConditions,
    recruitmentProcess: process,
    applicationMethod,
    deadlineText: deadline,
    otherInformation: [otherInformation, benefits && `특전: ${benefits}`].filter(Boolean).join('\n'),
    sections,
  };
}

function officialNoticeSemanticKey(title) {
  const token = String(title || '').replace(/\s+/g, '');
  if (/채용분야|채용인원|모집분야/u.test(token)) return 'duties';
  if (/지원자격|응시자격|자격요건/u.test(token)) return 'qualifications';
  if (/^급여|보수|복리후생/u.test(token)) return 'workConditions';
  if (/^전형절차|전형방법/u.test(token)) return 'recruitmentProcess';
  if (/지원서접수|원서접수|접수기간/u.test(token)) return 'applicationMethod';
  if (/우대사항|우대요건/u.test(token)) return 'preferredQualifications';
  if (/제출서류/u.test(token)) return 'documents';
  if (/^기타|유의사항/u.test(token)) return 'otherInformation';
  return '';
}

function officialNoticeDisplayTitle(title, content) {
  const token = String(title || '').replace(/\s+/g, '');
  if (/채용분야별채용인원/u.test(token)) return '채용 직무·인원';
  if (/^급여$/u.test(token)) return '급여·복지';
  if (/지원서접수/u.test(token)) return '접수 기간·방법';
  if (/^기타$/u.test(token) && /최초\s*임용계약|정년까지/u.test(content)) return '고용 안정성·기타 안내';
  return String(title || '').replace(/\s+/g, ' ').trim();
}

function cleanOfficialNoticeLine(value) {
  return String(value || '')
    .replace(/^[\s\u00ad\-–—•●▪·ㆍ○□⦁]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseOfficialNoticeText(value) {
  const description = normalizeDetailText(String(value || '').replace(/\f/g, '\n'), 40_000);
  if (!description) return {};

  const leading = [];
  const rawSections = [];
  let current = null;
  for (const line of description.split('\n')) {
    const heading = line.match(/^(\d{1,2})\.\s+(.{1,180})$/u);
    if (heading) {
      if (current) rawSections.push(current);
      const headingText = heading[2].trim();
      const headingParts = headingText.match(/^(.{1,100}?)[ \t]*[:：][ \t]*(.+)$/u);
      const title = (headingParts?.[1] || headingText).trim();
      const inlineContent = (headingParts?.[2] || '').trim();
      current = { number: Number(heading[1]), title, lines: inlineContent ? [inlineContent] : [] };
      continue;
    }
    (current?.lines || leading).push(line);
  }
  if (current) rawSections.push(current);

  const sectionRecords = rawSections.map((section) => {
    const content = normalizeDetailText(section.lines.join('\n'), 16_000);
    const semanticKey = officialNoticeSemanticKey(section.title);
    const title = officialNoticeDisplayTitle(section.title, content);
    const customKey = /전형일정/u.test(section.title) ? 'recruitmentSchedule'
      : /블라인드/u.test(section.title) ? 'blindHiring'
        : /이의신청/u.test(section.title) ? 'appeals'
          : /문의처|문의사항/u.test(section.title) ? 'inquiry'
            : `officialSection${section.number}`;
    return {
      key: semanticKey || customKey,
      semanticKey,
      title,
      content,
      kind: semanticKey === 'introduction' || semanticKey === 'otherInformation' ? 'prose' : 'mixed',
    };
  }).filter((section) => section.content);

  const leadingContent = normalizeDetailText(leading.join('\n'), 4000);
  const sections = normalizeDetailSections([
    ...(leadingContent ? [{ key: 'introduction', title: '공고 개요', content: leadingContent, kind: 'prose' }] : []),
    ...sectionRecords,
  ]);
  const contentFor = (pattern) => rawSections.filter((section) => pattern.test(section.title))
    .map((section) => normalizeDetailText(section.lines.join('\n'), 16_000)).filter(Boolean).join('\n\n');
  const duties = contentFor(/채용분야|채용인원|모집분야/u);
  const qualifications = contentFor(/지원자격|응시자격|자격요건/u);
  const payAndBenefits = contentFor(/^급여|보수|복리후생/u);
  const process = contentFor(/^전형절차|전형방법/u);
  const schedule = contentFor(/전형일정|채용일정/u);
  const applicationMethod = contentFor(/지원서\s*접수|원서\s*접수|접수기간/u);
  const preferredQualifications = contentFor(/우대사항|우대요건/u);
  const otherInformation = contentFor(/블라인드|^기\s*타$|유의사항|이의신청|문의처|문의사항/u);
  const experienceLine = qualifications.split('\n').map(cleanOfficialNoticeLine)
    .find((line) => /경력\s*\d+\s*년\s*이상/u.test(line)) || '';
  const salaryValue = payAndBenefits.match(/(?:약\s*)?\d{1,3}(?:,\d{3})+\s*천원/u)?.[0]
    || payAndBenefits.match(/(?:연봉|월급)\s*[^\n]{1,40}/u)?.[0]
    || '';
  const headcount = duties.match(/(?:^|\s)([1-9]\d*)\s*명(?:\s|$)/u)?.[0]?.trim() || '';
  const deadlineText = applicationMethod.split('\n').map(cleanOfficialNoticeLine)
    .find((line) => /(?:\d{2,4}[.년-].*)?~.*\d{1,2}:\d{2}/u.test(line)) || '';
  const detail = {
    description,
    descriptionKind: 'content',
    sections,
    duties,
    qualifications,
    preferredQualifications,
    workConditions: payAndBenefits,
    recruitmentProcess: [process, schedule].filter(Boolean).join('\n\n'),
    applicationMethod,
    otherInformation,
    experience: experienceLine,
    salary: salaryValue ? (/^연봉/u.test(salaryValue) ? salaryValue : `연봉 ${salaryValue}`) : '',
    headcount,
    deadlineText,
    employment: /정규직/u.test(description.slice(0, 800)) ? '정규직' : '',
    detailSource: 'official-attachment',
  };
  return Object.fromEntries(Object.entries(detail).filter(([, item]) => Array.isArray(item) ? item.length : Boolean(item)));
}

function safeOfficialRecruiterUrl(value, baseUrl) {
  try {
    const url = normalizeDetailUrl(new URL(String(value || ''), baseUrl));
    return isAllowedDetailUrl(url)
      && url.protocol === 'https:'
      && url.hostname.endsWith('.recruiter.co.kr')
      && /^\/app\/jobnotice\/view\/?$/u.test(url.pathname)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function extractOfficialRecruiterUrl(html, sourceUrl) {
  const $ = cheerio.load(html);
  const candidates = $('a[href]').map((_, element) => $(element).attr('href')).get();
  const searchable = $.html().replace(/&amp;/giu, '&').replace(/\\\//g, '/');
  candidates.push(...(searchable.match(/https:\/\/[^\s"'<>]+\.recruiter\.co\.kr\/app\/jobnotice\/view\?[^\s"'<>]+/giu) || []));
  for (const candidate of candidates) {
    const cleaned = String(candidate || '').replace(/[),.;]+$/u, '');
    const url = safeOfficialRecruiterUrl(cleaned, sourceUrl);
    if (url) return url;
  }
  return null;
}

function safeOfficialAssetUrl(value, sourceUrl, kind) {
  try {
    const url = new URL(String(value || ''), sourceUrl);
    const source = new URL(sourceUrl);
    if (!safeOfficialRecruiterUrl(source.href, source.href)) return null;
    if (url.protocol !== 'https:' || url.hostname !== source.hostname || url.port || url.username || url.password) return null;
    if (kind === 'image' && !/^\/upload\//u.test(url.pathname)) return null;
    if (kind === 'attachment' && !/^\/(?:mrs2\/)?attachFile\/downloadFile\/?$/iu.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function parseOfficialRecruiterAssets(html, sourceUrl) {
  const $ = cheerio.load(html);
  const sourceImages = [];
  $('#viewSmartEditorContent img[src]').each((_, element) => {
    const url = safeOfficialAssetUrl($(element).attr('src'), sourceUrl, 'image');
    if (!url || !/\.(?:jpe?g|png|webp)$/iu.test(url.pathname) || sourceImages.includes(url.href)) return;
    if (sourceImages.length < 12) sourceImages.push(url.href);
  });
  const attachments = [];
  $('a.fileWrapperView[href], a[href*="attachFile"]').each((_, element) => {
    const url = safeOfficialAssetUrl($(element).attr('href'), sourceUrl, 'attachment');
    if (!url || attachments.some((attachment) => attachment.url === url.href) || attachments.length >= 8) return;
    const name = normalizeDetailText($(element).text(), 240) || '공식 첨부파일';
    const extension = name.match(/\.([a-z\d]{2,5})$/iu)?.[1]
      || url.searchParams.get('fileUid')?.match(/\.([a-z\d]{2,5})$/iu)?.[1]
      || '';
    attachments.push({ name, url: url.href, type: extension.toUpperCase() || 'FILE' });
  });
  return { sourceImages, attachments };
}

function joinOfficialText(values, limit = 16_000) {
  return [...new Set(values.filter(Boolean))].join('\n\n').slice(0, limit);
}

// Preserve table rows so each department stays associated with its requirements.
function officialTableRows($, table) {
  const spans = [];
  const rows = [];
  $(table).find('tr').filter((_, row) => $(row).closest('table')[0] === table).each((_, row) => {
    const cells = [];
    for (let col = 0; col < spans.length; col += 1) {
      if (spans[col]?.remaining > 0) { cells[col] = spans[col].text; spans[col].remaining -= 1; }
    }
    let col = 0;
    $(row).children('td, th').each((_, cell) => {
      while (cells[col] !== undefined) col += 1;
      const text = nodeDetailText($, cell, 3000).replace(/\s+/g, ' ').trim();
      const width = Math.min(20, Math.max(1, Number($(cell).attr('colspan')) || 1));
      const height = Math.min(100, Math.max(1, Number($(cell).attr('rowspan')) || 1));
      for (let n = 0; n < width; n += 1) {
        cells[col] = text;
        if (height > 1) spans[col] = { text, remaining: height - 1 };
        col += 1;
      }
    });
    rows.push(cells);
  });
  return rows;
}

export function parseOfficialRecruiterDetail(html, sourceUrl) {
  const $ = cheerio.load(html);
  const root = $('#viewSmartEditorContent').first().clone();
  const requirements = [];
  const departments = [];
  const recruitmentRoles = [];
  root.find('table').each((_, table) => {
    const rows = officialTableRows($, table);
    const header = rows.findIndex((cells) => /모집분야|채용분야|부서|진료과/u.test(cells.join('').replace(/\s/g, ''))
      && /응시요건|응시자격|지원자격|자격요건/u.test(cells.join('').replace(/\s/g, '')));
    if (header >= 0) {
      const columns = rows[header].flatMap((value, index) => /모집분야|채용분야|부서|진료과/u.test(value.replace(/\s/g, '')) ? [index] : []);
      for (const cells of rows.slice(header + 1)) {
        if (!/간호|경력|면허/u.test(cells.join(' '))) continue;
        requirements.push([...new Set(cells.filter(Boolean))].join(' | '));
        const rowDepartments = [...new Set(columns.map((index) => cells[index]).filter((value) => value && !/^(?:간호직|간호사|보건직|직종)$/u.test(value)))];
        departments.push(...rowDepartments);
        if (rowDepartments.length) recruitmentRoles.push({ department: rowDepartments.join(' · '), qualifications: requirements.at(-1) });
      }
    }
    const replacement = $('<div></div>');
    for (const cells of rows) replacement.append($('<p></p>').text([...new Set(cells.filter(Boolean))].join(' | ')));
    $(table).replaceWith(replacement);
  });
  const description = nodeDetailText($, root, 40_000);
  const generic = parseGenericJobDetail(html, sourceUrl);
  const notice = description ? parseOfficialNoticeText(description) : {};
  const experience = requirements.filter((line) => /경력|경험/u.test(line));
  const caution = description.split('\n').filter((line) => /(?:교대|야간|휴일|온\s*콜|on[ -]?call|당직|근무형태)/iu.test(line));
  // A reservation that assignments/schedules may change is not evidence of a
  // current night or shift schedule. Keep it searchable as a source caution.
  const variableSchedule = (line) => /(?:병원|기관)\s*사정.{0,30}변경|근무형태.{0,40}변경.{0,15}(?:가능|수\s*있)/u.test(line);
  const workConditions = joinOfficialText([generic.workConditions, notice.workConditions, ...caution]
    .filter(Boolean).flatMap((text) => text.split('\n')).filter((line) => !variableSchedule(line)), 6000);
  const otherInformation = joinOfficialText([notice.otherInformation || generic.otherInformation, ...caution.filter(variableSchedule)]);
  return {
    ...generic,
    ...notice,
    ...(description ? { description, descriptionKind: 'content', detailSource: 'official-body' } : {}),
    ...(requirements.length ? { qualifications: joinOfficialText([requirements.join('\n'), notice.qualifications || generic.qualifications]) } : {}),
    ...(experience.length ? { experience: experience.join('\n').slice(0, 3000) } : {}),
    ...(departments.length ? {
      department: [...new Set(departments)].join(' · '), departments: [...new Set(departments)], recruitmentRoles,
      recruitmentScope: recruitmentRoles.length > 1 ? 'mixed' : 'single',
    } : {}),
    ...(workConditions ? { workConditions } : {}),
    ...(otherInformation ? { otherInformation } : {}),
    ...(extractDetailSection($, DETAIL_FIELD_ALIASES.deadlineText, 500) ? { deadlineText: extractDetailSection($, DETAIL_FIELD_ALIASES.deadlineText, 500) } : {}),
  };
}

export function parseOfficialRecruiterDocument(value) {
  const description = normalizeDetailText(value, ATTACHMENT_LIMITS.textChars);
  const fields = {};
  let field = '';
  for (const line of description.split('\n')) {
    const label = line.replace(/[\s:：\[\]]/gu, '');
    const next = /^(?:세부직무|담당업무|주요업무|직무내용|업무내용)$/u.test(label) ? 'duties'
      : /^(?:직무요건|자격요건|응시요건|지원자격)$/u.test(label) ? 'qualifications'
        : /^(?:비고|근무조건|근무시간|유의사항)$/u.test(label) ? 'workConditions'
          : /^(?:우대사항|우대요건)$/u.test(label) ? 'preferredQualifications' : '';
    if (next) { field = next; fields[field] ||= []; }
    else if (field) fields[field].push(line);
  }
  const detail = parseOfficialNoticeText(description);
  for (const [key, lines] of Object.entries(fields)) {
    const text = normalizeDetailText(lines.join('\n'), 16_000);
    if (text) detail[key] = text;
  }
  return detail;
}

export function parseWantedDetail(html) {
  const $ = cheerio.load(html);
  let wanted = null;
  try { wanted = JSON.parse($('#__NEXT_DATA__').html() || '{}')?.props?.pageProps?.initialData; } catch {}
  if (!wanted?.id) return {};
  const introSections = parseOrderedDetailSections(normalizeDetailText(wanted.intro, 16_000));
  const sections = normalizeDetailSections([
    ...introSections,
    { key: 'duties', title: '주요업무', content: normalizeDetailText(wanted.main_tasks, 16_000), kind: 'mixed' },
    { key: 'qualifications', title: '자격요건', content: normalizeDetailText(wanted.requirements, 16_000), kind: 'mixed' },
    { key: 'preferredQualifications', title: '우대사항', content: normalizeDetailText(wanted.preferred_points, 16_000), kind: 'mixed' },
    { key: 'benefits', title: '혜택 및 복지', content: normalizeDetailText(wanted.benefits, 16_000), kind: 'mixed' },
    { key: 'recruitmentProcess', title: '전형절차', content: normalizeDetailText(wanted.hire_rounds, 8000), kind: 'ordered' },
  ]);
  const from = wanted.career?.annual_from;
  const to = wanted.career?.annual_to;
  const experience = Number.isFinite(from) ? Number.isFinite(to) ? `${from}년~${to}년` : `${from}년 이상` : '';
  const employment = { regular: '정규직', contract: '계약직', intern: '인턴' }[wanted.employment_type] || normalizeDetailText(wanted.employment_type, 100);
  const description = sections.map((section) => `${section.title}\n${section.value}`).join('\n\n').slice(0, 20_000);
  return Object.fromEntries(Object.entries({
    title: normalizeDetailText(wanted.position, 300),
    company: normalizeDetailText(wanted.company?.company_name, 300),
    experience,
    employment,
    location: normalizeDetailText(wanted.address?.full_location || wanted.address?.location, 500),
    duties: normalizeDetailText(wanted.main_tasks, 4000),
    qualifications: normalizeDetailText(wanted.requirements, 4000),
    preferredQualifications: normalizeDetailText(wanted.preferred_points, 4000),
    deadlineText: wanted.status === 'active' && !wanted.due_time && !wanted.close_time ? '상시채용' : normalizeDetailText(wanted.due_time || wanted.close_time, 300),
    description,
    descriptionKind: description ? 'content' : '',
    sections,
  }).filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value)));
}

export function parseJobKorea(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('a[href*="/Recruit/GI_Read/"]').filter((_, el) => $(el).attr('class')?.includes('mb-0.5')).each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = href.match(/GI_Read\/(\d+)/)?.[1];
    const scope = link.closest('.rounded-2xl');
    const sameLinks = scope.find(`a[href*="GI_Read/${rawId}"]`).filter((_, a) => $(a).text().trim());
    const title = link.text().replace(/\s+/g, ' ').trim();
    const company = sameLinks.last().text().replace(/\s+/g, ' ').trim();
    const text = scope.text().replace(/\s+/g, ' ').trim();
    const region = text.match(/(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)(?:\s[^·,]+)?/)?.[1] || '지역 미표기';
    const deadline = text.match(/D-\d+|~\s?\d{1,2}\/\d{1,2}|오늘마감|내일마감|상시채용/)?.[0] || '공고 확인';
    if (rawId && title && company && !jobs.some((j) => j.id === `jobkorea-${rawId}`)) jobs.push({ id: `jobkorea-${rawId}`, company, title, region, deadline, source: '잡코리아', category: 'health', url: new URL(href, 'https://www.jobkorea.co.kr').href });
  });
  return jobs;
}

export function parseCatch(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('table.table2 tbody tr').each((_, node) => {
    const scope = $(node), link = scope.find('a[href*="RecruitInfoDetails"]').first(), href = link.attr('href') || '';
    const rawId = href.match(/RecruitInfoDetails\/(\d+)/)?.[1];
    const company = link.find('.t1').text().replace(/\s+/g, ' ').trim();
    const title = link.find('.name').text().replace(/\s+/g, ' ').trim();
    const region = link.find('.t3_2').text().trim() || '지역 미표기';
    if (rawId && company && title && !jobs.some((j) => j.id === `catch-${rawId}`)) jobs.push({ id: `catch-${rawId}`, company, title, region, deadline: '공고 확인', source: '캐치', category: 'health', url: new URL(href, 'https://www.catch.co.kr').href });
  });
  return jobs;
}

export function parseWork24(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('table#contentArea tbody tr[id^="list"]').each((_, node) => {
    const scope = $(node), link = scope.find('a[data-emp-detail]').first(), href = link.attr('href') || '';
    const rawId = new URL(href, 'https://www.work24.go.kr').searchParams.get('wantedAuthNo');
    const title = link.text().replace(/\s+/g, ' ').trim();
    const company = scope.find('.cp_name').first().text().replace(/\s+/g, ' ').trim();
    const text = scope.text().replace(/\s+/g, ' ').trim();
    const region = text.match(/(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)/)?.[1] || '지역 미표기';
    const deadline = text.match(/D-\d+|채용시까지|(?:\d{2,4}\/)?\d{1,2}\/\d{1,2}/)?.[0] || '공고 확인';
    if (rawId && company && title) jobs.push({ id: `work24-${rawId}`, company, title, region, deadline, source: '고용24', category: 'health', url: new URL(href, 'https://www.work24.go.kr').href });
  });
  return jobs;
}

function work24Date(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const compact = text.match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : text;
}

function work24Employment(code) {
  return {
    10: '기간의 정함이 없는 근로계약',
    11: '기간의 정함이 없는 근로계약(시간제)',
    20: '기간의 정함이 있는 근로계약',
    21: '기간의 정함이 있는 근로계약(시간제)',
  }[String(code || '').trim()] || '';
}

export function parseWork24OpenApi(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const jobs = [];
  const apiError = $('message, errMsg, returnAuthMsg, returnMsg').first().text().replace(/\s+/g, ' ').trim();
  if (apiError && !$('wanted').length) throw new Error(`고용24 Open API 응답 오류: ${apiError}`);

  $('wanted').each((_, node) => {
    const scope = $(node);
    const value = (name) => scope.find(name).first().text().replace(/\s+/g, ' ').trim();
    const rawId = value('wantedAuthNo');
    const company = value('company');
    const title = value('title');
    const hasNursingEvidence = /(간호사|간호직|간호팀|간호부|산업\s*간호|연구\s*간호|\bRN\b)/i.test(title);
    if (!rawId || !company || !title || !hasNursingEvidence) return;

    const region = value('region') || value('basicAddr') || '지역 미표기';
    const deadline = work24Date(value('closeDt')) || '원문 확인';
    const publishedAt = work24Date(value('regDt'));
    const salary = [value('salTpNm'), value('sal')].filter(Boolean).join(' · ');
    const education = [...new Set([value('minEdubg'), value('maxEdubg')].filter(Boolean))].join('~');
    const employment = work24Employment(value('empTpCd'));
    const url = value('wantedInfoUrl') || value('wantedMobileInfoUrl')
      || `https://www.work24.go.kr/wk/a/b/1500/empDetailAuthView.do?wantedAuthNo=${encodeURIComponent(rawId)}`;
    jobs.push({
      id: `work24-${rawId}`, company, title, region, deadline, publishedAt,
      salary, education, experience: value('career'), employment,
      workConditions: value('holidayTpNm'), source: '고용24', sourceProvider: '고용24 Open API',
      category: /(산업\s*간호|보건\s*관리|산업\s*보건)/i.test(title) ? 'health' : 'clinical',
      role: title, url,
    });
  });
  return jobs;
}

export async function collectWork24OpenApiJobs({ authKey = WORK24_AUTH_KEY, fetcher = fetchText, keywords = WORK24_SEARCH_KEYWORDS, previousJobs = [] } = {}) {
  const key = String(authKey || '').trim();
  if (!key) throw new Error('WORK24_AUTH_KEY가 설정되지 않았습니다.');
  const requestedKeywords = [...new Set((Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword || '').trim()).filter(Boolean))];
  if (!requestedKeywords.length) return [];

  const settled = await Promise.allSettled(requestedKeywords.map(async (keyword) => {
    const url = new URL(WORK24_OPEN_API);
    for (const [name, value] of Object.entries({
      authKey: key, callTp: 'L', returnType: 'XML', startPage: '1', display: '100',
      regDate: 'W-2', keyword, empTpGb: '1', sortOrderBy: 'DESC',
    })) url.searchParams.set(name, value);
    return { keyword, jobs: parseWork24OpenApi(await fetcher(url.href)) };
  }));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!fulfilled.length) throw new Error('고용24 Open API 검색을 모두 확인하지 못했습니다.');

  const failedKeywords = new Set(settled.flatMap((result, index) => result.status === 'rejected' ? [requestedKeywords[index]] : []));
  const byId = new Map();
  for (const { keyword, jobs } of fulfilled) {
    for (const job of jobs) {
      const previous = byId.get(job.id);
      byId.set(job.id, {
        ...(previous || {}), ...job,
        searchKeywords: [...new Set([...(previous?.searchKeywords || []), keyword])],
      });
    }
  }
  if (failedKeywords.size) {
    for (const previous of Array.isArray(previousJobs) ? previousJobs : []) {
      const previousKeywords = Array.isArray(previous.searchKeywords) ? previous.searchKeywords : [];
      const belongsToFailedSearch = !previousKeywords.length || previousKeywords.some((keyword) => failedKeywords.has(keyword));
      if (!belongsToFailedSearch || !previous?.id) continue;
      const current = byId.get(previous.id);
      if (!current) byId.set(previous.id, {
        ...previous,
        searchKeywords: previousKeywords.length ? previousKeywords : [...failedKeywords],
      });
      else byId.set(previous.id, {
        ...current,
        searchKeywords: [...new Set([...(current.searchKeywords || []), ...previousKeywords.filter((keyword) => failedKeywords.has(keyword))])],
      });
    }
  }
  return [...byId.values()];
}

export function parseAlio(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('a[href*="recruitview.do?idx="]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = href.match(/idx=(\d+)/)?.[1];
    const row = link.closest('tr'), cells = row.find('td');
    const title = link.text().replace(/\s+/g, ' ').trim();
    const company = cells.eq(3).text().replace(/\s+/g, ' ').trim() || '공공기관';
    const text = row.text().replace(/\s+/g, ' ').trim();
    const region = cells.eq(4).text().trim() || '지역 미표기';
    const deadline = cells.eq(7).text().replace(/\s+/g, ' ').trim() || '공고 확인';
    if (rawId && title) jobs.push({ id: `alio-${rawId}`, company, title, region, deadline, source: 'JOB-ALIO', category: 'health', url: new URL(href, 'https://job.alio.go.kr').href });
  });
  return jobs;
}

export function parseNurseLink(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[href^="/jobs/"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = href.match(/\/jobs\/(\d+)/)?.[1];
    const text = link.text().replace(/\s+/g, ' ').trim();
    const title = text.replace(/부서무관.*$/, '').trim();
    const company = title.replace(/^\[.*?\]\s*/, '').replace(/^\S+\s+\d{4}년\s*/, '').split(/보건관리자|산업간호사|간호사/)[0].trim() || '기관 정보 확인';
    const region = text.match(/(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)/)?.[1] || '지역 미표기';
    const deadline = title.match(/\[~([^\]]+)\]/)?.[1] || '공고 확인';
    if (rawId && title && !jobs.some((j) => j.id === `nurselink-${rawId}`)) jobs.push({ id: `nurselink-${rawId}`, company, title, region, deadline, source: '널스링크', category: 'health', url: new URL(href, 'https://nurse-link.co.kr').href });
  });
  return jobs;
}

export function parseKaohn(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[href*="/board/bbs81_1/"], a[href*="tbl=bbs81_1"][href*="mode=VIEW"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '';
    const url = new URL(href, 'https://www.kaohn.or.kr');
    if (url.origin !== 'https://www.kaohn.or.kr') return;
    const rawId = url.pathname.match(/^\/board\/bbs81_1\/(\d+)\/?$/)?.[1] || url.searchParams.get('num');
    const title = link.text().replace(/\s+/g, ' ').trim();
    const date = link.closest('tr').find('td').toArray().map((cell) => $(cell).text().trim())
      .find((value) => /^\d{4}[.\/-]\d{2}[.\/-]\d{2}$/.test(value));
    const postedAt = date?.replace(/[./]/g, '-');
    if (rawId && title && !/[채체]용\s*완료/.test(title) && !jobs.some((job) => job.id === `kaohn-${rawId}`)) jobs.push({ id: `kaohn-${rawId}`, company: '직업건강협회 구인게시판', title, region: title.match(/서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/)?.[0] || '지역 미표기', deadline: '원문 확인', ...(postedAt ? { postedAt } : {}), source: '직업건강협회', category: 'health', url: url.href });
  });
  return jobs;
}

export function parseKisanhyup(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a.item-subject[href*="bo_table=bd_num7"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = new URL(href).searchParams.get('wr_id'), title = link.text().replace(/\s+/g, ' ').trim();
    const row = link.closest('li, tr, .list-item'), text = row.text().replace(/\s+/g, ' ').trim();
    if (rawId && title) jobs.push({ id: `kisanhyup-${rawId}`, company: '전국기업체산업보건협의회', title, region: text.match(/서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/)?.[0] || '지역 미표기', deadline: '원문 확인', source: '산업보건협의회', category: 'health', url: href });
  });
  return jobs;
}

export function parseSnuh(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[href*="joining/recruit/view.do"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = new URL(href, 'https://recruit.snuh.org').searchParams.get('recruit_id'), title = link.text().replace(/\s+/g, ' ').trim();
    if (rawId && title && /간호/.test(title) && !/합격자|전형 결과|일정 공고/.test(title)) jobs.push({ id: `snuh-${rawId}`, company: '서울대학교병원', title, region: '서울', deadline: '원문 확인', source: '서울대병원', category: 'clinical', url: new URL(href, 'https://recruit.snuh.org').href });
  });
  return jobs;
}

export function parseAmc(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[onclick*="fnDetail"]').each((_, el) => {
    const link = $(el), onclick = link.attr('onclick') || '', ids = [...onclick.matchAll(/'(\d+)'/g)].map((m) => m[1]), title = link.text().replace(/\s+/g, ' ').trim();
    if (ids[0] && /간호/.test(title)) jobs.push({ id: `amc-${ids[0]}`, company: '서울아산병원', title, region: '서울', deadline: '원문 확인', source: '서울아산병원', category: 'clinical', url: `https://recruit.amc.seoul.kr/recruit/career/view.do?seq=${ids[0]}&scheduleno=${ids[1] || ''}` });
  });
  return jobs;
}

export function parseSamsung(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[href*="recruitNoticeView.do"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = new URL(href, 'https://www.samsunghospital.com').searchParams.get('RECRUIT_CD'), title = link.text().replace(/\s+/g, ' ').trim();
    const row = link.closest('tr'), role = row.find('td').eq(1).text().replace(/\s+/g, ' ').trim(), text = row.text().replace(/\s+/g, ' ').trim();
    if (rawId && title && (/간호/.test(title) || /간호사/.test(role))) jobs.push({ id: `samsung-${rawId}`, company: '삼성서울병원', title, region: '서울', deadline: text.match(/D-\d+|\d{4}\.\d{2}\.\d{2}/)?.[0] || '원문 확인', source: '삼성서울병원', category: 'clinical', url: new URL(href, 'https://www.samsunghospital.com').href });
  });
  return jobs;
}

export function parseMedicalJob(html) {
  const $ = cheerio.load(html), jobs = [];
  const grouped = new Map();
  const resultTable = $('table[width="680"]').filter((_, table) => /채용공고 제목/.test($(table).text())).first();
  const resultScope = resultTable.length ? resultTable : $.root();
  resultScope.find('a[href*="/job/view.asp"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = new URL(href, 'https://www.medicaljob.co.kr').searchParams.get('jsn'), text = link.text().replace(/\s+/g, ' ').trim();
    if (rawId && text) grouped.set(rawId, [...(grouped.get(rawId) || []), { text, href, row: link.closest('tr').text().replace(/\s+/g, ' ').trim() }]);
  });
  for (const [rawId, items] of grouped) {
    const title = [...items].sort((a, b) => b.text.length - a.text.length)[0].text;
    if (!/(간호사|간호직|보건관리)/.test(title) || /간호조무사/.test(title)) continue;
    const company = [...items].sort((a, b) => a.text.length - b.text.length)[0].text;
    const row = items[0].row;
    jobs.push({ id: `medicaljob-${rawId}`, company, title, region: row.match(/서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/)?.[0] || '지역 미표기', deadline: row.match(/채용시|D-\d+|(?:\d{2,4}\/)?\d{1,2}\/\d{1,2}/)?.[0] || '원문 확인', source: '메디컬잡', category: 'clinical', url: new URL(items[0].href, 'https://www.medicaljob.co.kr').href });
  }
  return jobs;
}

function encodeCp949FormValue(value) {
  let encoded = '';
  for (const byte of iconv.encode(String(value ?? ''), 'cp949')) {
    if ((byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || [0x2a, 0x2d, 0x2e, 0x5f].includes(byte)) {
      encoded += String.fromCharCode(byte);
    } else if (byte === 0x20) encoded += '+';
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

function medicalJobSearchBody(keyword) {
  return Object.entries({ jobid: 'etc', s_jkind: keyword, listsize: '50' })
    .map(([name, value]) => `${name}=${encodeCp949FormValue(value)}`)
    .join('&');
}

export async function collectMedicalJobJobs({ fetcher = fetchText, keywords = MEDICALJOB_SEARCH_KEYWORDS, previousJobs = [] } = {}) {
  const requestedKeywords = [...new Set((Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword || '').trim()).filter(Boolean))];
  if (!requestedKeywords.length) return [];

  const settled = await Promise.allSettled(requestedKeywords.map(async (keyword) => ({
    keyword,
    jobs: parseMedicalJob(await fetcher(MEDICALJOB_SEARCH, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=EUC-KR',
        referer: 'https://www.medicaljob.co.kr/job/',
      },
      body: medicalJobSearchBody(keyword),
    })),
  })));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!fulfilled.length) throw new Error('메디컬잡 검색을 모두 확인하지 못했습니다.');

  const failedKeywords = new Set(settled.flatMap((result, index) => result.status === 'rejected' ? [requestedKeywords[index]] : []));
  const byId = new Map();
  for (const { keyword, jobs } of fulfilled) {
    for (const job of jobs) {
      const previous = byId.get(job.id);
      byId.set(job.id, {
        ...(previous || {}),
        ...job,
        searchKeywords: [...new Set([...(previous?.searchKeywords || []), keyword])],
      });
    }
  }

  if (failedKeywords.size) {
    for (const previous of Array.isArray(previousJobs) ? previousJobs : []) {
      const previousKeywords = Array.isArray(previous.searchKeywords) ? previous.searchKeywords : [];
      const belongsToFailedSearch = !previousKeywords.length || previousKeywords.some((keyword) => failedKeywords.has(keyword));
      if (!belongsToFailedSearch || !previous?.id) continue;
      const current = byId.get(previous.id);
      if (!current) byId.set(previous.id, {
        ...previous,
        searchKeywords: previousKeywords.length ? previousKeywords : [...failedKeywords],
      });
      else byId.set(previous.id, {
        ...current,
        searchKeywords: [...new Set([
          ...(current.searchKeywords || []),
          ...previousKeywords.filter((keyword) => failedKeywords.has(keyword)),
        ])],
      });
    }
  }
  return [...byId.values()];
}

export function parseHospitalJob(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[title="상세채용정보보기"][href*="s01_v.php"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = new URL(href, 'https://www.byeongwonjob.com').searchParams.get('idx'), title = link.text().replace(/\s+/g, ' ').trim();
    if (!rawId || !title || !/(간호사|간호직|산업간호)/.test(title) || /간호조무사/.test(title) || jobs.some((j) => j.id === `hospitaljob-${rawId}`)) return;
    const row = link.closest('tr').text().replace(/\s+/g, ' ').trim();
    jobs.push({ id: `hospitaljob-${rawId}`, company: title.match(/^\[([^\]]+)\]/)?.[1] || '병원잡 등록기관', title, region: row.match(/서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/)?.[0] || '지역 미표기', deadline: row.match(/채용시|D-\d+|(?:\d{2,4}\/)?\d{1,2}\/\d{1,2}/)?.[0] || '원문 확인', source: '병원잡', category: 'clinical', url: new URL(href, 'https://www.byeongwonjob.com').href });
  });
  return jobs;
}

const FOCUSED_NURSING_ROLE_PATTERN = /(외래|검진|건진|건강\s*증진|상담|진료\s*협력|진료\s*지원|전담|코디네이터|보험\s*심사|심사\s*간호|심사평가|적정진료|건강보험|임상\s*시험|\bIRB\b)/i;
const NURSING_EVIDENCE_PATTERN = /(간호사|간호직|간호팀|간호부|간호본부|심사\s*간호)/;
const EXPLICIT_NURSE_ROLE_PATTERN = /(간호사|간호직|심사\s*간호)/;
const NURSING_DEPARTMENT_PATTERN = /(보험\s*심사|심사평가|적정진료|진료\s*협력)/;
const EXPLICIT_NON_NURSE_PATTERN = /(간호조무사|조무사|병원지원직|일반업무원|사무원|전담인력|방사선사|임상병리사|작업치료사|물리치료사|사회복지사|약사|연구원|의사|전공의)/;

function isFocusedNursingJobTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || !FOCUSED_NURSING_ROLE_PATTERN.test(title)) return false;
  if (EXPLICIT_NON_NURSE_PATTERN.test(title) && !EXPLICIT_NURSE_ROLE_PATTERN.test(title)) return false;
  return NURSING_EVIDENCE_PATTERN.test(title) || NURSING_DEPARTMENT_PATTERN.test(title);
}

const NURSE_JOB_TITLE_PATTERN = /(간호\s*사|간호직|간호원|수간호|전담\s*간호|가정\s*간호|산업\s*간호|보건\s*관리(?:자|직)?|\bRN\b|PA\s*간호)/i;

function isNurseJobTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || !NURSE_JOB_TITLE_PATTERN.test(title)) return false;
  if (EXPLICIT_NON_NURSE_PATTERN.test(title) && !EXPLICIT_NURSE_ROLE_PATTERN.test(title)) return false;
  return true;
}

const REGION_NAME_PATTERN = /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/;

function shortRegion(value) {
  return String(value || '').match(REGION_NAME_PATTERN)?.[1] || '지역 미표기';
}

function employmentFromText(...values) {
  const text = values.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  if (!text) return '';
  if (/정규직\s*전환\s*(?:조건|가능).*계약직|계약직.*정규직\s*전환/.test(text)) return '계약직(정규직 전환 조건)';
  const labels = [];
  if (/정규직/.test(text)) labels.push('정규직');
  if (/계약직|비정규직|촉탁직|파견직|위촉직|휴직\s*대체|대체\s*인력/.test(text)) labels.push('계약직');
  if (/기간제/.test(text)) labels.push('기간제');
  if (/시간제|파트타임|아르바이트/.test(text)) labels.push('시간제');
  if (/인턴/.test(text)) labels.push('인턴');
  if (/일용직?/.test(text)) labels.push('일용직');
  return [...new Set(labels)].join('·');
}

function dateOnlyValues(value) {
  return [...String(value || '').matchAll(/((?:19|20)\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})/g)]
    .map(([, year, month, day]) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

function caseManagerRegion(title) {
  const text = String(title || '');
  const regions = [
    [/(경기|일산|안산|단원병원|군포|지샘|의정부|성빈센트|부천|수원|용인|성남|분당|고양|시흥|김포|구리|남양주|광명|안양|파주|하남|평택)/, '경기'],
    [/(서울|여의도|은평|강남|강북|명지성모|세브란스|대한간호협회)/, '서울'],
    [/인천/, '인천'], [/대전/, '대전'], [/(경주|포항)/, '경북'], [/(대자인|전주)/, '전북'],
    [/부산/, '부산'], [/대구/, '대구'], [/광주/, '광주'], [/울산/, '울산'], [/제주/, '제주'],
  ];
  return regions.find(([pattern]) => pattern.test(text))?.[1] || '지역 미표기';
}

function caseManagerCompany(title) {
  const bracketed = String(title || '').match(/^\[([^\]]+)\]/)?.[1];
  if (bracketed) return bracketed.trim();
  return String(title || '').match(/^(.+?(?:병원|의료원|간호협회|의료재단|의원|센터))/)?.[1]?.trim() || '보험심사간호사회 등록기관';
}

export function parseCaseManager(html) {
  const $ = cheerio.load(html), jobs = [];
  $('table tbody tr').each((_, node) => {
    const row = $(node);
    if (row.hasClass('bo_notice')) return;
    const link = row.find('a[href*="bo_table=recruit_people"][href*="wr_id="]').first();
    const href = link.attr('href') || '';
    const rawId = new URL(href, 'https://www.casemanager.or.kr').searchParams.get('wr_id');
    const title = link.text().replace(/\s+/g, ' ').trim();
    if (!rawId || !title || !/(보험\s*심사|심사\s*간호|심사팀|심사평가|적정진료|평가분석)/.test(title) || /(채용\s*마감|모집\s*마감|운영\s*방식|합격자)/.test(title)) return;
    const publishedAt = dateOnlyValues(row.find('.td_date').text()).at(-1) || '';
    jobs.push({
      id: `casemanager-${rawId}`, company: caseManagerCompany(title), title,
      region: caseManagerRegion(title), deadline: '원문 확인', publishedAt,
      employment: employmentFromText(title), source: '보험심사간호사회', category: 'clinical',
      role: '보험심사 간호사', sectors: ['보험심사', '심사간호사'],
      url: new URL(href, 'https://www.casemanager.or.kr').href,
    });
  });
  return jobs;
}

export function parseEumc(jsonText) {
  const data = JSON.parse(jsonText), jobs = [];
  for (const item of data.data || []) {
    const title = String(item.title || '').replace(/\s+/g, ' ').trim();
    if (!item.id || item.status?.code !== 'ing' || !isFocusedNursingJobTitle(title)) continue;
    const categoryText = (item.categories || []).map((category) => category.text).filter(Boolean).join(' ');
    const company = /\[목동병원\]/.test(title) ? '이대목동병원' : /\[서울병원\]/.test(title) ? '이대서울병원' : '이화여자대학교의료원';
    const deadline = dateOnlyValues(item.end).at(-1) || (Number.isFinite(item.d_day) ? `D-${Math.max(0, item.d_day)}` : '원문 확인');
    jobs.push({
      id: `eumc-${item.id}`, company, title, region: '서울', deadline,
      publishedAt: dateOnlyValues(item.start).at(-1) || '', employment: employmentFromText(title, categoryText),
      source: '이화의료원', category: 'clinical', role: title,
      url: item.links?.['jobs.show'] || `https://eumc.applyin.co.kr/jobs/${item.id}`,
    });
  }
  return jobs;
}

function kumcCompany(classification) {
  return ({ 안암병원: '고려대학교 안암병원', 구로병원: '고려대학교 구로병원', 안산병원: '고려대학교 안산병원' })[classification] || '고려대학교의료원';
}

export function parseJobflex(jsonText, config) {
  const data = JSON.parse(jsonText), jobs = [];
  const titleFilter = config.titleFilter || isFocusedNursingJobTitle;
  for (const item of data.list || []) {
    const title = String(item.title || '').replace(/\s+/g, ' ').trim();
    if (!item.positionSn || item.submissionStatus !== 'IN_SUBMISSION' || !titleFilter(title)) continue;
    const classification = item.classificationCode || '';
    const experience = ({ NEW: '신입', CAREER: '경력', NEW_CAREER: '신입·경력', ANY: '경력무관' })[item.careerType] || '';
    jobs.push({
      id: `${config.id}-${item.positionSn}`, company: config.resolveCompany ? config.resolveCompany(classification, item) : config.company, title,
      region: config.resolveRegion ? config.resolveRegion(classification, item) : config.region,
      deadline: dateOnlyValues(item.endDateTime).at(-1) || (Number.isFinite(item.dday) ? `D-${Math.max(0, item.dday)}` : '원문 확인'),
      publishedAt: dateOnlyValues(item.startDateTime).at(-1) || '', employment: employmentFromText(title, item.recruitmentType), experience,
      source: config.source, category: 'clinical', role: title,
      url: `${config.origin}/career/jobs/${item.positionSn}`,
    });
  }
  return jobs;
}

export function parseKumc(jsonText) {
  return parseJobflex(jsonText, {
    id: 'kumc', source: '고려대의료원', origin: 'https://kumc.recruiter.co.kr',
    resolveCompany: (classification) => kumcCompany(classification),
    resolveRegion: (classification) => classification === '안산병원' ? '경기' : '서울',
  });
}

export function parseKhmc(html) {
  const $ = cheerio.load(html), jobs = [];
  $('.list-item-box li').each((_, node) => {
    const row = $(node);
    if (row.find('.state').first().text().replace(/\s+/g, '') !== '모집중') return;
    const link = row.find('a[href*="/khmc/job/"]').first(), href = link.attr('href') || '';
    const rawId = new URL(href, 'https://recruit.incruit.com').pathname.match(/\/khmc\/job\/(\d+)/)?.[1];
    const title = row.find('.title').first().text().replace(/\s+/g, ' ').trim();
    if (!rawId || !isFocusedNursingJobTitle(title)) return;
    const dates = dateOnlyValues(row.find('.date').text());
    jobs.push({
      id: `khmc-${rawId}`, company: '경희의료원', title, region: '서울',
      deadline: dates.at(-1) || '원문 확인', publishedAt: dates[0] || '', employment: employmentFromText(title),
      source: '경희의료원', category: 'clinical', role: title,
      url: new URL(href, 'https://recruit.incruit.com').href,
    });
  });
  return jobs;
}

export function parseNursenet(html) {
  const $ = cheerio.load(html), jobs = [];
  $('a[href^="/jobs/"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '';
    const rawId = href.match(/^\/jobs\/([0-9a-f-]{36})/i)?.[1];
    const label = String(link.attr('aria-label') || '');
    const [labelTitle = '', labelCompany = '', labelRegion = ''] = label.split('·').map((part) => part.trim());
    const title = link.find('h3').first().text().replace(/\s+/g, ' ').trim() || labelTitle;
    const company = labelCompany || link.find('p.text-slate-700').first().text().replace(/\s+/g, ' ').trim();
    const cardText = link.text().replace(/\s+/g, ' ');
    const deadline = cardText.match(/~\s*(\d{1,2})\.(\d{1,2})\s*마감/)?.[0].replace(/^~\s*/, '') || cardText.match(/D-\d+/)?.[0] || '원문 확인';
    const postedAt = cardText.match(/(\d+\s*일\s*전|\d+\s*시간\s*전|오늘|방금)/)?.[0] || '';
    if (!rawId || !title || !isNurseJobTitle(title) || jobs.some((job) => job.id === `nursenet-${rawId}`)) return;
    jobs.push({
      id: `nursenet-${rawId}`, company: company || '널스넷 등록기관', title,
      region: shortRegion(labelRegion), deadline, postedAt,
      employment: employmentFromText(title), source: '널스넷', category: /보건/.test(title) ? 'health' : 'clinical', role: title,
      url: `https://nursenet.co.kr/jobs/${rawId}`,
    });
  });
  return jobs;
}

export async function collectNursenetJobs({ fetcher = fetchText, maxPages = 3 } = {}) {
  const byId = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = page === 1 ? EXTRA_SOURCES.nursenet : `${EXTRA_SOURCES.nursenet}?page=${page}`;
    const jobs = parseNursenet(await fetcher(url));
    const added = jobs.filter((job) => !byId.has(job.id));
    for (const job of added) byId.set(job.id, job);
    if (!added.length) break;
  }
  return [...byId.values()];
}

const HALYM_HOSPITALS = [
  [/동탄/, '한림대학교동탄성심병원', '경기'],
  [/춘천/, '한림대학교춘천성심병원', '강원'],
  [/한강/, '한림대학교한강성심병원', '서울'],
  [/강남/, '한림대학교강남성심병원', '서울'],
  [/강동/, '한림대학교강동성심병원', '서울'],
  [/성심병원/, '한림대학교성심병원', '경기'],
  [/의료원/, '한림대학교의료원', '서울'],
];

export function parseHallym(html) {
  const $ = cheerio.load(html), jobs = [];
  $('#rct_list_ing a[href*="hrt_p20_detail.jsp"]').each((_, el) => {
    const link = $(el), href = link.attr('href') || '';
    const url = new URL(href, 'https://recruit.hallym.or.kr');
    if (url.searchParams.get('inggbn') !== 'ing') return;
    const adoptcnt = url.searchParams.get('adoptcnt');
    const cell = link.find('p').first();
    const spans = cell.find('span');
    const hospital = spans.first().text().replace(/\s+/g, ' ').trim();
    const clone = cell.clone(); clone.find('span').remove();
    const title = clone.text().replace(/\s+/g, ' ').trim();
    const deadline = dateOnlyValues(spans.last().text()).at(-1) || link.find('.d_day').first().text().trim() || '원문 확인';
    if (!adoptcnt || !title || !isNurseJobTitle(title) || jobs.some((job) => job.id === `hallym-${adoptcnt}`)) return;
    const [, company = hospital || '한림대학교의료원', region = '서울'] = HALYM_HOSPITALS.find(([pattern]) => pattern.test(hospital)) || [];
    jobs.push({
      id: `hallym-${adoptcnt}`, company, title, region, deadline,
      publishedAt: '', employment: employmentFromText(title), source: '한림대의료원', category: 'clinical', role: title,
      url: url.href,
    });
  });
  return jobs;
}

export async function collectHallymJobs({ fetcher = fetchText, maxPages = 2 } = {}) {
  const byId = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = EXTRA_SOURCES.hallym.replace(/movePage=\d+/, `movePage=${page}`);
    const jobs = parseHallym(await fetcher(url));
    const added = jobs.filter((job) => !byId.has(job.id));
    for (const job of added) byId.set(job.id, job);
    if (!added.length) break;
  }
  return [...byId.values()];
}

export function parseIncruit(html) {
  const $ = cheerio.load(html), jobs = [];
  $('.c_row[jobno]').each((_, el) => {
    const row = $(el), rawId = String(row.attr('jobno') || '').trim();
    const link = row.find('a[href*="jobpost.asp?job="]').first();
    const title = link.text().replace(/\s+/g, ' ').trim();
    const company = row.find('.cpname').first().text().replace(/\s+/g, ' ').trim();
    const conditions = row.find('.cl_md span').map((_, span) => $(span).text().replace(/\s+/g, ' ').trim()).get();
    const sector = row.find('.cell_mid .cl_btm span').first().text().replace(/\s+/g, ' ').trim();
    const lastSpans = row.find('.cell_last .cl_btm span').map((_, span) => $(span).text().replace(/\s+/g, ' ').trim()).get();
    const deadline = lastSpans[0] || '원문 확인';
    const postedAt = (lastSpans[1] || '').match(/\d+\s*일\s*전|오늘|방금/)?.[0] || '';
    if (!rawId || !title || !isNurseJobTitle(title) || jobs.some((job) => job.id === `incruit-${rawId}`)) return;
    const href = link.attr('href') || '';
    jobs.push({
      id: `incruit-${rawId}`, company: company || '인크루트 등록기관', title,
      region: conditions[0] || '지역 미표기', deadline, postedAt,
      experience: conditions[1] || '', education: conditions[2] || '', employment: conditions[3] || employmentFromText(title),
      source: '인크루트', category: /보건|산업간호/.test(`${title} ${sector}`) ? 'health' : 'clinical', role: `${title} ${sector}`.trim(),
      url: href.split('&')[0] || `https://job.incruit.com/jobdb_info/jobpost.asp?job=${rawId}`,
    });
  });
  return jobs;
}

export async function collectIncruitJobs({ fetcher = fetchText, keywords = ['간호사', '보건관리자'] } = {}) {
  const byId = new Map();
  const settled = await Promise.allSettled(keywords.map(async (keyword) => {
    const url = `${EXTRA_SOURCES.incruit}?col=job&kw=${encodeCp949FormValue(keyword)}`;
    return parseIncruit(await fetcher(url));
  }));
  const ok = settled.filter((result) => result.status === 'fulfilled');
  if (!ok.length) throw new Error('인크루트 검색을 모두 확인하지 못했습니다.');
  for (const job of ok.map((result) => result.value).flat()) {
    if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

export function parseKuh(html) {
  const $ = cheerio.load(html), jobs = [];
  $('table tbody tr').each((_, node) => {
    const row = $(node), link = row.find('a[href*="noticeView.do"][href*="anc_seq="]').first(), href = link.attr('href') || '';
    const rawId = new URL(href, 'https://www.kuh.ac.kr').searchParams.get('anc_seq');
    const title = link.text().replace(/\s+/g, ' ').trim();
    const state = row.find('.stateNotice').first().text().replace(/\s+/g, ' ').trim();
    if (!rawId || state === '마감' || !/간호/.test(title)) return;
    const cells = row.find('td'), classification = cells.eq(2).text().replace(/\s+/g, ' ').trim(), dates = dateOnlyValues(cells.eq(3).text());
    jobs.push({
      id: `kuh-${rawId}`, company: '건국대학교병원', title, region: '서울',
      deadline: dates.at(-1) || state || '원문 확인', publishedAt: dates[0] || '', employment: employmentFromText(title, classification),
      source: '건국대병원', category: 'clinical', role: title,
      url: new URL(href, 'https://www.kuh.ac.kr').href,
    });
  });
  return jobs;
}

export function parseCmc(html, config = { path: 'cmcseoul', company: '서울성모병원', region: '서울' }) {
  const $ = cheerio.load(html), jobs = [];
  $(`a[href*="/${config.path}/application/appView.do"]`).each((_, el) => {
    const link = $(el), href = link.attr('href') || '', rawId = new URL(href, 'https://recruit.cmcnu.or.kr').searchParams.get('seq_no');
    const row = link.closest('li'), title = (row.find('strong.reduce').first().text() || link.text()).replace(/\s+/g, ' ').replace(/^새로운글\s*/, '').trim();
    if (!rawId || !isFocusedNursingJobTitle(title) || jobs.some((job) => job.id === `cmc-${rawId}`)) return;
    jobs.push({
      id: `cmc-${rawId}`, company: config.company, title, region: config.region,
      deadline: /상시\s*모집/.test(title) ? '상시채용' : '원문 확인', publishedAt: dateOnlyValues(row.find('.data').text()).at(-1) || '',
      employment: employmentFromText(title), source: '가톨릭의료원', category: 'clinical', role: title,
      url: new URL(href, 'https://recruit.cmcnu.or.kr').href,
    });
  });
  return jobs;
}

export function parseRecruiter(jsonText, config) {
  const data = JSON.parse(jsonText), jobs = [];
  for (const item of data.jobnoticeInProgressList || []) {
    const title = String(item.jobnoticeName || '').replace(/\s+/g, ' ').trim();
    if (!/(간호|보건)/.test(title) || (config.titleFilter && !config.titleFilter(title)) || (config.focused && !isFocusedNursingJobTitle(title))) continue;
    // InProgressList can still contain closed notices. Never turn D+N into D-0.
    const receiptState = String(item.receiptState || '').trim();
    if (explicitlyClosedReceipt(receiptState) || (Number.isFinite(item.deadlineCount) && item.deadlineCount < 0)) continue;
    const company = config.resolveCompany?.(title, item) || config.company;
    const region = config.resolveRegion?.(title, item) || config.region;
    const start = recruiterDateTime(item.applyStartDate);
    const end = recruiterDateTime(item.applyEndDate);
    jobs.push({
      id: `${config.id}-${item.jobnoticeSn}`, company, title, region,
      deadline: end?.slice(0, 10) || (Number.isFinite(item.deadlineCount) ? `D-${item.deadlineCount}` : '원문 확인'),
      ...(start ? { postedAt: start, applyStartDate: start } : {}),
      ...(end ? { deadlineAt: end.slice(0, 10), applyEndDate: end } : {}),
      receiptState,
      employment: employmentFromText(title), source: config.source, category: /보건/.test(title) ? 'health' : 'clinical', role: title,
      url: `${config.origin}/app/jobnotice/view?systemKindCode=${encodeURIComponent(item.systemKindCode || 'MRS2')}&jobnoticeSn=${encodeURIComponent(item.jobnoticeSn)}`,
    });
  }
  return jobs;
}

function recruiterDateTime(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})[-.](\d{2})[-.](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/u);
  if (!match) return '';
  const [, year, month, day, hour = '00', minute = '00', second = '00', zone = '+09:00'] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day
    || +hour > 23 || +minute > 59 || +second > 59) return '';
  const result = `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
  return Number.isFinite(Date.parse(result)) ? result : '';
}

function explicitlyClosedReceipt(value) {
  return /마감|종료|closed|ended|finished/iu.test(String(value || ''));
}

const WANTED_SEARCH_API = 'https://www.wanted.co.kr/api/chaos/search/v1/position';
const WANTED_SEARCH_KEYWORDS = ['보건관리자', '간호사', '산업간호', 'EHS'];
const WANTED_SEARCH_PAGES = 3;
const WANTED_PAGE_SIZE = 20;

export function parseWantedPositions(data) {
  const jobs = [];
  for (const item of Array.isArray(data?.data) ? data.data : []) {
    const rawId = Number.isFinite(item?.id) ? item.id : null;
    const title = String(item?.position || '').replace(/\s+/g, ' ').trim();
    if (rawId == null || !/(보건|간호|EHS|SHE)/i.test(title) || jobs.some((job) => job.id === `wanted-${rawId}`)) continue;
    const from = Number.isFinite(item?.annual_from) ? item.annual_from : null;
    const to = Number.isFinite(item?.annual_to) ? item.annual_to : null;
    const experience = from != null && from > 0 ? (to != null && to < 100 ? `경력 ${from}~${to}년` : `경력 ${from}년 이상`) : (from === 0 ? '신입 가능' : '');
    jobs.push({
      id: `wanted-${rawId}`,
      company: String(item?.company?.name || '').replace(/\s+/g, ' ').trim() || '원티드 등록기업',
      title, region: '지역 미표기', deadline: '원문 확인',
      employment: { regular: '정규직', contract: '계약직', intern: '인턴' }[item?.employment_type] || '',
      experience,
      source: '원티드', category: 'health',
      url: `https://www.wanted.co.kr/wd/${rawId}`,
    });
  }
  return jobs;
}

async function collectWantedJobs() {
  const found = new Map();
  for (const keyword of WANTED_SEARCH_KEYWORDS) {
    for (let page = 0; page < WANTED_SEARCH_PAGES; page += 1) {
      const params = new URLSearchParams({ query: keyword, offset: String(page * WANTED_PAGE_SIZE), limit: String(WANTED_PAGE_SIZE) });
      const data = await fetchJson(`${WANTED_SEARCH_API}?${params}`, {
        timeoutMs: 30000,
        headers: { referer: `https://www.wanted.co.kr/search?query=${encodeURIComponent(keyword)}&tab=position` },
      });
      for (const job of parseWantedPositions(data)) found.set(job.id, job);
      if (!Array.isArray(data?.data) || data.data.length < WANTED_PAGE_SIZE) break;
    }
  }
  return [...found.values()];
}

export function parseRnjob(html) {
  const $ = cheerio.load(html), jobs = [];
  $('article.card_type1-job').each((_, node) => {
    const scope = $(node), link = scope.find('a.go_drt').first(), href = link.attr('href') || '', rawId = new URL(href, 'https://rnjob.koreanursing.or.kr').searchParams.get('rcrutSeq');
    const title = scope.find('.sbject_g h3').text().replace(/\s+/g, ' ').trim(), company = scope.find('.company_info .name').text().replace(/\s+/g, ' ').trim(), location = scope.find('.company_info .location').text().trim();
    if (rawId && title && !jobs.some((j) => j.id === `rnjob-${rawId}`)) jobs.push({ id: `rnjob-${rawId}`, company: company || 'RNJOB 등록기관', title, region: location.match(/서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/)?.[0] || '지역 미표기', deadline: scope.find('.d-day').text().replace(/\s+/g, '').trim() || '원문 확인', source: 'RNJOB', category: /(산업|보건|사업장)/.test(title) ? 'health' : 'clinical', url: new URL(href, 'https://rnjob.koreanursing.or.kr').href });
  });
  return jobs;
}

async function fetchRnjob() {
  const cookieFetch = makeFetchCookie(fetch, new CookieJar());
  await cookieFetch('https://ssorev.koreanursing.or.kr/login.html', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 NurseBoard/1.0' }, body: new URLSearchParams({ agentId: '9' }), signal: AbortSignal.timeout(30000) });
  const response = await cookieFetch('https://rnjob.koreanursing.or.kr/recruit/getJobOpenning.do', { headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`RNJOB ${response.status}`);
  return response.text();
}

async function fetchText(url, options = {}) {
  const { timeoutMs = 15000, ...rest } = options;
  const response = await fetch(url, { ...rest, headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0', ...(rest.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const legacy = /medicaljob|byeongwonjob|cmcnu/.test(new URL(url).hostname) || /charset=(?:euc-kr|ks_c_5601-1987|cp949)/i.test(contentType);
  return legacy ? iconv.decode(bytes, 'cp949') : bytes.toString('utf8');
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 15000, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0', accept: 'application/json', ...(rest.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function collectWithRetry(collect, { retries = 1 } = {}) {
  try {
    return await collect();
  } catch (error) {
    if (retries <= 0) throw error;
    return collectWithRetry(collect, { retries: retries - 1 });
  }
}

async function readNurscapeSource() {
  try {
    const parsed = nurscapeCacheStore
      ? await nurscapeCacheStore.read()
      : JSON.parse(fs.readFileSync(NURSCAPE_CACHE, 'utf8'));
    return {
      id: 'nurscape', name: '너스케입', status: 'bridge', jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      updatedAt: parsed.updatedAt || null, lastAttemptAt: parsed.updatedAt || null, lastSuccessAt: parsed.updatedAt || null,
    };
  } catch {
    return { id: 'nurscape', name: '너스케입', status: 'bridge', jobs: [], updatedAt: null };
  }
}

function createSourceDefinitions() {
  return [
    {
      id: 'nursejob', name: '널스잡', url: NURSE_SOURCE,
      collect: async () => collectNurseJobJobs(),
    },
    {
      id: 'zighang', name: '직행', url: ZIGHANG_SOURCE,
      collect: async () => collectZighangJobs(),
    },
    {
      id: 'saramin', name: '사람인', url: `${SARAMIN_SEARCH}${encodeURIComponent('상근 간호사')}`,
      collect: async ({ previousJobs = [] } = {}) => collectSaraminJobs({ previousJobs }),
    },
    {
      id: 'jobkorea', name: '잡코리아', url: JOBKOREA_SOURCE,
      collect: async () => parseJobKorea(await fetchText(JOBKOREA_SOURCE)),
    },
    {
      id: 'catch', name: '캐치', url: CATCH_SOURCE,
      collect: async () => parseCatch(await fetchText(CATCH_SOURCE)),
    },
    {
      id: 'work24', name: '고용24', url: WORK24_HTML_SEARCH,
      collect: ({ previousJobs = [] } = {}) => collectWithRetry(async () => WORK24_AUTH_KEY
        ? collectWork24OpenApiJobs({ previousJobs, fetcher: (apiUrl) => fetchText(apiUrl, { timeoutMs: 30000 }) })
        : parseWork24(await fetchText(WORK24_HTML_SEARCH, {
        method: 'POST', timeoutMs: 30000, headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ srcKeyword: KEYWORD, searchMode: 'Y', keywordWantedTitle: 'Y', resultCnt: '30', pageIndex: '1', currentPageNo: '1', sortField: 'DATE', sortOrderBy: 'DESC', siteClcd: 'all', empTpGbcd: '1' }),
      }))),
    },
    {
      id: 'alio', name: 'JOB-ALIO', url: ALIO_SOURCE,
      collect: async () => parseAlio(await fetchText(ALIO_SOURCE)),
    },
    {
      id: 'nurselink', name: '널스링크', url: EXTRA_SOURCES.nurselink,
      collect: async () => parseNurseLink(await fetchText(EXTRA_SOURCES.nurselink)),
    },
    {
      id: 'kaohn', name: '직업건강협회', url: EXTRA_SOURCES.kaohn,
      collect: async () => parseKaohn(await fetchText(EXTRA_SOURCES.kaohn)),
    },
    {
      id: 'kisanhyup', name: '산업보건협의회', url: EXTRA_SOURCES.kisanhyup,
      collect: async () => parseKisanhyup(await fetchText(EXTRA_SOURCES.kisanhyup)),
    },
    {
      id: 'snuh', name: '서울대병원', url: EXTRA_SOURCES.snuh,
      collect: async () => parseSnuh(await fetchText(EXTRA_SOURCES.snuh)),
    },
    {
      id: 'amc', name: '서울아산병원', url: EXTRA_SOURCES.amc,
      collect: async () => parseAmc(await fetchText(EXTRA_SOURCES.amc)),
    },
    {
      id: 'samsung', name: '삼성서울병원', url: EXTRA_SOURCES.samsung,
      collect: async () => parseSamsung(await fetchText(EXTRA_SOURCES.samsung)),
    },
    {
      id: 'medicaljob', name: '메디컬잡', url: EXTRA_SOURCES.medicaljob,
      collect: async ({ previousJobs = [] } = {}) => collectMedicalJobJobs({ previousJobs }),
    },
    {
      id: 'hospitaljob', name: '병원잡', url: EXTRA_SOURCES.hospitaljob,
      collect: async () => parseHospitalJob(await fetchText(EXTRA_SOURCES.hospitaljob)),
    },
    {
      id: 'cmc', name: '가톨릭의료원', url: EXTRA_SOURCES.cmc,
      collect: async () => (await Promise.all(CMC_INSTITUTIONS.map(async (institution) => {
        const url = `https://recruit.cmcnu.or.kr/${institution.path}/index.do`;
        return parseCmc(await fetchText(url), institution);
      }))).flat(),
    },
    {
      id: 'wanted', name: '원티드', url: EXTRA_SOURCES.wanted,
      collect: () => collectWantedJobs(),
    },
    {
      id: 'snubh', name: '분당서울대병원', url: EXTRA_SOURCES.snubh,
      collect: async () => parseRecruiter(await fetchText(EXTRA_SOURCES.snubh, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: 'https://snubh.recruiter.co.kr/appsite/company/index' },
        body: new URLSearchParams({ appsiteSn: '658', settingType: 'B' }),
      }), { id: 'snubh', company: '분당서울대학교병원', source: '분당서울대병원', region: '경기', origin: 'https://snubh.recruiter.co.kr' }),
    },
    {
      id: 'ncc', name: '국립암센터', url: EXTRA_SOURCES.ncc,
      collect: async () => parseRecruiter(await fetchText(EXTRA_SOURCES.ncc, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: 'https://ncc.recruiter.co.kr/appsite/company/index' },
        body: new URLSearchParams({ appsiteSn: '2145', settingType: 'C' }),
      }), { id: 'ncc', company: '국립암센터', source: '국립암센터', region: '경기', origin: 'https://ncc.recruiter.co.kr' }),
    },
    {
      id: 'rnjob', name: 'RNJOB', url: EXTRA_SOURCES.rnjob,
      collect: () => collectWithRetry(async () => parseRnjob(await fetchRnjob())),
    },
    {
      id: 'casemanager', name: '보험심사간호사회', url: EXTRA_SOURCES.casemanager,
      collect: async () => parseCaseManager(await fetchText(EXTRA_SOURCES.casemanager)),
    },
    {
      id: 'yuhs', name: '연세의료원', url: 'https://yuhs.recruiter.co.kr/',
      collect: async () => parseRecruiter(await fetchText(EXTRA_SOURCES.yuhs, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: 'https://yuhs.recruiter.co.kr/appsite/company/index' },
        body: new URLSearchParams({ appsiteSn: '4468', settingType: 'B' }),
      }), {
        id: 'yuhs', company: '연세의료원', source: '연세의료원', region: '서울', origin: 'https://yuhs.recruiter.co.kr', focused: true,
        resolveCompany: (title) => /강남/.test(title) ? '강남세브란스병원' : /용인/.test(title) ? '용인세브란스병원' : '세브란스병원',
        resolveRegion: (title) => /용인/.test(title) ? '경기' : '서울',
      }),
    },
    {
      id: 'eumc', name: '이화의료원', url: 'https://eumc.applyin.co.kr/',
      collect: async () => parseEumc(await fetchText(EXTRA_SOURCES.eumc, {
        headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      })),
    },
    {
      id: 'kumc', name: '고려대의료원', url: 'https://kumc.recruiter.co.kr/career/home',
      collect: async () => parseKumc(await fetchText(EXTRA_SOURCES.kumc, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', prefix: 'kumc.recruiter.co.kr', origin: 'https://kumc.recruiter.co.kr' },
        body: JSON.stringify({
          pageableRq: { page: 1, size: 100, sort: ['CREATED_DATE_TIME'] },
          filter: { keyword: '', tagSnList: [], jobGroupSnList: [], careerTypeList: [], regionSnList: [], submissionStatusList: ['IN_SUBMISSION'], openStatusList: [], resumeLanguageTypeList: [] },
        }),
      })),
    },
    {
      id: 'khmc', name: '경희의료원', url: EXTRA_SOURCES.khmc,
      collect: async () => parseKhmc(await fetchText(EXTRA_SOURCES.khmc)),
    },
    {
      id: 'kuh', name: '건국대병원', url: EXTRA_SOURCES.kuh,
      collect: async () => parseKuh(await fetchText(EXTRA_SOURCES.kuh)),
    },
    {
      id: 'nmc', name: '국립중앙의료원', url: EXTRA_SOURCES.nmc,
      collect: async () => collectNmcJobs(),
    },
    {
      id: 'bohun', name: '보훈의료공단', url: EXTRA_SOURCES.bohun,
      collect: async () => collectBohunJobs(),
    },
    {
      id: 'nursenet', name: '널스넷', url: EXTRA_SOURCES.nursenet,
      collect: async () => collectNursenetJobs(),
    },
    {
      id: 'paik', name: '백병원', url: 'https://paik.recruiter.co.kr/appsite/company/index',
      collect: async () => parseRecruiter(await fetchText(EXTRA_SOURCES.paik, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: 'https://paik.recruiter.co.kr/appsite/company/index' },
        body: new URLSearchParams({ appsiteSn: '7333', settingType: 'B' }),
      }), {
        id: 'paik', company: '인제대학교 백병원', source: '백병원', origin: 'https://paik.recruiter.co.kr',
        titleFilter: isNurseJobTitle,
        resolveCompany: (title) => title.match(/\[([^\]]*백병원)\]/)?.[1]?.trim() || '인제대학교 백병원',
        resolveRegion: (title) => /일산/.test(title) ? '경기' : /부산|해운대/.test(title) ? '부산' : /상계|서울/.test(title) ? '서울' : '지역 미표기',
      }),
    },
    {
      id: 'hallym', name: '한림대의료원', url: 'https://recruit.hallym.or.kr/',
      collect: async () => collectHallymJobs(),
    },
    {
      id: 'smc', name: '서울의료원', url: 'https://smc.recruiter.co.kr/career/home',
      collect: async () => parseJobflex(await fetchText(EXTRA_SOURCES.smc, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', prefix: 'smc.recruiter.co.kr', origin: 'https://smc.recruiter.co.kr' },
        body: JSON.stringify({
          pageableRq: { page: 1, size: 100, sort: ['CREATED_DATE_TIME'] },
          filter: { keyword: '', tagSnList: [], jobGroupSnList: [], careerTypeList: [], regionSnList: [], submissionStatusList: ['IN_SUBMISSION'], openStatusList: [], resumeLanguageTypeList: [] },
        }),
      }), {
        id: 'smc', source: '서울의료원', origin: 'https://smc.recruiter.co.kr', company: '서울의료원', region: '서울',
        titleFilter: isNurseJobTitle,
      }),
    },
    {
      id: 'incruit', name: '인크루트', url: 'https://job.incruit.com/',
      collect: async () => collectIncruitJobs(),
    },
  ];
}

const JOB_SOURCES = createSourceDefinitions();
let detailWorkerEnabled = false;
export function detailWorkerOptions(mode = process.env.NURSE_BOARD_DETAIL_WORKER, isVercel = IS_VERCEL) {
  return { enabled: !isVercel && mode !== 'false', officialOnly: mode === 'official', concurrency: mode === 'official' ? 1 : 3 };
}
const DETAIL_WORKER_OPTIONS = detailWorkerOptions();
export const jobDetailService = createJobDetailService({
  concurrency: DETAIL_WORKER_OPTIONS.concurrency,
  readCache: () => detailCacheStore ? detailCacheStore.read() : readDetailCache(DETAIL_CACHE),
  writeCache: (value) => detailCacheStore ? detailCacheStore.write(value) : writeDetailCache(DETAIL_CACHE, value),
  collect: collectJobDetail,
  onUpdated: async () => {
    jobService.invalidateSnapshot();
    await jobService.getSnapshotPayload();
    await ensureJobSnapshot({ force: true });
  },
  onError: () => console.warn('공고 상세 수집 또는 캐시 저장에 실패했습니다. 다음 수집에서 재시도합니다.'),
});
export const jobService = createJobService({
  sources: JOB_SOURCES,
  cacheFile: JOB_CACHE,
  prepareJob: (job) => prepareJobWithDetail(job, job.url ? jobDetailService.peek(normalizeDetailUrl(new URL(job.url)).href) : null),
  onRefreshed: async () => {
    await primeJobSnapshot();
  },
  ...(jobCacheStore ? {
    readCache: () => jobCacheStore.read(),
    writeCache: (_cacheFile, cache) => jobCacheStore.write(cache),
  } : {}),
});

export function prepareJobWithDetail(job, detail) {
  const { presentation, ...content } = job;
  return prepareJobForDisplay(detail?.detailVerified ? {
    ...content,
    ...Object.fromEntries(['experience', 'employment', 'salary', 'workHours', 'duties', 'qualifications', 'preferredQualifications', 'workConditions', 'department', 'departments', 'recruitmentScope', 'recruitmentRoles', 'workPattern', 'facilityType', 'experienceDomain', 'experienceEvidence', 'description', 'otherInformation', 'officialSourceUrl'].filter((field) => detail[field]).map((field) => [field, detail[field]])),
    detailEnrichmentCheckedAt: detail.detailCheckedAt,
  } : content);
}

async function primeJobSnapshot() {
  const snapshot = await ensureJobSnapshot({ force: true });
  if (detailWorkerEnabled) void warmJobDetails(snapshot).catch(() => {});
  return snapshot;
}

let snapshotPreparedAt = 0;
let snapshotPreparation;
async function ensureJobSnapshot({ force = false } = {}) {
  if (publishedFeedReader) return (await publishedFeedReader.readSnapshot()).value.snapshot;
  if (IS_COLLECTOR && snapshotPreparedAt && !force) return jobService.getSnapshot();
  if (!force && snapshotPreparedAt && Date.now() - snapshotPreparedAt < 60_000) return jobService.getSnapshot();
  if (!snapshotPreparation) {
    snapshotPreparation = (async () => {
      if (!IS_COLLECTOR && snapshotPreparedAt) {
        jobCacheStore?.clearCache();
        nurscapeCacheStore?.clearCache();
        await jobService.reload();
      }
      const [, , nurscapeSource] = await Promise.all([
        jobService.initialize(),
        jobDetailService.initialize().catch(() => {}),
        readNurscapeSource(),
      ]);
      const snapshot = await jobService.getSnapshot({ extraSources: [nurscapeSource] });
      if (publishedFeed) {
        try { await publishedFeed.publish(snapshot); }
        catch (error) {
          const reason = String(error?.message || error?.name || 'unknown').replaceAll(BLOB_READ_WRITE_TOKEN, '[redacted]').replace(/https?:\/\/\S+/g, '[url]');
          console.warn(`조회용 데이터 게시 실패: ${reason}. 마지막 정상 게시본을 유지하며 다음 주기에 재시도합니다.`);
        }
      }
      snapshotPreparedAt = Date.now();
      return snapshot;
    })().finally(() => { snapshotPreparation = null; });
  }
  return snapshotPreparation;
}

const OFFICIAL_DETAIL_HOSTS = new Set([
  'snubh.recruiter.co.kr', 'ncc.recruiter.co.kr', 'yuhs.recruiter.co.kr', 'kumc.recruiter.co.kr',
  'recruit.snuh.org', 'recruit.amc.seoul.kr', 'www.samsunghospital.com', 'recruit.cmcnu.or.kr',
  'eumc.applyin.co.kr', 'recruit.incruit.com', 'www.kuh.ac.kr', 'recruit.hallym.or.kr', 'www.nmc.or.kr', 'www.bohun.or.kr',
  'paik.recruiter.co.kr', 'smc.recruiter.co.kr', 'nursenet.co.kr',
]);

export function selectDetailWarmJobs(snapshot, { officialOnly = false, now = new Date() } = {}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const jobs = [...(snapshot.jobs || []), ...(snapshot.needsReviewJobs || [])].filter((job) => {
    try {
      const url = new URL(job.url);
      const end = recruiterDateTime(job.applyEndDate);
      return isAllowedDetailUrl(url) && (!officialOnly || OFFICIAL_DETAIL_HOSTS.has(url.hostname))
        && !['expired', 'closed'].includes(job.deadlineStatus) && !explicitlyClosedReceipt(job.receiptState)
        && !(end && Date.parse(end) <= now.getTime())
        && !(/^\d{4}-\d{2}-\d{2}/u.test(job.deadlineAt || '') && job.deadlineAt.slice(0, 10) < today);
    }
    catch { return false; }
  }).sort((left, right) => (right.applicationTierGroupScore || 0) - (left.applicationTierGroupScore || 0))
    .map((job) => ({ ...job, url: normalizeDetailUrl(new URL(job.url)).href }));
  const groups = [new Map(), new Map()];
  const seen = new Set();
  for (const job of jobs) {
    const url = new URL(job.url);
    url.searchParams.sort();
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const group = groups[OFFICIAL_DETAIL_HOSTS.has(url.hostname) ? 0 : 1];
    if (!group.has(url.hostname)) group.set(url.hostname, []);
    group.get(url.hostname).push(job);
  }
  // Two official sources then one general source, round robin by host within
  // each group. A large feed or high score cannot starve another hospital.
  const queues = groups.map((group) => [...group.values()].map((items) => ({ items, index: 0 })));
  const result = [];
  const take = (queue) => {
    if (!queue.length) return;
    const entry = queue.shift();
    result.push(entry.items[entry.index++]);
    if (entry.index < entry.items.length) queue.push(entry);
  };
  while (queues.some((queue) => queue.length)) {
    take(queues[0]); take(queues[0]); take(queues[1]);
  }
  return result;
}

function warmJobDetails(snapshot) {
  return jobDetailService.warm(selectDetailWarmJobs(snapshot, DETAIL_WORKER_OPTIONS));
}

function normalizeDetailUrl(url) {
  if (url.hostname === 'recruit.amc.seoul.kr' && url.searchParams.has('recruitNo')) {
    url.searchParams.set('scheduleno', url.searchParams.get('recruitNo'));
    url.searchParams.delete('recruitNo');
  }
  if (url.hostname.endsWith('.recruiter.co.kr') && url.pathname.includes('/app/jobnotice/') && !url.searchParams.has('systemKindCode')) url.searchParams.set('systemKindCode', 'MRS2');
  return url;
}

const DETAIL_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_DETAIL_REDIRECTS = 5;

function isAllowedDetailUrl(url) {
  return ['http:', 'https:'].includes(url.protocol)
    && DETAIL_HOSTS.has(url.hostname)
    && !url.port
    && !url.username
    && !url.password;
}

function structuredDetailHtml(posting) {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', ...posting }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script><main></main>`;
}

function zighangSummaryText(summary) {
  function render(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return String(node.text || '');
    if (node.type === 'hardBreak') return '\n';
    const children = Array.isArray(node.content) ? node.content : [];
    if (node.type === 'bulletList') return children.map((child) => `• ${render(child).trim()}`).filter((line) => line !== '•').join('\n');
    if (node.type === 'orderedList') return children.map((child, index) => `${index + 1}. ${render(child).trim()}`).filter((line) => !/^\d+[.]\s*$/.test(line)).join('\n');
    if (node.type === 'doc') return children.map(render).filter(Boolean).join('\n\n');
    if (node.type === 'listItem') return children.map(render).filter(Boolean).join('\n');
    return children.map(render).join('');
  }
  return render(summary).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20_000);
}

async function fetchPlatformJobDetail(url) {
  const zighangId = url.hostname === 'zighang.com' ? url.pathname.match(/^\/recruitment\/([a-f\d-]+)\/?$/i)?.[1] : '';
  if (zighangId) {
    const response = await fetch(`${ZIGHANG_API}/${zighangId}`, {
      headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0', accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const item = (await response.json()).data;
    if (!item || item.status && item.status !== 'ACTIVE') throw new Error('직행 공고가 종료되었거나 비어 있습니다.');
    const summary = zighangSummaryText(item.summary);
    const originalUrl = /^https:\/\//.test(String(item.redirectUrl || '')) ? String(item.redirectUrl) : '';
    if (!summary && !originalUrl) throw new Error('직행 상세 정보가 비어 있습니다.');
    return {
      html: structuredDetailHtml({
        title: item.title,
        description: summary,
        employmentType: Array.isArray(item.employeeTypes) ? item.employeeTypes : [],
        experienceRequirements: zighangCareer(item),
        educationRequirements: Array.isArray(item.educations) ? item.educations.join(' · ') : '',
        datePosted: zighangCreatedAt(item.createdAt),
        validThrough: item.endDate,
        hiringOrganization: { '@type': 'Organization', name: item.company?.name || '기관 정보 확인' },
        jobLocation: (Array.isArray(item.regions) ? item.regions : []).map((region) => ({
          '@type': 'Place', address: { '@type': 'PostalAddress', addressRegion: region },
        })),
      }),
      url,
      ...(originalUrl ? { officialSourceUrl: originalUrl } : {}),
    };
  }

  const eumcId = url.hostname === 'eumc.applyin.co.kr' ? url.pathname.match(/^\/jobs\/(\d+)\/?$/)?.[1] : '';
  if (eumcId) {
    const response = await fetch(url.href, {
      headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0', accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const item = (await response.json()).data;
    if (!item?.content) throw new Error('EUMC detail is empty');
    const categoryText = (item.categories || []).map((category) => category.text).filter(Boolean).join(' ');
    const company = /\[목동병원\]/.test(item.title || '') ? '이대목동병원' : '이대서울병원';
    return {
      html: structuredDetailHtml({
        title: item.title, description: item.content, employmentType: employmentFromText(item.title, categoryText),
        datePosted: item.start, validThrough: item.end,
        hiringOrganization: { '@type': 'Organization', name: company },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressRegion: '서울' } },
      }),
      url,
    };
  }

  const kumcId = url.hostname === 'kumc.recruiter.co.kr' ? url.pathname.match(/^\/career\/jobs\/(\d+)\/?$/)?.[1] : '';
  if (kumcId) {
    const response = await fetch(`https://api-recruiter.recruiter.co.kr/position/v2/jobflex/${kumcId}`, {
      headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0', accept: 'application/json', prefix: 'kumc.recruiter.co.kr', origin: 'https://kumc.recruiter.co.kr' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const item = await response.json();
    if (!item?.jobDescription) throw new Error('KUMC detail is empty');
    const experience = ({ NEW: '신입', CAREER: '경력', NEW_CAREER: '신입·경력', ANY: '경력무관' })[item.careerType] || '';
    const region = item.classificationCode === '안산병원' ? '경기' : '서울';
    return {
      html: structuredDetailHtml({
        title: item.title, description: item.jobDescription, employmentType: employmentFromText(item.title, item.recruitmentType),
        experienceRequirements: experience, datePosted: item.startDateTime, validThrough: item.endDateTime,
        hiringOrganization: { '@type': 'Organization', name: kumcCompany(item.classificationCode) },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressRegion: region } },
      }),
      url,
    };
  }
  return null;
}

async function fetchJobDetailText(initialUrl) {
  let currentUrl = initialUrl;
  let redirectCount = 0;
  while (true) {
    if (!isAllowedDetailUrl(currentUrl)) throw new Error('Unsafe job detail URL');
    const platformDetail = await fetchPlatformJobDetail(currentUrl);
    if (platformDetail) return platformDetail;
    const headers = { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0' };
    if (currentUrl.hostname === 'www.saramin.co.kr' && currentUrl.pathname === '/zf_user/jobs/relay/view-detail') {
      const referer = new URL('/zf_user/jobs/relay/view', currentUrl);
      referer.searchParams.set('rec_idx', currentUrl.searchParams.get('rec_idx') || '');
      headers.referer = referer.href;
    }
    const response = await fetch(currentUrl.href, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (DETAIL_REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= MAX_DETAIL_REDIRECTS) throw new Error('Too many job detail redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Job detail redirect is missing Location');
      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedDetailUrl(nextUrl)) throw new Error('Unsafe job detail redirect');
      currentUrl = nextUrl;
      redirectCount += 1;
      continue;
    }
    if (!response.ok) throw new Error(`${response.status}`);
    const bytes = await readBoundedResponse(response, 3 * 1024 * 1024);
    const contentType = response.headers.get('content-type') || '';
    const legacy = /medicaljob|byeongwonjob|cmcnu/.test(currentUrl.hostname)
      || /charset=(?:euc-kr|ks_c_5601-1987|cp949)/i.test(contentType);
    const html = legacy ? iconv.decode(bytes, 'cp949') : bytes.toString('utf8');
    const recIdx = currentUrl.hostname === 'www.saramin.co.kr' ? currentUrl.searchParams.get('rec_idx') : '';
    if (recIdx && currentUrl.pathname !== '/zf_user/jobs/relay/view-detail') {
      const embeddedUrl = new URL('/zf_user/jobs/relay/view-detail', currentUrl);
      embeddedUrl.searchParams.set('rec_idx', recIdx);
      embeddedUrl.searchParams.set('rec_seq', '0');
      const embedded = await fetchJobDetailText(embeddedUrl);
      const $outer = cheerio.load(html);
      const $embedded = cheerio.load(embedded.html);
      const content = $embedded('.user_content').first();
      if (content.length) {
        $outer('body').append(content.toString());
        return { html: $outer.html(), url: currentUrl };
      }
    }
    const jobKoreaId = currentUrl.hostname === 'www.jobkorea.co.kr'
      ? currentUrl.pathname.match(/^\/Recruit\/GI_Read\/(\d+)\/?$/i)?.[1]
      : '';
    const jobKoreaFramePath = jobKoreaId && html.includes('/Recruit/GI_Read_Comt_Worknet_Ifrm')
      ? '/Recruit/GI_Read_Comt_Worknet_Ifrm'
      : jobKoreaId && html.includes('/Recruit/GI_Read_Comt_Ifrm')
        ? '/Recruit/GI_Read_Comt_Ifrm'
        : '';
    if (jobKoreaFramePath) {
      const embeddedUrl = new URL(jobKoreaFramePath, currentUrl);
      embeddedUrl.searchParams.set('Gno', jobKoreaId);
      embeddedUrl.searchParams.set('isHiringCenter', 'false');
      embeddedUrl.searchParams.set('hideMapView', 'false');
      const embedded = await fetchJobDetailText(embeddedUrl);
      const $outer = cheerio.load(html);
      const $embedded = cheerio.load(embedded.html);
      const content = $embedded('#detail-content').first();
      if (content.length) {
        $outer('body').append(content.toString());
        return { html: $outer.html(), url: currentUrl };
      }
    }
    return { html, url: currentUrl };
  }
}

function isAllowedOfficialAttachmentUrl(url, officialSourceUrl) {
  return Boolean(safeOfficialAssetUrl(url.href, officialSourceUrl.href, 'attachment'));
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.body) throw new Error('Empty remote response');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error('Remote response is too large');
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Remote response is too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchOfficialAttachment(initialUrl, officialSourceUrl, { maxBytes = ATTACHMENT_LIMITS.downloadBytes, timeoutMs = 12_000 } = {}) {
  let currentUrl = initialUrl;
  let redirectCount = 0;
  const signal = AbortSignal.timeout(timeoutMs);
  while (true) {
    if (!isAllowedOfficialAttachmentUrl(currentUrl, officialSourceUrl)) throw new Error('Unsafe official attachment URL');
    const response = await fetch(currentUrl.href, {
      headers: { 'user-agent': 'Mozilla/5.0 NurseBoard/1.0', accept: 'application/pdf,application/zip,application/octet-stream;q=0.9' },
      redirect: 'manual',
      signal,
    });
    if (DETAIL_REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (redirectCount >= MAX_DETAIL_REDIRECTS) throw new Error('Too many official attachment redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Official attachment redirect is missing Location');
      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedOfficialAttachmentUrl(nextUrl, officialSourceUrl)) throw new Error('Unsafe official attachment redirect');
      currentUrl = nextUrl;
      redirectCount += 1;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Official attachment ${response.status}`);
    }
    return readBoundedResponse(response, Math.min(maxBytes, ATTACHMENT_LIMITS.downloadBytes));
  }
}

async function enrichOfficialRecruiterDetail(html, sourceUrl) {
  const body = parseOfficialRecruiterDetail(html, sourceUrl);
  const assets = parseOfficialRecruiterAssets(html, sourceUrl);
  const documents = [];
  let attempts = 0;
  let downloadedBytes = 0;
  const until = Date.now() + 20_000;
  // Role descriptions first so generic forms cannot consume the whole budget.
  const candidates = [...assets.attachments].sort((a, b) => Number(/직무|업무/u.test(b.name)) - Number(/직무|업무/u.test(a.name)));
  for (const attachment of candidates) {
    if (!['PDF', 'HWP', 'ZIP'].includes(attachment.type)) { attachment.extractionStatus = 'unsupported'; continue; }
    if (attempts >= 4 || downloadedBytes >= 12 * 1024 * 1024 || Date.now() >= until) { attachment.extractionStatus = 'limit'; continue; }
    attempts += 1;
    try {
      const bytes = await fetchOfficialAttachment(new URL(attachment.url), new URL(sourceUrl), {
        maxBytes: Math.min(ATTACHMENT_LIMITS.downloadBytes, 12 * 1024 * 1024 - downloadedBytes),
        timeoutMs: Math.max(1, Math.min(12_000, until - Date.now())),
      });
      downloadedBytes += bytes.length;
      const extracted = await extractOfficialAttachmentText(bytes, { ...attachment, timeoutMs: Math.max(1, until - Date.now()) });
      attachment.extractionStatus = extracted.documents.some((doc) => doc.text) ? extracted.skipped ? 'partial' : 'extracted' : 'unavailable';
      for (const doc of extracted.documents) {
        if (documents.length >= 8) { attachment.extractionStatus = 'partial'; break; }
        if (doc.text) documents.push({ ...doc, url: attachment.url, detail: parseOfficialRecruiterDocument(doc.text) });
      }
    } catch { attachment.extractionStatus = 'unavailable'; }
  }
  const detail = { ...body, ...assets, officialSourceUrl: sourceUrl, officialEnrichmentVersion: 1 };
  if (!documents.length) return detail;
  const roles = (body.recruitmentRoles || []).map((role) => ({ ...role }));
  const compact = (text) => String(text || '').replace(/\s+/gu, '');
  for (const doc of documents.filter((item) => item.detail.duties)) {
    const metadata = compact(`${doc.name}\n${doc.text.split(/세부\s*직무|담당\s*업무|업무\s*내용/u)[0]}`);
    const matches = roles.filter((role) => role.department && metadata.includes(compact(role.department)));
    const role = matches.length === 1 ? matches[0] : { department: '', sourceName: doc.name };
    if (!roles.includes(role)) roles.push(role);
    role.duties = joinOfficialText([role.duties, doc.detail.duties], 6000);
    role.qualifications = joinOfficialText([role.qualifications, doc.detail.qualifications], 6000);
    role.workConditions = joinOfficialText([role.workConditions, doc.detail.workConditions], 4000);
    role.sourceUrl = doc.url;
    role.sourceName = doc.name;
  }
  if (roles.length) {
    detail.recruitmentRoles = roles;
    detail.recruitmentScope = roles.length > 1 ? 'mixed' : 'single';
  }
  // Retain body and every document independently: one attachment must never
  // overwrite another department, eligibility requirement or on-call warning.
  for (const key of ['duties', 'qualifications', 'preferredQualifications', 'workConditions', 'experience', 'otherInformation', 'recruitmentProcess', 'applicationMethod']) {
    const value = joinOfficialText([body[key]?.slice(0, 4000), ...documents.filter((doc) => doc.detail[key]).map((doc) => `[${doc.name}]\n${doc.detail[key].slice(0, 1400)}`)], 18_000);
    if (value) detail[key] = value;
  }
  for (const key of ['salary', 'headcount', 'deadlineText', 'employment']) {
    if (!detail[key]) detail[key] = documents.map((doc) => doc.detail[key]).find(Boolean) || '';
  }
  detail.attachmentDocuments = documents.map(({ name, url, text }) => ({ name, url, text: normalizeDetailText(text, 12_000) }));
  detail.description = joinOfficialText([body.description?.slice(0, 32_000), ...detail.attachmentDocuments.map((doc) => `[${doc.name}]\n${doc.text}`)], 128_000);
  detail.descriptionKind = 'content';
  detail.detailSource = 'official-body-and-attachments';
  detail.sections = normalizeDetailSections([
    ...(body.sections || []),
    ...documents.map((doc, index) => ({ key: `officialAttachment${index + 1}`, title: doc.name, content: normalizeDetailText(doc.text, 12_000), kind: 'mixed' })),
  ]);
  return detail;
}

async function enrichNurseJobFromOfficialSource(html, sourceUrl) {
  const officialSourceUrl = extractOfficialRecruiterUrl(html, sourceUrl) || nurseJobOfficialDetailUrl(html, sourceUrl);
  if (!officialSourceUrl) return {};
  const response = await fetchJobDetailText(officialSourceUrl);
  if (safeOfficialRecruiterUrl(response.url.href, response.url.href)) return enrichOfficialRecruiterDetail(response.html, response.url.href);
  const assets = parseOfficialRecruiterAssets(response.html, response.url.href);
  const officialGeneric = parseGenericJobDetail(response.html, response.url.href);
  const officialStructured = response.url.hostname === 'recruit.hallym.or.kr'
    ? parseHallymDetail(response.html, response.url.href)
    : {};
  const genericBody = hasMeaningfulDetailBody(officialGeneric) ? officialGeneric : {};
  return {
    ...genericBody,
    ...officialStructured,
    ...assets,
    officialSourceUrl: response.url.href,
  };
}

function fallbackJobDetail(job) {
  if (!job || typeof job !== 'object') return {};
  const description = normalizeDetailText(job.description, 12_000);
  const detail = {
    experience: normalizeDetailText(job.experience || job.experienceLevel, 300), education: normalizeDetailText(job.education, 300),
    employment: normalizeDetailText(job.employment || job.employmentType, 300), salary: normalizeDetailText(job.salary, 300),
    workHours: normalizeDetailText(job.workHours, 700), duties: normalizeDetailText(job.duties, 1600),
    qualifications: normalizeDetailText(job.qualifications, 1600), preferredQualifications: normalizeDetailText(job.preferredQualifications, 1600),
    workConditions: normalizeDetailText(job.workConditions, 1600),
    recruitmentProcess: normalizeDetailText(job.recruitmentProcess, 1600), applicationMethod: normalizeDetailText(job.applicationMethod, 1200),
    otherInformation: normalizeDetailText(job.otherInformation, 2200), deadlineText: normalizeDetailText(job.deadlineText, 500),
    description, descriptionKind: description ? 'fallback' : '',
    welfare: splitBenefits(job.welfare), headcount: normalizeDetailText(job.headcount, 100), location: normalizeDetailText(job.location || job.region, 500),
  };
  return Object.fromEntries(Object.entries(detail).filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value)));
}

function finalizeJobDetail(detail, job) {
  const classification = classifyExperienceDomain({
    title: normalizeDetailText(detail?.title || job?.title, 300),
    experience: normalizeDetailText(detail?.experience || job?.experience, 300),
    qualifications: normalizeDetailText(detail?.qualifications || job?.qualifications, 1600),
    requirements: normalizeDetailText(detail?.requirements || job?.requirements, 1600),
    preferredQualifications: normalizeDetailText(detail?.preferredQualifications || job?.preferredQualifications, 1600),
    description: normalizeDetailText(detail?.description || job?.description || job?.role, 4000),
    duties: normalizeDetailText(detail?.duties || job?.duties, 1600),
  });
  return {
    ...detail,
    experienceDomain: detail?.experienceDomain || classification.domain,
    experienceEvidence: detail?.experienceEvidence || classification.evidence,
  };
}

function hasMeaningfulDetail(detail) {
  return ['description', 'duties', 'qualifications', 'preferredQualifications', 'workConditions', 'recruitmentProcess', 'applicationMethod', 'otherInformation', 'deadlineText', 'experience', 'education', 'employment', 'workHours', 'salary', 'headcount', 'location'].some((key) => String(detail?.[key] || '').trim().length > 1)
    || detail?.welfare?.length > 0
    || detail?.sourceImages?.length > 0
    || detail?.attachments?.length > 0;
}

function hasMeaningfulDetailBody(detail) {
  const structured = ['duties', 'qualifications', 'preferredQualifications', 'workConditions', 'recruitmentProcess', 'applicationMethod', 'otherInformation']
    .some((key) => String(detail?.[key] || '').trim().length > 1);
  const orderedSections = ['content', 'jobPosting'].includes(detail?.descriptionKind)
    && Array.isArray(detail?.sections)
    && detail.sections.some((section) => String(section?.value || section?.content || '').trim().length > 1);
  const sourceDescription = ['content', 'jobPosting'].includes(detail?.descriptionKind)
    && String(detail?.description || '').trim().length >= 40;
  return structured || orderedSections || sourceDescription || detail?.sourceImages?.length > 0;
}

const VERIFIED_DETAIL_FALLBACK_FIELDS = new Set([
  'experience', 'education', 'employment', 'salary', 'workHours', 'deadlineText', 'location',
]);

function verifiedDetailFallback(fallback, detailBodyAvailable) {
  if (!detailBodyAvailable) return fallback;
  return Object.fromEntries(Object.entries(fallback)
    .filter(([field]) => VERIFIED_DETAIL_FALLBACK_FIELDS.has(field)));
}

async function fetchIwinvJobDetail(payload) {
  if (!IS_VERCEL || !IWINV_API_ORIGIN || !IWINV_RELAY_TOKEN) throw new Error('IWINV detail relay is unavailable');
  const response = await fetch(new URL('/api/job-detail', `${IWINV_API_ORIGIN}/`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${IWINV_RELAY_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !/(?:^|[/+])json(?:\s*;|$)/iu.test(contentType)) throw new Error(`IWINV detail relay ${response.status}`);
  const detail = await response.json();
  if (!detail || typeof detail !== 'object' || detail.error) throw new Error('IWINV detail relay returned no detail');
  const { error, notice, detailVerified, detailBodyAvailable, detailOrigin, ...content } = detail;
  return content;
}

const nurscapeImportCors = createNurscapeImportCors();
app.options('/api/import/nurscape', nurscapeImportCors);
app.post('/api/import/nurscape', nurscapeImportCors, createNurscapeImportHandler({
  cachePath: NURSCAPE_CACHE,
  cacheStore: nurscapeCacheStore,
  onImported: primeJobSnapshot,
}));

export async function collectJobDetail(job) {
  const url = normalizeDetailUrl(new URL(job.url));
  if (!isAllowedDetailUrl(url)) throw new Error('등록되지 않은 채용처 주소입니다.');
  const fallback = fallbackJobDetail(job);
  try {
    const nonEmpty = (record) => Object.fromEntries(Object.entries(record)
      .filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value)));
    let parsedDetail;
    if (IS_VERCEL && url.hostname.includes('nursejob.co.kr') && IWINV_API_ORIGIN && IWINV_RELAY_TOKEN) {
      const relayed = await fetchIwinvJobDetail({ url: url.href, job, refresh: true });
      let official = {};
      const relayedHasOfficialDetail = Boolean(relayed.officialSourceUrl)
        || relayed.sourceImages?.length > 0
        || relayed.attachments?.length > 0;
      if (!relayedHasOfficialDetail) {
        try {
          official = await enrichNurseJobFromOfficialSource(relayed.description || '', url.href);
        } catch {
          // 공식 병원 페이지가 일시적으로 막혀도 수집 서버가 확인한 널스잡 상세는 표시합니다.
        }
      }
      parsedDetail = { ...nonEmpty(relayed), ...nonEmpty(official) };
    } else {
      const detailResponse = await fetchJobDetailText(url);
      const generic = parseGenericJobDetail(detailResponse.html, detailResponse.url.href);
      const specialized = detailResponse.url.hostname === 'www.casemanager.or.kr'
        ? parseCaseManagerDetail(detailResponse.html, detailResponse.url.href)
        : detailResponse.url.hostname.includes('nursejob.co.kr')
        ? parseNurseDetail(detailResponse.html)
        : detailResponse.url.hostname === 'www.wanted.co.kr'
          ? parseWantedDetail(detailResponse.html)
          : detailResponse.url.hostname === 'recruit.hallym.or.kr'
            ? parseHallymDetail(detailResponse.html, detailResponse.url.href)
            : {};
      let official = {};
      if (safeOfficialRecruiterUrl(detailResponse.url.href, detailResponse.url.href)) {
        official = await enrichOfficialRecruiterDetail(detailResponse.html, detailResponse.url.href);
      } else if (detailResponse.url.hostname.includes('nursejob.co.kr')) {
        try {
          official = await enrichNurseJobFromOfficialSource(detailResponse.html, detailResponse.url.href);
        } catch {
          // 연결된 병원 채용 페이지가 일시적으로 막혀도 널스잡 원문은 그대로 표시합니다.
        }
      }
      parsedDetail = {
        ...generic,
        ...nonEmpty(specialized),
        ...nonEmpty(detailResponse.officialSourceUrl ? { officialSourceUrl: detailResponse.officialSourceUrl } : {}),
        ...nonEmpty(official),
      };
    }
    const detailVerified = hasMeaningfulDetail(parsedDetail);
    const detailBodyAvailable = hasMeaningfulDetailBody(parsedDetail);
    const notice = !detailVerified
      ? '원문을 열었지만 자동으로 확인할 상세 본문을 찾지 못해 목록 정보를 표시합니다.'
      : !detailBodyAvailable
        ? '원문에서 상세 본문을 자동으로 확인하지 못해 확인 가능한 공고 정보만 표시합니다.'
        : '';
    const detail = {
      ...verifiedDetailFallback(fallback, detailBodyAvailable),
      ...parsedDetail,
      detailVerified,
      detailBodyAvailable,
      detailOrigin: detailVerified ? 'original' : 'feed-fallback',
      ...(notice ? { notice } : {}),
    };
    if (!hasMeaningfulDetail(detail)) throw new Error('원문에서 상세 본문을 찾지 못했습니다.');
    const finalizedDetail = finalizeJobDetail(detail, job);
    return finalizedDetail;
  } catch {
    if (hasMeaningfulDetail(fallback)) return finalizeJobDetail({ ...fallback, detailVerified: false, detailBodyAvailable: hasMeaningfulDetailBody(fallback), detailOrigin: 'feed-fallback', notice: '원문 사이트의 자동 조회 제한으로 목록에서 수집한 내용을 표시합니다.' }, job);
    throw new Error('원문 사이트가 자동 상세 조회를 제한했습니다. 원문 링크에서 바로 확인해 주세요.');
  }
}

async function cachedJobDetail(url, job) {
  const cached = await jobDetailService.read(url.href).catch(() => null);
  if (cached) return cached;
  return finalizeJobDetail({
    ...fallbackJobDetail(job),
    detailVerified: false,
    detailBodyAvailable: false,
    detailOrigin: 'feed-fallback',
    notice: '서버에 저장된 목록 정보입니다. 추가 상세는 다음 수집 후 제공되며, 원문 링크에서 바로 확인할 수 있습니다.',
  }, job);
}

app.post('/api/job-detail', async (req, res) => {
  let url;
  try { url = normalizeDetailUrl(new URL(String(req.body?.url || ''))); }
  catch { return res.status(400).json({ error: '잘못된 채용공고 주소입니다.' }); }
  if (!isAllowedDetailUrl(url)) return res.status(400).json({ error: '등록되지 않은 채용처 주소입니다.' });
  try {
    if (req.body?.refresh === true) {
      // Client-supplied fallback text must never enter the shared detail cache.
      const detail = await jobDetailService.refresh({ url: url.href });
      jobService.invalidateSnapshot();
      res.setHeader('x-nurse-board-detail-cache', 'refresh');
      return res.json(detail);
    }
    const detail = await cachedJobDetail(url, req.body?.job);
    res.setHeader('x-nurse-board-detail-cache', detail.detailVerified ? 'hit' : 'miss');
    return res.json(detail);
  } catch (error) {
    const fallback = fallbackJobDetail(req.body?.job);
    if (hasMeaningfulDetail(fallback)) return res.json(finalizeJobDetail({ ...fallback, detailVerified: false, detailOrigin: 'feed-fallback' }, req.body?.job));
    return res.status(502).json({ error: error.message });
  }
});

app.get('/api/saramin-image', async (req, res) => {
  const recIdx = String(req.query.rec_idx || '');
  let imageUrl;
  try { imageUrl = new URL(String(req.query.url || '')); } catch {}
  if (!/^\d{1,12}$/u.test(recIdx) || !imageUrl || imageUrl.protocol !== 'https:'
    || imageUrl.hostname !== 'pds.saramin.co.kr' || imageUrl.port || imageUrl.username || imageUrl.password
    || imageUrl.search || imageUrl.hash || !imageUrl.pathname.startsWith('/recruit/recruit/')
    || !/\.(?:jpe?g|png|webp)$/iu.test(imageUrl.pathname)) {
    return res.status(400).json({ error: '잘못된 사람인 공고 이미지 주소입니다.' });
  }
  try {
    const response = await fetch(imageUrl.href, {
      headers: {
        'user-agent': 'Mozilla/5.0 NurseBoard/1.0',
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        referer: `https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${recIdx}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return res.status(502).json({ error: '사람인 원문 이미지를 불러오지 못했습니다.' });
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      await response.body?.cancel().catch(() => {});
      return res.status(502).json({ error: '사람인에서 이미지가 아닌 응답을 받았습니다.' });
    }
    const image = await readBoundedResponse(response, 12 * 1024 * 1024);
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(image.length));
    res.setHeader('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('x-content-type-options', 'nosniff');
    return res.send(image);
  } catch {
    return res.status(502).json({ error: '사람인 원문 이미지를 불러오지 못했습니다.' });
  }
});

app.get('/api/job', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id || id.length > 500) return res.status(400).json({ error: '공고 번호를 확인해 주세요.' });
  try {
    const snapshot = await ensureJobSnapshot();
    const job = [...snapshot.jobs, ...snapshot.needsReviewJobs].find((item) =>
      [item.id, item.dedupeKey, ...(item.sourceIds || [])].includes(id));
    if (!job) return res.status(404).json({ error: '수집 목록에서 이 공고가 보이지 않습니다.' });
    const url = normalizeDetailUrl(new URL(job.url));
    const detail = await cachedJobDetail(url, job);
    return res.json({ job, detail });
  } catch {
    return res.status(503).json({ error: '저장된 공고를 불러오지 못했습니다.' });
  }
});

registerSavedSyncRoutes(app, { store: savedSyncStore });
registerCompanyReputationRoute(app, { lookup: companyReputationLookup });
registerFeedbackRoutes(app, { store: feedbackStore, allowRead: IS_COLLECTOR });
registerJobRoutes(app, {
  jobService,
  beforeRead: ensureJobSnapshot,
  awaitRefresh: IS_VERCEL,
  manualRefreshCooldownMs: MANUAL_REFRESH_COOLDOWN_MS,
});
registerAiJobRoutes(app);

app.use(express.static(DIST_ROOT));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  return res.sendFile(DIST_INDEX, (error) => error ? next(error) : undefined);
});

export { app };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4174);
  const host = process.env.HOST || '127.0.0.1';
  await jobService.start({ immediate: false });
  await ensureJobSnapshot();
  if (IS_COLLECTOR) setInterval(() => {
    void ensureJobSnapshot({ force: true }).catch(() => console.warn('공고 캐시 갱신 실패: 기존 응답을 유지합니다.'));
  }, 60_000).unref();
  detailWorkerEnabled = DETAIL_WORKER_OPTIONS.enabled;
  if (detailWorkerEnabled) {
    void warmJobDetails(await jobService.getSnapshot()).catch(() => {});
  }
  app.listen(port, host, () => console.log(`Nurse Board API http://${host}:${port}`));
}
