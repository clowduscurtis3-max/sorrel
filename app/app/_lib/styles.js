import { StyleSheet } from 'react-native';

// Sorrel brand palette (CLAUDE.md "Color palette" note, 2026-08-13) -
// dark-forest-green/sage/cream, light theme. Named by role so future
// screens import `colors` rather than re-typing hex values.
export const colors = {
  darkest: '#0F2B23',
  dark: '#1E4335',
  primary: '#2D6A4F',
  accent: '#6DAF8A',
  sage: '#A7CBB3',
  background: '#F4F6F2',
  card: '#EDECE7',
  // Semantic colors - not part of the 7-hex Sorrel brand palette above
  // (which has no warning/error/positive roles), so kept as their own
  // named group rather than forced into a brand hue that doesn't fit
  // their meaning. Values are the pre-existing hardcoded hex this app
  // already used for these purposes, just centralized here.
  warning: '#b8860b',
  warningText: '#7a5c00',
  error: '#b00020',
  positive: '#3a6b3a',
  reviewWarning: '#a06600',
  muted: '#666',
};

// Shared subset of the old app/App.js styles object, copied verbatim
// (Phase 7 Step 1 sub-step 1.2). Only the keys needed by sign-in.js/
// goal-intake.js/the current Home placeholder so far - later sub-steps
// (Budget/Recurring/Goal tabs) add more keys here as each screen migrates,
// rather than each route re-declaring its own copy.
export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
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
    borderColor: colors.sage,
    borderRadius: 4,
    padding: 8,
    fontSize: 15,
    color: colors.darkest,
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
    borderColor: colors.sage,
    borderRadius: 4,
    color: colors.darkest,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  text: {
    fontSize: 16,
    color: colors.darkest,
  },
  smallText: {
    fontSize: 13,
    color: colors.dark,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
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
    borderLeftColor: colors.warning,
    paddingLeft: 10,
    paddingVertical: 2,
    gap: 2,
  },
  alertText: {
    fontSize: 14,
    color: colors.warningText,
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
    backgroundColor: colors.card,
    color: colors.darkest,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.sage,
  },
  rowMain: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowName: {
    fontSize: 15,
    flexShrink: 1,
    paddingRight: 8,
    color: colors.darkest,
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.darkest,
  },
  recurringTag: {
    fontSize: 11,
    color: colors.positive,
    marginTop: 2,
  },
  reviewRow: {
    gap: 6,
    marginTop: 6,
    alignItems: 'flex-start',
  },
  reviewText: {
    fontSize: 12,
    color: colors.reviewWarning,
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
    borderBottomColor: colors.sage,
  },
  // Added for Recurring tab (sub-step 1.5) - ported verbatim from the old
  // app/App.js styles object. Distinguishes the three recurring-spend
  // groups (Subscriptions/Recurring bills/Other) within the same
  // scrolling tab.
  recurringGroupHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
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
  // Added for the account-menu modal (Phase 8 Step 3) - one block per
  // linked Plaid Item (institution name/status + its own Re-link/
  // Disconnect buttons), same plain-stacked-Button convention as every
  // other list in this app rather than a side-by-side row.
  plaidItemsSection: {
    gap: 12,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  plaidItemBlock: {
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.sage,
    paddingBottom: 10,
  },
});
