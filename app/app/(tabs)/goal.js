import { useState } from 'react';
import { View, Text, Button, Pressable, TextInput, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { useSessionContext } from '../_lib/session';
import { useAppData } from '../_lib/appData';
import { useGoalForm, GoalFormFields } from '../_components/GoalForm';
import { AtmosphericHomeBackground, TopFadeMask } from '../_components/Illustrations';
import SorrelWordmark from '../_components/SorrelWordmark';
import PrimaryButton from '../_components/PrimaryButton';

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

// Goal Calculator's amount field is plain typed/voice-transcribed text
// (2026-08-25, direct user request - replaced the DigitAmountPicker
// wheel), so it needs its own light client-side parse before becoming the
// `hypothetical_monthly_amount` number POST /goal/calculator expects.
// Strips everything but digits/decimal point so "$200", "200 dollars", and
// "200" (typed or however Whisper transcribed it) all resolve the same
// way - no server-side guardrail is needed here the way the "Can I afford
// this?" flow needs one, since this is the user's own direct planning
// input, never narrated back as a claimed financial fact from an
// untrusted source.
function parseDollarAmount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
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
      text: `A price increase was detected on ${priceJump.display_name} (+$${priceJump.increase_amount.toFixed(2)}) - canceling or renegotiating that could free up real money toward this goal.`,
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
// over existing data. The editing branch below is untouched (GoalFormFields
// is shared with goal-intake.js, out of this pass's scope).
export default function Goal() {
  const { goal, refetchGoal } = useSessionContext();
  const { goalProgress, refetchGoalProgress, subscriptionAudit, budgetStatus } = useAppData();
  const [editing, setEditing] = useState(false);
  const form = useGoalForm(goal, {
    onSaved: () => {
      setEditing(false);
      resetGoalDependentTools();
    },
    onGoalProgressChanged: refetchGoalProgress,
  });

  // Phase 29 (Emergency Fund surfacing, 2026-08-25): "set target" writes
  // through the same POST /goal every other save already uses (an upsert
  // needing the full goal object, not a partial patch) - goal_type/
  // target_timeframe_months/notes are carried over unchanged from the
  // already-persisted `goal`, only target_amount changes. No new endpoint.
  const [settingEmergencyTarget, setSettingEmergencyTarget] = useState(false);
  const [emergencyTargetError, setEmergencyTargetError] = useState(null);

  async function applyEmergencyFundTarget(targetAmount) {
    setSettingEmergencyTarget(true);
    setEmergencyTargetError(null);
    try {
      const res = await apiFetch('/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_type: 'emergency_fund',
          target_amount: targetAmount,
          target_timeframe_months: goal?.target_timeframe_months ?? null,
          notes: goal?.notes ?? null,
        }),
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      await refetchGoal();
      await refetchGoalProgress();
      resetGoalDependentTools();
    } catch (err) {
      console.error(err);
      setEmergencyTargetError(apiErrorMessage(err));
    } finally {
      setSettingEmergencyTarget(false);
    }
  }

  // Switches the Primary Goal to Emergency Fund via the existing edit form
  // (form.setGoalType is already exposed by useGoalForm) rather than a
  // second goal-creation UI - per Phase 29's own resolved open question,
  // this schema only supports one goal at a time, so this is a real
  // overwrite of whatever goal was previously set, not a parallel one.
  function switchToEmergencyFundGoal() {
    form.setGoalType('emergency_fund');
    setEditing(true);
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

  // Same shared-background scroll wiring as Home/Account (Illustrations.js's
  // AtmosphericHomeBackground/TopFadeMask) - only the Overview branch's
  // ScrollView drives it; the editing branch is a plain non-scrolling View.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  // Real bug found by adversarial review, 2026-08-13: Cancel used to only
  // toggle `editing` back to false, leaving any discarded edits sitting in
  // `form`'s state (this component instance, and therefore `form`, stays
  // alive for the whole session - see GoalForm.js's reset() comment for
  // the full failure scenario).
  function cancelEditing() {
    form.reset();
    setEditing(false);
  }

  return (
    <View style={styles.container}>
      {editing ? (
        // Reuses goal-intake.js's exact bottom-pinning treatment
        // (`goalScreen`'s flex:1 spacer + baked-in 72px clearance from the
        // phone's gesture bar) rather than the plain stacked buttons a
        // ScrollView would give - per direct user feedback, 2026-08-12:
        // Cancel (and Save goal, paired with it) belongs down at the true
        // bottom of the screen here too, not wherever it happens to fall
        // after the form fields. A plain View instead of the ScrollView
        // used below, since the flex-spacer trick needs a fixed-height
        // flex container to push against, not a content-sized one.
        <View style={styles.goalScreen}>
          <GoalFormFields form={form} />
          <View style={{ flex: 1 }} />
          {form.saving ? (
            <ActivityIndicator />
          ) : (
            <>
              <Button title="Save goal" onPress={form.save} />
              <Button title="Cancel" onPress={cancelEditing} />
            </>
          )}
        </View>
      ) : (
        <>
          <View style={goalStyles.backgroundLayer} pointerEvents="none">
            <AtmosphericHomeBackground scrollY={scrollY} />
          </View>

          <View style={goalStyles.wordmarkStrip}>
            <SorrelWordmark layout="row" leafSize={30} showTagline={false} />
            <MaterialIcons name="notifications-none" size={26} color={colors.darkest} />
          </View>

          <Animated.ScrollView
            style={[styles.list, goalStyles.transparentScroll]}
            onScroll={onScroll}
            scrollEventThrottle={16}
          >
            <View style={goalStyles.titleBlock}>
              <Text style={goalStyles.title}>Your Goals</Text>
              <Text style={goalStyles.subtitle}>Build the future you want.</Text>
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
                            ${goalProgress.target_amount.toFixed(2)} Target
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
                          ${goalProgress.saved_amount.toFixed(2)} saved
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
                          ${goalProgress.projections.monthly_savings_needed.toFixed(0)}
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
                              At ${calculatorResult.hypothetical_monthly_amount.toFixed(0)}/month, the
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
                            {milestone.percent}% · ${milestone.amount.toFixed(0)}
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
                          ${(roundUpsResult?.total_round_ups ?? 0).toFixed(2)}
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

            {goalProgress && (goalProgress.goal_type === 'emergency_fund' ? (
              (() => {
                const estimate = goalProgress.essential_expense_estimate;
                const refusalMessage = estimate ? emergencyEstimateRefusalMessage(estimate) : null;
                return (
                  <View style={[styles.card, goalStyles.cardMargin]}>
                    <View style={goalStyles.projectionsHeaderRow}>
                      <MaterialIcons name="shield" size={18} color={colors.dark} />
                      <Text style={goalStyles.cardTitle}>Emergency Fund Estimate</Text>
                    </View>
                    {!estimate ? (
                      <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                        Loading estimate…
                      </Text>
                    ) : refusalMessage ? (
                      <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                        {refusalMessage}
                      </Text>
                    ) : (
                      <>
                        <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                          Based on ${estimate.averageMonthlyEssential.toFixed(0)}/month in
                          essential spending ({estimate.monthsOfHistory} months of history), a
                          typical emergency fund covers 3-6 months of essential expenses.
                        </Text>
                        {!goalProgress.has_target && (
                          <>
                            {emergencyTargetError && (
                              <Text style={styles.errorText}>{emergencyTargetError}</Text>
                            )}
                            {settingEmergencyTarget ? (
                              <ActivityIndicator style={goalStyles.estimateSpacing} />
                            ) : (
                              <View style={goalStyles.estimateButtonRow}>
                                <Pressable
                                  style={goalStyles.estimateOutlineButton}
                                  onPress={() =>
                                    applyEmergencyFundTarget(
                                      Math.round(estimate.averageMonthlyEssential * 3)
                                    )
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
                                    applyEmergencyFundTarget(
                                      Math.round(estimate.averageMonthlyEssential * 6)
                                    )
                                  }
                                  accessibilityRole="button"
                                >
                                  <Text style={goalStyles.estimateOutlineButtonText}>
                                    6 MONTHS (${Math.round(estimate.averageMonthlyEssential * 6)})
                                  </Text>
                                </Pressable>
                              </View>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </View>
                );
              })()
            ) : (
              <View style={[styles.card, goalStyles.cardMargin]}>
                <Text style={goalStyles.cardTitle}>Want to build an emergency fund instead?</Text>
                <Text style={[styles.smallText, goalStyles.estimateSpacing]}>
                  This replaces your current goal - this app tracks one goal at a time.
                </Text>
                <View style={goalStyles.estimateSpacing}>
                  <Pressable
                    style={goalStyles.estimateOutlineButton}
                    onPress={switchToEmergencyFundGoal}
                    accessibilityRole="button"
                  >
                    <MaterialIcons name="shield" size={16} color={colors.primary} />
                    <Text style={goalStyles.estimateOutlineButtonText}>SWITCH TO EMERGENCY FUND</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </Animated.ScrollView>

          <TopFadeMask scrollY={scrollY} />
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
  },
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
  titleBlock: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 24,
    gap: 4,
  },
  title: {
    fontSize: 22,
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
