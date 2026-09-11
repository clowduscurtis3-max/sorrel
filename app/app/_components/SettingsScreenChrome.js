import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../_lib/theme';

// Shared by every Settings screen (settings/index.js, SettingsSectionShell.js,
// and each section's own real-content screen as Steps 2-8 land) - the
// backdrop + back-arrow header row was identical, copy-pasted verbatim
// across the first three of those before being pulled out here (flagged by
// code review, 2026-09-02: this app has already been bitten once by the
// same class of copy-pasted-constant drift, see GOAL_TYPES's client/server
// mirror). A tweak to the Settings header now only has one place to make it.
//
// IMPORTANT, found the hard way (2026-09-06): `children` is rendered
// directly, NOT wrapped in a ScrollView - a screen with more content than
// fits one viewport (most of them, once real content lands) will silently
// fail to scroll unless it wraps its own body in a <ScrollView> itself.
// settings/home.js has the established, working pattern to copy
// (ScrollView + contentContainerStyle, with real bottom padding so the
// last card clears the screen edge) - every Step 4-8 screen missed this
// the first time and had to be fixed after an on-device tap-test caught
// it. Do this for any new Settings screen from the start.
//
// Theme redesign (2026-09-11): the illustrated backdrop (and the
// isNightBackdrop()/onBackdropTextColor machinery that existed only to
// feed it) is gone - colors/styles come from useTheme() and are
// themselves theme-reactive, converting every settings/*.js screen's flat
// background/text for free through this one shared file.
export default function SettingsScreenChrome({ title, subtitle, onBack, children }) {
  const { colors, styles } = useTheme();
  const chromeStyles = useMemo(() => buildChromeStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <View style={chromeStyles.headerRow}>
        <Pressable
          style={chromeStyles.backButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <MaterialIcons name="arrow-back" size={26} color={colors.darkest} />
        </Pressable>
        <View style={chromeStyles.headerTextCol}>
          <Text style={chromeStyles.headerTitle}>{title}</Text>
          {subtitle && <Text style={chromeStyles.headerSubtitle}>{subtitle}</Text>}
        </View>
        <View style={chromeStyles.backButton} />
      </View>

      {children}
    </View>
  );
}

// Theme redesign: converted to a builder function, called via useMemo
// inside the component (keyed on colors).
function buildChromeStyles(colors) {
  return StyleSheet.create({
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
}
