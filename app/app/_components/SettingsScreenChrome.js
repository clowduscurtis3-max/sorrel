import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSharedValue } from 'react-native-reanimated';
import { styles, colors } from '../_lib/styles';
import { AppBackdrop, isNightBackdrop } from './Illustrations';

// Shared by every Settings screen (settings/index.js, SettingsSectionShell.js,
// and each section's own real-content screen as Steps 2-8 land) - the
// backdrop + back-arrow header row was identical, copy-pasted verbatim
// across the first three of those before being pulled out here (flagged by
// code review, 2026-09-02: this app has already been bitten once by the
// same class of copy-pasted-constant drift, see GOAL_TYPES's client/server
// mirror). A tweak to the Settings header now only has one place to make it.
export default function SettingsScreenChrome({ title, subtitle, onBack, children }) {
  const scrollY = useSharedValue(0);
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  return (
    <View style={styles.container}>
      <View style={chromeStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      <View style={chromeStyles.headerRow}>
        <Pressable
          style={chromeStyles.backButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <MaterialIcons name="arrow-back" size={26} color={onBackdropTextColor || colors.darkest} />
        </Pressable>
        <View style={chromeStyles.headerTextCol}>
          <Text style={[chromeStyles.headerTitle, onBackdropTextColor && { color: onBackdropTextColor }]}>
            {title}
          </Text>
          {subtitle && (
            <Text
              style={[
                chromeStyles.headerSubtitle,
                night && { color: 'rgba(244, 246, 242, 0.75)' },
              ]}
            >
              {subtitle}
            </Text>
          )}
        </View>
        <View style={chromeStyles.backButton} />
      </View>

      {children}
    </View>
  );
}

const chromeStyles = StyleSheet.create({
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    gap: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextCol: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.darkest,
  },
  headerSubtitle: {
    fontSize: 13,
    color: colors.dark,
    marginTop: 2,
    textAlign: 'center',
  },
});
