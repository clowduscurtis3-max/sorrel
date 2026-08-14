import { StyleSheet } from 'react-native';

// Shared subset of the old app/App.js styles object, copied verbatim
// (Phase 7 Step 1 sub-step 1.2). Only the keys needed by sign-in.js/
// goal-intake.js/the current Home placeholder so far - later sub-steps
// (Budget/Recurring/Goal tabs) add more keys here as each screen migrates,
// rather than each route re-declaring its own copy.
export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 60,
  },
  goalScreen: {
    flex: 1,
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 40,
    // Keeps Save goal (pinned to the bottom via a flex:1 spacer) clear of
    // the phone's gesture/button bar - found by the user on-device,
    // 2026-08-12. Scoped to goalScreen specifically (goal-intake.js's own
    // style, not the shared `container` above) after a second on-device
    // finding: `container` is also used by Home's SectionList, which
    // inherited this padding without needing it (nothing flush-to-bottom
    // there, just dead white space above the tab bar) - moved here rather
    // than left shared. A fixed value rather than
    // react-native-safe-area-context's insets (already an installed
    // dependency from Step 1.1) - no SafeAreaProvider is wired up anywhere
    // yet, and this was a quick on-device fix, not the moment to add one
    // untested. Revisit with real insets if this proves too much/little on
    // other devices.
    paddingBottom: 72,
  },
  goalTypeRow: {
    gap: 8,
  },
  // Cancel/Skip corner slots - one row, two ends. `justifyContent:
  // 'space-between'` plus two always-present child Views (one per corner)
  // means whichever one actually has a Button in it (they're mutually
  // exclusive - see goal-intake.js) lands on its own side without needing
  // conditional alignment styles; the empty slot is just a zero-size View.
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#999',
    borderRadius: 4,
    padding: 8,
    fontSize: 15,
  },
  // Without an explicit height, @react-native-picker/picker's Android
  // native view can render with zero measured height inside a flex/scroll
  // layout (confirmed on-device, ScenarioCheck.js's category dropdown) -
  // give it the same bordered-box look as `input` above so it's not just
  // invisible, functionally-zero-sized space. `color`/`backgroundColor`
  // are also explicit - the native Android Picker's closed-state text has
  // no color set by default and rendered effectively invisible against
  // this screen's white background (confirmed on-device).
  picker: {
    height: 50,
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#999',
    borderRadius: 4,
    color: '#000',
    backgroundColor: '#fff',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  text: {
    fontSize: 16,
  },
  smallText: {
    fontSize: 13,
    color: '#444',
    textAlign: 'center',
  },
  errorText: {
    fontSize: 14,
    color: '#b00020',
    textAlign: 'center',
  },
  // Added for Home tab (sub-step 1.3) - ported verbatim from the old
  // app/App.js styles object.
  header: {
    alignItems: 'center',
    gap: 8,
    paddingBottom: 16,
  },
  goalProgressSection: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  accountsSection: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 4,
  },
  alertsSection: {
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  alertRow: {
    borderLeftWidth: 3,
    borderLeftColor: '#b8860b',
    paddingLeft: 10,
    paddingVertical: 2,
    gap: 2,
  },
  alertText: {
    fontSize: 14,
    color: '#7a5c00',
  },
  errorBanner: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  list: {
    flex: 1,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: '#f2f2f2',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  rowMain: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowName: {
    fontSize: 15,
    flexShrink: 1,
    paddingRight: 8,
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '500',
  },
  recurringTag: {
    fontSize: 11,
    color: '#3a6b3a',
    marginTop: 2,
  },
  reviewRow: {
    gap: 6,
    marginTop: 6,
    alignItems: 'flex-start',
  },
  reviewText: {
    fontSize: 12,
    color: '#a06600',
  },
  categoryPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  // Added for Budget tab (sub-step 1.4). `budgetRow` is ported verbatim
  // from the old app/App.js styles object; `budgetScreen` is new - the old
  // app used a fixed `maxHeight: 280` scroll box (`budgetList`) because
  // budget status was one collapsible section sharing a screen with
  // several others. Now that Budget is its own dedicated tab, the whole
  // screen can just scroll instead of being capped at a small fixed
  // height.
  budgetScreen: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  budgetRow: {
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  // Added for Recurring tab (sub-step 1.5) - ported verbatim from the old
  // app/App.js styles object. Distinguishes the three recurring-spend
  // groups (Subscriptions/Recurring bills/Other) within the same
  // scrolling tab.
  recurringGroupHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginTop: 10,
    marginBottom: 2,
  },
  // Added for the account-menu modal (sub-step 1.7) - ported verbatim from
  // the old app/App.js styles object.
  gmailSection: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  // A flex:1 wrapper carrying the same 72px gesture-bar clearance as
  // goalScreen, for any screen that pins a final action to the true
  // bottom via a flex:1 spacer (account-menu's Sign out) without also
  // wanting goalScreen's goal-specific horizontal padding/top spacing.
  pinnedFooterScreen: {
    flex: 1,
    paddingBottom: 72,
  },
});
