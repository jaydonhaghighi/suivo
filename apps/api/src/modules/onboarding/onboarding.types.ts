export type OnboardingRole = 'AGENT' | 'TEAM_LEAD';

export const DEFAULT_LANGUAGE = 'en';
export const MAX_TEAM_CODE_GENERATION_ATTEMPTS = 10;
export const SAVEPOINT_TEAM_LEAD_ATTEMPT = 'onboarding_team_lead_attempt';
export const SAVEPOINT_AGENT_INSERT = 'onboarding_agent_insert';

export interface ExistingUserRow {
  id: string;
  team_id: string;
  role: OnboardingRole;
}

export type RegisterPayload =
  | { role: 'TEAM_LEAD'; language?: string | undefined }
  | { role: 'AGENT'; team_code: string; language?: string | undefined };

export interface OnboardingRegisterResult {
  user_id: string;
  team_id: string;
  role: OnboardingRole;
  onboarding_completed: true;
}
