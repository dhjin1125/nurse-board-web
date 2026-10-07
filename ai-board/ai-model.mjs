// AI·AX·앱 개발 직무 분류. 수집기는 키워드 검색으로 후보를 넓게 가져오고,
// 여기서 제목·직무태그 근거로 AI 관련 여부를 판정한다.

import { profileFitFor, PROFILE_YEARS } from './profile.mjs';

const EVIDENCE = /(인공지능|\bai\b|에이아이|머신\s*러닝|machine\s*learning|딥\s*러닝|deep\s*learning|\bml\b|\bnlp\b|자연어|llm|대규모\s*언어|생성형|gen\s*ai\b|genai|\bgpt\b|랭체인|langchain|\brag\b|에이전틱|agentic|ai\s*agent|mlops|llmops|컴퓨터\s*비전|computer\s*vision|영상\s*처리|\bax\b|ax\s*(전환|컨설팅|기획|pm|개발|엔지니어|프로젝트)|ai\s*전환|디지털\s*전환|\bdx\b|aix\b|안드로이드|android|\bios\b|앱\s*개발|앱개발|모바일\s*앱|모바일\s*개발|모바일\s*엔지니어|플러터|flutter|react\s*native|리액트\s*네이티브|코틀린|kotlin|\bswift\b|데이터\s*사이언티스트|data\s*scientist|데이터\s*엔지니어|data\s*engineer|빅\s*데이터|big\s*data|데이터\s*분석|data\s*analyst|데이터\s*과학|강화\s*학습|추천\s*(시스템|알고리즘|엔진)|파인\s*튜닝|fine[\s-]*tuning|프롬프트\s*엔지니어|ai\s*테크|ai\s*엔지니어|ai\s*개발|ai\s*서비스|ai\s*플랫폼|ai\s*인프라|ai\s*모델|모델\s*(학습|서빙|개발))/iu;

const TAG_MATCHERS = [
  [/llm|대규모\s*언어|생성형|gen\s*ai\b|genai|gpt|랭체인|langchain|\brag\b|에이전틱|agentic|ai\s*agent|파인\s*튜닝|fine[\s-]*tuning|프롬프트\s*엔지니어|nlp|자연어/iu, 'LLM·GenAI'],
  [/인공지능|\bai\b|에이아이|머신\s*러닝|machine\s*learning|딥\s*러닝|deep\s*learning|\bml\b|mlops|llmops|컴퓨터\s*비전|computer\s*vision|영상\s*처리|강화\s*학습|추천\s*(시스템|알고리즘|엔진)|모델\s*(학습|서빙|개발)|ai\s*테크|ai\s*엔지니어|ai\s*개발|ai\s*서비스|ai\s*플랫폼|ai\s*인프라|ai\s*모델/iu, 'AI·ML'],
  [/\bax\b|ax\s*(전환|컨설팅|기획|pm|개발|엔지니어|프로젝트)|ai\s*전환|aix\b|디지털\s*전환|\bdx\b|\bdt\b/iu, 'AX·DX'],
  [/안드로이드|android|코틀린|kotlin/iu, '안드로이드'],
  [/\bios\b|아이폰|\bswift\b/iu, 'iOS'],
  [/앱\s*개발|앱개발|모바일\s*앱|모바일\s*개발|모바일\s*엔지니어|플러터|flutter|react\s*native|리액트\s*네이티브/iu, '앱 개발'],
  [/데이터\s*사이언티스트|data\s*scientist|데이터\s*엔지니어|data\s*engineer|빅\s*데이터|big\s*data|데이터\s*분석|data\s*analyst|데이터\s*과학|dba\b/iu, '데이터'],
];

const PM_PATTERN = /(기획|pm\b|po\b|프로덕트|product|서비스\s*기획|프로젝트\s*관리|매니저|컨설팅|전략|리서치|research\s*manager|총괄|책임|리드|lead\b|head\b|사업)/iu;
const EXCLUDE_PATTERN = /(간호사|간호직|간호조무사|치위생사|약사|한약사|방사선사|임상병리사|물리치료사|작업치료사|영양사|조리사|조리원|미화|시설관리|경비|청소|요양보호사|택배|운전기사|생산직|라인\s*작업|판매\s*사원|캐셔|서빙|보건관리자|산업간호)/iu;

function textOf(value) {
  return String(value ?? '').normalize('NFKC').replace(/​|﻿/g, '').replace(/\s+/g, ' ').trim();
}

export function hasAiEvidence(value) {
  return EVIDENCE.test(textOf(value));
}

export function jobEvidenceText(job = {}) {
  const sectors = Array.isArray(job.sectors) ? job.sectors.join(' ') : textOf(job.sectors);
  const keywords = Array.isArray(job.keywords) ? job.keywords.join(' ') : textOf(job.keywords);
  return [
    textOf(job.title),
    sectors,
    keywords,
    textOf(job.role || job.description || job.duties).slice(0, 400),
  ].filter(Boolean).join(' ');
}

export function classifyAiRole(job = {}) {
  const evidence = jobEvidenceText(job);
  const roleTags = [];
  for (const [pattern, tag] of TAG_MATCHERS) {
    if (pattern.test(evidence) && !roleTags.includes(tag)) roleTags.push(tag);
  }
  const confidenceReasons = [];
  for (const tag of roleTags) confidenceReasons.push(`공고에 ${tag} 직무 표시`);
  const planning = roleTags.length && PM_PATTERN.test(evidence);
  if (planning && !roleTags.includes('기획·PM')) roleTags.push('기획·PM');
  const excluded = EXCLUDE_PATTERN.test(textOf(job.title));
  const needsReview = excluded || roleTags.length === 0;
  if (excluded) confidenceReasons.push('비개발 직무로 보이는 공고');
  else if (!roleTags.length) confidenceReasons.push('AI·앱 직무 근거 부족');
  return { roleTags, confidenceReasons, needsReview, planning };
}

/* ── 기업 규모 추정 ─────────────────────────── */

const PUBLIC_COMPANY_PATTERN = /(공사|공단|공기업|재단|진흥원|한국.{0,8}(연구원|연구소|기술원)|국립|출연|과학기술원|과학기술연구원|평가원|시청|도청|구청|교육청|대학교|학교법인|의료원|의료법인|협회|중앙회|보건소|체육회|문화원|한국은행|금융감독|예금보험|주택금융|신용보증|기술보증|조폐|공영|\bkbs\b|\bmbc\b|\bsbs\b|\bebs\b|\bjtbc\b|\bytn\b|연합뉴스|병원)/iu;

const MAJOR_COMPANY_PATTERN = /(삼성|samsung|에스원|제일기획|\bsk\b|에스케이|\blg\b|엘지|현대|hyundai|기아|\bkia\b|네이버|naver|라인플러스|라인게임즈|라인프렌즈|\bline\s*(plus|games|corp)|엔에이치엔|nhn페이코|페이코|payco|카카오|kakao|쿠팡|coupang|토스|toss|비바리퍼블리카|우아한형제|배달의민족|배민|woowa|넥슨|nexon|넷마블|netmarble|엔씨소프트|ncsoft|엔씨\b|크래프톤|krafton|펄어비스|pearlabyss|스마일게이트|smilegate|컴투스|com2us|위메이드|wemade|네오위즈|neowiz|\bnhn\b|게임빌|gamevil|\bkt\b|포스코|posco|\bcj\b|씨제이|한화|hanwha|롯데|lotte|\bgs\b|두산|doosan|신세계|shinsegae|이마트|emart|ssg|지에스샵|하이브|hybe|티맵모빌리티|tmap|신한|shinhan|kb금융|kb증권|kb국민|kb카드|국민은행|하나(은행|카드|금융|증권|생명|투어)|우리(은행|금융|에프아이에스|카드)|woori|nh농협|농협은행|농협|ibk|기업은행|미래에셋|한국투자|키움|메리츠|교보생명|현대해상|db손|db생명|비씨카드|bc카드|케이뱅크|kbank|대한항공|아시아나|korean\s*air|제주항공|셀트리온|celltrion|유한양행|대웅|한미약품|종근당|녹십자|보령|구글|google|애플|\bapple\b|마이크로소프트|microsoft|아마존|amazon|메타\b|\bmeta\b|넷플릭스|netflix|엔비디아|nvidia|\bibm\b|오라클|oracle|세일즈포스|salesforce|어도비|adobe|인텔|\bintel\b|퀄컴|qualcomm|\bamd\b|테슬라|tesla|\bsap\b|라이엇|riot\s*games|블리자드|blizzard|에픽게임즈|epic\s*games|티빙|tving|웨이브|wavve|신한ds|삼성sds|엘지씨엔에스|lg\s*cns|현대오토에버|오토에버|포스코dx|포스코디엑스|sk플랜트|sk ax|에스케이에이엑스)/iu;

const GROWTH_COMPANY_PATTERN = /(당근|daangn|무신사|musinsa|컬리|kurly|마켓컬리|야놀자|yanolja|직방|zigbang|리디|ridi|버킷플레이스|오늘의집|ohouse|채널코퍼레이션|채널톡|channel\s*(corp|talk|io)|뤼이드|riiid|매스프레소|콴다|qanda|뱅크샐러드|banksalad|핀다|finda|센드버드|sendbird|하이퍼커넥트|hyperconnect|두나무|dunamu|번개장터|리멤버|드라마앤컴퍼니|마이리얼트립|myrealtrip|브랜디|brandi|에이블리|\bably\b|버즈빌|buzzvil|토스랩|잔디|jandi|왓챠|watcha|아이디어스|크몽|kmong|숨고|soomgo|클래스101|class101|패스트캠퍼스|코멘토|원티드랩|wantedlab|사람인|saramin|잡코리아|jobkorea|피플앤컴퍼니|코드스테이츠|팀스파르타|항해99|이스트소프트|알서포트|한컴|더존|douzone|안랩|ahnlab|시큐아이|이글루|윈스|파수|지란지교|솔트룩스|saltlux|플리토|flitto|트웰브랩스|twelvelabs|뷰런|vueron|룰루랩|lululab|스켈터랩스|skelterlabs|업스테이지|upstage|아틀라스랩스|클로봇|매드업|madup|올거나이즈|allganize|딥브레인|deepbrain|마키나락스|makinarocks|옴니어스|omneus|노타\b|\bnota\b|커먼컴퓨터|수아랩|프렌들리에이아이|friendli|퓨리오사|furiosa|리벨리온|rebellions|사피온|sapeon|쏘카|socar|타다|vcnc|티머니|tmoney|산하정보|더존비즈온|다우기술|다우데이타|가비아|카페24|cafe24|메이크샵|코리아센터|인터파크|11번가|11st|티몬|tmon|위메프|지마켓|gmarket|홈앤쇼핑|k오타|웨이브릿지|오픈서베이|딜리버스|딜리버리히어로|요기요|쿠팡이츠|엔코아|바로고|생각대로|인성정보|웹젠|액션스퀘어|모히또|스토어링크|플랫팜|스타일쉐어|지그재그|브랜드코퍼레이션|힐링페이퍼|강남언니|바비톡|굿닥|케어랩스|닥터나우|솔닥|닥터다이어리|엠디프라임|눔|noom|휴먼스케이프|레몬헬스케어|웰트|welt|루카스랩스|메디블록|직방삼성sds|홈즈컴퍼니|삼성에스디에스|피터팬|다방|집꾸미기|오늘식탁|스픽|말해보카|튜터링|산타|뤼튼|wrtn|빙글|벤틀스페이스|팀바이럴|티앤엠|에이팀벤처스|빅케어|헬스허브|핀트|파운트|어니스트|에임|aim|케이뱅크|토스증권|토스뱅크|토스플레이스|토스페이먼츠|토스인컴)/iu;

const LEGAL_PATTERN = /(주식회사|㈜|\(주\)|\(사\)|\(유\)|\(재\)|유한회사|유한책임회사)/giu;
const LEGAL_ENTITY_MARK = /주식회사|㈜|\(주\)|\(사\)|\(유\)|\(재\)|유한회사|유한책임회사/iu;
const TOP_BADGE_PATTERN = /top\s*\d{2,3}|매출\s*상위|\d{2,3}대\s*기업|상장기업|코스피|코스닥/iu;

function normalizedCompanyName(job = {}) {
  return textOf([job.company, job.affiliate].filter(Boolean).join(' '))
    .replace(LEGAL_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scaleFromHint(hint) {
  const text = textOf(hint);
  if (!text) return null;
  if (/공기업|공공|준정부|공사|공단|기타공공/.test(text)) return { id: 'public', label: '공공·기관' };
  if (/대기업|지주|외국계|그룹|글로벌|상장|코스피|코스닥/.test(text)) return { id: 'major', label: '대기업·그룹사' };
  if (/중견|강소|벤처|스타트업|유니콘|이노비즈|메인비즈|유명/.test(text)) return { id: 'growth', label: '성장·중견기업' };
  if (/중소/.test(text)) return { id: 'sme', label: '중소기업' };
  return null;
}

export function companyScaleFor(job = {}) {
  const name = normalizedCompanyName(job);
  // ALIO는 공공기관만 게시되는 채널이라 소스 자체가 공공 신호다.
  const publicSource = /alio/i.test([job.sourceEntryId, job.source].filter(Boolean).join(' '));
  if (PUBLIC_COMPANY_PATTERN.test(name)) return { id: 'public', label: '공공·기관' };
  if (MAJOR_COMPANY_PATTERN.test(name)) return { id: 'major', label: '대기업·그룹사' };
  if (GROWTH_COMPANY_PATTERN.test(name)) return { id: 'growth', label: '성장·중견기업' };
  const hinted = scaleFromHint(job.companyScaleHint);
  if (hinted) return hinted;
  if (TOP_BADGE_PATTERN.test(String(job.badge || ''))) return { id: 'growth', label: '성장·중견기업' };
  if (LEGAL_ENTITY_MARK.test(String(job.company || ''))) return { id: 'sme', label: '법인·중소기업 추정' };
  if (publicSource) return { id: 'public', label: '공공·기관' };
  return { id: 'unknown', label: '규모 확인' };
}

/* ── 급여 ─────────────────────────── */

export function salaryFor(job = {}) {
  const raw = textOf(job.salary);
  if (!raw) return null;
  const annual = raw.match(/연봉\s*([\d,]+)\s*(?:만원)?\s*[~\-–—]?\s*([\d,]+)?\s*만원?/) || raw.match(/([\d,]+)\s*[~\-–—]?\s*([\d,]+)?\s*만원/);
  const monthly = !annual && raw.match(/월급\s*([\d,]+)\s*만원?/);
  const match = annual || monthly;
  let annualMinWon = null;
  let label = raw;
  if (match) {
    const amount = Number(String(match[1] || '').replace(/,/g, ''));
    const won = amount * (monthly ? 12 : 1) * 10000;
    if (won >= 5_000_000 && won <= 5_000_000_000) annualMinWon = won;
    const lo = match[1], hi = match[2];
    const unit = monthly ? '월급' : '연봉';
    label = hi && hi !== lo ? `${unit} ${lo}~${hi}만원` : `${unit} ${lo}만원`;
  }
  return { raw, label, annualMinWon };
}

/* ── 경력 분류 ─────────────────────────── */

export function experienceInfoFor(job = {}) {
  const expText = [job.experienceLevel, job.experience].filter(Boolean).join(' ');
  const empText = [job.employmentType, job.employment].filter(Boolean).join(' ');
  const title = textOf(job.title);
  const all = `${expText} ${empText} ${title}`;
  // "2026년 경력채용" 같은 연도가 연차로 잡히지 않게 숫자 앞에 다른 숫자가 없는 경우만 본다.
  const years = Math.max(0, ...[...all.matchAll(/(?<!\d)(\d{1,2})\s*년\s*(?:이상|↑|이후)|(?<!\d)경력\s*(?<!\d)(\d{1,2})\s*년|(?<!\d)(\d{1,2})\s*년차/gi)]
    .map((m) => Number(m[1] || m[2] || m[3] || 0))
    .filter((n) => n > 0 && n <= 20));
  if (/인턴|intern|체험형|교육생|채용연계형\s*교육/iu.test(all)) {
    return { category: 'intern', label: '인턴', years: 0 };
  }
  const entry = /신입|경력\s*무관|경력무관|무관|new\s*grad|entry\s*level|졸업\s*예정/iu.test(expText);
  const experienced = /경력(?!무관)|시니어|senior|리드|lead|팀장|주임|대리|과장|차장|매니저|manager/iu.test(expText);
  if (experienced && !entry) {
    return { category: 'experienced', label: years ? `경력 ${years}년↑` : '경력', years };
  }
  if (entry) {
    const exact = /신입/.test(expText) ? '신입' : '경력무관';
    return { category: 'junior', label: experienced ? `${exact}·경력` : exact, years };
  }
  if (!expText.trim()) return { category: 'unknown', label: '확인 필요', years: 0 };
  return { category: 'unknown', label: textOf(expText) || '확인 필요', years };
}

/* ── 지역 분류 ─────────────────────────── */

const REGION_GROUP_BY_CODE = { 11: '서울', 26: '부산', 27: '대구', 28: '인천', 29: '광주', 30: '대전', 31: '울산', 36: '세종', 41: '경기', 51: '강원', 43: '충북', 44: '충남', 52: '전북', 46: '전남', 47: '경북', 48: '경남', 50: '제주' };
const REGION_NAME_PATTERN = /서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/;
const REMOTE_PATTERN = /재택|원격|리모트|remote|자율\s*근무|전면\s*원격|풀\s*리모트/iu;

export function regionInfoFor(job = {}) {
  const region = textOf(job.region || job.location);
  const remote = REMOTE_PATTERN.test(`${region} ${textOf(job.title)}`);
  const group = REGION_GROUP_BY_CODE[job.regionCode] || (region.match(REGION_NAME_PATTERN) || [null])[0];
  return { group, remote, metro: group === '서울' || group === '경기' || group === '인천' };
}

/* ── 지원 티어 ─────────────────────────── */

export const AI_TIER_META = Object.freeze({
  S: { order: 0, grade: 'S', label: '최우선 지원', description: 'AI·앱 직무가 뚜렷하고 기업·고용·지역 조건이 좋은 공고' },
  A: { order: 1, grade: 'A', label: '적극 검토', description: '조건 대부분이 좋고 확인할 게 적은 공고' },
  B: { order: 2, grade: 'B', label: '조건 확인', description: '가능성은 있지만 고용형태·경력·기업 정보를 더 봐야 하는 공고' },
  C: { order: 3, grade: 'C', label: '후순위', description: '직무 근거나 조건이 아쉬운 공고' },
});
export const AI_TIER_ORDER = Object.freeze(['S', 'A', 'B', 'C']);

function capTier(tier, cap) {
  return AI_TIER_META[tier].order < AI_TIER_META[cap].order ? cap : tier;
}

export function aiTierFor(job = {}, { now = new Date() } = {}) {
  const tags = Array.isArray(job.roleTags) ? job.roleTags : [];
  const has = (t) => tags.includes(t);
  const devCount = [has('LLM·GenAI'), has('AI·ML'), has('안드로이드'), has('iOS'), has('앱 개발'), has('데이터')].filter(Boolean).length;

  let roleFit, roleReason;
  if (has('LLM·GenAI')) { roleFit = 30; roleReason = 'LLM·생성형 AI 직무'; }
  else if (has('AI·ML')) { roleFit = 28; roleReason = 'AI·ML 직무'; }
  else if (has('안드로이드') || has('iOS')) { roleFit = 24; roleReason = '모바일 앱 개발 직무'; }
  else if (has('앱 개발')) { roleFit = 23; roleReason = '앱 개발 직무'; }
  else if (has('데이터')) { roleFit = 20; roleReason = '데이터 직무'; }
  else if (has('AX·DX')) { roleFit = 16; roleReason = 'AX·DX 직무'; }
  else if (has('기획·PM')) { roleFit = 10; roleReason = 'AI·앱 기획 직무'; }
  else { roleFit = 8; roleReason = '직무 근거 확인 필요'; }
  if (devCount >= 2) roleFit = Math.min(30, roleFit + 2);

  const scale = job.companyScale || companyScaleFor(job);
  const organization = { major: 22, public: 18, growth: 16, sme: 10, unknown: 7 }[scale.id] ?? 7;

  const emp = textOf([job.employmentType, job.employment].filter(Boolean).join(' '));
  const exp = job.experienceInfo || experienceInfoFor(job);
  let stability = 9, empReason = null, empCaution = null;
  if (/인턴|체험형|교육생/.test(emp) || exp.category === 'intern') { stability = 4; empCaution = '인턴·체험형 전형'; }
  else if (/병역특례|전문연구|산업기능/.test(emp)) { stability = 10; empCaution = '병역특례·전문연구 전형'; }
  else if (/프리랜서|파견|도급|위촉|용역/.test(emp)) { stability = 5; empCaution = '프리랜서·파견 형태'; }
  else if (/정규직/.test(emp) && /계약|기간제/.test(emp)) { stability = 12; empReason = '정규직·계약 병기'; }
  else if (/정규직/.test(emp)) { stability = 18; empReason = '정규직'; }
  else if (/무기\s*계약/.test(emp)) { stability = 14; empReason = '무기계약'; }
  else if (/계약|기간제|수시/.test(emp)) { stability = 7; empCaution = '계약·기간제 고용'; }

  const region = job.regionInfo || regionInfoFor(job);
  let location = 7, locReason = null, locCaution = null;
  if (region.remote) { location = 13; locReason = '원격·재택 근무'; }
  else if (region.group === '서울') { location = 14; locReason = '서울 근무'; }
  else if (region.group === '경기') { location = 12; locReason = '경기 근무'; }
  else if (region.group === '인천') { location = 10; locReason = '인천 근무'; }
  else if (region.group) { location = 4; locCaution = '수도권 밖 근무지'; }

  const salary = job.salaryInfo || salaryFor(job);
  const compensation = salary?.annualMinWon ? 3 : salary?.raw ? 1 : 0;

  // 커리어 프로필 적합도 (profile.mjs) — 개인 맞춤 우선순위
  const profile = job.profileFit || profileFitFor(job);
  let expAdj = 0;
  if (exp.category === 'junior' && exp.label === '신입') expAdj = -4;
  else if (exp.years > PROFILE_YEARS.max) expAdj = -3;

  const reasons = [...profile.hits.slice(0, 2), roleReason];
  if (scale.id !== 'unknown') reasons.push(scale.label);
  if (empReason) reasons.push(empReason);
  if (locReason) reasons.push(locReason);
  if (salary?.annualMinWon && reasons.length < 4) reasons.push('연봉 공개');

  const cautions = [...profile.cautions];
  if (empCaution) cautions.push(empCaution);
  if (locCaution) cautions.push(locCaution);
  if (scale.id === 'unknown') cautions.push('기업 규모 확인');
  if (expAdj === -4) cautions.push('신입 전형 — 경력직 대상 아님');
  if (exp.years > PROFILE_YEARS.max) cautions.push(`경력 ${exp.years}년↑ 요구`);
  else if (exp.years > 0 && exp.years < PROFILE_YEARS.min) cautions.push('요구 연차 낮음');
  if (job.deadlineStatus === 'closing-soon' || job.deadlineStatus === 'today') cautions.push('마감 임박');

  let freshness = 2;
  const publishedMs = Date.parse(job.publishedAt || '');
  const ageDays = Number.isFinite(publishedMs) ? (now.getTime() - publishedMs) / 86400000 : null;
  if (ageDays != null && ageDays <= 7) freshness += 4;
  else if (ageDays != null && ageDays <= 30) freshness += 2;
  freshness = Math.max(0, Math.min(6, freshness));

  const score = roleFit + organization + stability + location + freshness + compensation + profile.score + expAdj;
  let tier = score >= 88 ? 'S' : score >= 66 ? 'A' : score >= 48 ? 'B' : 'C';

  if (job.deadlineStatus === 'expired') tier = 'C';
  if (exp.category === 'intern' || /인턴|체험형|교육생/.test(emp)) tier = capTier(tier, 'B');
  else if (/계약|기간제|수시|프리랜서|파견|도급|위촉|용역|병역특례|전문연구|산업기능/.test(emp)) tier = capTier(tier, 'B');
  if (scale.id === 'unknown' && location <= 7) tier = capTier(tier, 'B');

  return {
    tier,
    ...AI_TIER_META[tier],
    score,
    reasons: [...new Set(reasons)].slice(0, 3),
    cautions: [...new Set(cautions)].slice(0, 3),
  };
}

export function prepareAiJob(job = {}) {
  const ai = classifyAiRole(job);
  const companyScale = companyScaleFor(job);
  const experienceInfo = experienceInfoFor(job);
  const regionInfo = regionInfoFor(job);
  const salaryInfo = salaryFor(job);
  const tiered = {
    ...job,
    roleTags: ai.roleTags,
    confidenceReasons: [...new Set([...(job.confidenceReasons || []), ...ai.confidenceReasons])],
    needsReview: ai.needsReview,
    companyScale,
    experienceInfo,
    regionInfo,
    salaryInfo,
  };
  const withProfile = { ...tiered, profileFit: profileFitFor(tiered) };
  return { ...withProfile, aiTier: aiTierFor(withProfile) };
}
