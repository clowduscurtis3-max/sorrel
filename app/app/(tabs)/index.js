import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Button,
  ActivityIndicator,
  ScrollView,
  SectionList,
  RefreshControl,
  AppState,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import { apiFetch, apiErrorMessage, formatAmount, CATEGORIES } from '../_lib/api';
import { styles } from '../_lib/styles';
import { useAppData } from '../_lib/appData';
import { useSessionContext } from '../_lib/session';

// Phase 8 Step 4 follow-up: a plain time-of-day greeting, requested
// directly by the user - goalProgress's own message (already shown right
// below this) reads as a status line, not a greeting, so it wasn't filling
// this role on its own. First name only, from whatever Google Sign-In
// populated (session.user.user_metadata.full_name) - falls back to no name
// at all rather than guessing one from the email address, same "never
// fabricate" instinct as everywhere else in this app.
function greeting(session) {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const firstName = session?.user?.user_metadata?.full_name?.split(' ')[0];
  return firstName ? `Good ${timeOfDay}, ${firstName}.` : `Good ${timeOfDay}.`;
}

// Phase 8 Step 4 follow-up: the user's explicit "say maybe a week from the
// current date" - a bill due 6 weeks out isn't "upcoming" in the
// at-a-glance sense this section is for.
const UPCOMING_BILLS_WINDOW_DAYS = 7;

// Plain "in N days" framing for the Upcoming bills glance section -
// date-only math (matches this app's existing timezone-consistent-date
// convention elsewhere, e.g. alerts.js/subscriptionAudit.js's own
// UTC-calendar-date comparisons) so a bill due "today" doesn't flicker
// between today/tomorrow depending on time of day.
function formatDueText(nextExpectedDate) {
  const due = new Date(`${nextExpectedDate}T00:00:00Z`);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const days = Math.round((due - todayUtc) / (1000 * 60 * 60 * 24));
  if (days < 0) return 'expected recently';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

// Groups transactions into the shape SectionList expects, one section per
// category, ported verbatim from old app/App.js. A transaction with matched
// receipt items is exploded into its individual line items (each under its
// own category) instead of showing as a single lump-sum row.
function groupByCategory(transactions) {
  const groups = {};

  function addTo(category, entry) {
    const key = category || 'Other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }

  for (const t of transactions) {
    if (t.items && t.items.length > 0) {
      t.items.forEach((item, i) => {
        addTo(item.category, {
          key: `${t.transaction_id}-${i}`,
          name: item.name,
          amount: item.amount,
          needsReview: false,
        });
      });
    } else {
      addTo(t.category, {
        key: t.transaction_id,
        transactionId: t.transaction_id,
        name: t.merchant_name || t.name,
        amount: t.amount,
        needsReview: t.category === 'Uncategorized' || t.category_confidence !== 'high',
        isRecurring: !!t.is_recurring,
        recurringInterval: t.recurring_interval,
      });
    }
  }

  return Object.keys(groups)
    .sort()
    .map((title) => ({ title, data: groups[title] }));
}

// Phase 7 Step 1 sub-step 1.3: the real Home tab, replacing the sub-step
// 1.2 placeholder. Owns transactions/linked/linking locally (per the Phase
// 7 plan - not shared with other tabs), reads alerts/goalProgress/accounts
// from AppDataProvider (fetched proactively there, shared with other tabs
// that need them later).
//
// Phase 8 Step 3/4 follow-up (2026-08-16, per the user's explicit,
// repeated direction): Home is deliberately a lightweight glance screen
// now - greeting, budget alerts, upcoming bills, one bubble per linked bank
// ("institution name: total balance available", nothing more), and net
// worth. The subscription-audit findings (price-creep, price-jump, lapsed)
// were tried here and then explicitly removed - those belong solely on the
// Recurring tab. Upcoming bills is different in kind (a "what's due soon"
// glance, not a subscription-audit finding) and was explicitly asked back
// after being removed alongside that block by mistake. Individual account
// balances and every transaction (including recurring-tagged ones) only
// ever appear after tapping into a specific bank's bubble, which swaps the
// whole screen to a dedicated view for that bank - never squeezed onto
// Home itself, which is the whole point of this restructure (an earlier
// attempt - a combined transaction list always visible on Home - was
// exactly the "overcrowded home screen" the user pushed back on).
export default function Home() {
  const { alerts, goalProgress, subscriptionAudit, accounts, plaidItems, netWorth, bankRelinkSignal } =
    useAppData();
  const { session } = useSessionContext();

  // `null` is Home's own default Overview render; a specific plaid_items.id
  // swaps the whole screen to that bank's dedicated view. Deliberately a
  // local state swap, not a real Expo Router route - see AccountMenu.js's
  // own extensive comment for the three real, compounding bugs a
  // router-route-based overlay caused earlier in this project (useAppData()
  // throwing outside its provider, a GO_BACK error, and an unresolved
  // infinite navigation loop). A plain conditional render, still fully
  // inside AppDataProvider's tree, sidesteps that entire bug class - there's
  // no new route for the root gate or a cold app-launch to ever resolve to.
  const [viewingItemId, setViewingItemId] = useState(null);

  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [linked, setLinked] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const [reviewingTransactionId, setReviewingTransactionId] = useState(null);
  const [correctingCategory, setCorrectingCategory] = useState(false);
  // Phase 8 Step 4: net worth history toggle - netWorth.history already
  // arrives with `current` on the same fetch (GET /net-worth's own
  // {current, history} shape), so this is purely a local show/hide flag,
  // no new fetch needed.
  const [showNetWorthHistory, setShowNetWorthHistory] = useState(false);

  async function fetchTransactions({ silent = false, suppressErrorBanner = false } = {}) {
    if (!silent) setLoadingTransactions(true);
    setError(null);
    try {
      const res = await apiFetch('/transactions');
      if (res.status === 404) {
        setLinked(false);
        setTransactions([]);
        return;
      }
      // The backend's connection to this bank account can't be decrypted
      // (e.g. linked before encryption was added, or after a key
      // rotation) - reuse the "not linked" empty state rather than a
      // dead-end error, since re-linking is the actual fix.
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setLinked(false);
        setTransactions([]);
        setError(body.error || 'Your bank connection needs to be re-linked.');
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setTransactions(data.transactions || []);
      setLinked(true);
    } catch (err) {
      console.error(err);
      // suppressErrorBanner: used by the AppState foreground-resume refresh
      // below - the OS network stack sometimes hasn't reconnected yet at
      // the exact moment the app becomes active, so this call can fail
      // transiently and succeed moments later on its own. Existing data
      // just stays visible until the next successful sync. Pull-to-refresh
      // (also `silent`, but user-initiated) still surfaces real errors.
      if (!suppressErrorBanner) setError(apiErrorMessage(err));
    } finally {
      if (!silent) setLoadingTransactions(false);
    }
  }

  // sub-step 1.7: switched from a mount-only effect to refetch-on-focus
  // (same pattern Budget/Recurring already use) - needed so returning to
  // Home from the account menu after a re-link picks up fresh data.
  // linked/transactions are local to Home per the plan, so nothing else
  // could refresh them directly; this makes every return to the tab do it
  // on its own instead.
  useFocusEffect(
    useCallback(() => {
      fetchTransactions();
    }, [])
  );

  // Real bug found by adversarial review, 2026-08-13: the useFocusEffect
  // comment above assumed closing the account menu's re-link modal would
  // trigger this refetch on its own ("returning to Home from the account
  // menu... picks up fresh data"), but that's not actually true - the
  // account menu is a plain sibling <Modal>, not a router route (see
  // AccountMenu.js's own comment for why), so React Navigation never
  // considers Home to have lost focus in the first place and this
  // useFocusEffect never re-fires for it. `bankRelinkSignal` (bumped by
  // AccountMenu's relinkBankAccount) is the actual fix - guarded on `> 0`
  // so it doesn't also fire a redundant second fetch on first mount,
  // where useFocusEffect above already covers it.
  useEffect(() => {
    if (bankRelinkSignal > 0) fetchTransactions();
  }, [bankRelinkSignal]);

  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        setTimeout(() => {
          fetchTransactions({ silent: true, suppressErrorBanner: true });
        }, 1500);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    await fetchTransactions({ silent: true });
    setRefreshing(false);
  }

  // Re-fetches the whole list afterward rather than patching local state,
  // so the section it now belongs to (grouping is by category) updates
  // correctly too.
  async function correctCategory(transactionId, category) {
    setCorrectingCategory(true);
    setError(null);
    try {
      const res = await apiFetch(`/transactions/${transactionId}/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      setReviewingTransactionId(null);
      await fetchTransactions();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setCorrectingCategory(false);
    }
  }

  async function linkBankAccount() {
    setLinking(true);
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
            setLinking(false);
            await fetchTransactions();
          } catch (err) {
            console.error(err);
            setError(apiErrorMessage(err));
            setLinking(false);
          }
        },
        onExit: (exit) => {
          if (exit.error) console.error(exit.error);
          setLinking(false);
        },
        onEvent: () => {},
      });

      await plaidSession.open();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setLinking(false);
    }
  }

  // One bank's own depository total - shared by each Home bubble's label
  // and the dedicated institution screen's own header, same
  // depository-only/null-when-nothing convention as computeAccountsSummary
  // itself (server/accounts.js) rather than a second, drifting definition.
  function bankTotal(itemId) {
    const depository = (accounts?.accounts || []).filter(
      (a) =>
        a.plaid_item_id === itemId &&
        a.type === 'depository' &&
        (a.available_balance != null || a.current_balance != null)
    );
    if (depository.length === 0) return null;
    return depository.reduce((sum, a) => sum + (a.available_balance ?? a.current_balance), 0);
  }

  const activeItems = plaidItems.filter((i) => i.status === 'active');
  // Real fix found by /code-review (2026-08-16): a disconnected Item had no
  // remaining reachable UI at all - its accounts/transactions are
  // preserved server-side (per this phase's own "disconnect and
  // delete-history are separate concepts" rule), but nothing surfaced them.
  // Shown as its own, separate, visually distinct section below the active
  // bubbles rather than mixed in - tapping still opens the same dedicated
  // per-institution screen, which labels it "(Disconnected)" and frames
  // any balance as frozen, not current.
  const disconnectedItems = plaidItems.filter((i) => i.status !== 'active');

  // Found on-device: two real bills from two different banks that happen
  // to share a merchant/amount/date (Plaid Sandbox's canned data is
  // identical across institutions) read as an apparent duplicate with
  // nothing to tell them apart. Resolves a recurring-bill entry's
  // account_id (server/subscriptionAudit.js) to an institution name the
  // same way attachAccountInfo does server-side for transactions - via
  // accounts.accounts, which already carries both plaid_account_id and
  // institution_name.
  function institutionForAccount(accountId) {
    return accounts?.accounts.find((a) => a.plaid_account_id === accountId)?.institution_name || null;
  }

  // "Upcoming bills" at a glance, requested directly by the user - uses
  // subscriptionAudit.recurring_bills as-is (already fetched, already
  // carries next_expected_date/typical_amount per bill from
  // recurring_series - Bills & Utilities specifically, e.g. mortgage/
  // phone/electricity, not Subscriptions like Netflix, which stays on the
  // Recurring tab only). Windowed to the next 7 days
  // (UPCOMING_BILLS_WINDOW_DAYS) per the user's explicit request, rather
  // than an arbitrary top-N regardless of how far out it is.
  const upcomingBills = subscriptionAudit
    ? (() => {
        const now = new Date();
        const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        return [...subscriptionAudit.recurring_bills]
          .filter((bill) => {
            const days = Math.round(
              (new Date(`${bill.next_expected_date}T00:00:00Z`) - todayUtc) / (1000 * 60 * 60 * 24)
            );
            return days <= UPCOMING_BILLS_WINDOW_DAYS;
          })
          .sort((a, b) => new Date(a.next_expected_date) - new Date(b.next_expected_date));
      })()
    : [];

  // Shared between both branches below - a transaction row, including the
  // "needs review" category-correction flow (the one thing every
  // transaction list in this app has always supported). Only rendered
  // inside the dedicated institution screen now that Home itself never
  // shows any transactions.
  function renderTransactionRow({ item }) {
    return (
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.rowName}>{item.name}</Text>
          <Text style={styles.rowAmount}>{formatAmount(item.amount)}</Text>
        </View>

        {item.isRecurring && (
          <Text style={styles.recurringTag}>Recurring · {item.recurringInterval}</Text>
        )}

        {item.needsReview &&
          (reviewingTransactionId === item.transactionId ? (
            correctingCategory ? (
              <ActivityIndicator />
            ) : (
              <View style={styles.categoryPicker}>
                {CATEGORIES.map((c) => (
                  <Button key={c} title={c} onPress={() => correctCategory(item.transactionId, c)} />
                ))}
                <Button title="Cancel" onPress={() => setReviewingTransactionId(null)} />
              </View>
            )
          ) : (
            <View style={styles.reviewRow}>
              <Text style={styles.reviewText}>
                We couldn't confidently categorize this purchase. Help us out by choosing the
                correct category. We'll use your feedback to improve future matches.
              </Text>
              <Button
                title="Choose category"
                onPress={() => setReviewingTransactionId(item.transactionId)}
              />
            </View>
          ))}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.goalProgressSection}>
        <Text style={styles.rowName}>{greeting(session)}</Text>
      </View>

      {/* Stays fixed regardless of which branch below is showing - a 409
          from fetchTransactions (bank connection needs re-linking) can
          happen no matter which view is open. */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={() => fetchTransactions()} />
        </View>
      )}

      {loadingTransactions ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : !linked ? (
        <View style={styles.centered}>
          {linking ? (
            <ActivityIndicator />
          ) : (
            <Button title="Link bank account" onPress={linkBankAccount} />
          )}
        </View>
      ) : viewingItemId !== null ? (
        // ---- Dedicated per-institution screen ----
        // A full screen swap, not an overlay on top of Home, per the
        // user's explicit "separate screen... back arrow" request. This is
        // now the only place any transaction (recurring-tagged or not)
        // appears anywhere in this app outside the Recurring tab's own
        // audit view.
        (() => {
          // Real fix found by /code-review (2026-08-16): this looked up
          // activeItems only, so a disconnected Item's own name never
          // resolved here even once one became reachable via the
          // "Disconnected" section below - `plaidItems` (every Item
          // regardless of status) is the correct source for this screen,
          // since it needs to display disconnected Items too, not just
          // active ones.
          const item = plaidItems.find((i) => i.id === viewingItemId);
          const isDisconnected = item?.status !== 'active';
          const bankAccounts = (accounts?.accounts || []).filter(
            (a) => a.plaid_item_id === viewingItemId
          );
          const bankTransactions = transactions.filter((t) => t.plaid_item_id === viewingItemId);
          const total = bankTotal(viewingItemId);

          return (
            <>
              <View style={styles.topBar}>
                <View>
                  <Button title="← Back" onPress={() => setViewingItemId(null)} />
                </View>
                <View />
              </View>

              <View style={styles.header}>
                <Text style={styles.rowName}>
                  {item?.institution_name || 'Linked bank'}
                  {isDisconnected ? ' (Disconnected)' : ''}
                </Text>
                {isDisconnected ? (
                  <Text style={styles.smallText}>
                    This bank is disconnected - balances shown are frozen from when it was last
                    synced, not current.
                  </Text>
                ) : (
                  total != null && <Text style={styles.rowAmount}>${total.toFixed(2)} available</Text>
                )}
              </View>

              <SectionList
                style={styles.list}
                sections={groupByCategory(bankTransactions)}
                keyExtractor={(item) => item.key}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                ListHeaderComponent={
                  bankAccounts.length > 0 && (
                    <View style={styles.accountsSection}>
                      {bankAccounts.map((a) => {
                        const balance = a.available_balance ?? a.current_balance;
                        return (
                          <View key={a.id} style={styles.rowMain}>
                            <Text style={styles.rowName}>
                              {a.name}
                              {a.mask ? ` ···${a.mask}` : ''}
                            </Text>
                            <Text style={styles.rowAmount}>
                              {balance != null ? `$${balance.toFixed(2)}` : '—'}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )
                }
                renderSectionHeader={({ section: { title } }) => (
                  <Text style={styles.sectionHeader}>{title}</Text>
                )}
                renderItem={renderTransactionRow}
                ListEmptyComponent={<Text style={styles.text}>No transactions yet.</Text>}
              />
            </>
          );
        })()
      ) : (
        // ---- Home / Overview (default) ----
        // Deliberately short and bounded (a handful of alerts + one bubble
        // per bank + net worth) - a plain ScrollView is correct here, not a
        // SectionList; there is no long transaction feed on this screen
        // anymore for a nested-VirtualizedList concern to even apply to.
        <ScrollView style={styles.list}>
          {goalProgress && (
            <View style={styles.goalProgressSection}>
              <Text style={styles.smallText}>{goalProgress.message}</Text>
            </View>
          )}

          {alerts.length > 0 && (
            <View style={styles.alertsSection}>
              {alerts.map((a) => (
                <View key={a.category} style={styles.alertRow}>
                  <Text style={styles.alertText}>{a.message}</Text>
                  {a.suggested_action && <Text style={styles.smallText}>{a.suggested_action}</Text>}
                </View>
              ))}
            </View>
          )}

          {/* Upcoming bills - Bills & Utilities specifically (mortgage/
              phone/electricity-style), not Subscriptions (Netflix-style,
              shown on the Recurring tab only). A non-interactive header
              bubble (same visual chip language as the bank bubbles below,
              just not tappable) followed by the list itself, each row
              tagged with its bank so two real, distinct bills sharing a
              merchant/amount don't read as a duplicate. */}
          {upcomingBills.length > 0 && (
            <View style={styles.alertsSection}>
              <View style={styles.categoryPicker}>
                <Button title={`Upcoming bills (${upcomingBills.length})`} disabled />
              </View>
              {upcomingBills.map((bill) => {
                const institution = institutionForAccount(bill.account_id);
                return (
                  <View key={bill.id} style={styles.alertRow}>
                    <Text style={styles.alertText}>
                      {bill.display_name} — ${bill.typical_amount.toFixed(2)}
                    </Text>
                    <Text style={styles.smallText}>
                      {formatDueText(bill.next_expected_date)}
                      {institution ? ` · ${institution}` : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {activeItems.length > 0 && (
            <View style={styles.accountsSection}>
              <View style={styles.categoryPicker}>
                {activeItems.map((i) => {
                  const total = bankTotal(i.id);
                  return (
                    <Button
                      key={i.id}
                      title={`${i.institution_name || 'Linked bank'}: ${
                        total != null ? `$${total.toFixed(2)}` : '—'
                      }`}
                      onPress={() => setViewingItemId(i.id)}
                    />
                  );
                })}
              </View>
            </View>
          )}

          {disconnectedItems.length > 0 && (
            <View style={styles.accountsSection}>
              <Text style={styles.smallText}>Disconnected - history preserved, not synced</Text>
              <View style={styles.categoryPicker}>
                {disconnectedItems.map((i) => (
                  <Button
                    key={i.id}
                    title={`${i.institution_name || 'Linked bank'} (Disconnected)`}
                    onPress={() => setViewingItemId(i.id)}
                  />
                ))}
              </View>
            </View>
          )}

          {netWorth?.current && (
            <View style={styles.accountsSection}>
              <Text style={styles.rowName}>Net worth</Text>
              <Text style={styles.rowAmount}>${netWorth.current.net_worth.toFixed(2)}</Text>
              <Text style={styles.smallText}>
                ${netWorth.current.assets.toFixed(2)} assets — ${netWorth.current.liabilities.toFixed(2)}{' '}
                liabilities
              </Text>
              {netWorth.history.length > 0 && (
                <View style={styles.categoryPicker}>
                  <Button
                    title={showNetWorthHistory ? 'Hide history' : 'View history'}
                    onPress={() => setShowNetWorthHistory((v) => !v)}
                  />
                </View>
              )}
              {showNetWorthHistory &&
                netWorth.history
                  .slice()
                  .reverse()
                  .map((snap) => (
                    <View key={snap.snapshot_date} style={styles.budgetRow}>
                      <View style={styles.rowMain}>
                        <Text style={styles.rowName}>{snap.snapshot_date}</Text>
                        <Text style={styles.rowAmount}>${snap.net_worth.toFixed(2)}</Text>
                      </View>
                      <Text style={styles.smallText}>
                        ${snap.assets.toFixed(2)} assets — ${snap.liabilities.toFixed(2)} liabilities
                      </Text>
                    </View>
                  ))}
            </View>
          )}
        </ScrollView>
      )}
      <StatusBar style="auto" />
    </View>
  );
}
