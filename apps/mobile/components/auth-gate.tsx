import { useAuth } from '@clerk/clerk-expo';
import { PropsWithChildren, useCallback, useState } from 'react';
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
  const { isSignedIn, isLoaded } = useAuth();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [onboardingSeed, setOnboardingSeed] = useState<OnboardingSeed | null>(null);
  const currentUser = useCurrentUser({ enabled: isLoaded && isSignedIn });

  const completeOnboarding = useCallback(() => {
    setOnboardingSeed(null);
    void currentUser.refetch();
  }, [currentUser]);

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

  if (currentUser.data) {
    return <>{children}</>;
  }

  if (currentUser.isUnprovisioned || onboardingSeed) {
    return <OnboardingScreen initialSeed={onboardingSeed} onCompleted={completeOnboarding} />;
  }

  if (currentUser.isLoading || currentUser.isFetching) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (currentUser.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Unable to load account</Text>
        <Text style={styles.errorBody}>{currentUser.error.message}</Text>
        <Pressable style={styles.retryButton} onPress={() => void currentUser.refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
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
    retryButton: {
      marginTop: 16,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 18,
      paddingVertical: 10
    },
    retryText: {
      color: colors.white,
      fontWeight: '700'
    }
  });
}
