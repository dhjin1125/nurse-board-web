export const FEEDBACK_MESSAGE_MAX_LENGTH = 1500;

export async function submitFeedback(payload, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch 구현이 필요합니다.');
  const response = await fetchImpl('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error('피드백 저장 응답을 확인하지 못했습니다.');
  }
  if (!response.ok || !result.ok) throw new Error(result.error || '피드백을 저장하지 못했습니다.');
  return result;
}
