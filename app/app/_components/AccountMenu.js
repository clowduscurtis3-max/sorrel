import { useEffect, useState } from 'react';
import { Modal, View, Text, Button, ActivityIndicator, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import { apiFetch, apiErrorMessage, GMAIL_REDIRECT } from '../_lib/api';
import { styles } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';
import { useAppData } from '../_lib/appData';

// Found tap-testing Step 3's relink flow on-device, 2026-08-16: Plaid's
// Android SDK calls onExit with a truthy but completely empty `error`
// object ({}) when the Link UI is simply closing after a fully successful
// completion - confirmed via adb logcat, not just the on-screen LogBox
// (the raw ReactNativeJS log line itself is `{}`, not a rendering
// artifact hiding real fields). The SDK's own LinkError type says
// errorCode/errorType/errorMessage are all required - real runtime
// behavior doesn't match that contract in this case. A bare
// `if (exit.error)` check treats this benign close-after-success as a
// real error; checking for actual error content instead is what
// distinguishes a genuine failure from this placeholder.
function hasRealPlaidError(error) {
  return Boolean(error && (error.errorCode || error.errorType || error.errorMessage));
}

// Phase 7 Step 1 sub-step 1.7: account-level actions that don't belong on
// any one tab - Gmail link/unlink, re-link bank, sign out - all ported
// verbatim from old app/App.js's header section.
//
// Deliberately a plain component + React Native's own <Modal>, NOT an
// Expo Router route (`account-menu.js` under app/app/ + a Stack.Screen
// entry). That was the first design, and it caused three real, compounding
// bugs on-device: useAppData() throwing (account-menu was a Stack sibling
// of (tabs), never actually inside AppDataProvider's tree), "Close"
// throwing a GO_BACK error (the app sometimes resumed directly on the
// account-menu route with no history to pop), and finally an infinite
// flicker loop between account-menu and Home (something kept re-resolving
// the initial route back to account-menu even after an explicit
// router.replace('/') - the exact mechanism was never pinned down even
// after two attempts at correcting for it in the root gate). All three
// bugs share one root cause: this screen was reachable as a standalone,
// independently-resolvable route at all. A plain <Modal> toggled by local
// boolean state (owned by (tabs)/_layout.js, which renders this component)
// isn't addressable by any router/URL/deep-link mechanism, so there's
// nothing for anything to "restore" it to - the entire bug class doesn't
// apply. `visible`/`onClose` are the only two props; everything else is
// exactly as it was.
//
// "Add another account" and each linked Item's "Re-link"/"Disconnect" all
// have their own self-contained Plaid Link flow here (not reused from
// Home) - `linked`/`transactions` are deliberately local to Home per the
// plan, so this has no access to Home's state to update directly. After
// any of these three actions succeeds, this refetches `accounts` (shared
// via AppDataProvider, since balances would genuinely change) and its own
// local `plaidItems` list - Home itself refetches transactions on every
// focus (see its own useFocusEffect), so returning to Home after the
// modal closes picks up fresh data on its own, no direct coordination
// needed.
//
// Phase 8 Step 3: before this step, the button here (then labeled
// "Re-link bank account") called /link-token and /exchange-token with no
// relink_item_id at all - which, since Phase 8 Step 1 removed the old
// "delete the previous item's data on a differing item_id" cleanup (a
// real multi-item architecture can't unconditionally delete on every new
// link), meant tapping it silently *added* a duplicate Item instead of
// fixing the existing one - duplicate accounts, duplicate transaction
// history. That's now `addAccount()` below, correctly labeled for what
// it's always actually done (a plain ADD, never touching another Item's
// data). A genuine re-link now goes through Plaid Update Mode
// (`relinkItem`, using the specific Item's id) instead, which reconnects
// to the *same* Item/cursor - no duplication possible by construction.
export default function AccountMenu({ visible, onClose }) {
  const { session } = useSessionContext();
  const { signOut, refetchAccounts, notifyBankRelinked, plaidItems, refetchPlaidItems } = useAppData();

  const [gmailEmail, setGmailEmail] = useState(null);
  const [gmailLinking, setGmailLinking] = useState(false);
  const [showGmailExplainer, setShowGmailExplainer] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [error, setError] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  // Phase 8 Step 3: this user's linked Plaid Items (one per institution),
  // so more than one can actually be told apart/managed once it exists.
  // `actioningItemId` is keyed by item id (not a plain boolean) since
  // Re-link/Disconnect are both per-item actions - only the one row being
  // acted on should show a spinner/disable its own buttons, not every row.
  // `plaidItems` itself now comes from AppDataProvider (see its own
  // comment) - Home's Overview/per-bank filter needs the same list.
  const [actioningItemId, setActioningItemId] = useState(null);

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

  // Refetches every time the modal opens, matching the old route version's
  // mount-once behavior (a <Modal> unmounts its children when hidden by
  // default is false in RN - content stays mounted - so this is gated on
  // `visible` specifically rather than a plain mount-only effect).
  // plaidItems itself is fetched proactively by AppDataProvider (shared
  // with Home now), but re-fetched again here too on open, same "meant to
  // be live" reasoning as fetchGmailStatus - status/institution list may
  // have changed since AppDataProvider last fetched it.
  useEffect(() => {
    if (visible) {
      fetchGmailStatus();
      refetchPlaidItems();
    }
  }, [visible]);

  // Real bug found by adversarial review, 2026-08-13: handleSignOut below
  // (the "Sign out" button) already guards against a native Fabric
  // mounting crash that happens when this Modal is still visible at the
  // exact moment `session` clears and the root gate unmounts the entire
  // (tabs) tree underneath it - see that comment for the full history. But
  // `session` can also go null from a cause that has nothing to do with
  // that button: a 401 from any apiFetch call this component itself makes
  // (fetchGmailStatus, linkGmail, addAccount, relinkItem, disconnectItem)
  // now forces a sign-out
  // too (api.js's forceSignOut). That path never touches `signingOut`, so
  // it was still exposed to the exact same crash through a different
  // door. Reacting to `session` itself, rather than only to this
  // component's own button, covers every cause generically - anything
  // that clears the session while this Modal is open gets the same safe
  // treatment.
  useEffect(() => {
    if (!session && visible && !signingOut) {
      setSigningOut(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onClose();
        });
      });
    }
  }, [session, visible, signingOut, onClose]);

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

  // Real crash found on-device, not just reasoned through: tapping Sign
  // out directly (signOut prop's onPress) threw a native Fabric mounting
  // error (`RetryableMountingLayerException`) and left the app unable to
  // sign back in without a full close+reopen. Root cause: this whole
  // screen is a native <Modal>, still `visible={true}` at the moment
  // sign-out clears the session - which immediately unmounts the entire
  // (tabs) tree underneath it (the root gate redirects away from (tabs)
  // the instant `session` goes null). Two teardowns landing at once - the
  // Modal's own native window closing and its whole parent tree
  // disappearing - collided at the Fabric/native-mounting layer.
  //
  // First fix tried closing the modal, then delaying signOut() with a
  // fixed setTimeout to give the Modal's slide-out animation a moment to
  // finish first - 300ms, then 500ms after it recurred once. It recurred
  // *again* on 2026-08-13 at 500ms, same crash signature (`Unable to find
  // viewState for tag N`) - a fixed ms delay can't actually guarantee it
  // outlasts a real native transition's duration, so tuning the number
  // further was never going to be reliable, just less likely to lose.
  // Fixed properly this time by removing the animation from the race
  // entirely instead of trying to out-wait it: `signingOut` forces
  // `animationType="none"` and `visible=false` in the same render, so
  // there's no slide transition to race against at all - nothing left to
  // "beat". Two `requestAnimationFrame`s (not a timer) give React/Fabric a
  // couple of real frames to actually commit that removal natively before
  // `signOut()` clears the session and the (tabs) tree unmounts underneath
  // it. `signingOut` is reset in a `catch` (not a `finally` - the success
  // path unmounts this whole component via the session-clear redirect, so
  // there's nothing left to reset by then) so a failed sign-out doesn't
  // leave the account menu permanently unable to reopen.
  async function handleSignOut() {
    setSigningOut(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        onClose();
        try {
          await signOut();
        } catch (err) {
          console.error(err);
          setSigningOut(false);
        }
      });
    });
  }

  // The plain ADD flow - ports what this function has always actually done
  // (no relink_item_id anywhere in it), just correctly named/labeled now
  // that a genuine per-item relinkItem() exists below. Always creates a
  // brand-new Item; never touches any existing Item's data, no matter how
  // many the user already has (server/index.js's own ADD-branch comment).
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
            // See appData.js's bankRelinkSignal comment - closing this
            // Modal alone doesn't get Home to refetch its (deliberately
            // local) transactions/linked state, since it never actually
            // loses React Navigation focus.
            notifyBankRelinked();
            setAddingAccount(false);
            onClose();
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

  // The genuine re-link path (Phase 8 Step 1's Update Mode work) - reuses
  // the same Item/cursor rather than creating a new one, so it can never
  // produce duplicate accounts/transactions the way addAccount() above
  // would if used for this instead. /link-token's relink_item_id branch
  // 409s with NEEDS_DISCONNECT_AND_ADD for a token that can't be repaired
  // (already disconnected, or undecryptable) - surfaced here as a plain
  // message rather than silently falling back to a fresh Link session,
  // per this phase's own explicit "two actions, never one implicit merge"
  // decision.
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

  // Real product decision, 2026-08-17, replacing the earlier soft
  // "disconnect" model entirely: deleting a bank is a genuine, cascading
  // delete (server/index.js's DELETE /plaid-items/:id - revokes the Plaid
  // token, deletes this Item's transactions and accounts, recomputes
  // budget/goal/recurring/alerts fresh). Confirmation wording deliberately
  // doesn't say "cannot be undone" - direct user feedback: that reads as
  // needlessly scary and isn't even fully true, since the bank can just be
  // added back (as a fresh connection - the specific transaction history
  // being deleted is real and won't return, but the account itself isn't
  // gone forever).
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
    <Modal
      visible={visible && !signingOut}
      animationType={signingOut ? 'none' : 'slide'}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.topBar}>
          <View />
          <View>
            <Button title="Close" onPress={onClose} />
          </View>
        </View>

        <View style={styles.header}>
          <Text style={styles.smallText}>Signed in as {session.user.email}</Text>
        </View>

        {/* pinnedFooterScreen carries the same 72px gesture-bar clearance as
            goal-intake.js's goalScreen, so Sign out (pinned via the flex:1
            spacer below) doesn't repeat the exact bug found and fixed there
            earlier tonight - a bottom-pinned button rendering underneath the
            phone's OS nav bar. */}
        <View style={styles.pinnedFooterScreen}>
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
                  Optional: link Gmail so receipts from retailers can be broken into
                  itemized purchases (e.g. individual grocery items) instead of one lump
                  total. We only read receipt-like emails — nothing else in your inbox is
                  accessed or stored. You can unlink at any time.
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

          <View style={{ flex: 1 }} />

          <View style={styles.header}>
            <Button title="Sign out" onPress={handleSignOut} />
          </View>
        </View>
        <StatusBar style="auto" />
      </View>
    </Modal>
  );
}
