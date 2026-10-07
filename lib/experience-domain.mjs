export const EXPERIENCE_DOMAIN = Object.freeze({
  CLINICAL: 'clinical',
  HEALTH_MANAGER: 'health-manager',
  NURSING_GENERAL: 'nursing-general',
  UNSPECIFIED: 'unspecified',
});

const DETAIL_FIELDS = [
  'experienceRequirements',
  'experience',
  'qualifications',
  'requirements',
  'preferredQualifications',
  'description',
  'duties',
];

const CAREER_TERM = String.raw`(?:경력(?:직)?|경험|근무\s*이력)`;
const CLINICAL_TERM = String.raw`(?:임상(?:\s*간호)?|병동(?:\s*간호)?|중환자실(?:\s*간호)?|응급실(?:\s*간호)?|수술실(?:\s*간호)?|외래(?:\s*간호)?|진료지원(?:\s*간호)?)`;
const HEALTH_MANAGER_TERM = String.raw`(?:보건\s*관리(?:자|업무|직)?|산업\s*간호(?:사|업무)?|산업\s*보건|사업장\s*(?:간호|보건)|건강\s*관리실|직업\s*건강)`;
const NURSING_GENERAL_TERM = String.raw`(?:간호사|간호\s*(?:업무|실무|근무)?|의료기관\s*간호)`;
const NEARBY_TEXT = String.raw`[^.!?。；;\n]{0,18}`;

const CLINICAL_PATTERN = new RegExp(`(?:${CLINICAL_TERM}${NEARBY_TEXT}${CAREER_TERM}|${CAREER_TERM}${NEARBY_TEXT}${CLINICAL_TERM})`, 'i');
const HEALTH_MANAGER_PATTERN = new RegExp(`(?:${HEALTH_MANAGER_TERM}${NEARBY_TEXT}${CAREER_TERM}|${CAREER_TERM}${NEARBY_TEXT}${HEALTH_MANAGER_TERM})`, 'i');

// Generic nursing evidence is intentionally narrower than the domain-specific
// patterns. For example, "간호사 면허 · 경력 2년" does not prove that those
// two years must be nursing experience.
const NURSING_GENERAL_PATTERN = new RegExp(
  String.raw`(?:${NURSING_GENERAL_TERM}\s*(?:(?:관련|분야|업무|실무|근무|로서|로|에서|의)\s*){0,3}${CAREER_TERM}|${CAREER_TERM}\s*(?:(?:관련|분야|업무|실무|근무|의)\s*){0,3}${NURSING_GENERAL_TERM})`,
  'i',
);

function textParts(value) {
  if (Array.isArray(value)) return value.flatMap(textParts);
  if (typeof value !== 'string' && typeof value !== 'number') return [];
  const text = String(value)
    .normalize('NFKC')
    .replace(/\u200b|\ufeff/g, '')
    .replace(/<\s*br\s*\/?>|<\/(?:p|li|div|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?:담당\s*업무|주요\s*업무|자격\s*요건|지원\s*자격|우대\s*사항)\s*[:：]/g, (label) => `\n${label}`)
    .replace(/\r/g, '');
  return text
    .split(/\n+|[.!?。；;]|\s*[•●▪]\s*/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function excerptAround(text, match, limit = 140) {
  if (text.length <= limit) return text;
  const middle = match.index + Math.floor(match[0].length / 2);
  const start = Math.max(0, Math.min(text.length - limit, middle - Math.floor(limit / 2)));
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function evidenceFor(field, text, domain, strength) {
  const pattern = domain === EXPERIENCE_DOMAIN.CLINICAL
    ? CLINICAL_PATTERN
    : domain === EXPERIENCE_DOMAIN.HEALTH_MANAGER
      ? HEALTH_MANAGER_PATTERN
      : NURSING_GENERAL_PATTERN;
  const match = pattern.exec(text);
  if (!match) return null;
  return {
    domain,
    field,
    excerpt: excerptAround(text, match),
    strength,
  };
}

function collectFieldEvidence(field, value, strength) {
  const evidence = [];
  for (const part of textParts(value)) {
    const clinical = evidenceFor(field, part, EXPERIENCE_DOMAIN.CLINICAL, strength);
    const healthManager = evidenceFor(field, part, EXPERIENCE_DOMAIN.HEALTH_MANAGER, strength);
    if (clinical) evidence.push(clinical);
    if (healthManager) evidence.push(healthManager);

    // A specific phrase such as "산업간호사 경력" also contains the generic
    // word "간호사". Keep only the more informative evidence for that clause.
    if (!clinical && !healthManager) {
      const nursingGeneral = evidenceFor(field, part, EXPERIENCE_DOMAIN.NURSING_GENERAL, strength);
      if (nursingGeneral) evidence.push(nursingGeneral);
    }
  }
  return evidence;
}

function resolveEvidence(evidence) {
  const specific = evidence.filter((item) => item.domain !== EXPERIENCE_DOMAIN.NURSING_GENERAL);
  const specificDomains = new Set(specific.map((item) => item.domain));
  if (specificDomains.size > 1) {
    return { domain: EXPERIENCE_DOMAIN.UNSPECIFIED, evidence: null };
  }
  const chosen = specific[0] || evidence.find((item) => item.domain === EXPERIENCE_DOMAIN.NURSING_GENERAL);
  if (!chosen) return { domain: EXPERIENCE_DOMAIN.UNSPECIFIED, evidence: null };
  const { domain, field, excerpt, strength } = chosen;
  return { domain, evidence: { field, excerpt, strength } };
}

/**
 * Classifies only explicit prior-experience wording found inside each field.
 * It deliberately does not combine a job title/role from one field with a
 * generic "경력 2년" value from another field.
 */
export function classifyExperienceDomain(fields = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { domain: EXPERIENCE_DOMAIN.UNSPECIFIED, evidence: null };
  }

  const detailEvidence = DETAIL_FIELDS.flatMap((field) => (
    collectFieldEvidence(field, fields[field], 'explicit-detail')
  ));
  if (detailEvidence.length) return resolveEvidence(detailEvidence);

  const titleEvidence = collectFieldEvidence('title', fields.title, 'title-context');
  return resolveEvidence(titleEvidence);
}
