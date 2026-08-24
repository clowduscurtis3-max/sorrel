import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { AppDataProvider } from '../_lib/appData';
import { colors } from '../_lib/styles';

// Phase 7 Step 1: tab shell, originally exactly four tabs (Home/Budget/
// Recurring/Goal) with account-level actions living in a plain <Modal>
// (AccountMenu.js) toggled from a header button - see this file's prior
// version / git history for the full reasoning.
//
// Phase 14 (2026-08-24): revisits that "no fifth Settings tab" decision,
// per the reference mockup (design-references/home-tab-mockup-2026-08-23.png)
// and explicit user confirmation - Account is now a real fifth tab
// (app/(tabs)/account.js) rather than a Modal, and the header button/
// AppDataProvider-mounted-Modal dance this file used to need
// (accountMenuMounted, the Fabric-crash-avoidance lazy-mount) is gone
// entirely along with it, since a normal <Tabs.Screen> never has the
// "too much native work in one first commit" problem a Modal sitting
// alongside the Tabs navigator's own first mount did.
//
// tabBarIcon added for all five tabs (MaterialIcons, matching the mockup)
// - the old plain-text-only tab bar predates this app having any icon set
// installed anywhere; @expo/vector-icons has been a real, direct
// dependency since the Phase 13 wheel work, so this is no longer the
// "adding an icon library just for this" tradeoff the original Phase 7
// comment weighed against.
const TAB_ICONS = {
  index: 'home',
  budget: 'pie-chart',
  recurring: 'autorenew',
  goal: 'track-changes',
  account: 'person',
};

export default function TabsLayout() {
  return (
    <AppDataProvider>
      <Tabs
        screenOptions={({ route }) => ({
          // headerShown: false everywhere (2026-08-24, explicit user
          // request) - the tab bar's own icon+label already identifies
          // the screen, so a second native title bar above the content is
          // redundant on every tab, not just Home (which already had this
          // for its own reason - a branded header rendered inline). Budget
          // grew its own in-content "Budget" title as part of its own
          // redesign the same day, which this also stops duplicating.
          // `title` below is kept on each Tabs.Screen regardless - it's
          // still what drives the tab bar's own label text, independent
          // of whether the header itself is shown.
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.muted,
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name={TAB_ICONS[route.name]} size={size} color={color} />
          ),
        })}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="budget" options={{ title: 'Budget' }} />
        <Tabs.Screen name="recurring" options={{ title: 'Recurring' }} />
        <Tabs.Screen name="goal" options={{ title: 'Goal' }} />
        <Tabs.Screen name="account" options={{ title: 'Account' }} />
      </Tabs>
    </AppDataProvider>
  );
}
