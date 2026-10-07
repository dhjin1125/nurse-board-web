import { applicationTierFor, applicationTierProfileKey, departmentFor, facilityTypeFor, workPatternFor } from '../src/job-utils.js';

export function prepareJobForDisplay(job) {
  const prepared = {
    ...job,
    department: departmentFor(job),
    workPattern: workPatternFor(job),
    facilityType: facilityTypeFor(job),
  };
  const assessment = applicationTierFor(prepared);
  return {
    ...prepared,
    applicationTierGroup: assessment.tier,
    applicationTierGroupScore: assessment.score,
    presentation: { applicationTier: assessment, profileKey: applicationTierProfileKey() },
  };
}
