const SECTION_DEFINITIONS = [
  { key: 'introduction', title: '소개', prose: true, aliases: ['소개', '기업 소개', '회사 소개', '회사 및 팀 소개', '서비스 소개', '포지션 소개', '직무 소개', '조직 소개', 'about', 'about us', 'position overview'] },
  { key: 'teamIntroduction', title: '팀 소개', prose: true, aliases: ['팀 소개', '부서 소개', '유닛 소개', '셀 소개', '유닛/셀 소개', '조직/팀 소개', 'about the team', 'team introduction'] },
  { key: 'workCulture', title: '우리는 이렇게 일해요', aliases: ['우리는 이렇게 일해요', '이렇게 일해요', '일하는 방식', '업무 방식', '팀 문화', '조직문화', 'how we work', 'our culture'] },
  { key: 'duties', title: '담당업무', aliases: ['담당업무', '담당 업무', '주요업무', '주요 업무', '직무내용', '직무 내용', '업무내용', '업무 내용', '근무내용', '모집내용', 'responsibilities', "what you'll do"] },
  { key: 'qualifications', title: '자격요건', aliases: ['자격요건', '자격 요건', '지원자격', '지원 자격', '지원조건', '지원 조건', '응시자격', '응시요건', '필수요건', '필수 조건', 'requirements', 'qualifications', "what we're looking for"] },
  { key: 'preferredQualifications', title: '우대사항', aliases: ['우대사항', '우대 사항', '우대요건', '우대조건', '우대 조건', 'preferred qualifications', 'nice to have', 'preferred'] },
  { key: 'benefits', title: '혜택 및 복지', aliases: ['혜택 및 복지', '복지 및 혜택', '복리후생', '복리 후생', '혜택', '복지', 'benefits', 'benefits and perks', 'perks & benefits'] },
  { key: 'workConditions', title: '근무조건', aliases: ['근무조건', '근무 조건', '근로조건', '근로 조건', '근무환경', 'working conditions'] },
  { key: 'documents', title: '제출서류', aliases: ['제출서류', '제출 서류', 'required documents'] },
  { key: 'recruitmentProcess', title: '전형절차', ordered: true, aliases: ['전형절차', '전형 절차', '전형 절차 및 안내 사항', '채용절차', '채용 절차', '전형방법', '전형일정', '채용일정', '채용과정', '제출서류 및 전형방법', 'hiring process', 'recruitment process'] },
  { key: 'applicationMethod', title: '지원방법', aliases: ['지원방법', '지원 방법', '접수방법', '접수 방법', '지원 방식', '지원기간 및 방법', '접수기간 및 방법', '마감일 및 지원방법', 'how to apply'] },
  { key: 'otherInformation', title: '기타사항', prose: true, aliases: ['기타사항', '기타 사항', '유의사항', '안내사항', '참고사항', '개인정보 처리방침', '서류반환정책', '문의사항', '문의', '기타 안내', 'additional information', 'notes'] },
  { key: 'deadlineText', title: '마감기한', aliases: ['마감기한', '마감 기한', '마감일', '접수마감', '지원마감', '접수기간', '지원기간', '서류접수기간', 'application period'] },
];

const DEFINITION_BY_KEY = new Map(SECTION_DEFINITIONS.map((definition) => [definition.key, definition]));
const KEY_ALIASES = new Map([
  ['responsibilities', 'duties'], ['requirements', 'qualifications'], ['preferred', 'preferredQualifications'],
  ['preferredqualifications', 'preferredQualifications'], ['welfare', 'benefits'], ['jobbenefits', 'benefits'],
  ['benefits', 'benefits'], ['workconditions', 'workConditions'], ['process', 'recruitmentProcess'],
  ['application', 'applicationMethod'], ['other', 'otherInformation'], ['deadline', 'deadlineText'],
]);

function cleanSectionTitle(value) {
  let title = String(value || '').trim()
    .replace(/^(?:(?:#{1,6}|\d+[.)]|[-–—•●▪·ㆍ■□◆◇▶▷✓✔✅📌])\s*)+/u, '')
    .replace(/\s*[:：]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const bracketed = title.match(/^\[([^\]]+)]$/);
  if (bracketed) title = bracketed[1].trim();
  return title.slice(0, 80);
}

function titleToken(value) {
  return cleanSectionTitle(value).toLocaleLowerCase('ko-KR');
}

const DEFINITION_BY_TITLE = new Map(SECTION_DEFINITIONS.flatMap((definition) => definition.aliases.map((alias) => [titleToken(alias), definition])));

const DETAIL_SEPARATOR_LINE = /^(?:[|｜¦‖]+|[-–—]{1,3})$/u;
const DETAIL_NAVIGATION_NOISE = /^(?:이 페이지를)$/u;
const DETAIL_PROVIDER_PROMOTION = /^(?:[-–—•·ㆍ]\s*)?(?:본 정보는 국내 최초, 최대의 병원전문취업포털|의사\/간호사\/간호조무사\/한의사\/약사 등 채용정보 제공 \[메디컬잡)/u;

function cleanDetailSourceText(value, limit = 16_000) {
  const raw = Array.isArray(value) ? value.filter(Boolean).join('\n') : String(value || '');
  return raw.replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u2007\u202f]+/g, ' ').trim())
    .filter((line) => line && !DETAIL_SEPARATOR_LINE.test(line) && !DETAIL_NAVIGATION_NOISE.test(line) && !DETAIL_PROVIDER_PROMOTION.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

function introductionDisplay(title, content, semanticKey) {
  if (semanticKey !== 'introduction' || !/^모집요강(?:\n|$)/u.test(content)) return { title, content };
  return { title: '모집요강', content: content.replace(/^모집요강\s*/u, '').trim() };
}

function semanticKeyFor(key, title) {
  const rawKey = String(key || '').replace(/[^a-zA-Z]/g, '');
  if (DEFINITION_BY_KEY.has(rawKey)) return rawKey;
  const aliasedKey = KEY_ALIASES.get(rawKey.toLocaleLowerCase('en-US'));
  if (aliasedKey) return aliasedKey;
  return DEFINITION_BY_TITLE.get(titleToken(title))?.key || '';
}

function sectionValue(section) {
  const value = section?.value ?? section?.content ?? section?.body ?? section?.text ?? section?.items;
  return cleanDetailSourceText(value);
}

export function normalizeRecruitmentSteps(value) {
  const values = Array.isArray(value) ? value : [value];
  const steps = values.flatMap((item) => cleanDetailSourceText(item, 8000)
    .split(/\n+|\s*[•●▪]\s*|\s+[·ㆍ]\s+|\s*(?:-{1,2}>|={1,2}>|[▶▷▸►→➜⇒›»➡⟶↓▼▽>])\s*/u))
    .map((item) => item
      .replace(/^\s*(?:step\s*\d+[:.)-]?|\d+[.)]|[①-⑳]|[-–—])\s*/iu, '')
      .trim())
    .filter(Boolean);
  return [...new Set(steps)].slice(0, 80);
}

export function normalizeDetailSections(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((section) => {
    if (!section || typeof section !== 'object') return [];
    let title = cleanSectionTitle(section.title || section.heading || section.label);
    let content = sectionValue(section);
    if (!title || !content) return [];
    const semanticKey = semanticKeyFor(section.semanticKey || section.key, title);
    ({ title, content } = introductionDisplay(title, content, semanticKey));
    if (!content) return [];
    const definition = DEFINITION_BY_KEY.get(semanticKey);
    const kind = ['prose', 'list', 'ordered', 'mixed'].includes(section.kind) ? section.kind : '';
    return [{
      key: semanticKey || 'custom',
      semanticKey,
      title,
      value: content,
      prose: kind ? kind === 'prose' : Boolean(definition?.prose),
      ordered: kind ? kind === 'ordered' : Boolean(definition?.ordered),
      kind: kind || (definition?.prose ? 'prose' : definition?.ordered ? 'ordered' : 'mixed'),
    }];
  });
}

function appendLine(lines, rawLine) {
  const line = String(rawLine || '').trim();
  if (line) lines.push(line);
  else if (lines.length && lines.at(-1) !== '') lines.push('');
}

function finishSection(target, section) {
  if (!section) return;
  let value = cleanDetailSourceText(section.lines.join('\n'));
  let title = section.title;
  ({ title, content: value } = introductionDisplay(title, value, section.definition.key));
  if (!value) return;
  target.push({
    key: section.definition.key,
    semanticKey: section.definition.key,
    title,
    value: value.slice(0, 16_000),
    prose: Boolean(section.definition.prose),
    ordered: Boolean(section.definition.ordered),
    kind: section.definition.prose ? 'prose' : section.definition.ordered ? 'ordered' : 'mixed',
  });
}

export function parseOrderedDetailSections(value) {
  const text = cleanDetailSourceText(value, 20_000);
  if (!text) return [];
  const leading = [];
  const sections = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      appendLine(current?.lines || leading, '');
      continue;
    }
    const separatorIndex = trimmed.search(/[:：]/);
    const possibleTitle = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed;
    const definition = DEFINITION_BY_TITLE.get(titleToken(possibleTitle));
    if (definition) {
      finishSection(sections, current);
      current = { definition, title: cleanSectionTitle(possibleTitle) || definition.title, lines: [] };
      const remainder = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : '';
      if (remainder) appendLine(current.lines, remainder);
      continue;
    }
    appendLine(current?.lines || leading, rawLine);
  }
  finishSection(sections, current);

  let leadingValue = cleanDetailSourceText(leading.join('\n'));
  if (leadingValue && !sections.some((section) => section.semanticKey === 'introduction')) {
    let leadingTitle = '소개';
    ({ title: leadingTitle, content: leadingValue } = introductionDisplay(leadingTitle, leadingValue, 'introduction'));
    if (leadingValue) sections.unshift({ key: 'introduction', semanticKey: 'introduction', title: leadingTitle, value: leadingValue.slice(0, 16_000), prose: true, ordered: false, kind: 'prose' });
  }
  return sections.slice(0, 24);
}

export function detailSectionFingerprint(value) {
  return String(value || '').toLocaleLowerCase('ko-KR').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 500);
}

const DETAIL_BULLET = /^[-–—•●▪·ㆍ◆◇▶▷✓✔✅]\s*/u;
const DETAIL_GROUP = /^□\s*/u;
const DETAIL_NOTE = /^※\s*/u;
const DETAIL_BRACKET_HEADING = /^\[([^\]]{1,40})\]$/u;
const DETAIL_NUMBERED_HEADING = /^(\d{1,2})[.)]\s+(.{2,60})$/u;
const DETAIL_TABLE_LABEL = /^(?:구\s*분|내\s*용|인원|제한|경쟁|필수|우대|유형|보수|공통|직무기술서|채용분야)$/u;
const DETAIL_STANDALONE_FRAGMENT = /^(?:\d+|행정직|총무|안전팀|시스템|개발팀|정규직|계약직|기간제|시간제|\d+~\d+급|\(주임~|대리급\)|원서접수|서류전형|면접전형)$/u;
const DETAIL_INLINE_HEADING = /^(?:모집요강|상세요강|채용담당자 정보|담당자 정보)$/u;
const DETAIL_SOURCE_NOTE = /(?:사정상 조기 마감|본 정보는 .+에서 제공|채용정보 제공 \[)/u;
const DETAIL_FIELD_LABELS = new Map([
  ['모집분야', '모집 분야'], ['채용분야', '모집 분야'], ['모집부문', '모집 부문'],
  ['근무지', '근무지'], ['근무지역', '근무지'], ['모집인원', '모집 인원'], ['채용인원', '모집 인원'],
  ['고용형태', '고용 형태'], ['채용형태', '고용 형태'], ['근무형태', '근무 형태'], ['근무시간', '근무 시간'],
  ['경력', '경력'], ['경력조건', '경력'], ['나이', '나이'], ['연령', '나이'], ['학력', '학력'], ['학력조건', '학력'],
  ['급여', '급여'], ['급여조건', '급여'], ['연봉', '급여'], ['월급', '급여'], ['마감일', '마감일'],
  ['담당자명', '담당자'], ['담당자', '담당자'], ['연락처', '연락처'], ['전화', '연락처'], ['전화번호', '연락처'],
  ['이메일', '이메일'], ['홈페이지', '홈페이지'], ['회사주소', '회사 주소'], ['주소', '회사 주소'],
  ['접수기간', '접수 기간'], ['접수방법', '접수 방법'], ['공식채용공고', '공식 채용공고'],
]);

function detailFieldToken(value) {
  return String(value || '').replace(/[()[\]]/g, '').replace(/[\s:：]+/g, '').trim();
}

function detailFieldLabel(value) {
  return DETAIL_FIELD_LABELS.get(detailFieldToken(value)) || '';
}

function emptyFieldValue(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return !text || DETAIL_SEPARATOR_LINE.test(text) || /^(?:없음|미표기|--?)$/u.test(text)
    || /^(?:Tel\s*:)?\s*핸드폰\s*:\s*팩스\s*:\s*--?$/iu.test(text);
}

function detailLines(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => cleanDetailSourceText(item)
    .split(/\n+/))
    .map((line) => line.replace(/[ \t\u00a0\u2007\u202f]+/g, ' ').trim())
    .filter(Boolean);
}

function shortSourceFragment(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 16 || /[.!?。,:：;；]/u.test(text)) return false;
  return DETAIL_TABLE_LABEL.test(text) || text.split(/\s+/).length <= 3;
}

function appendReadableBlock(blocks, block) {
  if (!block?.text && !block?.items?.length && !block?.value) return;
  const previous = blocks.at(-1);
  if (block.type === 'fragment' && previous?.type === 'fragment' && previous.items.length < 6) {
    previous.items.push(...block.items.slice(0, 6 - previous.items.length));
    return;
  }
  blocks.push(block);
}

function canJoinDetailContinuation(previous, line) {
  if (!previous || !['bullet', 'note'].includes(previous.type)) return false;
  if (DETAIL_TABLE_LABEL.test(line) || DETAIL_STANDALONE_FRAGMENT.test(line) || DETAIL_BRACKET_HEADING.test(line) || DETAIL_NUMBERED_HEADING.test(line)) return false;
  if (/[,，(/]$/u.test(previous.text)) return true;
  return !/[.!?。]$/u.test(previous.text)
    || /(?:[,，(/]|\b및|\b등)$/u.test(previous.text)
    || /^(?:및|또는|등|각|제\d+조|시행|운영|관리|업무|지원|지급|결정|선정|점수|결과)/u.test(line);
}

/**
 * Converts table-cell-heavy source text into a smaller set of readable blocks.
 * The source wording is preserved; only line-wrap fragments are joined.
 */
export function readableDetailBlocks(value) {
  const blocks = [];
  const lines = detailLines(value);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const bracketed = rawLine.match(DETAIL_BRACKET_HEADING);
    const numbered = rawLine.match(DETAIL_NUMBERED_HEADING);
    const isGroup = DETAIL_GROUP.test(rawLine);
    const isNote = DETAIL_NOTE.test(rawLine);
    const isBullet = DETAIL_BULLET.test(rawLine);
    const text = rawLine
      .replace(DETAIL_GROUP, '')
      .replace(DETAIL_NOTE, '')
      .replace(DETAIL_BULLET, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;

    if (bracketed) {
      appendReadableBlock(blocks, { type: 'subheading', text: bracketed[1].trim() });
      continue;
    }
    if (DETAIL_INLINE_HEADING.test(text)) {
      appendReadableBlock(blocks, { type: 'subheading', text });
      continue;
    }
    const fieldLabel = detailFieldLabel(text);
    if (fieldLabel) {
      const nextRawLine = lines[index + 1] || '';
      const nextText = nextRawLine
        .replace(DETAIL_GROUP, '')
        .replace(DETAIL_NOTE, '')
        .replace(DETAIL_BULLET, '')
        .replace(/\s+/g, ' ')
        .trim();
      const nextIsControl = !nextText || DETAIL_BRACKET_HEADING.test(nextRawLine)
        || DETAIL_INLINE_HEADING.test(nextText) || Boolean(detailFieldLabel(nextText));
      if (!nextIsControl) {
        const fieldValue = fieldLabel === '모집 인원' && /^0\s*명$/u.test(nextText)
          ? '공고에서 확인 필요'
          : nextText;
        const genericCategory = ['모집 부문', '고용 형태'].includes(fieldLabel) && fieldValue === '기타';
        if (!genericCategory && !emptyFieldValue(fieldValue)) appendReadableBlock(blocks, { type: 'field', label: fieldLabel, value: fieldValue });
        index += 1;
      }
      continue;
    }

    const previous = blocks.at(-1);
    if (!isGroup && !isNote && !isBullet && !bracketed && !numbered && canJoinDetailContinuation(previous, text)) {
      previous.text = `${previous.text} ${text}`.replace(/\s+/g, ' ').trim();
      continue;
    }
    if (numbered && rawLine.length <= 64) {
      appendReadableBlock(blocks, { type: 'subheading', text: numbered[2].trim() });
      continue;
    }
    if (isGroup) {
      appendReadableBlock(blocks, { type: /^\([^)]{1,30}\)/u.test(text) ? 'bullet' : 'subheading', text });
      continue;
    }
    if (isNote) {
      appendReadableBlock(blocks, { type: 'note', text });
      continue;
    }
    if (isBullet) {
      appendReadableBlock(blocks, { type: DETAIL_SOURCE_NOTE.test(text) ? 'note' : 'bullet', text });
      continue;
    }
    if (shortSourceFragment(text)) {
      appendReadableBlock(blocks, { type: 'fragment', items: [text] });
      continue;
    }
    appendReadableBlock(blocks, { type: 'text', text });
  }
  return blocks.slice(0, 120);
}

function sourceText(value) {
  return Array.isArray(value) ? value.filter(Boolean).join('\n') : String(value || '');
}

function firstCapturedLine(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.replace(/^[\s:：·ㆍ-]+|[\s,，]+$/g, '').replace(/\s+/g, ' ').trim();
    if (value) return value.slice(0, 180);
  }
  return '';
}

/** Pulls facts already printed in long-form source text into the summary grid. */
export function extractDetailFacts(value) {
  const text = cleanDetailSourceText(sourceText(value), 20_000);
  if (!text.trim()) return {};
  const inlineFacts = new Map(readableDetailBlocks(text)
    .filter((block) => block.type === 'field')
    .map((block) => [block.label, block.value]));
  const location = inlineFacts.get('근무지') || firstCapturedLine(text, [
    /(?:□\s*)?\(?근무\s*(?:지역|지)\)?(?!\s*(?:변경|이동|전보))\s*[:：]?\s*([^\n]+)/iu,
  ]);
  const workHours = inlineFacts.get('근무 시간') || firstCapturedLine(text, [
    /(?:□\s*)?\(?근무\s*(?:시간|요일\s*\/\s*시간)\)?\s*[:：]?\s*([^\n]+)/iu,
    /((?:주\s*[1-7]일[^\n]{0,100})?\d{1,2}:\d{2}\s*[~～\-]\s*\d{1,2}:\d{2}[^\n]*)/u,
  ]);
  const salary = inlineFacts.get('급여') || firstCapturedLine(text, [
    /\[월\s*기본급\]\s*[\s\S]{0,90}?[·ㆍ•-]\s*([^\n]*\d[\d,]*\s*원[^\n]*)/iu,
    /(?:연봉|월급|급여)\s*[:：]?\s*([^\n]*\d[\d,]*(?:\s*만)?\s*원[^\n]*)/iu,
  ]);
  const rawHeadcount = inlineFacts.get('모집 인원') || firstCapturedLine(text, [
    /(?:□\s*)?모집\s*인원\s*[:：]\s*([^\n]+)/iu,
    /(?:□\s*)?모집\s*인원\s+((?:총\s*)?\d+\s*명[^\n]*)/iu,
  ]);
  const headcount = /^(?:0\s*명|공고에서 확인 필요)$/u.test(rawHeadcount) ? '' : rawHeadcount;
  const rawEmployment = inlineFacts.get('고용 형태') || inlineFacts.get('근무 형태')
    || firstCapturedLine(text, [/(?:□\s*)?\(?(?:채용|고용)\s*형태\)?\s*[:：]?\s*([^\n]+)/iu]);
  const employment = /^(?:기타|무관)$/u.test(rawEmployment) ? '' : rawEmployment;
  return Object.fromEntries(Object.entries({ location, workHours, salary, headcount, employment }).filter(([, fact]) => fact));
}

/** Uses only facts explicitly printed in a posting title. */
export function extractTitleFacts(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return {};
  const employment = /시간제|파트\s*타임|아르바이트|알바/iu.test(title) ? '시간제'
    : /정규직/u.test(title.replace(/비정규직/g, '')) ? '정규직'
      : /계약직/u.test(title) ? '계약직'
        : /기간제/u.test(title) ? '기간제' : '';
  const dailyHours = title.match(/1\s*일\s*(\d+(?:\.\d+)?)\s*시간/u)?.[1];
  const weeklyHours = title.match(/주\s*(\d+(?:\.\d+)?)\s*시간/u)?.[1];
  const workHours = dailyHours ? `1일 ${dailyHours}시간` : weeklyHours ? `주 ${weeklyHours}시간` : '';
  return Object.fromEntries(Object.entries({ employment, workHours }).filter(([, fact]) => fact));
}

const HIGHLIGHT_DEFINITIONS = [
  { id: 'license', label: '필수 자격', pattern: /(?:간호사.{0,16}(?:면허|자격)|(?:면허|자격).{0,16}간호사)/iu },
  { id: 'experience', label: '요구 경력', pattern: /(?:(?:산업보건|보건관리|간호|임상연구|연구윤리|hrpp|irb).{0,28}경력\s*\d|경력\s*\d.{0,28}(?:산업보건|보건관리|간호|임상연구|연구윤리|hrpp|irb))/iu },
  { id: 'schedule', label: '근무 시간', pattern: /(?:근무\s*시간|주\s*[1-7]일|\d{1,2}:\d{2}\s*[~～\-]\s*\d{1,2}:\d{2})/iu },
  { id: 'duties', label: '주요 업무', pattern: /(?:보건관리(?:계획|자|\s*업무)?|건강(?:상담|진단|검진|증진|관리)|유소견자|응급처치|임상연구|연구윤리|표준작업지침|이해상충|\birb\b)/iu },
  { id: 'pay', label: '급여·복지', pattern: /(?:기본급|연봉|월급|급여|복지포인트|식대|\d[\d,]*\s*원)/iu },
];

/** Selects a few verbatim, nurse-relevant statements for the quick-scan area. */
export function extractRecruitmentHighlights(sections, limit = 5) {
  if (!Array.isArray(sections) || limit < 1) return [];
  const statements = sections.flatMap((section) => readableDetailBlocks(section?.value)
    .flatMap((block) => block.type === 'fragment' ? [] : [{ text: block.text, sectionKey: section.semanticKey || section.key || '' }]))
    .filter(({ text }) => text && text.length >= 6 && text.length <= 220);
  const used = new Set();
  const highlights = [];
  for (const definition of HIGHLIGHT_DEFINITIONS) {
    const match = statements.find((statement) => !used.has(statement.text) && definition.pattern.test(statement.text));
    if (!match) continue;
    used.add(match.text);
    highlights.push({ id: definition.id, label: definition.label, text: match.text, sectionKey: match.sectionKey });
    if (highlights.length >= limit) break;
  }
  return highlights.length >= 2 ? highlights : [];
}
