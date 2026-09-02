import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { styles, colors } from '../_lib/styles';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';

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

  return (
    <SettingsScreenChrome title="Settings" onBack={() => router.back()}>
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
    </SettingsScreenChrome>
  );
}

const settingsStyles = StyleSheet.create({
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
