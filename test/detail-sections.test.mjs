import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detailSectionFingerprint, extractDetailFacts, extractRecruitmentHighlights, extractTitleFacts, normalizeDetailSections,
  normalizeRecruitmentSteps, parseOrderedDetailSections, readableDetailBlocks,
} from '../src/detail-sections.js';

const WANTED_STYLE_DETAIL = `소개
백패커는 아이디어스, 텀블벅, 텐바이텐을 만드는 사람들이 모인 곳입니다.

유닛/셀 소개
idus Mobile셀은 사용자와 가장 가까운 곳에서 서비스를 만듭니다.

우리는 이렇게 일해요
• 컨벤션과 문서로 합의하고 코드 리뷰로 신뢰를 쌓아요
• AI를 적극 활용해 반복 작업을 자동화해요

주요업무
• Android 앱의 커머스 경험을 만들어요
• Jetpack Compose로 낡은 화면을 개선해요

자격요건
• Kotlin으로 Android 앱을 만들어 온 분

우대사항
• Jetpack Compose로 실제 화면을 만들어 본 경험

혜택 및 복지
[Health]
• VIP급 건강검진
[Growth]
• 업무 연관 교육과 도서 구입 지원`;

test('keeps Wanted-style detail sections in their original order', () => {
  const sections = parseOrderedDetailSections(WANTED_STYLE_DETAIL);
  assert.deepEqual(sections.map(({ semanticKey }) => semanticKey), [
    'introduction', 'teamIntroduction', 'workCulture', 'duties', 'qualifications', 'preferredQualifications', 'benefits',
  ]);
  assert.deepEqual(sections.map(({ title }) => title), [
    '소개', '유닛/셀 소개', '우리는 이렇게 일해요', '주요업무', '자격요건', '우대사항', '혜택 및 복지',
  ]);
  assert.equal(sections[0].prose, true);
  assert.match(sections.at(-1).value, /\[Health\][\s\S]*\[Growth\]/);
});

test('keeps an unheaded preamble as an introduction', () => {
  const sections = parseOrderedDetailSections('회사를 소개하는 첫 문단입니다.\n\n담당업무\n• 건강상담');
  assert.equal(sections[0].semanticKey, 'introduction');
  assert.equal(sections[0].title, '소개');
  assert.equal(sections[1].semanticKey, 'duties');
});

test('normalizes API section aliases and rejects empty entries', () => {
  const sections = normalizeDetailSections([
    { key: 'responsibilities', title: '주요업무', content: ['건강상담', '보건교육'] },
    { key: 'welfare', heading: '혜택 및 복지', body: '[Health]\n건강검진', kind: 'mixed' },
    { title: '빈 섹션', content: '' },
  ]);
  assert.deepEqual(sections.map(({ semanticKey }) => semanticKey), ['duties', 'benefits']);
  assert.equal(sections[0].value, '건강상담\n보건교육');
  assert.equal(detailSectionFingerprint('건강 상담!'), detailSectionFingerprint('건강상담'));
});

test('keeps only real recruitment steps around connector symbols', () => {
  assert.deepEqual(
    normalizeRecruitmentSteps('1. 서류전형\n▶\n2. 1차면접 → 최종합격'),
    ['서류전형', '1차면접', '최종합격'],
  );
  assert.deepEqual(
    normalizeRecruitmentSteps(['STEP 1 서류검토', '▼', 'STEP 2 면접']),
    ['서류검토', '면접'],
  );
});

test('joins wrapped source lines without turning every table cell into a bullet', () => {
  const blocks = readableDetailBlocks(`직무기술서
인원
ㆍ산업위생관리기사, 인간공학기사,
산업보건지도사 자격증 소지자
□ (근무시간) 주 5일(40시간), 일 8시간(09:00~18:00)
※ 수습기간 이후 정식 임용 시 제공`);

  assert.deepEqual(blocks[0], { type: 'fragment', items: ['직무기술서', '인원'] });
  assert.equal(blocks[1].text, '산업위생관리기사, 인간공학기사, 산업보건지도사 자격증 소지자');
  assert.equal(blocks[2].type, 'bullet');
  assert.match(blocks[2].text, /09:00~18:00/);
  assert.equal(blocks[3].type, 'note');
});

test('lifts confirmed facts out of a long-form posting into the summary', () => {
  const facts = extractDetailFacts(`1. 모집인원 및 분야
□ 모집인원 : 총 2명
□ (근무지역) 경기도 성남시 분당구 구미동
□ (근무시간) 주 5일(40시간), 일 8시간(09:00~18:00)
□ (채용형태) 정규직
[월 기본급]
ㆍ행정직 9급(주임급): 2,262,730원`);

  assert.equal(facts.location, '경기도 성남시 분당구 구미동');
  assert.equal(facts.workHours, '주 5일(40시간), 일 8시간(09:00~18:00)');
  assert.equal(facts.employment, '정규직');
  assert.equal(facts.headcount, '총 2명');
  assert.match(facts.salary, /2,262,730원/);
  assert.equal(extractDetailFacts('기관 업무상 필요에 따라 근무지 변경(전보)를 실시할 수 있음').location, undefined);
});

test('surfaces nurse-relevant source statements before the full document', () => {
  const highlights = extractRecruitmentHighlights([
    { key: 'duties', value: 'ㆍ보건관리계획 수립, 건강진단 실시\n및 사후관리, 건강증진활동' },
    { key: 'qualifications', value: 'ㆍ간호사 면허 소지자\nㆍ산업보건 실무 경력 2년 이상인 자' },
    { key: 'workConditions', value: '□ (근무시간) 주 5일(40시간), 일 8시간(09:00~18:00)\n[월 기본급]\nㆍ행정직 9급: 2,262,730원' },
  ]);

  assert.deepEqual(highlights.map(({ id }) => id), ['license', 'experience', 'schedule', 'duties', 'pay']);
  assert.equal(highlights[0].text, '간호사 면허 소지자');
  assert.match(highlights.find(({ id }) => id === 'duties').text, /건강진단 실시 및 사후관리/);

  const researchHighlights = extractRecruitmentHighlights([
    { key: 'duties', value: '○IRB 표준작업지침서 유지·관리' },
    { key: 'qualifications', value: '- 간호사 면허증 소지자\n- 임상연구보호프로그램(HRPP) 관련 업무 경력 1년 이상' },
    { key: 'workConditions', value: '연봉 약 37,202천원' },
  ]);
  assert.deepEqual(researchHighlights.map(({ id }) => id), ['license', 'experience', 'duties', 'pay']);
});

test('turns legacy recruitment tables into useful fields and drops empty source sections', () => {
  const source = `모집요강
· 모집분야
|
간호/의료/행정/기타
· 근무지
|
경기
· 모집인원
|
0명
· 고용형태
|
기타
· 자격요건
경력
경력 1년이상
나이
무관
학력
무관
급여조건
면접시 협의
- 본 정보는 국내 최초, 최대의 병원전문취업포털 1위 [메디컬잡]에서 제공합니다.
- 의사/간호사/간호조무사/한의사/약사 등 채용정보 제공 [메디컬잡 - www.medicaljob.co.kr]
제출서류 및 전형방법
· 제출서류
|
· 전형방법
|
· 복리후생
|
마감일 및 지원방법
· 마감일
2026-09-06
· 지원방법
[홈페이지]
해당 홈페이지의 온라인 입사지원 시스템을 이용하시기 바랍니다.
이 페이지를
채용담당자 정보
· 담당자명
채용담당자
· 연락처
Tel : 핸드폰 : 팩스 : --
· 이메일
--
· 홈페이지
http://hosp.ajoumc.or.kr
· 회사주소`;

  const sections = parseOrderedDetailSections(source);
  assert.deepEqual(sections.map(({ semanticKey }) => semanticKey), ['introduction', 'qualifications', 'deadlineText', 'applicationMethod']);
  assert.deepEqual(sections.map(({ title }) => title), ['모집요강', '자격요건', '마감일', '지원방법']);
  assert.ok(sections.every((section) => !/(?:^|\n)\|(?:\n|$)/u.test(section.value)));

  const overview = readableDetailBlocks(sections[0].value);
  assert.deepEqual(overview.find((block) => block.label === '근무지'), { type: 'field', label: '근무지', value: '경기' });
  assert.equal(overview.some((block) => block.label === '고용 형태'), false);
  const qualifications = readableDetailBlocks(sections[1].value);
  assert.deepEqual(qualifications.filter((block) => block.type === 'field').map(({ label, value }) => [label, value]), [
    ['경력', '경력 1년이상'], ['나이', '무관'], ['학력', '무관'], ['급여', '면접시 협의'],
  ]);
  assert.doesNotMatch(sections[1].value, /국내 최초|채용정보 제공/);
  const application = readableDetailBlocks(sections.at(-1).value);
  assert.deepEqual(application.filter((block) => block.type === 'field').map(({ label, value }) => [label, value]), [
    ['담당자', '채용담당자'], ['홈페이지', 'http://hosp.ajoumc.or.kr'],
  ]);

  assert.deepEqual(extractDetailFacts(source), { location: '경기', salary: '면접시 협의' });
  assert.equal(overview.find((block) => block.label === '모집 인원').value, '공고에서 확인 필요');
  assert.deepEqual(normalizeDetailSections([{ key: 'documents', title: '제출서류', value: '|' }]), []);
});

test('structures official application fields and keeps the source URL linkable', () => {
  const blocks = readableDetailBlocks(`접수 기간
2026.07.30(목) ~ 채용시까지
접수 방법
채용사이트를 통한 온라인 접수
공식 채용공고
https://recruit.hallym.or.kr/hrt_p20_detail.jsp?adoptcnt=169`);
  assert.deepEqual(blocks.filter((block) => block.type === 'field'), [
    { type: 'field', label: '접수 기간', value: '2026.07.30(목) ~ 채용시까지' },
    { type: 'field', label: '접수 방법', value: '채용사이트를 통한 온라인 접수' },
    { type: 'field', label: '공식 채용공고', value: 'https://recruit.hallym.or.kr/hrt_p20_detail.jsp?adoptcnt=169' },
  ]);
});

test('uses explicit part-time facts printed in a posting title', () => {
  assert.deepEqual(
    extractTitleFacts('간호본부 외래간호사 (시간제 / 1일6.5시간)'),
    { employment: '시간제', workHours: '1일 6.5시간' },
  );
});
