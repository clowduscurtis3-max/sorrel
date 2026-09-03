import { StyleSheet } from 'react-native';

// Phase 38 Step 3 (Home card colors) - shared by both the Home tab (applies
// the color) and settings/home.js (live preview while picking one).
// Standard WCAG relative-luminance formula, not a full contrast-ratio
// check against the specific text size/weight - a "basic contrast check"
// per the brief, not a full accessibility audit. Returns null for
// anything that isn't a clean 6-digit hex, so callers can tell "no valid
// color" apart from a real light/dark answer.
export function isValidHexColor(hexColor) {
  return typeof hexColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(hexColor);
}

function relativeLuminance(hexColor) {
  const hex = hexColor.slice(1);
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// WCAG contrast ratio: (lighter + 0.05) / (darker + 0.05).
function contrastRatio(luminanceA, luminanceB) {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

// Fixed by code review, 2026-09-02: this used to pick colors.darkest vs.
// colors.background by a flat 0.5 luminance threshold on the background
// color alone. The real crossover - the luminance where colors.darkest and
// colors.background give equal contrast against a given background - works
// out to ≈0.21 for this app's actual palette (colors.darkest is very dark,
// luminance ≈0.02; colors.background is very light, ≈0.92), nowhere near
// 0.5. A mid-brightness color like #B0B0B0 (luminance ≈0.435) used to get
// light text (≈2:1 contrast, barely readable) when dark text would have
// given ≈7:1 - directly undermining the "basic contrast check" this
// function exists for. Computing both real contrast ratios and picking
// whichever is actually higher is correct by construction and needs no
// hand-derived threshold at all.
export function readableTextColor(hexColor, colors) {
  if (!isValidHexColor(hexColor)) return null;
  const bgLuminance = relativeLuminance(hexColor);
  const contrastWithDark = contrastRatio(bgLuminance, relativeLuminance(colors.darkest));
  const contrastWithLight = contrastRatio(bgLuminance, relativeLuminance(colors.background));
  return contrastWithDark >= contrastWithLight ? colors.darkest : colors.background;
}

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
  // Translucent placeholder text color (Budget-tab Sorrel restyle,
  // 2026-08-20) - found on-device: TextInput's platform-default
  // placeholder color was unreadable against the restyle's light card
  // background, close enough to white to be effectively invisible.
  // Bumped 0.35 -> 0.7 (2026-09-01), still a dark-green tint - swapped to
  // a true neutral grey the same day per direct user request ("translucent
  // grey, but not too translucent - clear enough to read easily but still
  // be able to tell its not text in the box"), ~3.7:1 contrast against the
  // card color, clearly lighter than real text (colors.darkest) without
  // being unreadable.
  placeholder: 'rgba(100, 100, 100, 0.8)',
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
  // Added for the Budget-tab Sorrel restyle (2026-08-20). `card` is the
  // rounded/filled section pattern the mockup uses throughout but that
  // didn't exist anywhere in this app before this pass (every prior
  // section here is a flat hairline row or a left-border accent, never a
  // filled rounded box) - new, not a reuse of an existing key.
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.darkest,
  },
  // Pill button replacing native <Button> within the affordability flow
  // only (see PrimaryButton.js) - this app's other screens keep using
  // plain <Button> deliberately, not refactored as part of this pass.
  primaryButton: {
    backgroundColor: colors.darkest,
    borderRadius: 28,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryButtonDisabled: {
    backgroundColor: colors.sage,
  },
  primaryButtonText: {
    color: colors.background,
    fontSize: 15,
    fontWeight: '600',
  },
  // Chat-bubble pair, originally added for AffordabilityQuery's own single
  // query/clarification exchange (see pendingContext) - since reused
  // unchanged by AffordabilityChat.js for a real, growing back-and-forth
  // (the "AI-narrated responses + conversation memory" follow-up), so this
  // is no longer "the one turn this flow keeps," just the shared bubble
  // look both screens draw from.
  chatBubbleAssistant: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderTopLeftRadius: 4,
    padding: 12,
    maxWidth: '85%',
    alignSelf: 'flex-start',
  },
  chatBubbleAssistantText: {
    color: colors.darkest,
    fontSize: 14,
  },
  chatBubbleUser: {
    backgroundColor: colors.darkest,
    borderRadius: 16,
    borderTopRightRadius: 4,
    padding: 12,
    maxWidth: '85%',
    alignSelf: 'flex-end',
  },
  chatBubbleUserText: {
    color: colors.background,
    fontSize: 14,
  },
  // Comparison table on the "Add payment vs. wait" screen - deliberately
  // only 2 rows are ever rendered here (Discretionary spending, Goal
  // progress), see that screen's own build notes for why the mockup's
  // other 3 rows were dropped rather than styled.
  comparisonTableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.sage,
  },
  comparisonTableLabel: {
    fontSize: 13,
    color: colors.dark,
    flexShrink: 1,
    paddingRight: 8,
  },
  comparisonTableValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
  },
});
