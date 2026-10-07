// 커리어 프로필 — 포트폴리오 기반 개인 맞춤 우선순위.
// 핵심: 안드로이드(Kotlin/Compose) ~4-5년 + AI 에이전트·LLM 자동화(코드리뷰 봇, RAG, MCP, 멀티모델 파이프라인) + 핀테크 도메인.
// 채용공고 증거(제목·직무·키워드)와 매칭해 aiTierFor의 profile 점수로 쓴다. 용어를 고치면 즉시 반영된다.

function textOf(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value || '');
}

// 적합 신호: 직접 경력과 일치
export const PROFILE = {
  // 안드로이드 본업
  android: /(안드로이드|android|kotlin|코틀린|jetpack|compose|컴포즈|플레이\s*스토어|구글플레이)/iu,
  // 현재 회사에서 만든 것과 같은 AI 에이전트·LLM 자동화 축
  aiAgent: /(llm|생성형|gen\s*ai|에이전트|ai\s*agent|rag|mcp|ai\s*코딩|코딩\s*에이전트|claude|openai|gpt|gemini|copilot|온디바이스|ai\s*자동화|멀티모달|파인튜닝|fine[\s-]?tuning|프롬프트)/iu,
  // 핀테크 도메인 경험(비상장주식 플랫폼, 투자중개 인가 대응)
  fintech: /(핀테크|fintech|증권|주식|투자|자산관리|자산운용|페이|결제|금융|은행|보험|카드사|뱅킹)/iu,
  // 유사 수용 가능: 크로스플랫폼 모바일(네이티브 경력 전이 가능)
  mobile: /(flutter|플러터|react\s*native|모바일\s*(개발|엔지니어|앱)|앱\s*개발|app\s*developer)/iu,
};

// 미스매칭 신호: 이 조합이 없을 때만 감점 (안드로이드·AI와 공존하면 중립)
export const PROFILE_MISFIT = {
  iosOnly: /(ios|swift|objective[\s-]?c|엑스코드|xcode)/iu,
  webOnly: /(프론트엔드|front[\s-]?end|react|next\.?js|vue|nuxt|svelte|웹\s*개발자)/iu,
  gameOnly: /(unity|unreal|유니티|언리얼|게임\s*(클라이언트|엔진|개발))/iu,
  researchOnly: /(데이터\s*사이언티스트|data\s*scientist|research\s*scientist|리서치\s*엔지니어|컴퓨터\s*비전\s*연구|논문)/iu,
  embedded: /(임베디드|embedded|펌웨어|firmware|mcu|iot\s*디바이스)/iu,
};

// 현재 경력 구간 — 요구 연차가 max를 넘으면 caution, 신입 전용 공고는 감점
export const PROFILE_YEARS = { min: 3, max: 6 };

export function profileFitFor(job = {}) {
  const evidence = textOf([
    job.title, job.role, job.description,
    job.keywords, job.sectors, job.duties, job.roleTags,
  ].filter(Boolean).join(' '));
  if (!evidence.trim()) return { score: 0, hits: [], cautions: [] };

  const android = PROFILE.android.test(evidence);
  const aiAgent = PROFILE.aiAgent.test(evidence);
  const fintech = PROFILE.fintech.test(evidence);
  const mobile = android || PROFILE.mobile.test(evidence);

  const hits = [], cautions = [];
  let score = 0;

  if (android && aiAgent) { score = 22; hits.push('안드로이드+AI 에이전트 경력 적합'); }
  else if (android) { score = 16; hits.push('안드로이드 경력 적합'); }
  else if (aiAgent && mobile) { score = 14; hits.push('모바일+AI 경험 활용 가능'); }
  else if (aiAgent) { score = 11; hits.push('AI 에이전트·LLM 경험 활용'); }
  else if (mobile) { score = 7; hits.push('모바일 개발 유사 경험'); }

  if (fintech) { score += 4; hits.push('핀테크 도메인 경험'); }

  // 미스매칭: 적합 신호가 없을 때만 감점 (예: Android+iOS 겸직 공고는 무감점)
  if (!android && PROFILE_MISFIT.iosOnly.test(evidence)) { score -= 8; cautions.push('iOS 전용 — 안드로이드 경력 적용 제한'); }
  if (!mobile && PROFILE_MISFIT.webOnly.test(evidence)) { score -= 6; cautions.push('웹 프론트 전용 — 모바일 경력 비연관'); }
  if (!mobile && PROFILE_MISFIT.gameOnly.test(evidence)) { score -= 6; cautions.push('게임 클라이언트 — 도메인 비연관'); }
  if (!mobile && PROFILE_MISFIT.embedded.test(evidence)) { score -= 6; cautions.push('임베디드 — 경력 비연관'); }
  if (!android && !aiAgent && PROFILE_MISFIT.researchOnly.test(evidence)) { score -= 4; cautions.push('연구직 중심 — 실무 프로필과 거리'); }

  return { score: Math.max(-10, Math.min(26, score)), hits, cautions };
}
