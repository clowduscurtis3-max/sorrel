import { View, Text, Button, ActivityIndicator } from 'react-native';
import { styles } from '../_lib/styles';

// Shared by every Settings screen that has nothing to show until its first
// GET /settings succeeds (SettingsSectionShell.js, settings/budget.js, and
// each section as Steps 3-8 add their own real content). Fixed a real bug
// found by code review, 2026-09-02: both of the first two screens left
// `settings` at its initial `null` on a fetch failure while only setting
// `error` - since their render only showed the error banner *inside* the
// "settings loaded" branch, a failed initial fetch spun the
// ActivityIndicator forever with no error shown and no way to retry.
// Mirrors the plain `<Button title="Retry">` pattern this app's other two
// initial-fetch-failure sites already use ((tabs)/index.js, (tabs)/budget.js)
// rather than inventing a third look for the same situation.
export default function SettingsFetchGate({ loaded, error, onRetry, children }) {
  if (loaded) return children;

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Button title="Retry" onPress={onRetry} />
      </View>
    );
  }

  return (
    <View style={styles.centered}>
      <ActivityIndicator />
    </View>
  );
}
