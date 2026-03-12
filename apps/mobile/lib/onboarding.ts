export type SignupRole = 'AGENT' | 'TEAM_LEAD';

export interface OnboardingSeed {
  role: SignupRole;
  teamCode: string;
  autoSubmit?: boolean;
}

