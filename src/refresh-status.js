// The published feed can lag behind the live collector. A stale snapshot with
// inProgress=false is not evidence that the user's refresh has finished.
export function refreshHasPublished(snapshot, startedAt) {
  const start = Date.parse(startedAt);
  const completed = Date.parse(snapshot?.refresh?.completedAt);
  const runStarted = Date.parse(snapshot?.refresh?.startedAt);
  return Number.isFinite(start) && Number.isFinite(completed) && runStarted >= start
    && completed >= start && !snapshot?.refresh?.inProgress;
}
