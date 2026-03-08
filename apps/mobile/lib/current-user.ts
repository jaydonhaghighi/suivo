import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';

import { apiGet } from './api';

export type CurrentUser = {
  userId: string;
  teamId: string;
  role: 'AGENT' | 'TEAM_LEAD';
};

type Role = CurrentUser['role'];
const UNPROVISIONED_USER_MESSAGE = 'No linked user account found';

function parseRole(value: string | undefined): Role | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === 'AGENT' || normalized === 'TEAM_LEAD') {
    return normalized;
  }

  return null;
}

function getConfiguredDevRole(): Role | null {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;
  return parseRole(extra.DEV_ROLE) ?? parseRole(process.env.EXPO_PUBLIC_DEV_ROLE);
}

export function useCurrentUser(options?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: ['current-user'],
    queryFn: () => apiGet<CurrentUser>('/users/me'),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
    retry: 1
  });

  const effectiveRole = query.data?.role ?? getConfiguredDevRole();
  const isUnprovisioned =
    query.error instanceof Error && query.error.message.includes(UNPROVISIONED_USER_MESSAGE);

  return {
    ...query,
    effectiveRole,
    isUnprovisioned
  };
}
