import { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  ActivityIndicator,
  Alert,
  Switch,
  TextInput,
  StyleSheet,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect } from '@react-navigation/native';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { apiFetch, apiErrorMessage, GMAIL_REDIRECT } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';
import { useAppData } from '../_lib/appData';
import { getBiometricLockEnabled, setBiometricLockEnabled } from '../_lib/biometricPreference';
import { listVerifiedTotpFactors, enrollTotp, verifyTotpEnrollment, unenrollTotp } from '../_lib/mfa';
import { AppBackdrop, TopEdgeFade, isNightBackdrop } from '../_components/Illustrations';
import PrimaryButton from '../_components/PrimaryButton';
import SorrelWordmark from '../_components/SorrelWordmark';

// Phase 14 (5-tab conversion, 2026-08-24): account-level actions - Gmail
// link/unlink, per-bank re-link/delete, biometric-lock preference, sign
// out - promoted from a plain <Modal> (_components/AccountMenu.js, Phase 7
// Step 1 sub-step 1.7) into a real fifth tab, per the reference mockup's
// own 5-tab bottom nav (design-references/home-tab-mockup-2026-08-23.png)
// and the user's explicit confirmation this revisits Phase 7's original
// "exactly four tabs, no fifth Settings tab" decision.
//
// Being a real tab (not a Modal) removes an entire bug class the old
// component had to work around: there's no longer a Modal-vs-(tabs)-
// unmount collision to race, since navigating away from this screen on
// sign-out is now the exact same "root gate redirects once session goes
// null" mechanism every other tab already relies on - no Fabric-crash
// workaround, no requestAnimationFrame dance, no `signingOut`-gated
// animationType needed (see the old AccountMenu.js's own extensive
// comment history for what that used to take).
//
// Data refresh: was gated on the Modal's own `visible` prop before; now
// uses `useFocusEffect`, same convention as Budget/Recurring's own tabs -
// visiting this tab is the direct equivalent of the old modal opening.
//
// Visual restyle (2026-08-24, design-references/account-tab-mockup-2026-08-24.png):
// pure layout/styling pass over the exact same state/handlers above - no
// business logic changed. Reuses AppBackdrop verbatim from Home (the
// user's explicit direction: every tab shares the same full-page
// atmospheric background, not a one-off treatment) and the bank-logo/
// fallback pattern Home's own per-institution drill-down already
// established, rather than inventing a second version of either.
function hasRealPlaidError(error) {
  return Boolean(error && (error.errorCode || error.errorType || error.errorMessage));
}

export default function Account() {
  const router = useRouter();
  const { session } = useSessionContext();
  const { signOut, refetchAccounts, notifyBankRelinked, plaidItems, refetchPlaidItems } = useAppData();

  const [gmailEmail, setGmailEmail] = useState(null);
  const [gmailLinking, setGmailLinking] = useState(false);
  const [showGmailExplainer, setShowGmailExplainer] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [error, setError] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  const [actioningItemId, setActioningItemId] = useState(null);
  const [biometricLockEnabled, setBiometricLockEnabledState] = useState(true);

  // Username/password linking (2026-08-25, the authenticated replacement
  // for the account-takeover bug fixed in server/usernameAuth.js -
  // POST /auth/link-username trusts this screen's own session token, never
  // a typed email). `null` while the initial status fetch is in flight, so
  // this card doesn't flash the setup form before we know it's unnecessary.
  const [usernameStatus, setUsernameStatus] = useState(null);
  const [showUsernameForm, setShowUsernameForm] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [linkingUsername, setLinkingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState(null);

  // Two-factor authentication (Phase 21, 2026-08-25) - entirely client-
  // driven via Supabase Auth's own MFA client (_lib/mfa.js), no new
  // backend route needed the way username/password linking needed one -
  // that flow had to be server-authenticated specifically to fix a real
  // account-takeover bug (see server/usernameAuth.js); enrolling/verifying/
  // removing your OWN TOTP factor from your OWN already-authenticated
  // session has no equivalent trust gap to close. `null` while the initial
  // factor-list fetch is in flight, mirrors usernameStatus's own
  // don't-flash-the-wrong-state-first reasoning.
  const [mfaFactors, setMfaFactors] = useState(null);
  const [showMfaSetup, setShowMfaSetup] = useState(false);
  const [enrollingMfa, setEnrollingMfa] = useState(false);
  const [mfaEnrollment, setMfaEnrollment] = useState(null); // { id, totp: { secret } }
  const [mfaCode, setMfaCode] = useState('');
  const [verifyingMfa, setVerifyingMfa] = useState(false);
  const [mfaError, setMfaError] = useState(null);
  const [disablingMfa, setDisablingMfa] = useState(false);

  // Kept for Animated.ScrollView's own onScroll wiring below - no longer
  // drives the backdrop (AppBackdrop is a static full-screen layer, not
  // scroll-parallaxed), the shared background concept every tab now uses.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  // Text rendered directly on top of AppBackdrop (not inside an opaque
  // card) needs to switch to a light color during the night backdrop -
  // colors.darkest reads fine on the light morning/afternoon/evening
  // tints but is unreadable on night's dark tint.
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  async function fetchGmailStatus() {
    try {
      const res = await apiFetch('/gmail/status');
      if (res.status === 404) {
        setGmailEmail(null);
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setGmailEmail(data.email);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchUsernameStatus() {
    try {
      const res = await apiFetch('/auth/username-status');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setUsernameStatus(data);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchMfaFactors() {
    try {
      setMfaFactors(await listVerifiedTotpFactors());
    } catch (err) {
      console.error(err);
    }
  }

  useFocusEffect(
    useCallback(() => {
      fetchGmailStatus();
      fetchUsernameStatus();
      fetchMfaFactors();
      refetchPlaidItems();
      getBiometricLockEnabled().then(setBiometricLockEnabledState);
    }, [])
  );

  async function startMfaEnrollment() {
    setEnrollingMfa(true);
    setMfaError(null);
    try {
      const data = await enrollTotp();
      setMfaEnrollment(data);
      setShowMfaSetup(true);
    } catch (err) {
      console.error(err);
      setMfaError('Could not start two-factor setup. Try again.');
    } finally {
      setEnrollingMfa(false);
    }
  }

  function cancelMfaSetup() {
    // Real bug avoided, not fixed after the fact: leaving an
    // enrolled-but-never-verified factor behind on Supabase's side after a
    // cancel doesn't count as real 2FA (this app's own "verified factors
    // only" filter, listVerifiedTotpFactors, already excludes it from
    // showing as enabled) - harmless, and Supabase itself never surfaces
    // it via getAuthenticatorAssuranceLevel either, so it's left to be
    // silently superseded by whatever the user tries next rather than
    // needing an explicit cleanup call here.
    setShowMfaSetup(false);
    setMfaEnrollment(null);
    setMfaCode('');
    setMfaError(null);
  }

  async function submitMfaVerification() {
    if (!mfaEnrollment || mfaCode.trim().length !== 6) return;
    setVerifyingMfa(true);
    setMfaError(null);
    try {
      await verifyTotpEnrollment(mfaEnrollment.id, mfaCode.trim());
      setShowMfaSetup(false);
      setMfaEnrollment(null);
      setMfaCode('');
      await fetchMfaFactors();
    } catch (err) {
      console.error(err);
      setMfaError('That code didn’t work - check your authenticator app and try again.');
    } finally {
      setVerifyingMfa(false);
    }
  }

  function handleDisableMfa() {
    if (!mfaFactors || mfaFactors.length === 0) return;
    Alert.alert(
      'Turn off two-factor authentication?',
      'Signing in will no longer require a code from your authenticator app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: async () => {
            setDisablingMfa(true);
            setMfaError(null);
            try {
              await unenrollTotp(mfaFactors[0].id);
              await fetchMfaFactors();
            } catch (err) {
              console.error(err);
              setMfaError('Could not turn off two-factor authentication. Try again.');
            } finally {
              setDisablingMfa(false);
            }
          },
        },
      ]
    );
  }

  async function handleToggleBiometricLock(nextEnabled) {
    setBiometricLockEnabledState(nextEnabled);
    await setBiometricLockEnabled(nextEnabled);
  }

  async function submitLinkUsername() {
    setUsernameError(null);
    if (newUsername.trim().length < 3) {
      setUsernameError('Username must be at least 3 characters.');
      return;
    }
    if (newPassword.length < 8) {
      setUsernameError('Password must be at least 8 characters.');
      return;
    }
    setLinkingUsername(true);
    try {
      const res = await apiFetch('/auth/link-username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set up username and password.');
      setShowUsernameForm(false);
      setNewUsername('');
      setNewPassword('');
      await fetchUsernameStatus();
    } catch (err) {
      console.error(err);
      setUsernameError(err.message || apiErrorMessage(err));
    } finally {
      setLinkingUsername(false);
    }
  }

  async function linkGmail() {
    setGmailLinking(true);
    setError(null);
    try {
      const res = await apiFetch('/gmail/auth-url');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { url } = await res.json();

      const result = await WebBrowser.openAuthSessionAsync(url, GMAIL_REDIRECT);
      if (result.type === 'success') {
        if (result.url.includes('error=1')) {
          setError('Failed to link Gmail. Please try again.');
        } else {
          setShowGmailExplainer(false);
          await fetchGmailStatus();
        }
      }
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setGmailLinking(false);
    }
  }

  async function unlinkGmail() {
    setError(null);
    try {
      const res = await apiFetch('/gmail/unlink', { method: 'POST' });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setGmailEmail(null);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setSigningOut(false);
    }
  }

  async function addAccount() {
    setAddingAccount(true);
    setError(null);
    try {
      const linkTokenRes = await apiFetch('/link-token', { method: 'POST' });
      if (!linkTokenRes.ok) throw new Error('SERVER_ERROR');
      const { link_token } = await linkTokenRes.json();

      const plaidSession = await createPlaidLinkSession({
        token: link_token,
        onSuccess: async (success) => {
          try {
            const exchangeRes = await apiFetch('/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: success.publicToken }),
            });
            if (!exchangeRes.ok) throw new Error('SERVER_ERROR');
            await refetchAccounts();
            await refetchPlaidItems();
            notifyBankRelinked();
            setAddingAccount(false);
          } catch (err) {
            console.error(err);
            setError(apiErrorMessage(err));
            setAddingAccount(false);
          }
        },
        onExit: (exit) => {
          if (hasRealPlaidError(exit.error)) console.error(exit.error);
          setAddingAccount(false);
        },
        onEvent: () => {},
      });

      await plaidSession.open();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setAddingAccount(false);
    }
  }

  async function relinkItem(item) {
    setActioningItemId(item.id);
    setError(null);
    try {
      const linkTokenRes = await apiFetch('/link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relink_item_id: item.id }),
      });
      if (!linkTokenRes.ok) {
        const body = await linkTokenRes.json().catch(() => ({}));
        if (body.code === 'NEEDS_DISCONNECT_AND_ADD') {
          throw new Error(body.error);
        }
        throw new Error('SERVER_ERROR');
      }
      const { link_token } = await linkTokenRes.json();

      const plaidSession = await createPlaidLinkSession({
        token: link_token,
        onSuccess: async (success) => {
          try {
            const exchangeRes = await apiFetch('/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                public_token: success.publicToken,
                relink_item_id: item.id,
              }),
            });
            if (!exchangeRes.ok) throw new Error('SERVER_ERROR');
            await refetchAccounts();
            await refetchPlaidItems();
            notifyBankRelinked();
            setActioningItemId(null);
          } catch (err) {
            console.error(err);
            setError(apiErrorMessage(err));
            setActioningItemId(null);
          }
        },
        onExit: (exit) => {
          if (hasRealPlaidError(exit.error)) console.error(exit.error);
          setActioningItemId(null);
        },
        onEvent: () => {},
      });

      await plaidSession.open();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setActioningItemId(null);
    }
  }

  async function deleteItem(item) {
    Alert.alert(
      'Are you sure you want to delete this account?',
      'Deleting removes all transaction history and account balances.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setActioningItemId(item.id);
            setError(null);
            try {
              const res = await apiFetch(`/plaid-items/${item.id}`, { method: 'DELETE' });
              if (!res.ok) throw new Error('SERVER_ERROR');
              await refetchAccounts();
              await refetchPlaidItems();
              notifyBankRelinked();
            } catch (err) {
              console.error(err);
              setError(apiErrorMessage(err));
            } finally {
              setActioningItemId(null);
            }
          },
        },
      ]
    );
  }

  return (
    <View style={styles.container}>
      <View style={accountStyles.backgroundLayer} pointerEvents="none">
        <AppBackdrop scrollY={scrollY} />
      </View>

      {/* Same fixed wordmark strip every other tab uses (2026-08-27, direct
          user feedback - "they need to all have the same sorrel logo at
          the top"). Account was the one tab with no header row above its
          scroll content at all. */}
      <View style={accountStyles.wordmarkStrip}>
        <SorrelWordmark layout="row" leafSize={30} showTagline={false} textColor={onBackdropTextColor} />
        <MaterialIcons name="notifications-none" size={26} color={onBackdropTextColor || colors.darkest} />
      </View>

      <TopEdgeFade height={90}>
      <Animated.ScrollView
        style={[styles.list, accountStyles.transparentScroll]}
        contentContainerStyle={{ paddingBottom: 150 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={accountStyles.signedInBlock}>
          <Text
            style={[
              accountStyles.signedInLabel,
              night && { color: 'rgba(244, 246, 242, 0.75)' },
            ]}
          >
            SIGNED IN AS
          </Text>
          <Text style={[accountStyles.signedInEmail, onBackdropTextColor && { color: onBackdropTextColor }]}>
            {session.user.email}
          </Text>
        </View>

        {/* Phase 38 Step 1: the Settings tab's entry point - a nested
            menu (settings/index.js) lives behind here, not a flat page.
            Placed first so it's easy to find without pushing the rest of
            this screen's existing content further down. */}
        <Pressable
          style={[styles.card, accountStyles.cardMargin, accountStyles.settingsRow]}
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <View style={accountStyles.iconRow}>
            <View style={accountStyles.iconCircle}>
              <MaterialIcons name="settings" size={18} color={colors.dark} />
            </View>
            <Text style={accountStyles.iconRowText}>Settings</Text>
          </View>
          <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
        </Pressable>

        {error && (
          <View style={[styles.card, accountStyles.cardMargin]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {plaidItems.length > 0 && (
          <View style={[styles.card, accountStyles.cardMargin]}>
            {plaidItems.map((item, index) => (
              <View
                key={item.id}
                style={[accountStyles.bankRow, index > 0 && accountStyles.bankRowDivider]}
              >
                <View style={accountStyles.bankNameRow}>
                  {item.institution_logo ? (
                    <Image
                      source={{ uri: `data:image/png;base64,${item.institution_logo}` }}
                      style={accountStyles.bankLogo}
                    />
                  ) : (
                    <View style={accountStyles.bankLogoFallback}>
                      <Text style={accountStyles.bankLogoInitial}>
                        {(item.institution_name || '?').charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <Text style={accountStyles.bankName} numberOfLines={1}>
                    {item.institution_name || 'Linked bank account'}
                  </Text>
                </View>

                {actioningItemId === item.id ? (
                  <ActivityIndicator style={accountStyles.bankActionSpacing} />
                ) : (
                  <View style={[accountStyles.outlineButtonRow, accountStyles.bankActionSpacing]}>
                    <Pressable
                      style={accountStyles.outlineButton}
                      onPress={() => relinkItem(item)}
                      accessibilityRole="button"
                      accessibilityLabel={`Re-link ${item.institution_name || 'bank'}`}
                    >
                      <MaterialIcons name="link" size={16} color={colors.primary} />
                      <Text style={accountStyles.outlineButtonText}>RE-LINK</Text>
                    </Pressable>
                    <Pressable
                      style={accountStyles.outlineButton}
                      onPress={() => deleteItem(item)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${item.institution_name || 'bank'}`}
                    >
                      <MaterialIcons name="delete-outline" size={16} color={colors.primary} />
                      <Text style={accountStyles.outlineButtonText}>DELETE</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}

            <View style={accountStyles.addAccountSpacing}>
              {addingAccount ? (
                <ActivityIndicator />
              ) : (
                <PrimaryButton title="ADD ANOTHER ACCOUNT" onPress={addAccount} />
              )}
            </View>
          </View>
        )}

        <View style={[styles.card, accountStyles.cardMargin]}>
          {gmailEmail ? (
            <>
              <View style={accountStyles.iconRow}>
                <View style={accountStyles.iconCircle}>
                  <MaterialIcons name="mail-outline" size={18} color={colors.dark} />
                </View>
                <Text style={accountStyles.iconRowText}>
                  Itemized receipts linked:{'\n'}
                  <Text style={accountStyles.iconRowTextBold}>{gmailEmail}</Text>
                </Text>
              </View>
              <Pressable
                style={[accountStyles.outlineButton, accountStyles.outlineButtonFull]}
                onPress={unlinkGmail}
                accessibilityRole="button"
                accessibilityLabel="Unlink email"
              >
                <MaterialIcons name="link-off" size={16} color={colors.primary} />
                <Text style={accountStyles.outlineButtonText}>UNLINK EMAIL</Text>
              </Pressable>
            </>
          ) : showGmailExplainer ? (
            <>
              <Text style={styles.smallText}>
                Optional: link Gmail so receipts from retailers can be broken into itemized
                purchases (e.g. individual grocery items) instead of one lump total. We only
                read receipt-like emails — nothing else in your inbox is accessed or stored. You
                can unlink at any time.
              </Text>
              {gmailLinking ? (
                <ActivityIndicator />
              ) : (
                <PrimaryButton title="LINK GMAIL" onPress={linkGmail} />
              )}
              <Pressable onPress={() => setShowGmailExplainer(false)} accessibilityRole="button">
                <Text style={accountStyles.textLink}>Not now</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={[accountStyles.outlineButton, accountStyles.outlineButtonFull]}
              onPress={() => setShowGmailExplainer(true)}
              accessibilityRole="button"
              accessibilityLabel="Get itemized receipts (optional)"
            >
              <MaterialIcons name="mail-outline" size={16} color={colors.primary} />
              <Text style={accountStyles.outlineButtonText}>GET ITEMIZED RECEIPTS (OPTIONAL)</Text>
            </Pressable>
          )}
        </View>

        {usernameStatus && (
          <View style={[styles.card, accountStyles.cardMargin]}>
            {usernameStatus.has_username ? (
              <View style={accountStyles.iconRow}>
                <View style={accountStyles.iconCircle}>
                  <MaterialIcons name="badge" size={18} color={colors.dark} />
                </View>
                <Text style={accountStyles.iconRowText}>
                  Signed in with username:{'\n'}
                  <Text style={accountStyles.iconRowTextBold}>{usernameStatus.username}</Text>
                </Text>
              </View>
            ) : showUsernameForm ? (
              <>
                <Text style={styles.smallText}>
                  Optional: add a username and password as a second way to sign in, alongside
                  Google.
                </Text>
                <View style={accountStyles.formFieldRow}>
                  <MaterialIcons name="person" size={18} color={colors.dark} />
                  <TextInput
                    style={accountStyles.formFieldInput}
                    placeholder="Username"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={newUsername}
                    onChangeText={setNewUsername}
                  />
                </View>
                <View style={accountStyles.formFieldRow}>
                  <MaterialIcons name="lock-outline" size={18} color={colors.dark} />
                  <TextInput
                    style={accountStyles.formFieldInput}
                    placeholder="Password"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!showNewPassword}
                    value={newPassword}
                    onChangeText={setNewPassword}
                  />
                  <Pressable
                    onPress={() => setShowNewPassword((v) => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={showNewPassword ? 'Hide password' : 'Show password'}
                  >
                    <MaterialIcons
                      name={showNewPassword ? 'visibility-off' : 'visibility'}
                      size={18}
                      color={colors.dark}
                    />
                  </Pressable>
                </View>
                {usernameError && <Text style={styles.errorText}>{usernameError}</Text>}
                {linkingUsername ? (
                  <ActivityIndicator style={accountStyles.addAccountSpacing} />
                ) : (
                  <View style={accountStyles.addAccountSpacing}>
                    <PrimaryButton title="SAVE USERNAME & PASSWORD" onPress={submitLinkUsername} />
                  </View>
                )}
                <Pressable
                  onPress={() => {
                    setShowUsernameForm(false);
                    setUsernameError(null);
                    setNewUsername('');
                    setNewPassword('');
                  }}
                  accessibilityRole="button"
                >
                  <Text style={accountStyles.textLink}>Cancel</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={[accountStyles.outlineButton, accountStyles.outlineButtonFull]}
                onPress={() => setShowUsernameForm(true)}
                accessibilityRole="button"
                accessibilityLabel="Set up username and password (optional)"
              >
                <MaterialIcons name="badge" size={16} color={colors.primary} />
                <Text style={accountStyles.outlineButtonText}>SET UP USERNAME & PASSWORD (OPTIONAL)</Text>
              </Pressable>
            )}
          </View>
        )}

        {mfaFactors && (
          <View style={[styles.card, accountStyles.cardMargin]}>
            {mfaFactors.length > 0 ? (
              <>
                <View style={accountStyles.iconRow}>
                  <View style={accountStyles.iconCircle}>
                    <MaterialIcons name="verified-user" size={18} color={colors.dark} />
                  </View>
                  <Text style={accountStyles.iconRowText}>Two-factor authentication is on</Text>
                </View>
                {mfaError && <Text style={styles.errorText}>{mfaError}</Text>}
                {disablingMfa ? (
                  <ActivityIndicator style={accountStyles.addAccountSpacing} />
                ) : (
                  <Pressable
                    style={[accountStyles.outlineButton, accountStyles.outlineButtonFull, accountStyles.addAccountSpacing]}
                    onPress={handleDisableMfa}
                    accessibilityRole="button"
                    accessibilityLabel="Turn off two-factor authentication"
                  >
                    <Text style={accountStyles.outlineButtonText}>TURN OFF</Text>
                  </Pressable>
                )}
              </>
            ) : showMfaSetup && mfaEnrollment ? (
              <>
                <Text style={styles.smallText}>
                  Open your authenticator app (Google Authenticator, Authy, etc.), choose "Enter a
                  setup key" / "Enter code manually," and enter this secret:
                </Text>
                <Text style={accountStyles.mfaSecret} selectable>
                  {mfaEnrollment.totp.secret}
                </Text>
                <Text style={styles.smallText}>Then enter the 6-digit code it generates:</Text>
                <View style={accountStyles.formFieldRow}>
                  <MaterialIcons name="pin" size={18} color={colors.dark} />
                  <TextInput
                    style={accountStyles.formFieldInput}
                    placeholder="123456"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="number-pad"
                    maxLength={6}
                    value={mfaCode}
                    onChangeText={(t) => setMfaCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
                  />
                </View>
                {mfaError && <Text style={styles.errorText}>{mfaError}</Text>}
                {verifyingMfa ? (
                  <ActivityIndicator style={accountStyles.addAccountSpacing} />
                ) : (
                  <View style={accountStyles.addAccountSpacing}>
                    <PrimaryButton title="VERIFY & TURN ON" onPress={submitMfaVerification} />
                  </View>
                )}
                <Pressable onPress={cancelMfaSetup} accessibilityRole="button">
                  <Text style={accountStyles.textLink}>Cancel</Text>
                </Pressable>
              </>
            ) : enrollingMfa ? (
              <ActivityIndicator />
            ) : (
              <>
                <Pressable
                  style={[accountStyles.outlineButton, accountStyles.outlineButtonFull]}
                  onPress={startMfaEnrollment}
                  accessibilityRole="button"
                  accessibilityLabel="Set up two-factor authentication (optional)"
                >
                  <MaterialIcons name="verified-user" size={16} color={colors.primary} />
                  <Text style={accountStyles.outlineButtonText}>SET UP TWO-FACTOR AUTHENTICATION (OPTIONAL)</Text>
                </Pressable>
                {mfaError && <Text style={styles.errorText}>{mfaError}</Text>}
              </>
            )}
          </View>
        )}

        <View
          style={[styles.card, accountStyles.cardMargin, accountStyles.faceIdRow]}
        >
          <View style={[accountStyles.iconRow, accountStyles.iconRowGrow]}>
            <View style={accountStyles.iconCircle}>
              <MaterialIcons name="fingerprint" size={18} color={colors.dark} />
            </View>
            <Text style={accountStyles.iconRowText}>Require Face ID / Fingerprint to unlock</Text>
          </View>
          <Switch
            value={biometricLockEnabled}
            onValueChange={handleToggleBiometricLock}
            trackColor={{ false: colors.sage, true: colors.primary }}
          />
        </View>

        <View style={accountStyles.signOutSpacing}>
          {signingOut ? (
            <ActivityIndicator />
          ) : (
            <Pressable
              style={[accountStyles.outlineButton, accountStyles.outlineButtonFull]}
              onPress={handleSignOut}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
            >
              <MaterialIcons name="logout" size={16} color={colors.primary} />
              <Text style={accountStyles.outlineButtonText}>SIGN OUT</Text>
            </Pressable>
          )}
        </View>
      </Animated.ScrollView>
      </TopEdgeFade>

      <StatusBar style="auto" />
    </View>
  );
}

const accountStyles = StyleSheet.create({
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Same values as every other tab's wordmarkStrip - kept identical on
  // purpose so the header reads as one consistent piece across tabs.
  wordmarkStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
  },
  transparentScroll: {
    backgroundColor: 'transparent',
  },
  signedInBlock: {
    // Matches every other tab's own first-scroll-item paddingTop (Budget/
    // Recurring/Goal's 110, Home's greetingBlock) - was 100 here, the one
    // tab that had drifted slightly from that shared value.
    paddingTop: 110,
    paddingBottom: 24,
    alignItems: 'center',
    gap: 2,
  },
  // Matches Home/Recurring/Goal's own cardEyebrow exactly (2026-08-31
  // consistency pass) - this was a one-off 13px/regular style, the only
  // "label above a value" element in the app not using either of its two
  // established label conventions (this eyebrow style for a full-width
  // section header, or the smaller centered statLabel used in stat-tile
  // rows - Budget's own statLabel already matches Home's exactly, so that
  // one didn't need changing).
  signedInLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.dark,
  },
  signedInEmail: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.darkest,
  },
  cardMargin: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bankRow: {
    paddingVertical: 12,
    gap: 10,
  },
  bankRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  bankNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bankLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.background,
  },
  bankLogoFallback: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bankLogoInitial: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.background,
  },
  bankName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.darkest,
  },
  bankActionSpacing: {
    marginTop: 2,
  },
  outlineButtonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  outlineButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
    backgroundColor: colors.background,
    borderRadius: 22,
    paddingVertical: 10,
    minHeight: 40,
  },
  outlineButtonFull: {
    marginTop: 4,
  },
  outlineButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.3,
  },
  addAccountSpacing: {
    marginTop: 4,
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  // Only for iconRow's use inside faceIdRow (a row container, not a
  // column card) - without this, iconRow has no flexGrow along the row's
  // main axis, so it sizes to its own text's natural width instead of
  // sharing the row with the Switch, pushing the Switch off the card's
  // edge. Scoped here rather than added to iconRow itself: iconRow's
  // other uses (Gmail/itemized-receipts cards) sit inside a column card,
  // where the default cross-axis stretch already gives it the card's
  // full width - flex:1 there would additionally affect vertical sizing
  // along the column's main axis, which those cards don't need.
  iconRowGrow: {
    flex: 1,
  },
  formFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.background,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
  },
  formFieldInput: {
    flex: 1,
    fontSize: 14,
    color: colors.darkest,
  },
  mfaSecret: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.darkest,
    backgroundColor: colors.background,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconRowText: {
    flex: 1,
    fontSize: 13,
    color: colors.dark,
    lineHeight: 18,
  },
  iconRowTextBold: {
    fontWeight: '700',
    color: colors.darkest,
  },
  faceIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  signOutSpacing: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 32,
  },
  textLink: {
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 4,
  },
});
