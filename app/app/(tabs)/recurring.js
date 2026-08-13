import { useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import { styles } from '../_lib/styles';
import { useAppData } from '../_lib/appData';

// Phase 6 Step 3: one row in the recurring-spend list, shared across all
// three groups below - ported verbatim from old app/App.js.
function renderRecurringRow(s) {
  return (
    <View key={s.id} style={styles.budgetRow}>
      <Text style={styles.rowName}>{s.display_name}</Text>
      <Text style={styles.smallText}>
        ${s.typical_amount.toFixed(2)} / {s.interval} (~${s.monthly_equivalent_amount.toFixed(2)}/mo) · next
        expected {s.next_expected_date}
      </Text>
    </View>
  );
}

// Phase 7 Step 1 sub-step 1.5: the real Recurring tab, replacing the
// sub-step 1.2 placeholder. `subscriptionAudit` comes from AppDataProvider
// (shared with Home's unprompted findings section) rather than local state
// - unlike Budget, there's no separate edit/proposal sub-state here, this
// tab is a read-only view of data Home already fetches proactively.
export default function Recurring() {
  const { subscriptionAudit, refetchSubscriptionAudit } = useAppData();

  // Refetches on every focus, same "visiting the tab is the toggle-open
  // equivalent" reasoning as Budget (sub-step 1.4) - no loading spinner
  // needed the way Budget has one, since subscriptionAudit already has a
  // value from AppDataProvider's own proactive fetch to show immediately;
  // this just keeps it current, same silent-by-design treatment the old
  // app already gave this data's background fetches.
  useFocusEffect(
    useCallback(() => {
      refetchSubscriptionAudit();
    }, [])
  );

  return (
    <View style={styles.container}>
      <ScrollView style={styles.budgetScreen}>
        {subscriptionAudit && (
          <Text style={styles.smallText}>
            ~${subscriptionAudit.total_monthly_equivalent.toFixed(2)}/month across{' '}
            {subscriptionAudit.subscriptions.length +
              subscriptionAudit.recurring_bills.length +
              subscriptionAudit.other_recurring.length}{' '}
            recurring charges
          </Text>
        )}
        {subscriptionAudit &&
          subscriptionAudit.subscriptions.length === 0 &&
          subscriptionAudit.recurring_bills.length === 0 &&
          subscriptionAudit.other_recurring.length === 0 && (
            <Text style={styles.smallText}>No recurring charges detected yet.</Text>
          )}

        {subscriptionAudit?.subscriptions.length > 0 && (
          <>
            <Text style={styles.recurringGroupHeader}>Subscriptions</Text>
            {subscriptionAudit.subscriptions.map(renderRecurringRow)}
          </>
        )}
        {subscriptionAudit?.recurring_bills.length > 0 && (
          <>
            <Text style={styles.recurringGroupHeader}>Recurring bills</Text>
            {subscriptionAudit.recurring_bills.map(renderRecurringRow)}
          </>
        )}
        {subscriptionAudit?.other_recurring.length > 0 && (
          <>
            <Text style={styles.recurringGroupHeader}>Other recurring charges</Text>
            {subscriptionAudit.other_recurring.map(renderRecurringRow)}
          </>
        )}
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}
