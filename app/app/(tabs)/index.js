import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Button,
  ActivityIndicator,
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

// Phase 6 Step 3: display text for a subscription-audit price-change
// finding, ported verbatim from old app/App.js - hand-matched to the exact
// same wording server/subscriptionAuditEvents.js already uses for the push-
// notification body, so what a notification says and what this screen shows
// for the same finding read the same rather than drifting apart.
function formatPriceChangeText(item) {
  const pct = Math.round(item.increase_ratio * 100);
  return (
    `${item.display_name} is now $${item.current_amount.toFixed(2)} / ${item.interval}, up from ` +
    `$${item.previous_amount.toFixed(2)} — about ${pct}% more.`
  );
}

function formatLapsedText(item) {
  const days = item.days_overdue;
  return (
    `${item.display_name} hasn't charged in ${days} day${days === 1 ? '' : 's'}, past its usual ` +
    `${item.interval} schedule — worth checking if it's still something you want.`
  );
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
// 7 plan - not shared with other tabs), reads alerts/goalProgress/
// subscriptionAudit/accounts from AppDataProvider (fetched proactively
// there, shared with other tabs that need them later).
export default function Home() {
  const { alerts, goalProgress, subscriptionAudit, accounts, bankRelinkSignal } = useAppData();

  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [linked, setLinked] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const [reviewingTransactionId, setReviewingTransactionId] = useState(null);
  const [correctingCategory, setCorrectingCategory] = useState(false);

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

  return (
    <View style={styles.container}>
      {goalProgress && (
        <View style={styles.goalProgressSection}>
          <Text style={styles.smallText}>{goalProgress.message}</Text>
        </View>
      )}

      {/* This one stays fixed (not part of the scrolling header below) -
          a 409 from fetchTransactions (bank connection needs re-linking)
          sets both `error` and `linked: false`, and the "not linked" empty
          state below has no SectionList to carry a header on at all - this
          message would never be reachable if it only lived there. */}
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
      ) : (
        <SectionList
          style={styles.list}
          sections={groupByCategory(transactions)}
          keyExtractor={(item) => item.key}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          // Account balances, overspend alerts, and subscription-audit
          // findings all live here now instead of as fixed content above
          // the list - with a real linked account (12 balance rows plus a
          // long alert, in the case that surfaced this) that fixed content
          // alone could fill the whole screen with nothing below it
          // scrollable, making the actual transaction list unreachable
          // (found on-device, 2026-08-12). Bundling them into the list's
          // own header means everything scrolls together as one list
          // instead of nesting a second scrollable region inside
          // `SectionList` (a VirtualizedList) - RN explicitly warns against
          // nesting a VirtualizedList inside a plain ScrollView with the
          // same orientation, so a wrapping ScrollView was not an option.
          ListHeaderComponent={
            <>
              {accounts && accounts.accounts.length > 0 && (
                <View style={styles.accountsSection}>
                  {accounts.accounts.map((a) => {
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
                  {accounts.total_depository_available != null && (
                    <Text style={styles.smallText}>
                      ${accounts.total_depository_available.toFixed(2)} total available
                    </Text>
                  )}
                </View>
              )}

              {alerts.length > 0 && (
                <View style={styles.alertsSection}>
                  {alerts.map((a) => (
                    <View key={a.category} style={styles.alertRow}>
                      <Text style={styles.alertText}>{a.message}</Text>
                      {a.suggested_action && (
                        <Text style={styles.smallText}>{a.suggested_action}</Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              {/* Phase 6 Step 3: subscription-audit findings (price creep,
                  price jumps, lapsed subscriptions) - shown unprompted,
                  same "red flags surfaced on their own" treatment as the
                  overspend alerts above. The full per-subscription list
                  lives on the Recurring tab (sub-step 1.5). */}
              {subscriptionAudit &&
                (subscriptionAudit.gradual_increases.length > 0 ||
                  subscriptionAudit.price_jumps.length > 0 ||
                  subscriptionAudit.lapsed.length > 0) && (
                  <View style={styles.alertsSection}>
                    {subscriptionAudit.gradual_increases.map((item) => (
                      <View key={`creep-${item.series_id}`} style={styles.alertRow}>
                        <Text style={styles.alertText}>{formatPriceChangeText(item)}</Text>
                      </View>
                    ))}
                    {subscriptionAudit.price_jumps.map((item) => (
                      <View
                        key={`jump-${item.previous_series_id}-${item.current_series_id}`}
                        style={styles.alertRow}
                      >
                        <Text style={styles.alertText}>{formatPriceChangeText(item)}</Text>
                      </View>
                    ))}
                    {subscriptionAudit.lapsed.map((item) => (
                      <View key={`lapsed-${item.id}`} style={styles.alertRow}>
                        <Text style={styles.alertText}>{formatLapsedText(item)}</Text>
                      </View>
                    ))}
                  </View>
                )}
            </>
          }
          renderSectionHeader={({ section: { title } }) => (
            <Text style={styles.sectionHeader}>{title}</Text>
          )}
          renderItem={({ item }) => (
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
                        <Button
                          key={c}
                          title={c}
                          onPress={() => correctCategory(item.transactionId, c)}
                        />
                      ))}
                      <Button title="Cancel" onPress={() => setReviewingTransactionId(null)} />
                    </View>
                  )
                ) : (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewText}>
                      We couldn't confidently categorize this purchase. Help us out by
                      choosing the correct category. We'll use your feedback to improve
                      future matches.
                    </Text>
                    <Button
                      title="Choose category"
                      onPress={() => setReviewingTransactionId(item.transactionId)}
                    />
                  </View>
                ))}
            </View>
          )}
          ListEmptyComponent={<Text style={styles.text}>No transactions yet.</Text>}
        />
      )}
      <StatusBar style="auto" />
    </View>
  );
}
