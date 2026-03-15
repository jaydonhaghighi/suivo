import { useAuth, useClerk } from '@clerk/clerk-expo';
import { useQueryClient } from '@tanstack/react-query';
import { PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useCurrentUser } from '../lib/current-user';
import { OnboardingSeed } from '../lib/onboarding';
import { useTabTheme } from '../lib/tab-theme';

import { OnboardingScreen } from './onboarding-screen';
import { SignInScreen } from './sign-in-screen';
import { SignUpScreen } from './sign-up-screen';

export function AuthGate({ children }: PropsWithChildren): JSX.Element {
  const { colors } = useTabTheme();
  const styles = createStyles(colors);
  const queryClient = useQueryClient();
  const { isSignedIn, isLoaded, userId } = useAuth();
  const { signOut } = useClerk();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [onboardingSeed, setOnboardingSeed] = useState<OnboardingSeed | null>(null);
  const hasAttemptedErrorSignOut = useRef(false);
  const lastSignedInUserId = useRef<string | null>(null);
  const currentUser = useCurrentUser({ enabled: isLoaded && isSignedIn });

  const completeOnboarding = useCallback(() => {
    setOnboardingSeed(null);
    void currentUser.refetch();
  }, [currentUser]);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    if (!isSignedIn || !userId) {
      if (lastSignedInUserId.current !== null) {
        queryClient.clear();
      }
      lastSignedInUserId.current = null;
      setOnboardingSeed(null);
      hasAttemptedErrorSignOut.current = false;
      return;
    }

    if (lastSignedInUserId.current && lastSignedInUserId.current !== userId) {
      queryClient.clear();
      setOnboardingSeed(null);
      hasAttemptedErrorSignOut.current = false;
    }

    lastSignedInUserId.current = userId;
  }, [isLoaded, isSignedIn, queryClient, userId]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      hasAttemptedErrorSignOut.current = false;
      return;
    }

    if (currentUser.isLoading || currentUser.isFetching || currentUser.isUnprovisioned || onboardingSeed) {
      return;
    }

    if (!currentUser.error || !currentUser.isAuthFailure || hasAttemptedErrorSignOut.current) {
      return;
    }

    hasAttemptedErrorSignOut.current = true;
    void signOut();
  }, [
    currentUser.error,
    currentUser.isFetching,
    currentUser.isLoading,
    currentUser.isUnprovisioned,
    isLoaded,
    isSignedIn,
    onboardingSeed,
    signOut
  ]);

  if (!isLoaded) {
    return <></>;
  }

  if (!isSignedIn) {
    if (mode === 'sign-up') {
      return (
        <SignUpScreen
          onSwitchToSignIn={() => setMode('sign-in')}
          onVerificationComplete={(seed) => setOnboardingSeed(seed)}
        />
      );
    }
    return <SignInScreen onSwitchToSignUp={() => setMode('sign-up')} />;
  }

  if (currentUser.isUnprovisioned || onboardingSeed) {
    return <OnboardingScreen initialSeed={onboardingSeed} onCompleted={completeOnboarding} />;
  }

  if (currentUser.error) {
    if (currentUser.isAuthFailure) {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Unable to load account</Text>
          <Text style={styles.errorBody}>Signing you out and returning to sign in...</Text>
          <ActivityIndicator color={colors.primary} style={styles.errorSpinner} />
        </View>
      );
    }

    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Unable to load account</Text>
        <Text style={styles.errorBody}>
          {currentUser.error.message || 'Please check your API connection and try again.'}
        </Text>
        <Pressable style={styles.retryButton} onPress={() => void currentUser.refetch()}>
          <Text style={styles.retryButtonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (currentUser.data) {
    return <>{children}</>;
  }

  if (currentUser.isLoading || currentUser.isFetching) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return <>{children}</>;
}

function createStyles(colors: ReturnType<typeof useTabTheme>['colors']) {
  return StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      backgroundColor: colors.background
    },
    errorTitle: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '700'
    },
    errorBody: {
      color: colors.textSecondary,
      fontSize: 14,
      marginTop: 8,
      textAlign: 'center'
    },
    errorSpinner: {
      marginTop: 16
    },
    retryButton: {
      marginTop: 16,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16
    },
    retryButtonText: {
      color: colors.white,
      fontWeight: '700'
    }
  });
}
