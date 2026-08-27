import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { AppDataProvider } from '../_lib/appData';
import { colors } from '../_lib/styles';
import { isNightBackdrop } from '../_components/Illustrations';

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
  // Floating pill tab bar (2026-08-27), matching the user's own reference
  // mockup exactly: a rounded, inset-from-the-edges bar rather than a
  // flat edge-to-edge one, with a light (colors.card) fill during the day
  // and a dark (colors.darkest) fill at night - previously always the
  // platform-default white bar regardless of AppBackdrop's own time-of-day
  // theme, which read as a jarring light bar sitting on top of the night
  // backdrop. `night` is computed once per render, same "no live-updating
  // timer, a re-render eventually happening is enough" convention already
  // used everywhere else this app switches on time-of-day (see
  // isNightBackdrop's own callers) - this isn't a countdown clock, a
  // several-times-an-hour discrepancy at a period boundary is fine.
  const night = isNightBackdrop();

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
          tabBarActiveTintColor: night ? colors.sage : colors.primary,
          tabBarInactiveTintColor: night ? 'rgba(244, 246, 242, 0.45)' : colors.muted,
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name={TAB_ICONS[route.name]} size={size} color={color} />
          ),
          // Absolutely positioned + inset from all three edges + a large
          // borderRadius is what actually produces the "floating pill"
          // look rather than a flat bar - each screen's own ScrollView
          // content gets matching extra bottom padding (see each tab's
          // own contentContainerStyle) so the last card can still scroll
          // fully clear of it instead of sitting behind it.
          tabBarStyle: {
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 20,
            height: 64,
            borderRadius: 28,
            borderTopWidth: 0,
            backgroundColor: night ? colors.darkest : colors.card,
            elevation: 8,
            shadowColor: '#000',
            shadowOpacity: 0.15,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
          },
          tabBarItemStyle: { paddingTop: 6 },
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
