import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppDataProvider } from '../_lib/appData';
import { apiFetch } from '../_lib/api';
import { useTheme } from '../_lib/theme';

// Phase 38 Step 8 (cross-cutting settings: tab visibility/reorder,
// default landing tab). React Navigation's tab navigator expects a
// stable set/order of screens - changing which <Tabs.Screen>s exist (or
// their order) *after* the navigator has already mounted is the kind of
// thing this app's own history already warns about getting careless
// with (see this file's own Phase 14 comment on the Modal-vs-(tabs)
// unmount collision it used to have to work around). Rather than mount
// <Tabs> immediately and reshuffle it once a settings fetch resolves,
// this waits for that one fetch first (same "gate render on a resolved
// value" discipline the root _layout.js already uses for session/goal)
// so <Tabs> only ever mounts once, already in its final shape - a brief
// loading spinner on cold start, not a visible tab-bar reshuffle later.
const DEFAULT_TAB_ORDER = ['index', 'budget', 'recurring', 'goal'];

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

const TAB_TITLES = {
  index: 'Home',
  budget: 'Budget',
  recurring: 'Recurring',
  goal: 'Goal',
  account: 'Account',
};

export default function TabsLayout() {
  // Theme redesign (2026-09-11): colors/styles/isNight now come from
  // useTheme() (live-updated on a 60s interval, see _lib/theme.js) rather
  // than a fresh isNightBackdrop() call - genuinely reactive now, not
  // "eventually correct on some later render."
  //
  // Floating pill tab bar (2026-08-27), matching the user's own reference
  // mockup exactly: a rounded, inset-from-the-edges bar rather than a
  // flat edge-to-edge one, with a light (colors.card) fill during the day
  // and a dark (colors.darkest) fill at night - previously always the
  // platform-default white bar regardless of the old illustrated
  // backdrop's own time-of-day theme, which read as a jarring light bar
  // sitting on top of the night backdrop. The active/inactive tint colors
  // below are a genuine, deliberate design choice (not a contrast fix
  // like most of this redesign) - a specific sage/translucent-cream pair
  // for the floating pill at night, kept exactly as designed.
  const { colors, styles, isNight } = useTheme();
  // Real device gesture-bar/nav-bar clearance (2026-08-27, direct user
  // feedback: the previous fixed `bottom: 20` sat half-underneath the OS
  // gesture controls) - this app renders edge-to-edge, so Android reports
  // a real nonzero insets.bottom for either nav style (a taller value for
  // the classic three-button bar, a shorter one for gesture nav); reading
  // it directly clears whichever one the device actually has instead of
  // guessing one fixed number that only happened to fit some devices.
  const insets = useSafeAreaInsets();
  const tabBarBottom = 12 + insets.bottom;

  // null while loading (fetch not yet resolved) - see this file's own
  // header comment for why <Tabs> waits for this instead of mounting
  // immediately and reshuffling later. Fetched once per app session (not
  // on every focus - unlike a Settings screen, there's no "come back to
  // this screen" moment for the tab bar itself to refresh from; a change
  // made in Settings -> General applies the next time the app is
  // launched, same as sessionTimeoutPreference-style device state
  // elsewhere in this app that reads once at a natural boundary rather
  // than continuously).
  const [generalSettings, setGeneralSettings] = useState(null);

  useEffect(() => {
    apiFetch('/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setGeneralSettings(data?.general_settings || {}))
      .catch((err) => {
        console.error(err);
        setGeneralSettings({}); // fail open to defaults, never block the app on this
      });
  }, []);

  // 'account' is deliberately excluded from both hiding and reordering
  // here - per the brief, "Account itself should probably not be
  // hideable, since Settings lives inside it." Always rendered last,
  // matching Settings -> General's own fixed-position display of it.
  // hidden_tabs stripped of any stored 'account' value defensively (a
  // bad/tampered setting should never be able to hide the one tab that
  // leads back to Settings itself). Safe to compute even while
  // `generalSettings` is still null (the `|| {}` below) - only the
  // final <Tabs> vs. spinner render decision actually depends on
  // whether the fetch has resolved yet.
  const hiddenTabs = ((generalSettings || {}).hidden_tabs || []).filter((t) => t !== 'account');
  const savedOrder = (generalSettings || {}).tab_order;
  const reorderableTabs =
    Array.isArray(savedOrder) && DEFAULT_TAB_ORDER.every((t) => savedOrder.includes(t))
      ? savedOrder
      : DEFAULT_TAB_ORDER;
  const orderedTabNames = [...reorderableTabs, 'account'];

  const visibleTabNames = orderedTabNames.filter((t) => t === 'account' || !hiddenTabs.includes(t));
  const defaultLandingTab = visibleTabNames.includes((generalSettings || {}).default_landing_tab)
    ? generalSettings.default_landing_tab
    : 'index';

  return (
    // AppDataProvider mounts (and starts its own account/goal/audit
    // fetches) immediately regardless of whether the settings fetch
    // above has resolved yet - only <Tabs> itself waits, so this
    // Step 8 addition doesn't push AppDataProvider's own fetches
    // later than they used to start.
    <AppDataProvider>
      {!generalSettings ? (
        <View style={[styles.container, styles.centered]}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
      <Tabs
        initialRouteName={defaultLandingTab}
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
          tabBarActiveTintColor: isNight ? colors.sage : colors.primary,
          tabBarInactiveTintColor: isNight ? 'rgba(244, 246, 242, 0.45)' : colors.muted,
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name={TAB_ICONS[route.name]} size={size} color={color} />
          ),
          // Real labels, not just icons (2026-08-27, direct user feedback -
          // "they dont have words on them anymore"). tabBarShowLabel/
          // tabBarLabelStyle are explicit here rather than left to defaults:
          // the previous height:64 + tabBarItemStyle paddingTop:6 combo left
          // too little vertical room for icon+label together, so the label
          // was being clipped off the bottom of the rounded pill entirely -
          // that clipped-off label area, rendering against whatever sits
          // behind the floating bar, is also what read as the pill's
          // "bottom half is black" - a taller bar fixes both at once.
          tabBarShowLabel: true,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
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
            bottom: tabBarBottom,
            height: 78,
            paddingTop: 10,
            paddingBottom: 10,
            borderRadius: 28,
            borderTopWidth: 0,
            // Real bug found (2026-09-11, theme redesign): the old
            // `night ? colors.darkest : colors.card` ternary relied on
            // colors.darkest always being dark - but darkest and
            // background now swap roles at night (see _lib/styles.js's
            // NIGHT_COLOR_OVERRIDES), so colors.darkest is LIGHT at
            // night, which would have made this bar light instead of
            // dark, the opposite of the original design intent.
            // colors.card alone is already correctly theme-reactive
            // (light day, dark night) - no ternary needed.
            backgroundColor: colors.card,
            elevation: 8,
            shadowColor: '#000',
            shadowOpacity: 0.15,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
          },
        })}
      >
        {orderedTabNames.map((name) => (
          <Tabs.Screen
            key={name}
            name={name}
            options={{
              title: TAB_TITLES[name],
              // href: null is Expo Router's supported way to remove a
              // screen from the tab bar UI while keeping it mounted in
              // the navigator - not conditionally omitting the
              // <Tabs.Screen> itself, which would change the screen SET
              // this navigator manages (the exact "stable set of
              // screens" concern this file's own header comment flags).
              href: hiddenTabs.includes(name) ? null : undefined,
            }}
          />
        ))}
      </Tabs>
      )}
    </AppDataProvider>
  );
}
