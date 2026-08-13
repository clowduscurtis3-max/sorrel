import { useState } from 'react';
import { Button } from 'react-native';
import { Tabs } from 'expo-router';
import { AppDataProvider } from '../_lib/appData';
import AccountMenu from '../_components/AccountMenu';

// Phase 7 Step 1: tab shell. Exactly four tabs per the locked-in decision,
// no fifth "Settings" tab - account-level actions (Gmail link/unlink,
// re-link bank, sign out) live in AccountMenu, a plain React Native
// <Modal> toggled by local state here, not a router route (see
// _components/AccountMenu.js's comment for why - it started as a route and
// caused three real, compounding on-device bugs). A plain `Button` in the
// header rather than a real icon - this app has no icon library/dependency
// anywhere else (every other screen uses plain RN `Button`s), and adding
// one just for this would be the first visual-polish exception to that
// otherwise-consistent plainness, not something this phase's "no UI
// polish" scope calls for.
//
// AppDataProvider is back to wrapping just this file (the original
// sub-step 1.3 design - "wrapping only the (tabs) group" per the plan) -
// it only ever needed to move out to the root layout because account-menu
// was briefly a route living outside this tree; now that it's a plain
// component rendered right here, that's no longer true.
export default function TabsLayout() {
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  // Real crash found on-device, 2026-08-13: right after signing in, the
  // (tabs) tree's very first mount - this file, AppDataProvider, the Tabs
  // navigator resolving its own default screen, AND AccountMenu (its
  // Modal plus every child View/Button inside it) - all landed in the same
  // initial commit, and that much simultaneous native mounting work raced
  // Fabric hard enough to throw `RetryableMountingLayerException: Unable
  // to find viewState for tag N` (confirmed via `adb logcat` - the
  // component stack at the moment of the crash named AccountMenu,
  // AppDataProvider, and TabsLayout directly). Same underlying class of
  // bug as the already-documented notification-tap race in _layout.js
  // (too much native work landing in one still-settling first paint), just
  // triggered here by the ordinary post-sign-in navigation into (tabs)
  // instead of a notification tap.
  //
  // `accountMenuMounted` keeps AccountMenu entirely out of that first
  // commit - it isn't created at all until the user actually taps
  // "Account" for the first time, so there's meaningfully less native work
  // competing with the Tabs navigator's own first-mount settling. Once
  // opened, it stays mounted permanently (never goes back to `false`) so
  // every close after the first keeps the Modal's normal slide-out
  // animation and existing behavior - this only changes what happens
  // before the first tap.
  const [accountMenuMounted, setAccountMenuMounted] = useState(false);

  function openAccountMenu() {
    setAccountMenuMounted(true);
    setShowAccountMenu(true);
  }

  return (
    <AppDataProvider>
      <Tabs
        screenOptions={{
          headerRight: () => <Button title="Account" onPress={openAccountMenu} />,
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="budget" options={{ title: 'Budget' }} />
        <Tabs.Screen name="recurring" options={{ title: 'Recurring' }} />
        <Tabs.Screen name="goal" options={{ title: 'Goal' }} />
      </Tabs>
      {accountMenuMounted && (
        <AccountMenu visible={showAccountMenu} onClose={() => setShowAccountMenu(false)} />
      )}
    </AppDataProvider>
  );
}
