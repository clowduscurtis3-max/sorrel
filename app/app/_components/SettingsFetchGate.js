import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '../_lib/theme';

// Shared by every Settings screen that has nothing to show until its first
// GET /settings succeeds (SettingsSectionShell.js, settings/budget.js, and
// each section as Steps 3-8 add their own real content). Fixed a real bug
// found by code review, 2026-09-02: both of the first two screens left
// `settings` at its initial `null` on a fetch failure while only setting
// `error` - since their render only showed the error banner *inside* the
// "settings loaded" branch, a failed initial fetch spun the
// ActivityIndicator forever with no error shown and no way to retry.
//
// Theme redesign (2026-09-11): the Retry action used to be a plain native
// <Button> - unstyled, renders platform-default blue on Android, exactly
// the "old blue button" class this app has already restyled away
// elsewhere (Phase 35's own goal-intake.js pass). Harmless but jarring by
// day; a bright blue button flashing against an otherwise dark night
// screen is what actually got noticed and reported live. Restyled to
// match this app's own established Pressable/PrimaryButton convention,
// and colors/styles now come from useTheme().
export default function SettingsFetchGate({ loaded, error, onRetry, children }) {
  const { colors, styles } = useTheme();
  const gateStyles = useMemo(() => buildGateStyles(colors), [colors]);
  if (loaded) return children;

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable
          style={gateStyles.retryButton}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
        >
          <Text style={gateStyles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.centered}>
      <ActivityIndicator />
    </View>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildGateStyles(colors) {
  return StyleSheet.create({
    retryButton: {
      backgroundColor: colors.darkest,
      borderRadius: 22,
      paddingVertical: 10,
      paddingHorizontal: 24,
      marginTop: 8,
    },
    retryButtonText: {
      color: colors.background,
      fontSize: 14,
      fontWeight: '700',
    },
  });
}
