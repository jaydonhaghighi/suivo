import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCurrentUser } from '../../lib/current-user';
import { useTabTheme } from '../../lib/tab-theme';

export default function TabsLayout(): JSX.Element {
  const { colors } = useTabTheme();
  const currentUser = useCurrentUser();
  const insets = useSafeAreaInsets();
  const bottomInset = Platform.OS === 'ios' ? Math.max(insets.bottom, 10) : 10;
  const canSeeAdminHub = currentUser.effectiveRole === 'TEAM_LEAD' || currentUser.effectiveRole === 'AGENT';

  return (
    <Tabs
      initialRouteName="task-deck"
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitle: '',
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 58 + bottomInset,
          paddingTop: 6,
          paddingBottom: bottomInset
        },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarLabelStyle: {
          fontSize: 9,
          fontWeight: '600',
          letterSpacing: 0.4,
          textTransform: 'uppercase'
        },
        tabBarButton: (props) => (
          <Pressable
            {...(props as any)}
            hitSlop={8}
            style={props.style}
            android_ripple={{ color: 'transparent' }}
          />
        ),
        tabBarIcon: ({ color, size }) => {
          const iconName =
            route.name === 'task-deck'
              ? 'layers'
              : route.name === 'notifications'
                ? 'bell'
              : route.name === 'leads'
                ? 'users'
                : route.name === 'metrics'
                  ? 'bar-chart-2'
                  : route.name === 'admin-hub'
                    ? 'shield'
                    : 'user';
          return <Feather name={iconName} size={(size ?? 18) - 4} color={color} />;
        }
      })}
    >
      <Tabs.Screen name="task-deck" options={{ title: 'Tasks' }} />
      <Tabs.Screen name="notifications" options={{ title: 'Alerts' }} />
      <Tabs.Screen name="leads" options={{ title: 'Leads' }} />
      <Tabs.Screen name="metrics" options={{ title: 'Metrics' }} />
      <Tabs.Screen name="admin-hub" options={{ title: 'Admin', href: canSeeAdminHub ? '/admin-hub' : null }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
