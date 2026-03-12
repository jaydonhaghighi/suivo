import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-expo';
import Constants from 'expo-constants';

import { apiGet } from './api';

export type CurrentUser = {
  userId: string;
  teamId: string;
  role: 'AGENT' | 'TEAM_LEAD';
};

type Role = CurrentUser['role'];
const UNPROVISIONED_USER_MESSAGE = 'No linked user account found';
export const CURRENT_USER_QUERY_KEY = ['current-user'] as const;

export function currentUserQueryKey(clerkUserId: string | null | undefined): readonly [string, string] {
  return [CURRENT_USER_QUERY_KEY[0], clerkUserId ?? 'signed-out'];
}

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
  const { isLoaded, isSignedIn, userId } = useAuth();
  const enabled = (options?.enabled ?? true) && isLoaded && isSignedIn && Boolean(userId);
  const query = useQuery({
    queryKey: currentUserQueryKey(userId),
    queryFn: () => apiGet<CurrentUser>('/users/me'),
    enabled,
    staleTime: 60_000,
    retry: 3,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    refetchOnReconnect: true
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
