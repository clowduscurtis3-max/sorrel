import { useCallback, useState } from 'react';
import { View, Text, Button, ScrollView, ActivityIndicator, Alert, Switch } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect } from '@react-navigation/native';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import { apiFetch, apiErrorMessage, GMAIL_REDIRECT } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';
import { useAppData } from '../_lib/appData';
import { getBiometricLockEnabled, setBiometricLockEnabled } from '../_lib/biometricPreference';

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
function hasRealPlaidError(error) {
  return Boolean(error && (error.errorCode || error.errorType || error.errorMessage));
}

export default function Account() {
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

  useFocusEffect(
    useCallback(() => {
      fetchGmailStatus();
      refetchPlaidItems();
      getBiometricLockEnabled().then(setBiometricLockEnabledState);
    }, [])
  );

  async function handleToggleBiometricLock(nextEnabled) {
    setBiometricLockEnabledState(nextEnabled);
    await setBiometricLockEnabled(nextEnabled);
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
      <ScrollView style={styles.list}>
        <View style={styles.header}>
          <Text style={styles.smallText}>Signed in as {session.user.email}</Text>
        </View>

        {plaidItems.length > 0 && (
          <View style={styles.plaidItemsSection}>
            {plaidItems.map((item) => (
              <View key={item.id} style={styles.plaidItemBlock}>
                <Text style={styles.smallText}>{item.institution_name || 'Linked bank account'}</Text>
                {actioningItemId === item.id ? (
                  <ActivityIndicator />
                ) : (
                  <>
                    <Button title="Re-link" onPress={() => relinkItem(item)} />
                    <Button title="Delete" onPress={() => deleteItem(item)} />
                  </>
                )}
              </View>
            ))}
          </View>
        )}

        <View style={styles.header}>
          {addingAccount ? (
            <ActivityIndicator />
          ) : (
            <Button title="Add another account" onPress={addAccount} />
          )}
        </View>

        <View style={styles.gmailSection}>
          {gmailEmail ? (
            <>
              <Text style={styles.smallText}>Itemized receipts linked: {gmailEmail}</Text>
              <Button title="Unlink email" onPress={unlinkGmail} />
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
                <Button title="Link Gmail" onPress={linkGmail} />
              )}
              <Button title="Not now" onPress={() => setShowGmailExplainer(false)} />
            </>
          ) : (
            <Button
              title="Get itemized receipts (optional)"
              onPress={() => setShowGmailExplainer(true)}
            />
          )}
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <View
          style={[
            styles.header,
            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
          ]}
        >
          <Text style={styles.smallText}>Require Face ID / Fingerprint to unlock</Text>
          <Switch
            value={biometricLockEnabled}
            onValueChange={handleToggleBiometricLock}
            trackColor={{ false: colors.sage, true: colors.primary }}
          />
        </View>

        <View style={styles.header}>
          {signingOut ? (
            <ActivityIndicator />
          ) : (
            <Button title="Sign out" onPress={handleSignOut} />
          )}
        </View>
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}
