import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSharedValue } from 'react-native-reanimated';
import { styles, colors } from '../_lib/styles';
import { AppBackdrop, isNightBackdrop } from '../_components/Illustrations';

// Phase 38 Step 1: the Settings tab shell. A nested menu (this screen) ->
// one screen per section, not one long flat page, per the brief. Each
// entry pushes to its own route under settings/ rather than this screen
// owning any actual controls itself.
const SECTIONS = [
  { path: '/settings/budget', title: 'Budget', icon: 'pie-chart' },
  { path: '/settings/home', title: 'Home', icon: 'home' },
  { path: '/settings/goal', title: 'Goal', icon: 'flag' },
  { path: '/settings/recurring', title: 'Recurring', icon: 'autorenew' },
  { path: '/settings/account', title: 'Account & Security', icon: 'shield' },
  { path: '/settings/notifications', title: 'Notifications', icon: 'notifications-none' },
];

export default function Settings() {
  const router = useRouter();
  const scrollY = useSharedValue(0);
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  return (
    <View style={styles.container}>
      <View style={settingsStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      <View style={settingsStyles.headerRow}>
        <Pressable
          style={settingsStyles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to Account"
        >
          <MaterialIcons name="arrow-back" size={26} color={onBackdropTextColor || colors.darkest} />
        </Pressable>
        <View style={settingsStyles.headerTextCol}>
          <Text style={[settingsStyles.headerTitle, onBackdropTextColor && { color: onBackdropTextColor }]}>
            Settings
          </Text>
        </View>
        <View style={settingsStyles.backButton} />
      </View>

      <View style={settingsStyles.body}>
        <View style={[styles.card, settingsStyles.listCard]}>
          {SECTIONS.map((section, index) => (
            <Pressable
              key={section.path}
              style={[settingsStyles.sectionRow, index > 0 && settingsStyles.sectionRowDivider]}
              onPress={() => router.push(section.path)}
              accessibilityRole="button"
              accessibilityLabel={`${section.title} settings`}
            >
              <View style={settingsStyles.sectionRowMain}>
                <MaterialIcons name={section.icon} size={20} color={colors.dark} />
                <Text style={settingsStyles.sectionRowText}>{section.title}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const settingsStyles = StyleSheet.create({
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
  body: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  listCard: {
    padding: 0,
    overflow: 'hidden',
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sectionRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  sectionRowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sectionRowText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.darkest,
  },
});
