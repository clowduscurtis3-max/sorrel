import { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  AppState,
  StyleSheet,
  Switch,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { MaterialIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import {
  apiFetch,
  apiErrorMessage,
  GOAL_TYPES,
  parseDollarAmount,
  formatDecimal,
  formatWhole,
  logRecommendationEvent,
} from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';
import { useAppData } from '../_lib/appData';
import { useGoalForm, computeTargetDateFromTimeframe } from '../_components/GoalForm';
import { formatAmountLabel } from '../_lib/amountPicker';
import { AppBackdrop, TopEdgeFade, isNightBackdrop } from '../_components/Illustrations';
import SorrelWordmark from '../_components/SorrelWordmark';
import PrimaryButton from '../_components/PrimaryButton';

// Edit Goal redesign (2026-08-27) - per-goal-type icon (reusing the same
// icon-circle visual language already established by targetIconCircle/
// insightIconCircle below) and a short descriptive tagline. The tagline is
// plain product-voice UI copy (same category as "Turn your goals into
// progress." just below it in the existing Primary Goal card) - never a
// financial figure, so it's fine as static per-type text rather than
// something that needs to come from goal data.
// Collapsed to just debt/savings 2026-09-01 (was: house/debt/general/
// other, before that also emergency_fund) - see server/index.js's own
// GOAL_TYPES comment for the full "why". 'savings' covers every non-debt
// goal now; what it's actually for comes from the always-visible `notes`
// field via goalDisplayName() below, not a per-type label.
const GOAL_TYPE_ICON = {
  debt: 'money-off',
  savings: 'savings',
};
const GOAL_TYPE_TAGLINE = {
  debt: 'One step closer to being debt-free.',
  savings: 'One deposit at a time.',
};

// Phase 25 ("Can I afford to buy a house?", 2026-08-31): the same 51
// codes server/stateHousingCosts.js has real reference data for - kept in
// sync by hand (no shared module between client/server in this project),
// so an edit to one must be mirrored in the other.
const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
  ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
  ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

// Plain-language read of the back-end DTI tier (server/homeAffordability.js's
// classifyBackEndDti) - explicitly a general guideline, never a lending
// decision, matching this app's "advisor, not accountant documents" voice
// (explains, doesn't announce) and standing caution against false
// precision on anything this app can't actually verify (real approval
// depends on credit/compensating factors this app has no visibility into).
const DTI_TIER_COPY = {
  comfortable: 'comfortably within typical lending guidelines',
  workable: 'within typical lending guidelines, on the higher side',
  tight: 'tight against typical lending guidelines',
  over_typical_guidelines: 'above typical lending guidelines for this loan amount',
};

// The goal's own display name - `notes` (the always-visible "what's this
// for?" field, since the goal_type collapse 2026-09-01) whenever the user
// has typed one, falling back to the generic per-type GOAL_TYPES label
// only when they haven't.
function goalDisplayName(goalType, notes) {
  if (notes) return notes;
  return GOAL_TYPES.find((g) => g.value === goalType)?.label || 'Your goal';
}

// Status badge for the Primary Goal card - derived entirely from
// goalProgress's own already-computed fields (saved_amount/target_amount/
// on_pace), never a new judgment call of its own. on_pace is always one of
// null/true/false whenever has_target is true (server/goalProgress.js's
// computeGoalProgress always sets it in that branch), so this covers every
// case that can reach it.
function goalStatusBadge(goalProgress) {
  if (goalProgress.saved_amount >= goalProgress.target_amount) {
    return { label: 'Goal reached', color: colors.positive };
  }
  if (goalProgress.on_pace === true) return { label: 'On track', color: colors.positive };
  if (goalProgress.on_pace === false) return { label: 'Behind pace', color: colors.warning };
  return { label: 'Not started yet', color: colors.muted };
}

// "4y 0m" style, from the projections.months_remaining float the backend
// returns (server/goalProgress.js's computeGoalProjections) - formatting
// only, no math of its own beyond splitting months into years+months.
function formatTimeRemaining(monthsRemaining) {
  const totalMonths = Math.round(monthsRemaining);
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  return `${years}y ${months}m`;
}

// Honest per-reason copy for the estimate's explicit refusal states
// (server/emergencyFund.js's estimateEssentialMonthlyExpenses never
// returns a number it isn't confident in - these are the reasons it
// declined, not error states to hide from the user).
function emergencyEstimateRefusalMessage(estimate) {
  if (estimate.insufficient_history) {
    return `Not enough transaction history yet to estimate a recommended emergency fund (${estimate.monthsOfHistory} of at least 2 months needed).`;
  }
  if (estimate.non_positive_essential_spend) {
    return "Can't estimate a recommended emergency fund from essential spending right now — recent numbers don't look reliable yet.";
  }
  if (estimate.uncategorized_ratio_too_high) {
    return 'Too much recent spending is still uncategorized to estimate a recommended emergency fund reliably.';
  }
  return null;
}

function formatTargetDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// One line per Savings Planner checkpoint (server/scenario.js's
// computeGoalMilestones - each milestone is a projectAffordableDate
// result, so it carries the exact same status vocabulary that function
// already uses).
function describeMilestoneStatus(milestone) {
  if (milestone.status === 'already_affordable') return 'Already reached';
  if (milestone.status === 'projected') return `Projected: ${formatTargetDate(milestone.projected_date)}`;
  return milestone.detail || 'Not enough data yet';
}

// Phase 30 (Advisor Tips, 2026-08-25): a small, deterministic rules list
// evaluated against real already-fetched data (goalProgress/subscriptionAudit/
// budgetStatus, all already in AppDataProvider - no new fetch), same
// pattern as homeSummary.js's computeInsight - never an LLM call, per this
// project's own no-fabricated-financial-content discipline. Returns the
// single most relevant real tip, ordered most-specific/actionable first;
// each condition is checked against real data, never shown when its
// condition isn't actually true. The Goal Insight pill above already shows
// goalProgress.message verbatim, so rules here deliberately favor genuinely
// NEW information (a detected price jump, an over-budget category, a
// concrete next step) over restating what that pill already says - "behind
// pace" here points at the Goal Calculator rather than repeating the pace
// sentence, and "on pace"/"goal reached" are ranked last since the Insight
// pill already covers that ground.
function computeGoalAdvisorTip({ goalProgress, subscriptionAudit, budgetStatus }) {
  if (!goalProgress) return null;

  if (!goalProgress.has_target) {
    return {
      icon: 'flag',
      text: 'Setting a specific target and timeframe turns this into real, trackable progress - tap Edit Goal to add one.',
    };
  }

  if (goalProgress.saved_amount >= goalProgress.target_amount) {
    return { icon: 'celebration', text: 'This goal has been reached.' };
  }

  const priceJump = subscriptionAudit?.price_jumps?.[0];
  if (priceJump) {
    return {
      icon: 'trending-up',
      text: `A price increase was detected on ${priceJump.display_name} (+$${formatDecimal(priceJump.increase_amount)}) - canceling or renegotiating that could free up real money toward this goal.`,
    };
  }

  const overBudgetCategory = (budgetStatus?.status || []).find(
    (s) => s.remaining != null && s.remaining < 0
  );
  if (overBudgetCategory) {
    return {
      icon: 'trending-down',
      text: `Spending in ${overBudgetCategory.category} is running over budget this period - reeling that in would help this goal move faster.`,
    };
  }

  if (goalProgress.on_pace === false) {
    return {
      icon: 'calculate',
      text: 'This goal is currently behind pace for its target date - the Goal Calculator above can show what monthly amount would get it back on track.',
    };
  }

  if (goalProgress.on_pace === null && goalProgress.saved_amount <= 0) {
    return {
      icon: 'savings',
      text: 'Nothing has been saved toward this goal yet - even a small recurring contribution starts real progress.',
    };
  }

  if (goalProgress.on_pace === true) {
    return {
      icon: 'trending-up',
      text: 'This goal is on pace for its target date - staying consistent is what keeps it there.',
    };
  }

  return null;
}

// Phase 7 Step 1 sub-step 1.6: the real Goal tab, replacing the placeholder.
// `goalProgress` comes from AppDataProvider (same shared state Home's short
// progress line already reads) - this tab shows the fuller detail behind
// that one line. Editing reuses the same GoalForm as goal-intake.js
// (see _components/GoalForm.js) rather than a second copy of the same
// fields/save logic - toggled inline (same pattern as Budget tab's
// per-category edit), not a navigation to a separate screen, since a goal
// always exists by the time this tab is even reachable (the root layout's
// gate requires one).
//
// Visual restyle (2026-08-24, design-references/goal-tab-mockup-2026-08-24.png):
// scoped to the read-only Overview branch only, per the user's own explicit
// walk-through-each-feature decision - Goal Projections (the deadline-
// driven Monthly Savings Needed/Target Date/Time Remaining row) is real,
// built against a new backend field (goalProgress.projections, additive -
// see server/goalProgress.js's computeGoalProjections). The mockup's Goal
// Planning Tools row (Calculator/Savings Planner/Emergency Fund), Advisor
// Tips carousel, and Savings Shortcuts (Round-Ups/Auto-Save/etc.) are all
// explicitly deferred - each bundles either a real scoped tool or an
// entirely new backend concept that doesn't exist yet, not visual styling
// over existing data. The editing branch below is untouched as of this
// note (GoalFormFields is shared with goal-intake.js, out of this pass's
// scope) - **superseded 2026-08-27 by the Edit Goal redesign**, which
// replaced the editing branch with its own tap-to-reveal rows built
// directly against `form`, no longer sharing GoalFormFields at all. See
// that section's own header comment below for the current, accurate
// picture - kept here unedited as a historical note, not corrected in
// place.
export default function Goal() {
  const { goal, refetchGoal } = useSessionContext();
  const { goalProgress, refetchGoalProgress, subscriptionAudit, budgetStatus, accounts } = useAppData();
  const [editing, setEditing] = useState(false);
  const form = useGoalForm(goal, {
    onSaved: () => {
      setEditing(false);
      resetGoalDependentTools();
    },
    onGoalProgressChanged: refetchGoalProgress,
  });

  // Edit Goal redesign (2026-08-27): which settings row (if any) currently
  // has its editor expanded inline below it - 'amount' | 'date' | 'type' |
  // null. Only one at a time, same "focused interaction, not inline
  // clutter" reasoning as the mockup's own tap-to-reveal rows, replacing
  // the old always-visible type-button wall + wheel + date picker all
  // shown at once regardless of what the user actually came here to
  // change.
  const [activeEditor, setActiveEditor] = useState(null);

  // Real bug found on-device (2026-08-31): backgrounding the app while the
  // inline "Target date" editor was open (the native Android DateTimePicker
  // dialog showing) left `activeEditor` as 'date' across the background/
  // foreground cycle - plain component state, untouched by the app merely
  // being backgrounded. On resume, Android's own FragmentManager restores
  // the DateTimePicker's DialogFragment on top of whatever re-render this
  // screen's foreground-refresh triggers; each dismissal just re-triggered
  // the still-`'date'`-declared row to render the picker again, an
  // effectively endless reopen loop the user could only escape by force-
  // closing the app. `activeEditor`/`'amount'`/`'type'` don't own a native
  // OS dialog the same way and aren't known to have this problem, but
  // closing whichever inline editor is open on backgrounding is the
  // correct general rule regardless - nothing in this screen's own state
  // should assume it survives a real background period unexamined.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState.match(/inactive|background/)) {
        setActiveEditor(null);
      }
    });
    return () => subscription.remove();
  }, []);

  // "See how I calculated this" - a plain expand/collapse over numbers
  // already in goalProgress/goalProgress.projections, not a second
  // calculation or a fetch of its own.
  const [showCalculationDetail, setShowCalculationDetail] = useState(false);

  // Voice input for the inline "Target amount" editor row above (2026-08-27,
  // direct user request - replaced NumberScrollWheel here too, same reason
  // as GoalForm.js's own swap: "the wheel picker seems to be too much
  // trouble than it's actually worth"). This screen builds its own tap-to-
  // reveal rows rather than rendering GoalFormFields (see this component's
  // own header comment), so it needs its own recorder instance - same
  // record -> transcribe -> land-in-the-field flow as the Goal Calculator's
  // amount field further down this file, kept separate rather than shared
  // since the two rows can be open independently.
  const editAmountRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const editAmountRecorderState = useAudioRecorderState(editAmountRecorder);
  const [editAmountTranscribing, setEditAmountTranscribing] = useState(false);
  const [editAmountVoiceError, setEditAmountVoiceError] = useState(null);

  async function startEditAmountRecording() {
    setEditAmountVoiceError(null);
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      setEditAmountVoiceError('Microphone access is needed to speak the amount.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await editAmountRecorder.prepareToRecordAsync();
    editAmountRecorder.record();
  }

  async function stopEditAmountRecordingAndTranscribe() {
    await editAmountRecorder.stop();
    if (!editAmountRecorder.uri) {
      setEditAmountVoiceError("That recording didn't come through - try again or type it.");
      return;
    }
    setEditAmountTranscribing(true);
    setEditAmountVoiceError(null);
    try {
      const fileResponse = await fetch(editAmountRecorder.uri);
      const blob = await fileResponse.blob();
      const res = await apiFetch('/affordability/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/m4a' },
        body: blob,
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { text: transcribed } = await res.json();
      form.setGoalAmount(transcribed || '');
    } catch (err) {
      console.error(err);
      setEditAmountVoiceError(
        err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : "Couldn't transcribe that - try again or type it."
      );
    } finally {
      setEditAmountTranscribing(false);
    }
  }

  function onEditAmountMicPress() {
    if (editAmountRecorderState.isRecording) {
      stopEditAmountRecordingAndTranscribe();
    } else {
      startEditAmountRecording();
    }
  }

  // Own scroll tracking for the editing screen's ScrollView (separate from
  // the read-only Overview's own scrollY below) - same AppBackdrop
  // parallax + TopEdgeFade pattern every other screen in this app already
  // uses, so this redesigned screen doesn't look or behave like a one-off.
  const editScrollY = useSharedValue(0);
  const onEditScroll = useAnimatedScrollHandler((event) => {
    editScrollY.value = event.contentOffset.y;
  });

  function closeEditorAnd(fn) {
    setActiveEditor(null);
    fn();
  }

  // Real note on scope: this app's goal model is one goal per user
  // (upsert-only; no DELETE /goal route exists, and the root layout's own
  // gate requires a goal to exist before (tabs) is even reachable - see
  // this file's own header note and _layout.js). "Delete Goal" therefore
  // can't mean removing the row outright without breaking that invariant
  // - it reuses the exact same reset-to-general path goal-intake.js's own
  // "Skip" already exercises (useGoalForm's skip()), which is the smallest
  // correct interpretation of "delete this specific goal" this schema
  // actually supports, not a new backend route.
  function confirmDeleteGoal() {
    Alert.alert(
      'Delete this goal?',
      'This removes your specific goal and target, and returns to a general "smarter spending" focus - it does not affect your linked accounts or transaction history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete Goal', style: 'destructive', onPress: form.skip },
      ]
    );
  }

  // Emergency fund (2026-09-01, redesigned per direct user request): its
  // own independent, always-available tracker (GET/POST /emergency-fund,
  // server/emergencyFund.js) rather than one of several primary
  // goal_types competing for the app's single goal slot - see that
  // server module's own header for the full "why". Fetched locally (not
  // via AppDataProvider's shared context) since only this screen needs
  // it, same reasoning showMilestones/calculatorResult already fetch
  // locally rather than being globally shared.
  const [emergencyFundStatus, setEmergencyFundStatus] = useState(null);
  const [emergencyFundError, setEmergencyFundError] = useState(null);
  const [efEditing, setEfEditing] = useState(false);
  const [efSelectedAccountIds, setEfSelectedAccountIds] = useState([]);
  const [efTargetText, setEfTargetText] = useState('');
  // Tracks whether the current efTargetText came from tapping a suggested
  // 3mo/6mo amount, not typed by hand - cleared the moment the user edits
  // the field afterward. Only used to decide whether a successful save
  // logs a real recommendation-accepted event (Phase 33) - typing your
  // own number isn't "accepting a suggestion," even if it happens to
  // match one, so this tracks the actual interaction, not just the
  // resulting value.
  const [efUsedSuggestedAmount, setEfUsedSuggestedAmount] = useState(null);
  const [savingEmergencyFund, setSavingEmergencyFund] = useState(false);

  async function fetchEmergencyFundStatus() {
    try {
      const res = await apiFetch('/emergency-fund');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { status } = await res.json();
      setEmergencyFundStatus(status);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    fetchEmergencyFundStatus();
  }, []);

  // Opens the settings panel seeded from whatever's already saved (or a
  // sensible empty state for first-time setup) - never starts from a
  // blank slate if the user is just coming back to adjust an existing
  // configuration.
  function openEmergencyFundEditor() {
    setEfSelectedAccountIds(emergencyFundStatus?.account_ids || []);
    setEfTargetText(
      emergencyFundStatus?.target_amount ? String(emergencyFundStatus.target_amount) : ''
    );
    setEfUsedSuggestedAmount(null);
    setEmergencyFundError(null);
    setEfEditing(true);
  }

  function toggleEfAccount(accountId) {
    setEfUsedSuggestedAmount(null);
    setEfSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    );
  }

  function applySuggestedTarget(amount) {
    setEfTargetText(String(amount));
    setEfUsedSuggestedAmount(amount);
  }

  async function saveEmergencyFundConfig({ enabled, targetAmount, accountIds }) {
    setSavingEmergencyFund(true);
    setEmergencyFundError(null);
    try {
      const res = await apiFetch('/emergency-fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, target_amount: targetAmount, account_ids: accountIds }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { status } = await res.json();
      setEmergencyFundStatus(status);
      return true;
    } catch (err) {
      console.error(err);
      setEmergencyFundError(apiErrorMessage(err));
      return false;
    } finally {
      setSavingEmergencyFund(false);
    }
  }

  // Quick on/off from the card header - preserves whatever's already
  // configured exactly as-is (a pause, not a reset), so turning it back
  // on later doesn't need re-entering accounts/target. Turning ON with
  // nothing meaningfully configured yet opens the setup editor instead,
  // since there's nothing real to enable.
  function handleEmergencyFundToggle(nextEnabled) {
    const hasRealConfig =
      (emergencyFundStatus?.account_ids?.length || 0) > 0 && emergencyFundStatus?.target_amount;
    if (nextEnabled && !hasRealConfig) {
      openEmergencyFundEditor();
      return;
    }
    saveEmergencyFundConfig({
      enabled: nextEnabled,
      targetAmount: emergencyFundStatus?.target_amount ?? null,
      accountIds: emergencyFundStatus?.account_ids ?? [],
    });
  }

  async function submitEmergencyFundEditor() {
    const targetAmount = parseDollarAmount(efTargetText);
    if (efSelectedAccountIds.length === 0) {
      setEmergencyFundError('Choose at least one account.');
      return;
    }
    if (!targetAmount) {
      setEmergencyFundError('Enter a valid target amount, like $10,000.');
      return;
    }
    const ok = await saveEmergencyFundConfig({
      enabled: true,
      targetAmount,
      accountIds: efSelectedAccountIds,
    });
    if (ok) {
      // Only a real "accepted this suggestion" signal when the saved
      // amount is still exactly the one they tapped, unedited since -
      // see efUsedSuggestedAmount's own comment above.
      if (efUsedSuggestedAmount === targetAmount) {
        logRecommendationEvent('emergency_fund_target', 'accepted', { target_amount: targetAmount });
      }
      setEfEditing(false);
    }
  }

  // Phase 27 (Goal Calculator, 2026-08-25): "what date would this
  // hypothetical monthly amount reach my goal" - the complementary
  // direction to the Goal Projections card above (which answers "what
  // pace do I need for my target date"), scoped narrowly per the phase
  // brief's own resolved open question so the two don't become two ways
  // to ask the same thing. Calls POST /goal/calculator (server/scenario.js's
  // calculateGoalPace) rather than duplicating projectFinishDate's formula
  // client-side a third time.
  const [showCalculator, setShowCalculator] = useState(false);
  const [calculatorAmountText, setCalculatorAmountText] = useState('');
  const [calculatorResult, setCalculatorResult] = useState(null);
  const [calculatingGoal, setCalculatingGoal] = useState(false);
  const [calculatorError, setCalculatorError] = useState(null);

  // Voice input for the Calculator's amount field (2026-08-25) - same
  // record -> transcribe -> land-in-the-text-field flow AffordabilityQuery.js
  // already uses for "Can I afford this?", reused here rather than a second
  // implementation. Never submits on its own.
  const calculatorRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const calculatorRecorderState = useAudioRecorderState(calculatorRecorder);
  const [calculatorTranscribing, setCalculatorTranscribing] = useState(false);
  const [calculatorVoiceError, setCalculatorVoiceError] = useState(null);

  async function startCalculatorRecording() {
    setCalculatorVoiceError(null);
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      setCalculatorVoiceError('Microphone access is needed to speak the amount.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await calculatorRecorder.prepareToRecordAsync();
    calculatorRecorder.record();
  }

  async function stopCalculatorRecordingAndTranscribe() {
    await calculatorRecorder.stop();
    if (!calculatorRecorder.uri) {
      setCalculatorVoiceError("That recording didn't come through - try again or type it.");
      return;
    }
    setCalculatorTranscribing(true);
    setCalculatorVoiceError(null);
    try {
      const fileResponse = await fetch(calculatorRecorder.uri);
      const blob = await fileResponse.blob();
      const res = await apiFetch('/affordability/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/m4a' },
        body: blob,
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { text: transcribed } = await res.json();
      setCalculatorAmountText(transcribed || '');
    } catch (err) {
      console.error(err);
      setCalculatorVoiceError(
        err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : "Couldn't transcribe that - try again or type it."
      );
    } finally {
      setCalculatorTranscribing(false);
    }
  }

  function onCalculatorMicPress() {
    if (calculatorRecorderState.isRecording) {
      stopCalculatorRecordingAndTranscribe();
    } else {
      startCalculatorRecording();
    }
  }

  async function runGoalCalculator() {
    const amount = parseDollarAmount(calculatorAmountText);
    if (!amount) {
      setCalculatorError('Enter a valid monthly amount, like $200.');
      return;
    }
    setCalculatingGoal(true);
    setCalculatorError(null);
    setCalculatorResult(null);
    try {
      const res = await apiFetch('/goal/calculator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hypothetical_monthly_amount: amount }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setCalculatorResult(data.result);
    } catch (err) {
      console.error(err);
      setCalculatorError(apiErrorMessage(err));
    } finally {
      setCalculatingGoal(false);
    }
  }

  // Phase 25 ("Can I afford to buy a house?", 2026-08-31): its own card in
  // this same Planning Tools row, matching the Calculator/Savings Planner/
  // Emergency Fund cards' established toggle-then-fetch pattern - not a
  // 6th tab, not folded into the "Can I afford this?" chat, per the phase
  // brief's own explicit scoping. All the real math (mortgage P&I,
  // state-sourced property tax/insurance, PMI, DTI against real detected
  // debt) already lives server-side (server/homeAffordability.js); this is
  // a thin client for it. No voice input for the two dollar fields here
  // (unlike the Calculator/Goal-amount fields) - a deliberate first-pass
  // scoping call given how much this feature already carries, not an
  // oversight; can follow the same record->transcribe pattern later if
  // it's wanted.
  const [showHomeAffordability, setShowHomeAffordability] = useState(false);
  const [homePriceText, setHomePriceText] = useState('');
  const [downPaymentText, setDownPaymentText] = useState('');
  const [homeState, setHomeState] = useState('');
  const [homeAffordabilityResult, setHomeAffordabilityResult] = useState(null);
  const [calculatingHomeAffordability, setCalculatingHomeAffordability] = useState(false);
  const [homeAffordabilityError, setHomeAffordabilityError] = useState(null);

  async function runHomeAffordability() {
    const homePrice = parseDollarAmount(homePriceText);
    if (!homePrice) {
      setHomeAffordabilityError('Enter a valid home price, like $350,000.');
      return;
    }
    // parseDollarAmount rejects 0 (treats it as "not a real amount," same
    // as every other dollar field in this app) - a literal $0 down
    // payment isn't supported in this first pass, a known simplification,
    // not an oversight.
    const downPayment = parseDollarAmount(downPaymentText);
    if (!downPayment) {
      setHomeAffordabilityError('Enter a valid down payment, like $35,000.');
      return;
    }
    if (downPayment >= homePrice) {
      setHomeAffordabilityError('Down payment must be less than the home price.');
      return;
    }
    if (!homeState) {
      setHomeAffordabilityError('Choose a state.');
      return;
    }
    setCalculatingHomeAffordability(true);
    setHomeAffordabilityError(null);
    setHomeAffordabilityResult(null);
    try {
      const res = await apiFetch('/home-affordability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ home_price: homePrice, down_payment: downPayment, state: homeState }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setHomeAffordabilityResult(data.result);
    } catch (err) {
      console.error(err);
      setHomeAffordabilityError(apiErrorMessage(err));
    } finally {
      setCalculatingHomeAffordability(false);
    }
  }

  // Phase 28 (Savings Planner v1, 2026-08-25): computed checkpoints (25/50/
  // 75/100% of the real target), fetched lazily on first expand rather than
  // eagerly on every tab visit - same toggle-then-fetch pattern as the Goal
  // Calculator card above, since GET /goal/milestones costs a handful of DB
  // reads (no Claude call) but isn't something worth fetching unasked.
  const [showMilestones, setShowMilestones] = useState(false);
  const [milestonesResult, setMilestonesResult] = useState(null);
  const [loadingMilestones, setLoadingMilestones] = useState(false);
  const [milestonesError, setMilestonesError] = useState(null);

  async function fetchMilestones() {
    setLoadingMilestones(true);
    setMilestonesError(null);
    try {
      const res = await apiFetch('/goal/milestones');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setMilestonesResult(data.result);
    } catch (err) {
      console.error(err);
      setMilestonesError(apiErrorMessage(err));
    } finally {
      setLoadingMilestones(false);
    }
  }

  function openMilestones() {
    setShowMilestones(true);
    if (!milestonesResult) fetchMilestones();
  }

  // Real bug found by /code-review (2026-08-25): the Goal Calculator's
  // projected date and the Savings Planner's checkpoints are both computed
  // server-side against the goal's CURRENT target_amount at the moment
  // they're requested - neither is invalidated when the goal itself
  // changes. Without this, editing the target (or switching the goal to
  // Emergency Fund, which also changes target_amount) would leave stale
  // numbers on screen computed against the old target, with no visual
  // indication and no way to force a refresh short of a full remount -
  // exactly the kind of stale-financial-fact this app's guardrails
  // elsewhere are careful to avoid. Collapses both panels back to their
  // "not yet computed" state rather than just clearing the number, so a
  // stale result can never render even for an instant before a refetch.
  function resetGoalDependentTools() {
    setShowCalculator(false);
    setCalculatorResult(null);
    setCalculatorError(null);
    setShowMilestones(false);
    setMilestonesResult(null);
    setMilestonesError(null);
  }

  // Phase 31 (Round-Ups v1, 2026-08-25): simulation/tracking only - this
  // app has no real money-movement capability (see server/roundUps.js's
  // own header), so this shows what round-ups WOULD add up to from real
  // transaction data. The copy below is deliberately framed as "see how
  // much this could add up to," never implying anything is actually being
  // set aside automatically - a real, user-facing honesty requirement per
  // the phase brief, not a wording preference.
  const [showRoundUps, setShowRoundUps] = useState(false);
  const [roundUpsResult, setRoundUpsResult] = useState(null);
  const [loadingRoundUps, setLoadingRoundUps] = useState(false);
  const [roundUpsError, setRoundUpsError] = useState(null);

  async function fetchRoundUps() {
    setLoadingRoundUps(true);
    setRoundUpsError(null);
    try {
      const res = await apiFetch('/goal/round-ups');
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setRoundUpsResult(data.result);
    } catch (err) {
      console.error(err);
      setRoundUpsError(apiErrorMessage(err));
    } finally {
      setLoadingRoundUps(false);
    }
  }

  function openRoundUps() {
    setShowRoundUps(true);
    if (!roundUpsResult) fetchRoundUps();
  }

  // Kept for the Overview branch's Animated.ScrollView onScroll handler -
  // no longer drives the backdrop itself (AppBackdrop is a static
  // full-screen layer, not scroll-parallaxed), but still needed to
  // satisfy Animated.ScrollView's own onScroll wiring below.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  // Text/icons rendered directly on top of AppBackdrop (not inside an
  // opaque card) need to switch to a light color during the night
  // backdrop - colors.darkest reads fine on the light morning/afternoon/
  // evening tints but is unreadable on night's dark tint.
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  // Real bug found by adversarial review, 2026-08-13: Cancel used to only
  // toggle `editing` back to false, leaving any discarded edits sitting in
  // `form`'s state (this component instance, and therefore `form`, stays
  // alive for the whole session - see GoalForm.js's reset() comment for
  // the full failure scenario).
  function cancelEditing() {
    form.reset();
    setActiveEditor(null);
    setShowCalculationDetail(false);
    setEditing(false);
  }

  // Derived, display-only values for the redesigned editing screen -
  // pending/uncommitted (`form.*`) vs. persisted (`goalProgress`) is kept
  // deliberately distinct throughout this render: the Goal Summary/Settings
  // rows reflect what the user is *currently editing* (form state, same as
  // today's GoalFormFields already does), while Progress/Sorrel's Take
  // reflect the *saved* goal (goalProgress, server-computed) - showing
  // pending, unsaved numbers there would be fabricating a projection
  // against a goal that was never actually persisted.
  const editGoalIcon = GOAL_TYPE_ICON[form.goalType] || 'flag';
  const editGoalName = goalDisplayName(form.goalType, form.goalNotes);
  const editGoalTagline = GOAL_TYPE_TAGLINE[form.goalType] || 'Your own goal, your own pace.';
  const editTargetDate = computeTargetDateFromTimeframe(form.goalTimeframe);
  const editTargetDateLabel = editTargetDate
    ? editTargetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'No target date set';
  const editAmountLabel = form.goalAmount ? formatAmountLabel(form.goalAmount) : 'No target amount set';
  const editGoalTypeLabel = GOAL_TYPES.find((g) => g.value === form.goalType)?.label || 'Goal type';
  const tomorrow = new Date(Date.now() + 86400000);

  return (
    <View style={styles.container}>
      {editing ? (
        // Edit Goal redesign (2026-08-27, design-references - see the user's
        // own mockup for this exact screen). Replaces the old always-
        // visible button wall (GoalFormFields rendered directly) with a
        // scrolling, card-based screen matching the rest of this app's
        // Sorrel visual language - reuses useGoalForm's state/save/skip
        // logic completely unchanged, only the presentation around it is
        // new. GoalFormFields itself is untouched and still used as-is by
        // goal-intake.js's first-run flow - this screen builds its own
        // tap-to-reveal rows directly against the same `form` object
        // instead, since the two screens' layouts diverged too far for one
        // shared middle-section component to serve both well (documented
        // in that file's own header comment).
        <>
          <View style={goalStyles.backgroundLayer} pointerEvents="none">
            <AppBackdrop scrollY={editScrollY} />
          </View>

          <View style={goalStyles.editHeaderRow}>
            <Pressable
              style={goalStyles.backButton}
              onPress={cancelEditing}
              accessibilityRole="button"
              accessibilityLabel="Back, discard unsaved changes"
            >
              <MaterialIcons
                name="arrow-back"
                size={26}
                color={night ? colors.background : colors.darkest}
              />
            </Pressable>
            <View style={goalStyles.editHeaderTextCol}>
              <Text style={[goalStyles.editHeaderTitle, night && { color: colors.background }]}>
                Edit Goal
              </Text>
              <Text
                style={[goalStyles.editHeaderSubtitle, night && { color: 'rgba(244, 246, 242, 0.75)' }]}
              >
                Make changes to your goal.
              </Text>
            </View>
            <View style={{ width: 40 }} />
          </View>

          <TopEdgeFade height={90}>
          <Animated.ScrollView
            style={goalStyles.editingScroll}
            // 150 (the default every other tab uses) wasn't enough here -
            // this screen's content (a couple of short cards) is close
            // enough to viewport height that there's little natural
            // overflow to scroll through, so the Save Changes/Delete Goal
            // buttons at the very end stayed pinned behind the floating tab
            // bar even at max scroll (real, user-reported 2026-08-28). 350
            // overshot the other direction (confirmed on-device: a large
            // blank gap between Delete Goal and the tab bar at max scroll) -
            // 260 matches Budget's own ScrollView, which needed more than
            // the 150 default for the same reason and was already tuned
            // against a real device.
            contentContainerStyle={{ paddingBottom: 260 }}
            onScroll={onEditScroll}
            scrollEventThrottle={16}
          >
            {/* Goal Summary - informational only, no button here (the old
                screen's giant "SAVE FOR A HOUSE"-style buttons lived in the
                type picker below instead, also since replaced). */}
            <View style={[styles.card, goalStyles.cardMargin]}>
              <View style={goalStyles.summaryRow}>
                <View style={goalStyles.summaryIconCircle}>
                  <MaterialIcons name={editGoalIcon} size={28} color={colors.dark} />
                </View>
                <View style={goalStyles.summaryTextCol}>
                  <Text style={goalStyles.cardEyebrow}>YOUR GOAL</Text>
                  <Text style={goalStyles.summaryName}>{editGoalName}</Text>
                  <Text style={goalStyles.summaryTagline}>{editGoalTagline}</Text>
                </View>
              </View>
            </View>

            {/* Goal Settings - one unified card, three tap-to-reveal rows
                instead of the old permanently-visible type-button wall +
                wheel + date picker + two "CLEAR" buttons all shown at once. */}
            <View style={[styles.card, goalStyles.cardMargin, goalStyles.settingsCard]}>
              <Pressable
                style={goalStyles.settingsRow}
                onPress={() => setActiveEditor(activeEditor === 'amount' ? null : 'amount')}
                accessibilityRole="button"
                accessibilityLabel={`Target amount: ${editAmountLabel}`}
              >
                <View style={goalStyles.settingsIconCircle}>
                  <MaterialIcons name="attach-money" size={18} color={colors.dark} />
                </View>
                <View style={goalStyles.settingsRowText}>
                  <Text style={goalStyles.settingsRowLabel}>Target amount</Text>
                  <Text style={goalStyles.settingsRowValue}>{editAmountLabel}</Text>
                </View>
                <MaterialIcons
                  name={activeEditor === 'amount' ? 'expand-less' : 'chevron-right'}
                  size={22}
                  color={colors.muted}
                />
              </Pressable>
              {activeEditor === 'amount' && (
                <View style={goalStyles.inlineEditor}>
                  <View style={goalStyles.calculatorInputRow}>
                    <TextInput
                      style={[styles.input, goalStyles.calculatorInput]}
                      value={form.goalAmount}
                      onChangeText={form.setGoalAmount}
                      placeholder="e.g. $10,000"
                      placeholderTextColor={colors.placeholder}
                      keyboardType="numeric"
                      editable={!editAmountTranscribing && !editAmountRecorderState.isRecording}
                    />
                    {editAmountTranscribing ? (
                      <ActivityIndicator style={goalStyles.calculatorMicButton} />
                    ) : (
                      <Pressable
                        onPress={onEditAmountMicPress}
                        accessibilityRole="button"
                        accessibilityLabel={
                          editAmountRecorderState.isRecording ? 'Stop recording' : 'Speak the amount'
                        }
                        style={[
                          goalStyles.calculatorMicButton,
                          editAmountRecorderState.isRecording
                            ? goalStyles.calculatorMicButtonRecording
                            : goalStyles.calculatorMicButtonIdle,
                        ]}
                      >
                        <MaterialIcons
                          name={editAmountRecorderState.isRecording ? 'stop' : 'mic'}
                          size={20}
                          color={colors.background}
                        />
                      </Pressable>
                    )}
                  </View>
                  {editAmountVoiceError && (
                    <Text style={styles.errorText}>{editAmountVoiceError}</Text>
                  )}
                  <View style={goalStyles.inlineEditorActions}>
                    {!!form.goalAmount && (
                      <Pressable
                        onPress={() => form.setGoalAmount('')}
                        accessibilityRole="button"
                        accessibilityLabel="Clear target amount"
                      >
                        <Text style={goalStyles.inlineEditorLink}>Clear amount</Text>
                      </Pressable>
                    )}
                    <Pressable onPress={() => setActiveEditor(null)} accessibilityRole="button">
                      <Text style={goalStyles.inlineEditorLinkDone}>Done</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              <View style={goalStyles.settingsDivider} />

              <Pressable
                style={goalStyles.settingsRow}
                onPress={() => setActiveEditor(activeEditor === 'date' ? null : 'date')}
                accessibilityRole="button"
                accessibilityLabel={`Target date: ${editTargetDateLabel}`}
              >
                <View style={[goalStyles.settingsIconCircle, goalStyles.settingsIconCircleWarm]}>
                  <MaterialIcons name="event" size={18} color={colors.warningText} />
                </View>
                <View style={goalStyles.settingsRowText}>
                  <Text style={goalStyles.settingsRowLabel}>Target date</Text>
                  <Text style={goalStyles.settingsRowValue}>{editTargetDateLabel}</Text>
                </View>
                <MaterialIcons
                  name={activeEditor === 'date' ? 'expand-less' : 'chevron-right'}
                  size={22}
                  color={colors.muted}
                />
              </Pressable>
              {activeEditor === 'date' && (
                <View style={goalStyles.inlineEditor}>
                  <DateTimePicker
                    value={editTargetDate ?? tomorrow}
                    mode="date"
                    minimumDate={tomorrow}
                    onChange={(event, selectedDate) => {
                      if (event.type === 'dismissed' || !selectedDate) return;
                      const months = Math.max(
                        1,
                        Math.round((selectedDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44))
                      );
                      form.setGoalTimeframe(String(months));
                    }}
                  />
                  <View style={goalStyles.inlineEditorActions}>
                    {!!editTargetDate && (
                      <Pressable
                        onPress={() => form.setGoalTimeframe('')}
                        accessibilityRole="button"
                        accessibilityLabel="Remove target date"
                      >
                        <Text style={goalStyles.inlineEditorLink}>Remove date</Text>
                      </Pressable>
                    )}
                    <Pressable onPress={() => setActiveEditor(null)} accessibilityRole="button">
                      <Text style={goalStyles.inlineEditorLinkDone}>Done</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              <View style={goalStyles.settingsDivider} />

              <Pressable
                style={goalStyles.settingsRow}
                onPress={() => setActiveEditor(activeEditor === 'type' ? null : 'type')}
                accessibilityRole="button"
                accessibilityLabel={`Goal type: ${editGoalTypeLabel}`}
              >
                <View style={goalStyles.settingsIconCircle}>
                  <MaterialIcons name="track-changes" size={18} color={colors.dark} />
                </View>
                <View style={goalStyles.settingsRowText}>
                  <Text style={goalStyles.settingsRowLabel}>Goal type</Text>
                  <Text style={goalStyles.settingsRowValue}>{editGoalTypeLabel}</Text>
                </View>
                <MaterialIcons
                  name={activeEditor === 'type' ? 'expand-less' : 'chevron-right'}
                  size={22}
                  color={colors.muted}
                />
              </Pressable>
              {activeEditor === 'type' && (
                <View style={goalStyles.inlineEditor}>
                  {GOAL_TYPES.map((g) => {
                    const selected = form.goalType === g.value;
                    return (
                      <Pressable
                        key={g.value}
                        style={[goalStyles.typeOptionCard, selected && goalStyles.typeOptionCardSelected]}
                        onPress={() => form.setGoalType(g.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        accessibilityLabel={g.label}
                      >
                        <View
                          style={[
                            goalStyles.settingsIconCircle,
                            selected && goalStyles.settingsIconCircleSelected,
                          ]}
                        >
                          <MaterialIcons
                            name={GOAL_TYPE_ICON[g.value] || 'flag'}
                            size={18}
                            color={selected ? colors.card : colors.dark}
                          />
                        </View>
                        <View style={goalStyles.typeOptionTextGroup}>
                          <Text style={goalStyles.typeOptionTitle}>{g.label}</Text>
                          {!!GOAL_TYPE_TAGLINE[g.value] && (
                            <Text style={goalStyles.typeOptionSubtitle}>{GOAL_TYPE_TAGLINE[g.value]}</Text>
                          )}
                        </View>
                        <MaterialIcons
                          name={selected ? 'check-circle' : 'radio-button-unchecked'}
                          size={20}
                          color={selected ? colors.primary : colors.muted}
                        />
                      </Pressable>
                    );
                  })}
                  {/* Always shown, not gated behind a specific type
                      (2026-09-01) - this is what actually names the goal
                      (see goalDisplayName above), whether it's debt or
                      savings, so it shouldn't be hidden behind a menu
                      choice. */}
                  <Text style={goalStyles.settingsRowLabel}>What's this for? (optional)</Text>
                  <TextInput
                    style={[styles.input, goalStyles.notesInput]}
                    placeholder="e.g. a house, a wedding, the Chase card"
                    placeholderTextColor={colors.placeholder}
                    value={form.goalNotes}
                    onChangeText={form.setGoalNotes}
                  />
                  <View style={goalStyles.inlineEditorActions}>
                    <Pressable onPress={() => setActiveEditor(null)} accessibilityRole="button">
                      <Text style={goalStyles.inlineEditorLinkDone}>Done</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>

            {/* Progress - the *saved* goal's real progress (goalProgress,
                same canonical server calculation the read-only Overview
                below already uses), not the pending form edits above -
                gracefully adapts rather than fabricating a number when
                there's no target on the saved goal yet. */}
            <View style={[styles.card, goalStyles.cardMargin]}>
              <View style={goalStyles.progressHeaderRow}>
                <Text style={goalStyles.cardEyebrow}>YOUR PROGRESS</Text>
                <MaterialIcons name="auto-awesome" size={16} color={colors.dark} />
              </View>
              {!goalProgress ? (
                <Text style={styles.smallText}>Loading…</Text>
              ) : !goalProgress.has_target ? (
                <Text style={styles.smallText}>
                  Set a target amount to start tracking progress toward this goal.
                </Text>
              ) : (
                (() => {
                  const percent = Math.min(100, Math.max(0, goalProgress.percent_complete));
                  const remaining = Math.max(0, goalProgress.target_amount - goalProgress.saved_amount);
                  return (
                    <>
                      <View style={goalStyles.progressValuesRow}>
                        <View>
                          <Text style={goalStyles.progressBigValue}>
                            ${formatDecimal(goalProgress.saved_amount)}
                          </Text>
                          <Text style={styles.smallText}>saved so far</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={[goalStyles.progressBigValue, { color: colors.primary }]}>
                            {Math.round(percent)}%
                          </Text>
                          <Text style={styles.smallText}>of your goal</Text>
                        </View>
                      </View>
                      <View style={goalStyles.progressTrack}>
                        <View style={[goalStyles.progressFill, { width: `${percent}%` }]} />
                      </View>
                      <Text style={[styles.smallText, { marginTop: 8 }]}>
                        ${formatDecimal(remaining)} to go
                      </Text>
                    </>
                  );
                })()
              )}
            </View>

            {/* Sorrel's Take - reuses goalProgress.projections verbatim
                (server/goalProgress.js's computeGoalProjections, already
                built and already shown on the read-only Overview) - no new
                calculation. "See how I calculated this" is a plain expand
                over numbers already in hand, not a second fetch/estimate. */}
            {goalProgress?.projections && (
              <View style={[styles.card, goalStyles.cardMargin, goalStyles.insightCard]}>
                <View style={goalStyles.insightIconCircle}>
                  <MaterialIcons name="auto-awesome" size={18} color={colors.dark} />
                </View>
                <View style={goalStyles.insightBody}>
                  <Text style={goalStyles.cardEyebrow}>SORREL'S TAKE</Text>
                  <Text style={goalStyles.insightText}>
                    {goalProgress.projections.deadline_passed
                      ? `Your target date of ${formatTargetDate(goalProgress.projections.target_date)} has passed - you'd still need about $${formatWhole(goalProgress.projections.monthly_savings_needed)} per month to reach this goal.`
                      : `To reach your goal by ${formatTargetDate(goalProgress.projections.target_date)}, you'll need to save about $${formatWhole(goalProgress.projections.monthly_savings_needed)} per month.`}
                  </Text>
                  <Pressable
                    onPress={() => setShowCalculationDetail((s) => !s)}
                    accessibilityRole="button"
                  >
                    <Text style={goalStyles.inlineEditorLink}>
                      {showCalculationDetail ? 'Hide calculation' : 'See how I calculated this'}
                      {'  '}
                      <MaterialIcons
                        name={showCalculationDetail ? 'expand-less' : 'chevron-right'}
                        size={14}
                      />
                    </Text>
                  </Pressable>
                  {showCalculationDetail && (
                    <View style={goalStyles.calculationDetail}>
                      <Text style={styles.smallText}>
                        Target amount: ${formatDecimal(goalProgress.target_amount)}
                      </Text>
                      <Text style={styles.smallText}>
                        Saved so far: ${formatDecimal(goalProgress.saved_amount)}
                      </Text>
                      <Text style={styles.smallText}>
                        Remaining: $
                        {formatDecimal(Math.max(0, goalProgress.target_amount - goalProgress.saved_amount))}
                      </Text>
                      <Text style={styles.smallText}>
                        Time remaining: {formatTimeRemaining(goalProgress.projections.months_remaining)}
                      </Text>
                      <Text style={styles.smallText}>
                        Remaining ÷ time remaining = about $
                        {formatWhole(goalProgress.projections.monthly_savings_needed)}/month
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {form.error && (
              <Text style={[styles.errorText, goalStyles.cardMargin]}>{form.error}</Text>
            )}

            <View style={goalStyles.cardMargin}>
              <PrimaryButton title="Save Changes" onPress={form.save} loading={form.saving} />
            </View>

            <Pressable
              style={[goalStyles.deleteGoalButton, goalStyles.cardMargin]}
              onPress={confirmDeleteGoal}
              disabled={form.saving}
              accessibilityRole="button"
              accessibilityLabel="Delete goal"
            >
              <MaterialIcons name="delete-outline" size={18} color={colors.error} />
              <Text style={goalStyles.deleteGoalButtonText}>Delete Goal</Text>
            </Pressable>
          </Animated.ScrollView>
          </TopEdgeFade>
        </>
      ) : (
        <>
          <View style={goalStyles.backgroundLayer} pointerEvents="none">
            <AppBackdrop scrollY={scrollY} />
          </View>

          <View style={goalStyles.wordmarkStrip}>
            <SorrelWordmark layout="row" leafSize={30} showTagline={false} textColor={onBackdropTextColor} />
            <MaterialIcons name="notifications-none" size={26} color={onBackdropTextColor || colors.darkest} />
          </View>

          <TopEdgeFade height={90}>
          <Animated.ScrollView
            style={[styles.list, goalStyles.transparentScroll]}
            contentContainerStyle={{ paddingBottom: 150 }}
            onScroll={onScroll}
            scrollEventThrottle={16}
          >
            <View style={goalStyles.titleBlock}>
              <Text style={[goalStyles.title, onBackdropTextColor && { color: onBackdropTextColor }]}>
                Your Goals
              </Text>
              <Text
                style={[goalStyles.subtitle, night && { color: 'rgba(244, 246, 242, 0.75)' }]}
              >
                Build the future you want.
              </Text>
            </View>

            {!goalProgress ? (
              <Text style={[styles.smallText, goalStyles.cardMargin]}>
                Loading goal progress…
              </Text>
            ) : goalProgress.has_target ? (
              <>
                {(() => {
                  const badge = goalStatusBadge(goalProgress);
                  const percent = Math.min(100, Math.max(0, goalProgress.percent_complete));
                  return (
                    <View style={[styles.card, goalStyles.cardMargin]}>
                      <View style={goalStyles.primaryGoalHeaderRow}>
                        <View style={goalStyles.targetIconCircle}>
                          <MaterialIcons name="track-changes" size={20} color={colors.dark} />
                        </View>
                        <View style={goalStyles.primaryGoalHeaderText}>
                          <Text style={goalStyles.primaryGoalEyebrow}>Primary Goal</Text>
                          <Text style={goalStyles.primaryGoalTarget}>
                            ${formatDecimal(goalProgress.target_amount)} Target
                          </Text>
                        </View>
                        <View style={[goalStyles.badge, { backgroundColor: badge.color }]}>
                          <Text style={goalStyles.badgeText}>{badge.label}</Text>
                        </View>
                      </View>

                      <Text style={goalStyles.primaryGoalTagline}>
                        Turn your goals into progress.
                      </Text>

                      <View style={goalStyles.savedRow}>
                        <Text style={goalStyles.savedAmount}>
                          ${formatDecimal(goalProgress.saved_amount)} saved
                        </Text>
                        <Text style={goalStyles.savedPercent}>{Math.round(percent)}%</Text>
                      </View>
                      <View style={goalStyles.progressTrack}>
                        <View style={[goalStyles.progressFill, { width: `${percent}%` }]} />
                      </View>

                      <View style={goalStyles.editGoalSpacing}>
                        <PrimaryButton title="EDIT GOAL" onPress={() => setEditing(true)} />
                      </View>
                    </View>
                  );
                })()}

                <View style={[styles.card, goalStyles.cardMargin, goalStyles.insightCard]}>
                  <View style={goalStyles.insightIconCircle}>
                    <MaterialIcons name="auto-awesome" size={18} color={colors.dark} />
                  </View>
                  <View style={goalStyles.insightBody}>
                    <Text style={goalStyles.cardEyebrow}>GOAL INSIGHT</Text>
                    <Text style={goalStyles.insightText}>{goalProgress.message}</Text>
                  </View>
                </View>

                {goalProgress.projections && (
                  <View style={[styles.card, goalStyles.cardMargin]}>
                    <View style={goalStyles.projectionsHeaderRow}>
                      <MaterialIcons name="show-chart" size={18} color={colors.dark} />
                      <Text style={goalStyles.cardTitle}>Goal Projections</Text>
                    </View>
                    <View style={goalStyles.projectionsRow}>
                      <View style={goalStyles.projectionTile}>
                        <Text style={goalStyles.projectionLabel}>
                          {goalProgress.projections.deadline_passed
                            ? 'STILL NEEDED'
                            : 'MONTHLY SAVINGS NEEDED'}
                        </Text>
                        <Text style={goalStyles.projectionValue}>
                          ${formatWhole(goalProgress.projections.monthly_savings_needed)}
                        </Text>
                      </View>
                      <View style={goalStyles.projectionDivider} />
                      <View style={goalStyles.projectionTile}>
                        <Text style={goalStyles.projectionLabel}>TARGET DATE</Text>
                        <Text style={goalStyles.projectionValue}>
                          {formatTargetDate(goalProgress.projections.target_date)}
                        </Text>
                      </View>
                      <View style={goalStyles.projectionDivider} />
                      <View style={goalStyles.projectionTile}>
                        <Text style={goalStyles.projectionLabel}>TIME REMAINING</Text>
                        <Text style={goalStyles.projectionValue}>
                          {goalProgress.projections.deadline_passed
                            ? 'Passed'
                            : formatTimeRemaining(goalProgress.projections.months_remaining)}
                        </Text>
                      </View>
                    </View>
                  </View>
                )}

                <View style={[styles.card, goalStyles.cardMargin]}>
                  <View style={goalStyles.projectionsHeaderRow}>
                    <MaterialIcons name="calculate" size={18} color={colors.dark} />
                    <Text style={goalStyles.cardTitle}>Goal Calculator</Text>
                  </View>
                  {!showCalculator ? (
                    <Pressable
                      style={[goalStyles.estimateOutlineButton, goalStyles.estimateSpacing]}
                      onPress={() => setShowCalculator(true)}
                      accessibilityRole="button"
                    >
                      <Text style={goalStyles.estimateOutlineButtonText}>
                        SEE HOW A MONTHLY AMOUNT REACHES YOUR GOAL FASTER
                      </Text>
                    </Pressable>
                  ) : (
                    <>
                      <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                        Type or speak a hypothetical monthly amount to see when it would reach your target.
                      </Text>
                      <View style={[goalStyles.calculatorInputRow, goalStyles.estimateSpacing]}>
                        <TextInput
                          style={[styles.input, goalStyles.calculatorInput]}
                          value={calculatorAmountText}
                          onChangeText={setCalculatorAmountText}
                          placeholder="e.g. $200"
                          placeholderTextColor={colors.placeholder}
                          keyboardType="numeric"
                          editable={!calculatingGoal && !calculatorTranscribing}
                        />
                        {calculatorTranscribing ? (
                          <ActivityIndicator style={goalStyles.calculatorMicButton} />
                        ) : (
                          <Pressable
                            onPress={onCalculatorMicPress}
                            disabled={calculatingGoal}
                            accessibilityRole="button"
                            accessibilityLabel={
                              calculatorRecorderState.isRecording ? 'Stop recording' : 'Speak the amount'
                            }
                            style={[
                              goalStyles.calculatorMicButton,
                              calculatorRecorderState.isRecording
                                ? goalStyles.calculatorMicButtonRecording
                                : goalStyles.calculatorMicButtonIdle,
                            ]}
                          >
                            <MaterialIcons
                              name={calculatorRecorderState.isRecording ? 'stop' : 'mic'}
                              size={20}
                              color={colors.background}
                            />
                          </Pressable>
                        )}
                      </View>
                      {calculatorVoiceError && (
                        <Text style={[styles.errorText, goalStyles.estimateSpacing]}>{calculatorVoiceError}</Text>
                      )}
                      {calculatorError && <Text style={styles.errorText}>{calculatorError}</Text>}
                      {calculatingGoal ? (
                        <ActivityIndicator style={goalStyles.estimateSpacing} />
                      ) : (
                        <View style={goalStyles.estimateSpacing}>
                          <PrimaryButton
                            title="SEE PROJECTED DATE"
                            onPress={runGoalCalculator}
                            disabled={calculatorTranscribing || calculatorRecorderState.isRecording}
                          />
                        </View>
                      )}

                      {calculatorResult && (
                        <View style={goalStyles.estimateSpacing}>
                          {calculatorResult.available && calculatorResult.status === 'already_reached' ? (
                            <Text style={styles.smallText}>
                              The target is already met by what's been saved - no monthly amount is
                              needed to reach it.
                            </Text>
                          ) : calculatorResult.available && calculatorResult.status === 'projected' ? (
                            <Text style={styles.smallText}>
                              At ${formatWhole(calculatorResult.hypothetical_monthly_amount)}/month, the
                              target would be reached around{' '}
                              {formatTargetDate(calculatorResult.projected_date)}.
                            </Text>
                          ) : (
                            <Text style={styles.smallText}>{calculatorResult.detail}</Text>
                          )}
                        </View>
                      )}
                    </>
                  )}
                </View>

                <View style={[styles.card, goalStyles.cardMargin]}>
                  <View style={goalStyles.projectionsHeaderRow}>
                    <MaterialIcons name="flag" size={18} color={colors.dark} />
                    <Text style={goalStyles.cardTitle}>Savings Planner</Text>
                  </View>
                  {!showMilestones ? (
                    <Pressable
                      style={[goalStyles.estimateOutlineButton, goalStyles.estimateSpacing]}
                      onPress={openMilestones}
                      accessibilityRole="button"
                    >
                      <Text style={goalStyles.estimateOutlineButtonText}>SEE CHECKPOINTS TOWARD YOUR GOAL</Text>
                    </Pressable>
                  ) : loadingMilestones ? (
                    <ActivityIndicator style={goalStyles.estimateSpacing} />
                  ) : milestonesError ? (
                    <Text style={[styles.errorText, goalStyles.estimateSpacing]}>{milestonesError}</Text>
                  ) : milestonesResult?.available ? (
                    <View style={goalStyles.estimateSpacing}>
                      {milestonesResult.milestones.map((milestone) => (
                        <View key={milestone.percent} style={goalStyles.milestoneRow}>
                          <Text style={goalStyles.milestoneLabel}>
                            {milestone.percent}% · ${formatWhole(milestone.amount)}
                          </Text>
                          <Text style={goalStyles.milestoneStatus}>
                            {describeMilestoneStatus(milestone)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                      {milestonesResult?.detail || 'Checkpoints are not available right now.'}
                    </Text>
                  )}
                </View>

                <View style={[styles.card, goalStyles.cardMargin]}>
                  <View style={goalStyles.projectionsHeaderRow}>
                    <MaterialIcons name="toll" size={18} color={colors.dark} />
                    <Text style={goalStyles.cardTitle}>Round-Ups</Text>
                  </View>
                  {!showRoundUps ? (
                    <Pressable
                      style={[goalStyles.estimateOutlineButton, goalStyles.estimateSpacing]}
                      onPress={openRoundUps}
                      accessibilityRole="button"
                    >
                      <Text style={goalStyles.estimateOutlineButtonText}>
                        SEE HOW MUCH ROUND-UPS COULD ADD UP TO
                      </Text>
                    </Pressable>
                  ) : loadingRoundUps ? (
                    <ActivityIndicator style={goalStyles.estimateSpacing} />
                  ) : roundUpsError ? (
                    <Text style={[styles.errorText, goalStyles.estimateSpacing]}>{roundUpsError}</Text>
                  ) : (
                    <View style={[goalStyles.estimateSpacing, goalStyles.wrappingTextBlock]}>
                      <Text style={[styles.smallText, goalStyles.wrappingText]}>
                        Rounding each of this period's {roundUpsResult?.transaction_count ?? 0}{' '}
                        purchase{roundUpsResult?.transaction_count === 1 ? '' : 's'} up to the next
                        dollar would have added up to{' '}
                        <Text style={goalStyles.inlineBold}>
                          ${formatDecimal(roundUpsResult?.total_round_ups ?? 0)}
                        </Text>
                        . This is an estimate only - nothing is actually being set aside
                        automatically.
                      </Text>
                    </View>
                  )}
                </View>
              </>
            ) : (
              <View style={[styles.card, goalStyles.cardMargin, goalStyles.insightCard]}>
                <View style={goalStyles.insightIconCircle}>
                  <MaterialIcons name="auto-awesome" size={18} color={colors.dark} />
                </View>
                <View style={goalStyles.insightBody}>
                  <Text style={goalStyles.cardEyebrow}>GOAL INSIGHT</Text>
                  <Text style={goalStyles.insightText}>{goalProgress.message}</Text>
                  <View style={goalStyles.editGoalSpacing}>
                    <PrimaryButton title="SET A TARGET" onPress={() => setEditing(true)} />
                  </View>
                </View>
              </View>
            )}

            {goalProgress &&
              (() => {
                const tip = computeGoalAdvisorTip({ goalProgress, subscriptionAudit, budgetStatus });
                if (!tip) return null;
                return (
                  <View style={[styles.card, goalStyles.cardMargin, goalStyles.insightCard]}>
                    <View style={goalStyles.insightIconCircle}>
                      <MaterialIcons name={tip.icon} size={18} color={colors.dark} />
                    </View>
                    <View style={goalStyles.insightBody}>
                      <Text style={goalStyles.cardEyebrow}>ADVISOR TIP</Text>
                      <Text style={goalStyles.insightText}>{tip.text}</Text>
                    </View>
                  </View>
                );
              })()}

            {(() => {
              const estimate = emergencyFundStatus?.essential_expense_estimate;
              const refusalMessage = estimate ? emergencyEstimateRefusalMessage(estimate) : null;
              const depositoryAccounts = (accounts?.accounts || []).filter(
                (a) => a.type === 'depository'
              );
              const isConfigured =
                emergencyFundStatus?.enabled &&
                emergencyFundStatus?.target_amount &&
                (emergencyFundStatus?.account_ids?.length || 0) > 0;

              return (
                <View style={[styles.card, goalStyles.cardMargin]}>
                  <View style={[goalStyles.projectionsHeaderRow, goalStyles.spaceBetweenRow]}>
                    <View style={goalStyles.projectionsHeaderRow}>
                      <MaterialIcons name="shield" size={18} color={colors.dark} />
                      <Text style={goalStyles.cardTitle}>Emergency Fund</Text>
                    </View>
                    {emergencyFundStatus && (
                      <Switch
                        value={!!emergencyFundStatus.enabled}
                        onValueChange={handleEmergencyFundToggle}
                        disabled={savingEmergencyFund}
                        trackColor={{ false: colors.sage, true: colors.primary }}
                      />
                    )}
                  </View>

                  {!emergencyFundStatus ? (
                    <Text style={[styles.smallText, goalStyles.estimateSpacing]}>Loading…</Text>
                  ) : efEditing ? (
                    <>
                      <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                        Choose which account(s) this tracks and a target amount - Sorrel will
                        track the real balance against it, the same way a budget category does.
                      </Text>

                      {depositoryAccounts.length === 0 ? (
                        <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                          No linked bank/savings accounts found yet.
                        </Text>
                      ) : (
                        <View style={goalStyles.estimateSpacing}>
                          {depositoryAccounts.map((a) => {
                            const selected = efSelectedAccountIds.includes(a.id);
                            const balance = a.available_balance ?? a.current_balance;
                            return (
                              <Pressable
                                key={a.id}
                                style={goalStyles.efAccountRow}
                                onPress={() => toggleEfAccount(a.id)}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: selected }}
                              >
                                <MaterialIcons
                                  name={selected ? 'check-box' : 'check-box-outline-blank'}
                                  size={20}
                                  color={selected ? colors.primary : colors.muted}
                                />
                                <View style={goalStyles.efAccountRowText}>
                                  <Text style={goalStyles.settingsRowLabel}>
                                    {a.name}
                                    {a.mask ? ` ····${a.mask}` : ''}
                                  </Text>
                                  <Text style={styles.smallText}>
                                    {a.institution_name ? `${a.institution_name} · ` : ''}
                                    {balance != null ? `$${formatDecimal(balance)}` : '—'}
                                  </Text>
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}

                      {estimate && !refusalMessage && (
                        <>
                          <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                            Based on ${formatWhole(estimate.averageMonthlyEssential)}/month in
                            essential spending ({estimate.monthsOfHistory} months of history), a
                            typical emergency fund covers 3-6 months of essential expenses.
                          </Text>
                          <View style={goalStyles.estimateButtonRow}>
                            <Pressable
                              style={goalStyles.estimateOutlineButton}
                              onPress={() =>
                                applySuggestedTarget(Math.round(estimate.averageMonthlyEssential * 3))
                              }
                              accessibilityRole="button"
                            >
                              <Text style={goalStyles.estimateOutlineButtonText}>
                                3 MONTHS (${Math.round(estimate.averageMonthlyEssential * 3)})
                              </Text>
                            </Pressable>
                            <Pressable
                              style={goalStyles.estimateOutlineButton}
                              onPress={() =>
                                applySuggestedTarget(Math.round(estimate.averageMonthlyEssential * 6))
                              }
                              accessibilityRole="button"
                            >
                              <Text style={goalStyles.estimateOutlineButtonText}>
                                6 MONTHS (${Math.round(estimate.averageMonthlyEssential * 6)})
                              </Text>
                            </Pressable>
                          </View>
                        </>
                      )}

                      <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                        Target amount
                      </Text>
                      <TextInput
                        style={styles.input}
                        value={efTargetText}
                        onChangeText={(text) => {
                          setEfTargetText(text);
                          setEfUsedSuggestedAmount(null);
                        }}
                        placeholder="e.g. $10,000"
                        placeholderTextColor={colors.placeholder}
                        keyboardType="numeric"
                      />

                      {emergencyFundError && (
                        <Text style={styles.errorText}>{emergencyFundError}</Text>
                      )}

                      {savingEmergencyFund ? (
                        <ActivityIndicator style={goalStyles.estimateSpacing} />
                      ) : (
                        <View style={goalStyles.estimateButtonRow}>
                          <PrimaryButton title="SAVE" onPress={submitEmergencyFundEditor} />
                          <Pressable
                            onPress={() => setEfEditing(false)}
                            accessibilityRole="button"
                          >
                            <Text style={goalStyles.textLink}>Cancel</Text>
                          </Pressable>
                        </View>
                      )}
                    </>
                  ) : isConfigured ? (
                    <>
                      <View style={goalStyles.progressTrack}>
                        <View
                          style={[
                            goalStyles.progressFill,
                            {
                              width: `${Math.min(
                                100,
                                Math.max(0, emergencyFundStatus.percent_complete || 0)
                              )}%`,
                            },
                          ]}
                        />
                      </View>
                      <Text style={styles.smallText}>
                        ${formatDecimal(emergencyFundStatus.current_amount)} of $
                        {formatDecimal(emergencyFundStatus.target_amount)} —{' '}
                        {Math.round(emergencyFundStatus.percent_complete)}%
                      </Text>
                      {emergencyFundStatus.missing_account_ids?.length > 0 && (
                        <Text style={[styles.errorText, goalStyles.estimateSpacing]}>
                          One or more tracked accounts are no longer linked - edit below to
                          update which accounts count toward this.
                        </Text>
                      )}
                      <Pressable
                        onPress={openEmergencyFundEditor}
                        accessibilityRole="button"
                        style={goalStyles.estimateSpacing}
                      >
                        <Text style={goalStyles.textLink}>Edit accounts or target</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                      Turn this on to track a dedicated safety-net balance across one or more of
                      your accounts, the same way a budget category is tracked - separate from
                      your primary goal above, not competing with it.
                    </Text>
                  )}
                </View>
              );
            })()}

            <View style={[styles.card, goalStyles.cardMargin]}>
              <View style={goalStyles.projectionsHeaderRow}>
                <MaterialIcons name="home" size={18} color={colors.dark} />
                <Text style={goalStyles.cardTitle}>Home Affordability</Text>
              </View>
              {!showHomeAffordability ? (
                <Pressable
                  style={[goalStyles.estimateOutlineButton, goalStyles.estimateSpacing]}
                  onPress={() => setShowHomeAffordability(true)}
                  accessibilityRole="button"
                >
                  <Text style={goalStyles.estimateOutlineButtonText}>
                    SEE IF YOU CAN AFFORD A HOME
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                    Enter a home price, down payment, and state to see an estimated monthly
                    cost and how it stacks up against your real income and debt.
                  </Text>
                  <TextInput
                    style={[styles.input, goalStyles.estimateSpacing]}
                    value={homePriceText}
                    onChangeText={setHomePriceText}
                    placeholder="Home price, e.g. $350,000"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="numeric"
                    editable={!calculatingHomeAffordability}
                  />
                  <TextInput
                    style={[styles.input, goalStyles.estimateSpacing]}
                    value={downPaymentText}
                    onChangeText={setDownPaymentText}
                    placeholder="Down payment, e.g. $35,000"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="numeric"
                    editable={!calculatingHomeAffordability}
                  />
                  <View style={[styles.picker, goalStyles.estimateSpacing]}>
                    <Picker
                      selectedValue={homeState}
                      onValueChange={setHomeState}
                      enabled={!calculatingHomeAffordability}
                    >
                      <Picker.Item label="Choose a state..." value="" />
                      {US_STATES.map(([code, name]) => (
                        <Picker.Item key={code} label={name} value={code} />
                      ))}
                    </Picker>
                  </View>
                  {homeAffordabilityError && (
                    <Text style={styles.errorText}>{homeAffordabilityError}</Text>
                  )}
                  {calculatingHomeAffordability ? (
                    <ActivityIndicator style={goalStyles.estimateSpacing} />
                  ) : (
                    <View style={goalStyles.estimateSpacing}>
                      <PrimaryButton title="ESTIMATE MONTHLY COST" onPress={runHomeAffordability} />
                    </View>
                  )}

                  {homeAffordabilityResult && (
                    <View style={goalStyles.estimateSpacing}>
                      <View style={styles.card}>
                        <Text style={styles.cardTitle}>Estimated monthly cost</Text>
                        <View style={styles.comparisonTableRow}>
                          <Text style={styles.comparisonTableLabel}>Loan amount</Text>
                          <Text style={styles.comparisonTableValue}>
                            ${formatDecimal(homeAffordabilityResult.loan_amount)}
                          </Text>
                        </View>
                        <View style={styles.comparisonTableRow}>
                          <Text style={styles.comparisonTableLabel}>Down payment</Text>
                          <Text style={styles.comparisonTableValue}>
                            {homeAffordabilityResult.down_payment_percent}%
                          </Text>
                        </View>
                        <View style={styles.comparisonTableRow}>
                          <Text style={styles.comparisonTableLabel}>Principal & interest</Text>
                          <Text style={styles.comparisonTableValue}>
                            ${formatDecimal(homeAffordabilityResult.monthly_principal_and_interest)}/mo
                          </Text>
                        </View>
                        {homeAffordabilityResult.has_state_cost_data && (
                          <>
                            <View style={styles.comparisonTableRow}>
                              <Text style={styles.comparisonTableLabel}>Property tax (est.)</Text>
                              <Text style={styles.comparisonTableValue}>
                                ${formatDecimal(homeAffordabilityResult.monthly_property_tax)}/mo
                              </Text>
                            </View>
                            <View style={styles.comparisonTableRow}>
                              <Text style={styles.comparisonTableLabel}>Home insurance (est.)</Text>
                              <Text style={styles.comparisonTableValue}>
                                ${formatDecimal(homeAffordabilityResult.monthly_insurance)}/mo
                              </Text>
                            </View>
                          </>
                        )}
                        {homeAffordabilityResult.pmi_applies && (
                          <View style={styles.comparisonTableRow}>
                            <Text style={styles.comparisonTableLabel}>PMI (est., under 20% down)</Text>
                            <Text style={styles.comparisonTableValue}>
                              ${formatDecimal(homeAffordabilityResult.monthly_pmi)}/mo
                            </Text>
                          </View>
                        )}
                        <View style={[styles.comparisonTableRow, { borderBottomWidth: 0 }]}>
                          <Text style={styles.comparisonTableLabel}>Total monthly housing cost</Text>
                          <Text style={styles.comparisonTableValue}>
                            {homeAffordabilityResult.total_monthly_housing_cost != null
                              ? `$${formatDecimal(homeAffordabilityResult.total_monthly_housing_cost)}/mo`
                              : 'Unavailable'}
                          </Text>
                        </View>
                      </View>

                      {homeAffordabilityResult.back_end_dti_tier ? (
                        <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                          {homeAffordabilityResult.back_end_dti_exceeds_display_cap
                            ? `Including this and your other recurring debt ($${formatDecimal(homeAffordabilityResult.existing_monthly_debt)}/month), your total monthly debt would come to well more than your detected income covers.`
                            : `Including this and your other recurring debt ($${formatDecimal(homeAffordabilityResult.existing_monthly_debt)}/month), your total monthly debt would be about ${homeAffordabilityResult.back_end_dti_percent}% of your income — ${DTI_TIER_COPY[homeAffordabilityResult.back_end_dti_tier]}.`}
                          {' '}This is a general guideline, not a lending decision — actual
                          approval depends on credit and other factors this app can't see.
                        </Text>
                      ) : (
                        <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                          Not enough income history is detected yet to estimate how this
                          would compare to your income.
                        </Text>
                      )}

                      {!homeAffordabilityResult.has_state_cost_data && (
                        <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                          Property tax and insurance estimates aren't available for this state
                          yet, so the total above only includes principal, interest
                          {homeAffordabilityResult.pmi_applies ? ', and PMI' : ''}.
                        </Text>
                      )}
                    </View>
                  )}
                </>
              )}
            </View>
          </Animated.ScrollView>
          </TopEdgeFade>
        </>
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const goalStyles = StyleSheet.create({
  backgroundLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  wordmarkStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
  },
  // Shared by both the Overview and Edit Goal ScrollViews - kept plain
  // (no paddingTop here). Overview's own first child (titleBlock, below)
  // already carries the standard paddingTop:110 fade-clearing padding;
  // adding it here too double-stacked it for Overview specifically (220px
  // instead of 110) when this was added to fix Edit Goal's own missing
  // padding - editingScroll (below) carries that fix instead, scoped to
  // just the screen that actually needed it.
  transparentScroll: {
    backgroundColor: 'transparent',
  },
  // Edit Goal's own ScrollView style (2026-08-27) - unlike Overview,
  // Edit Goal's first child (the Goal Summary card) has no paddingTop of
  // its own, so this is the one screen that genuinely needs it here
  // rather than on its first child.
  editingScroll: {
    flex: 1,
    backgroundColor: 'transparent',
    paddingTop: 110,
  },
  // --- Edit Goal redesign (2026-08-27) ---
  editHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    gap: 12,
  },
  // Plain arrow, no square/card background (2026-08-27, direct user
  // feedback: the rounded-square treatment this used to share with Home's
  // bank drill-down back button made the arrow itself hard to see - "its
  // almost invisible in the square"). Keeps the same 40x40 touch target
  // for a comfortable tap area, just transparent instead of card-colored.
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editHeaderTextCol: {
    flex: 1,
    alignItems: 'center',
  },
  editHeaderTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.darkest,
  },
  editHeaderSubtitle: {
    fontSize: 13,
    color: colors.dark,
    marginTop: 2,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  summaryIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryTextCol: {
    flex: 1,
    gap: 2,
  },
  summaryName: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.darkest,
  },
  summaryTagline: {
    fontSize: 13,
    color: colors.dark,
  },
  settingsCard: {
    paddingVertical: 4,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  settingsIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsIconCircleWarm: {
    backgroundColor: '#F3D9B8',
  },
  settingsRowText: {
    flex: 1,
    gap: 2,
  },
  settingsRowLabel: {
    fontSize: 12,
    color: colors.dark,
  },
  settingsRowValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.darkest,
  },
  settingsDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.sage,
  },
  inlineEditor: {
    paddingBottom: 12,
    gap: 8,
  },
  inlineEditorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
    paddingTop: 4,
  },
  inlineEditorLink: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.error,
    textDecorationLine: 'underline',
  },
  inlineEditorLinkDone: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  typeOptionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  typeOptionCardSelected: {
    backgroundColor: colors.background,
    borderColor: colors.sage,
  },
  typeOptionTextGroup: {
    flex: 1,
    gap: 2,
  },
  typeOptionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.darkest,
  },
  typeOptionSubtitle: {
    fontSize: 12,
    color: colors.muted,
  },
  settingsIconCircleSelected: {
    backgroundColor: colors.primary,
  },
  notesInput: {
    marginTop: 4,
  },
  progressHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  progressValuesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  progressBigValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.darkest,
  },
  calculationDetail: {
    marginTop: 8,
    gap: 2,
  },
  deleteGoalButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.error,
    borderRadius: 22,
    paddingVertical: 12,
  },
  deleteGoalButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.error,
  },
  titleBlock: {
    paddingHorizontal: 24,
    // Pushed down past TopEdgeFade's 90px fade zone (Illustrations.js) -
    // otherwise the title sat inside that zone even at rest (scroll
    // position 0), reading as "already faded before scrolling" instead of
    // only fading once actually scrolled up into it.
    paddingTop: 110,
    paddingBottom: 24,
    gap: 4,
  },
  // fontSize 26, matching Budget's and Recurring's own page title exactly
  // (found via a cross-tab consistency pass, 2026-08-31) - this was 22,
  // the one tab whose title read visibly smaller than its two siblings.
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.darkest,
  },
  subtitle: {
    fontSize: 13,
    color: colors.dark,
  },
  cardMargin: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  primaryGoalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  targetIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryGoalHeaderText: {
    flex: 1,
    gap: 2,
  },
  primaryGoalEyebrow: {
    fontSize: 12,
    color: colors.dark,
  },
  primaryGoalTarget: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.darkest,
  },
  badge: {
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.background,
  },
  primaryGoalTagline: {
    fontSize: 13,
    color: colors.dark,
    marginTop: 8,
  },
  savedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 14,
  },
  savedAmount: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.darkest,
  },
  savedPercent: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.darkest,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.sage,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.darkest,
  },
  editGoalSpacing: {
    marginTop: 16,
  },
  cardEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.dark,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.darkest,
  },
  insightCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  insightIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightBody: {
    flex: 1,
    gap: 4,
  },
  insightText: {
    fontSize: 15,
    color: colors.darkest,
  },
  projectionsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  // Emergency fund card (2026-09-01) - a plain header row plus a toggle
  // switch at the far end, reused wherever a card header needs a control
  // on the opposite side rather than just the icon+title.
  spaceBetweenRow: {
    justifyContent: 'space-between',
  },
  efAccountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  efAccountRowText: {
    flex: 1,
  },
  // Plain secondary link text - Cancel/Edit-style actions that aren't
  // destructive (inlineEditorLink above is styled for "Remove date"-style
  // destructive actions specifically, not a fit here).
  textLink: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.dark,
    textDecorationLine: 'underline',
  },
  projectionsRow: {
    flexDirection: 'row',
    marginTop: 8,
  },
  projectionTile: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  projectionDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.sage,
    marginHorizontal: 4,
  },
  projectionLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  projectionValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.darkest,
    textAlign: 'center',
  },
  estimateSpacing: {
    marginTop: 8,
  },
  estimateButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  estimateOutlineButton: {
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
  estimateOutlineButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  milestoneRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sage,
  },
  milestoneLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.darkest,
    flexShrink: 0,
  },
  // Real bug found on-device (2026-08-25): a long status string (e.g.
  // "Not enough observed saving history yet to project a rate.") had no
  // flex/width constraint in this row, so it rendered at its own full
  // intrinsic width and ran off the right edge of the screen instead of
  // wrapping. `flex: 1` claims the remaining row width after the label so
  // it has somewhere bounded to wrap into; `textAlign: 'right'` keeps the
  // original visual alignment for the short "on track" cases.
  milestoneStatus: {
    fontSize: 12,
    color: colors.dark,
    flex: 1,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 12,
  },
  inlineBold: {
    fontWeight: '700',
    color: colors.darkest,
  },
  // Goal Calculator's text + voice input (2026-08-25) - same visual
  // pattern as AffordabilityQuery.js's own input row, sized for a card
  // rather than the full-width query bar.
  calculatorInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  calculatorInput: {
    flex: 1,
  },
  calculatorMicButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calculatorMicButtonIdle: {
    backgroundColor: colors.primary,
  },
  calculatorMicButtonRecording: {
    backgroundColor: colors.error,
  },
  // Defensive wrap fix for the Round-Ups paragraph (2026-08-25, direct
  // user report - "the text ... is going off screen") - explicit width/
  // flexShrink so this long, nested-bold-Text paragraph can't render at
  // an unconstrained intrinsic width regardless of what's above it in the
  // tree; alongside the Savings Planner row fix above, which was the
  // other, structurally-confirmed source of the same symptom on this tab.
  wrappingTextBlock: {
    width: '100%',
  },
  wrappingText: {
    flexShrink: 1,
    alignSelf: 'stretch',
  },
});
