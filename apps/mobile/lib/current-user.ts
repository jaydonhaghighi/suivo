import { useAuth } from '@clerk/clerk-expo';
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
const AUTH_FAILURE_SNIPPETS = [
  'authentication required',
  'invalid bearer token',
  'jwt issuer/audience is not configured',
  'unsupported authorization scheme'
] as const;
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
  const errorMessage = query.error instanceof Error ? query.error.message : '';
  const isUnprovisioned = errorMessage.includes(UNPROVISIONED_USER_MESSAGE);
  const isAuthFailure = errorMessage.startsWith('401 ')
    || AUTH_FAILURE_SNIPPETS.some((snippet) => errorMessage.toLowerCase().includes(snippet));

  return {
    ...query,
    effectiveRole,
    isUnprovisioned,
    isAuthFailure
  };
}
