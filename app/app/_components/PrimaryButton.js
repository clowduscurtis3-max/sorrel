import { Pressable, Text, ActivityIndicator } from 'react-native';
import { useTheme } from '../_lib/theme';

// Dark pill button matching the Budget-tab Sorrel restyle's mockup
// (SUBMIT AMOUNT / COMPARE / GOT IT). Scoped to that flow only - every
// other screen in this app keeps using plain native <Button> on purpose,
// this isn't a repo-wide button component.
//
// A bare Pressable gets none of native <Button>'s built-in accessibility/
// hit-area behavior, so both are set explicitly here rather than left to
// default - matches this app's own established touch-target discipline
// elsewhere in this exact flow (the mic button's circular hit area,
// DigitAmountPicker's touch-target-doubling fix).
//
// Theme redesign (2026-09-11): colors/styles now come from useTheme() -
// styles.primaryButton/primaryButtonText are a matched darkest/background
// pair (both flip together at night, contrast preserved automatically).
export default function PrimaryButton({ title, onPress, disabled, loading }) {
  const { colors, styles } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || loading }}
      hitSlop={8}
      style={[styles.primaryButton, (disabled || loading) && styles.primaryButtonDisabled]}
    >
      {loading ? (
        <ActivityIndicator color={colors.background} />
      ) : (
        <Text style={styles.primaryButtonText}>{title}</Text>
      )}
    </Pressable>
  );
}
