import { useState } from 'react';
import { View, Text, TextInput, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { apiFetch, apiErrorMessage, formatDecimal, formatWhole, formatDateMDY } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { formatAmountLabel } from '../_lib/amountPicker';
import { useAppData } from '../_lib/appData';
import { ScenarioResult, describeComparisonDifference } from './ScenarioResult';
import DigitAmountPicker from './DigitAmountPicker';
import PrimaryButton from './PrimaryButton';
import AffordabilityChat from './AffordabilityChat';
import { LeafAvatar, CheckBadge, CarIllustration, MountainIllustration, isNightBackdrop } from './Illustrations';

// "A few things to consider" (comparison screen) - 30 days, matching the
// mockup's own "in the next 30 days" copy. Deliberately independent of
// Home's UPCOMING_BILLS_WINDOW_DAYS (7 days, a short glance list there) -
// this card is a single summed total, not a list, so a longer window
// reads better here without the two ever needing to agree.
//
// No lower bound on `days`, matching Home's own filter exactly (`(tabs)/
// index.js`'s upcomingBills: `days <= UPCOMING_BILLS_WINDOW_DAYS`, no
// `days >= 0`) - an earlier version of this function added one, which
// real /code-review (2026-08-20) caught as a genuine inconsistency: the
// same underlying data would report two different totals depending on
// which screen you're on, since Home deliberately still counts an
// overdue bill (shown there as "expected recently") as upcoming. Not
// extracted into one shared helper both screens import - that would mean
// touching Home's file, outside this restyle's own scope guardrails
// (Budget tab only); logged as a reasonable future cleanup instead.
const UPCOMING_BILLS_CARD_WINDOW_DAYS = 30;

function upcomingBillsTotal(subscriptionAudit, now = new Date()) {
  if (!subscriptionAudit?.recurring_bills?.length) return null;
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const total = subscriptionAudit.recurring_bills.reduce((sum, bill) => {
    const days = Math.round(
      (new Date(`${bill.next_expected_date}T00:00:00Z`) - todayUtc) / (1000 * 60 * 60 * 24)
    );
    return days <= UPCOMING_BILLS_CARD_WINDOW_DAYS ? sum + bill.typical_amount : sum;
  }, 0);
  return Math.round(total * 100) / 100;
}

// monthsOfExpenses() and the "Emergency fund" card that used it were
// removed 2026-09-01 - emergency fund is no longer a primary goal_type
// (see server/index.js's GOAL_TYPES comment), so goalProgress.goal_type
// can never be 'emergency_fund' again and goalProgress.essential_expense_
// estimate is no longer attached server-side either. The underlying
// insight (how many months of expenses does the tracked balance cover)
// is still real and could be rebuilt against the new independent
// emergency-fund tracker (GET /emergency-fund) as a follow-up - not done
// in this pass, which was scoped to the Goal-tab redesign itself.

// Phase 9 Step 4, moved to the Budget tab in Phase 13: the "can I afford
// this?" entry point - one text field, one submit action, one structured
// result, not a chat thread. The only multi-turn shape this component
// knows about is the brief's single sanctioned exception (missing-amount
// clarification), implemented the same stateless way the backend does:
// the previously returned `context` is held in local state and echoed
// back on the follow-up POST, never persisted, never a running
// conversation.
//
// Voice (Option B, approved 2026-08-19 - see CLAUDE.md's Voice
// Architecture Decision Gate): record -> upload to the backend's
// /affordability/transcribe -> the transcribed text lands in this same
// editable field, nothing more. The hard safety rule this satisfies by
// construction: transcription and submission are two separate user
// actions through two separate endpoints - there is no code path where a
// recording reaches the financial engine without the user seeing and
// having a chance to correct the text first (a misheard "50" as "15" is
// visible and editable before "Ask" is ever pressed).
//
// Phase 13: gained a third, conditional input for the amount - a wheel
// (DigitAmountPicker, see that file's header), rendered only during the
// needs_amount clarification (text and voice stay always-available,
// unchanged from Phase 9) - and an explicit "Compare: buy now vs. wait"
// secondary action, reusing ScenarioCheck.js's old comparison endpoint/
// rendering verbatim via ScenarioResult.js (ScenarioCheck.js itself is
// deleted as of this phase). The wheel writes a formatted amount string
// into the same `text` field voice transcription already populates -
// both converge on one value before submission, so the backend needs no
// new code to support a third input method (extractCandidateAmounts/
// validateStatedAmountAgainstRawInput already handle whatever string
// reaches them).
//
// Budget-tab Sorrel restyle (2026-08-20): presentation-only pass over all
// of the above - every function in this file that touches `apiFetch`,
// `pendingContext`, the recorder, or the wheel is unchanged from Phase 13.
// The one new piece of state is `originalQuestion`, added purely so the
// mockup's chat-bubble pair can still show the user's original question
// once `text` itself has been cleared for the amount-only reply - it does
// not feed into `submit()` or the backend contract at all.

// Exported for AffordabilityChat.js's own inline result card
// (project_affordable_date's tool result is the identical shape this
// function already renders here) - real bug found by adversarial review
// (2026-08-22): the chat originally assumed every tool result matched
// evaluate_scenario's shape and crashed on this one (and three others).
export function describeProjection(p) {
  if (p.status === 'already_affordable') {
    return (
      `You already have enough saved for this — $${formatDecimal(p.saved_amount)} toward the ` +
      `$${formatDecimal(p.target_amount)} target.`
    );
  }
  const days = p.days_from_now;
  return (
    `At your current saving pace (about $${formatDecimal(p.monthly_pace)}/month), you're on track ` +
    `for this by ${formatDateMDY(p.projected_date)} — about ${days} day${days === 1 ? '' : 's'} from now.`
  );
}

// Pure, deterministic - template text over goal_impact's already-computed
// fields (delay_days/stalls_goal/projected_date_after), same discipline as
// describeComparisonDifference below. Never invents a number that isn't
// already on goalImpact.
// Exported for AffordabilityChat.js's own fallback opening-sections builder
// (used only when explainScenario failed/returned the old shape - see that
// file's buildOpeningSections).
export function describeGoalCallout(goalImpact) {
  if (!goalImpact?.available) return null;
  if (goalImpact.stalls_goal) {
    return "This would stop your goal from advancing at its current pace.";
  }
  if (!goalImpact.delay_days || goalImpact.delay_days <= 0) {
    return "This won't slow your progress toward your goal.";
  }
  return (
    `This pushes your projected goal date back about ${goalImpact.delay_days} ` +
    `day${goalImpact.delay_days === 1 ? '' : 's'}, to around ${formatDateMDY(goalImpact.projected_date_after)}.`
  );
}

// Concrete "here's where the money could come from" line, straight off
// server/scenario.js's buildSuggestions (real unspent budget in other
// categories this period - never invented here). Added per direct user
// request (2026-08-25): the old bullet set explained why a purchase was
// tight but never guided toward what to actually do about it.
// Exported for AffordabilityChat.js's own fallback opening-sections builder.
export function describeSuggestion(suggestions) {
  const s = suggestions?.[0];
  if (!s) return null;
  const names = s.categories.map((c) => c.category);
  const list =
    names.length === 1
      ? names[0]
      : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return `There's real room in ${list} this period (about $${formatWhole(s.combined_available)} combined) that could help cover this.`;
}

// The main result screen's primary explanation (2026-08-28, direct user
// request - the old deterministic bullet list "feels like a robot spitting
// facts," specifically confusing on a real case where a category's
// pre-existing overage and a new charge's own cost got silently added
// together into one unexplained number). Reuses `anchorResult.explanation`
// (the already-generated, already-paid-for Claude call from
// /affordability/query - zero new cost) rather than a fresh call, same
// three-section shape (reasoning/possible_room/recommended_actions)
// AffordabilityChat.js's own opening message already uses, so the two
// surfaces never disagree on phrasing. Falls back to the deterministic
// tradeoffs/suggestions/goal_impact facts (never empty) when the
// explanation call failed - a Claude outage must never leave the main
// result screen with nothing to show.
// Exported so AffordabilityChat.js's own opening message reuses this
// exact implementation instead of a second copy.
export function buildOpeningSections(anchorResult) {
  const explanation = anchorResult?.explanation;
  // New shape: { reasoning, possible_room, recommended_actions }, all
  // non-empty strings (scenarioExplain.js's parseSections never returns a
  // partial object).
  if (explanation && typeof explanation === 'object' && explanation.reasoning) {
    return explanation;
  }

  const reasoning =
    // Old plain-string shape (a stale/legacy result) still reads fine as
    // the "why" section on its own.
    (typeof explanation === 'string' && explanation) ||
    anchorResult?.tradeoffs?.[0]?.text ||
    anchorResult?.limitations?.[0] ||
    null;

  const possibleRoom =
    describeSuggestion(anchorResult?.suggestions) ||
    "There's no obvious room in the budget to free up right now, based on what's already known.";

  const recommendedActions =
    describeGoalCallout(anchorResult?.goal_impact) ||
    'Review the numbers above before deciding whether to move ahead.';

  if (!reasoning) return null;
  return { reasoning, possible_room: possibleRoom, recommended_actions: recommendedActions };
}

// Short two-word-ish label for the comparison table's Goal progress row -
// same fields describeGoalCallout uses, just condensed for a table cell
// instead of a sentence.
function shortGoalImpactLabel(goalImpact) {
  if (!goalImpact?.available) return 'Not available';
  if (goalImpact.stalls_goal) return 'Stalls goal';
  if (!goalImpact.delay_days || goalImpact.delay_days <= 0) return 'On track';
  return `Delayed ${goalImpact.delay_days}d`;
}

// Badge tone per result status - never a reassuring green check on a risky
// or unknown result. See Illustrations.js's CheckBadge header for why this
// mapping exists as a real design decision, not an incidental default.
const STATUS_TONE = {
  comfortable: 'positive',
  affordable_with_tradeoff: 'positive',
  risky_timing: 'caution',
  insufficient_data: 'neutral',
};

// Text-color counterpart to STATUS_TONE/CheckBadge's fill colors, for the
// smaller inline status labels (comparison cards, max_comfortable) that
// show status as colored text rather than a full badge.
const STATUS_TEXT_COLOR = { positive: colors.primary, caution: colors.warning, neutral: colors.muted };

// Long history (2026-08-19/20) of the wheel's amount-selection design,
// worth keeping since the final answer isn't obvious from the code alone:
// dragging a single continuous $1-$9999 wheel could partially scroll the
// parent Budget ScrollView mid-drag on a fast/long swipe. Five things
// tried, in order: (1) raw View touch handlers toggling scrollEnabled -
// desynced React Native's own gesture bookkeeping (confirmed via adb
// logcat); (2) the wheel's own onValueChanging/onChange driving the same
// toggle - fixed (1)'s desync but still lost the touch-dispatch race on a
// fast swipe; (3) locking scrollEnabled for the wheel's whole visible
// lifetime - reduced but didn't eliminate the scroll, AND trapped the
// user unable to scroll back up once it happened, a strictly worse
// failure mode ("the screen scrolled down, and now I can't even scroll
// up"); (4) moving the wheel into its own <Modal> - structurally solved
// the conflict (confirmed on-device: "runs great, super smooth"), but the
// presentation (an explicit "Pick with wheel" tap, a popup sheet) was
// rejected directly by the user as unnecessary friction; (5) reverted to
// a plain inline wheel with a much bigger touch target - genuinely helped
// normal-paced swiping, but a real fast/long swipe could still
// occasionally trigger the scroll.
//
// The real fix (2026-08-20) turned out to be orthogonal to all five
// attempts above: none of them addressed *why* a long/fast swipe was ever
// needed in the first place. A single $1-$999,999 wheel needs one either
// to reach a realistic amount; a tiered-step version (fine near $1,
// coarser further out - tried and reverted the same day) fixed that but
// gave up exact-value precision, correctly rejected by the user ("cant
// select the exact number anymore"). DigitAmountPicker's per-digit
// odometer design resolves both at once: every individual wheel only
// ever has 10 rows, so no swipe on any single wheel can travel far
// regardless of speed, while every digit 0-9 stays directly selectable -
// no tiering, no precision lost. See DigitAmountPicker.js's own header
// for the full reasoning.
export default function AffordabilityQuery() {
  // "A few things to consider" (comparison screen) - goalProgress and
  // subscriptionAudit are already fetched app-wide by AppDataProvider
  // (Home/Goal tabs already consume both), reused here with zero new
  // fetch plumbing.
  const { goalProgress, subscriptionAudit } = useAppData();

  // This component always renders directly on top of the Budget tab's
  // AppBackdrop (no card wrapper around its own header/status-label text)
  // - only ever used there, so it's safe to compute this itself rather
  // than threading a prop down from budget.js.
  const night = isNightBackdrop();
  const onBackdropTextColor = night ? colors.background : undefined;

  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);
  // Non-null only while the clarification round-trip is in progress - the
  // context a NEEDS_AMOUNT response returned, which the follow-up request
  // echoes back verbatim (see server/index.js's /affordability/query).
  const [pendingContext, setPendingContext] = useState(null);
  // Restyle-only addition (2026-08-20) - see this file's header comment.
  const [originalQuestion, setOriginalQuestion] = useState('');

  // The wheel's own numeric value, separate from `text` - it needs a plain
  // number to drive DigitAmountPicker's controlled `value` prop, while
  // `text` stays the one field that's actually submitted (same field
  // voice transcription writes into).
  const [wheelValue, setWheelValue] = useState(1);

  // Step 4 (moved from ScenarioCheck.js in Phase 13): "buy now vs. wait
  // until your next paycheck" - its own separate loading/error/result
  // state, shown only as an explicit secondary action after a plain
  // result, never auto-run alongside it.
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState(null);
  const [comparison, setComparison] = useState(null);

  // Phase 23 (fund-source suggestion): the AI-authored exact per-category
  // split, shown only as an explicit secondary action under the
  // deterministic "there's room in X and Y" line - never auto-run, same
  // "preview, real cost, only when actually wanted" reasoning
  // /scenarios/suggestion-split itself follows server-side.
  const [checkingFundSource, setCheckingFundSource] = useState(false);
  const [fundSourceError, setFundSourceError] = useState(null);
  const [fundSourceSplit, setFundSourceSplit] = useState(null);

  // "AI-narrated responses + conversation memory" follow-up: which result
  // (if any) a "More details" tap opened the chat for - the chat itself
  // holds no state here beyond this, since its own conversation is fully
  // local to AffordabilityChat.js and discarded when it closes.
  const [chatAnchorResult, setChatAnchorResult] = useState(null);
  // Real bug found by adversarial review (2026-08-22): AffordabilityChat is
  // always mounted (only `visible` toggles), and its own message state is
  // seeded via a useState lazy initializer that only ever runs once on
  // first mount - so reopening "More details" for a DIFFERENT purchase kept
  // showing the previous purchase's full transcript instead of starting
  // fresh, directly contradicting that file's own "starts from the same
  // anchor_result's explanation, not where this one left off" contract.
  // Incrementing this on every open and passing it as AffordabilityChat's
  // `key` forces a genuine remount (fresh internal state) each time,
  // regardless of whether it's the same or a different purchase.
  const [chatKey, setChatKey] = useState(0);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState(null);

  async function startRecording() {
    setVoiceError(null);
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      setVoiceError('Microphone access is needed to ask by voice.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  // Stops, uploads the raw recording, and - critically - only ever writes
  // the transcribed text into the same editable field this component
  // already uses for typed input. Never calls submit() itself.
  async function stopRecordingAndTranscribe() {
    await recorder.stop();
    if (!recorder.uri) {
      // Real bug found by /code-review (2026-08-19): this used to return
      // with zero feedback - the mic button silently reverted to idle with
      // no indication anything went wrong, in the one flow this project's
      // own brief calls out as safety-critical for user visibility (a
      // misheard/failed recording needs to be visibly correctable, not
      // silently dropped).
      setVoiceError("That recording didn't come through - try again or type it.");
      return;
    }

    setTranscribing(true);
    setVoiceError(null);
    try {
      const fileResponse = await fetch(recorder.uri);
      const blob = await fileResponse.blob();
      const res = await apiFetch('/affordability/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/m4a' },
        body: blob,
      });
      if (!res.ok) throw new Error('SERVER_ERROR');
      const { text: transcribed } = await res.json();
      setText(transcribed || '');
    } catch (err) {
      console.error(err);
      setVoiceError(
        err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : "Couldn't transcribe that - try again or type it."
      );
    } finally {
      setTranscribing(false);
    }
  }

  function onMicPress() {
    if (recorderState.isRecording) {
      stopRecordingAndTranscribe();
    } else {
      startRecording();
    }
  }

  async function submit(rawText, context) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/affordability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context ? { text: rawText, context } : { text: rawText }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 400 ? body.error || 'SERVER_ERROR' : 'SERVER_ERROR');
      }
      const body = await res.json();
      setResponse(body);
      // A fresh result makes any prior comparison/fund-source split stale -
      // both were run against a different (or now-superseded) checked amount.
      setComparison(null);
      setComparisonError(null);
      setFundSourceSplit(null);
      setFundSourceError(null);
      if (
        body.status === 'needs_amount' ||
        body.status === 'needs_financing_confirmation' ||
        body.status === 'needs_finance_term'
      ) {
        setPendingContext(body.context);
        setText(''); // clears the field for the amount-only reply, not auto-submitted
        setWheelValue(1);
      } else {
        // Real bug found on-device (2026-08-21): a terminal status (result/
        // insufficient_data/unsupported) used to leave whatever was last
        // typed/submitted sitting in the field - the conversation was over,
        // but the input still showed a stale reply from partway through it.
        setPendingContext(null);
        setText('');
        setWheelValue(1);
      }
    } catch (err) {
      console.error(err);
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function onAsk() {
    if (!text.trim()) return;
    if (!pendingContext) setOriginalQuestion(text);
    submit(text, pendingContext || undefined);
  }

  function onWheelChange(v) {
    setWheelValue(v);
    setText(formatAmountLabel(v));
  }

  // "Will this be financed?" turn: the only two replies the backend accepts
  // here are its fixed 'yes'/'no' button values (see server/index.js's
  // deterministic financing-confirmation branch, no free text parsed for
  // this turn) - so these bypass onAsk()/the text field entirely rather
  // than routing through it.
  function answerFinancingConfirmation(answer) {
    submit(answer, pendingContext);
  }

  function startOver() {
    setText('');
    setResponse(null);
    setPendingContext(null);
    setError(null);
    setComparison(null);
    setComparisonError(null);
    setFundSourceSplit(null);
    setFundSourceError(null);
    setOriginalQuestion('');
  }

  // Reuses the last successfully-checked amount/category/recurrence
  // (response.result.scenario, the normalized scenario evaluateScenario
  // itself produced) rather than re-deriving anything client-side - the
  // exact same body shape ScenarioCheck.js used to send.
  async function checkComparison() {
    if (!response?.result?.scenario) return;
    const { amount, category, recurrence } = response.result.scenario;
    setComparing(true);
    setComparisonError(null);
    setComparison(null);
    try {
      const res = await apiFetch('/scenarios/compare-buy-now-vs-wait', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, category, recurrence }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      const body = await res.json();
      setComparison(body);
    } catch (err) {
      console.error(err);
      setComparisonError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setComparing(false);
    }
  }

  // Same reuse-the-normalized-scenario pattern checkComparison uses above -
  // the server re-derives budgetImpact/suggestions itself from this
  // scenario rather than trusting anything else the client might send, so
  // sending back the same amount/category/recurrence the result was
  // already evaluated from is all this needs.
  async function checkFundSourceSplit() {
    if (!response?.result?.scenario) return;
    const { amount, category, recurrence } = response.result.scenario;
    setCheckingFundSource(true);
    setFundSourceError(null);
    setFundSourceSplit(null);
    try {
      const res = await apiFetch('/scenarios/suggestion-split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, category, recurrence }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'SERVER_ERROR');
        }
        throw new Error('SERVER_ERROR');
      }
      const body = await res.json();
      setFundSourceSplit(body.proposal);
    } catch (err) {
      console.error(err);
      setFundSourceError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setCheckingFundSource(false);
    }
  }

  const result = response?.status === 'result' ? response.result : null;
  const opening = result ? buildOpeningSections(result) : null;
  const tone = result ? STATUS_TONE[result.status] || 'positive' : 'positive';
  const awaitingFinancing = pendingContext?.awaiting === 'financing_confirmation';
  // "60 months" / "5 years" isn't a dollar amount - the wheel doesn't apply
  // and the field's placeholder/button label need their own wording. Same
  // treatment for the 0%-promo-plan term question (furniture/appliances) -
  // it's the identical "how long" shape, just a different financing path
  // server-side (see server/index.js's nextFinancingStep).
  const awaitingFinanceTerm =
    pendingContext?.awaiting === 'finance_term' || pendingContext?.awaiting === 'promo_term';

  return (
    <View style={{ gap: 16 }}>
      <View style={{ alignItems: 'center', gap: 4 }}>
        <LeafAvatar size={48} />
        <Text style={[styles.cardTitle, { fontSize: 19 }, onBackdropTextColor && { color: onBackdropTextColor }]}>
          Can I afford this?
        </Text>
        <Text style={[styles.smallText, night && { color: 'rgba(244, 246, 242, 0.75)' }]}>
          Tell Sorrel what you're thinking about.
        </Text>
      </View>

      {pendingContext && (
        <View style={{ gap: 8 }}>
          {!!originalQuestion && (
            <View style={styles.chatBubbleUser}>
              <Text style={styles.chatBubbleUserText}>{originalQuestion}</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <LeafAvatar size={28} />
            <View style={styles.chatBubbleAssistant}>
              <Text style={styles.chatBubbleAssistantText}>{response?.message || 'How much?'}</Text>
            </View>
          </View>
        </View>
      )}

      {/* "Will this be financed?" turn: only the two fixed Yes/No replies
          the backend's deterministic branch accepts (see
          answerFinancingConfirmation above) - no text/voice/wheel input for
          this turn, so there's nothing ambiguous to type. */}
      {awaitingFinancing ? (
        submitting ? (
          <ActivityIndicator />
        ) : (
          <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'center' }}>
            <View style={{ flex: 1 }}>
              <PrimaryButton title="Yes" onPress={() => answerFinancingConfirmation('yes')} />
            </View>
            <View style={{ flex: 1 }}>
              <PrimaryButton title="No" onPress={() => answerFinancingConfirmation('no')} />
            </View>
          </View>
        )
      ) : (
        <>
          {/* Phase 13: the wheel is a fallback for the needs_amount state
              only - "not taking up the screen constantly." Writes into the
              same `text` field typed/voice input use, so it needs no
              separate submit path. DigitAmountPicker already renders its
              own card, not re-wrapped here. Doesn't apply to the
              finance-term turn - "60 months" isn't a dollar amount. */}
          {pendingContext && !awaitingFinanceTerm && (
            <DigitAmountPicker value={wheelValue} onValueChange={onWheelChange} />
          )}

          {/* Voice: record -> transcribe -> lands in the field to the left
              as plain editable text. Never submits on its own - "Ask"/
              "Submit amount" below is still the only way to actually send
              anything. */}
          <View style={inlineStyles.inputRow}>
            <TextInput
              style={[
                styles.input,
                inlineStyles.input,
                night && { borderColor: 'rgba(244, 246, 242, 0.4)', color: colors.background },
              ]}
              value={text}
              onChangeText={setText}
              placeholder={
                awaitingFinanceTerm ? 'e.g. 60 months' : pendingContext ? 'e.g. $50' : 'e.g. Can I afford a $50 dinner?'
              }
              placeholderTextColor={night ? 'rgba(244, 246, 242, 0.5)' : colors.placeholder}
              editable={!submitting && !transcribing}
            />
            {transcribing ? (
              <ActivityIndicator style={inlineStyles.micButton} />
            ) : (
              <Pressable
                onPress={onMicPress}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel={recorderState.isRecording ? 'Stop recording' : 'Ask by voice'}
                style={[
                  inlineStyles.micButton,
                  recorderState.isRecording ? inlineStyles.micButtonRecording : inlineStyles.micButtonIdle,
                ]}
              >
                <MaterialIcons name={recorderState.isRecording ? 'stop' : 'mic'} size={22} color={colors.background} />
              </Pressable>
            )}
          </View>

          {voiceError && <Text style={styles.errorText}>{voiceError}</Text>}

          {submitting ? (
            <ActivityIndicator />
          ) : (
            <PrimaryButton
              title={awaitingFinanceTerm ? 'Submit term' : pendingContext ? 'Submit amount' : 'Ask'}
              onPress={onAsk}
              disabled={transcribing || recorderState.isRecording}
            />
          )}
        </>
      )}

      {response && !pendingContext && (
        <Pressable onPress={startOver} accessibilityRole="button" accessibilityLabel="Ask something else">
          <Text style={[styles.smallText, { color: colors.primary, textDecorationLine: 'underline' }]}>
            Ask something else
          </Text>
        </Pressable>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {response?.status === 'unsupported' && (
        <View style={styles.card}>
          <Text style={styles.smallText}>{response.message}</Text>
        </View>
      )}

      {response?.status === 'insufficient_data' && (
        <View style={styles.card}>
          <Text style={styles.smallText}>{response.detail}</Text>
        </View>
      )}

      {result && (
        <View style={{ gap: 16 }}>
          <View style={{ alignItems: 'center', gap: 8 }}>
            <CheckBadge size={56} tone={tone} />
            <Text
              style={[
                styles.cardTitle,
                { fontSize: 20, textAlign: 'center' },
                onBackdropTextColor && { color: onBackdropTextColor },
              ]}
            >
              {result.status_label}
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.comparisonTableRow}>
              <Text style={styles.comparisonTableLabel}>Amount</Text>
              <Text style={styles.comparisonTableValue}>${formatDecimal(result.scenario.amount)}</Text>
            </View>
            <View style={styles.comparisonTableRow}>
              <Text style={styles.comparisonTableLabel}>Recurrence</Text>
              <Text style={styles.comparisonTableValue}>
                {result.scenario.recurrence === 'once'
                  ? 'One-time'
                  : result.scenario.recurrence[0].toUpperCase() + result.scenario.recurrence.slice(1)}
              </Text>
            </View>
            <View style={[styles.comparisonTableRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.comparisonTableLabel}>Category</Text>
              <Text style={styles.comparisonTableValue}>{result.scenario.category || 'Not specified'}</Text>
            </View>
          </View>

          {/* Only present when the Amount above is a computed estimate, not
              a number the user typed - states the real source plainly
              rather than leaving it implicit in the advisor paragraph
              alone (see server/financeRate.js's header for why this has to
              come from a real published rate, not an AI guess). */}
          {result.rate_estimate && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Estimated payment</Text>
              <Text style={styles.smallText}>
                Based on a ${formatDecimal(result.rate_estimate.base_price)} price plus an assumed{' '}
                {result.rate_estimate.estimated_ttl_rate_percent}% for tax, title, and license ($
                {formatDecimal(result.rate_estimate.total_price)} total), financed over {result.rate_estimate.term_months}{' '}
                months at the average new-auto-loan rate of {result.rate_estimate.annual_rate_percent}% APR
                (published by the Federal Reserve as of {formatDateMDY(result.rate_estimate.as_of_date)}), the estimated payment is
                ${formatDecimal(result.rate_estimate.estimated_payment)}/month. This is an estimate, not a real quote -
                your actual rate, tax, and fees depend on your credit, lender, and location.
              </Text>
            </View>
          )}

          {/* Furniture/appliance-style 0%-promo plan - a genuine even-split
              calculation (no rate invented, no external call), but the two
              caveats matter as much as the number itself: whether a 0%
              plan is actually offered isn't something Sorrel can verify,
              and missing the payoff window is a real, often-retroactive
              risk (see server/index.js's nextFinancingStep header). */}
          {result.promo_plan_estimate && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Estimated payment (0% plan)</Text>
              <Text style={styles.smallText}>
                If this is financed on a 0%-interest plan over {result.promo_plan_estimate.term_months} months, $
                {formatDecimal(result.promo_plan_estimate.total_price)} works out to $
                {formatDecimal(result.promo_plan_estimate.estimated_payment)}/month.
              </Text>
              <Text style={[styles.smallText, { marginTop: 8 }]}>
                {result.promo_plan_estimate.confirmation_caveat}
              </Text>
              <Text style={[styles.smallText, { marginTop: 8 }]}>{result.promo_plan_estimate.risk_caveat}</Text>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Why</Text>
            {/* Two of the same three warm, advisor-voice sections
                AffordabilityChat.js's opening message uses (reasoning +
                possible_room) - `recommended_actions` stays chat-only,
                where "what should I actually do" fits better as a deeper
                follow-up than a third paragraph on the glance-able primary
                screen (direct user request, 2026-08-28: shorter, still
                friendly). Falls back to the deterministic tradeoffs/
                suggestion text via buildOpeningSections' own fallback path
                if the explanation call failed - never empty. */}
            {opening && (
              <>
                <Text style={styles.smallText}>{opening.reasoning}</Text>
                <Text style={[styles.smallText, { marginTop: 8 }]}>{opening.possible_room}</Text>
              </>
            )}
            {result.limitations?.[0] && (
              <Text style={[styles.smallText, { marginTop: 8, color: colors.muted }]}>
                {result.limitations[0]}
              </Text>
            )}
            <Pressable
              onPress={() => {
                setChatAnchorResult(result);
                setChatKey((k) => k + 1);
              }}
              accessibilityRole="button"
              accessibilityLabel="More details"
            >
              <Text style={[styles.smallText, { color: colors.primary, textDecorationLine: 'underline' }]}>
                More details
              </Text>
            </Pressable>

            {/* Phase 23 (fund-source suggestion): only offered when the
                deterministic "there's room in X and Y" suggestion above is
                itself present - an exact split has nothing to propose
                otherwise. On-demand, real (small) AI cost per tap - never
                fired automatically alongside the result itself. */}
            {result.suggestions?.[0] && !fundSourceSplit && (
              <Pressable
                onPress={checkFundSourceSplit}
                disabled={checkingFundSource}
                accessibilityRole="button"
                accessibilityLabel="See the exact split"
                style={{ marginTop: 8 }}
              >
                {checkingFundSource ? (
                  <ActivityIndicator />
                ) : (
                  <Text style={[styles.smallText, { color: colors.primary, textDecorationLine: 'underline' }]}>
                    See the exact split
                  </Text>
                )}
              </Pressable>
            )}

            {fundSourceError && <Text style={styles.errorText}>{fundSourceError}</Text>}

            {fundSourceSplit && fundSourceSplit.adjustments.length === 0 && (
              <Text style={[styles.smallText, { marginTop: 8 }]}>
                {fundSourceSplit.summary || "Couldn't find a clean split across those categories."}
              </Text>
            )}

            {fundSourceSplit && fundSourceSplit.adjustments.length > 0 && (
              <View style={{ marginTop: 8, gap: 4 }}>
                {fundSourceSplit.adjustments.map((a) => (
                  <Text key={a.category} style={styles.smallText}>
                    • Cut ${formatDecimal(a.reduce_by)} from {a.category} — {a.reasoning}
                  </Text>
                ))}
                {fundSourceSplit.summary && (
                  <Text style={[styles.smallText, { marginTop: 4 }]}>{fundSourceSplit.summary}</Text>
                )}
              </View>
            )}
          </View>

          {result.budget_impact?.available && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>After adding this payment</Text>
              <Text style={styles.smallText}>
                You'd have ${formatDecimal(result.budget_impact.total_remaining_after)} left in your budget this
                period.
              </Text>
            </View>
          )}

          {result.goal_impact?.available && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Your goal</Text>
              <Text style={styles.smallText}>{describeGoalCallout(result.goal_impact)}</Text>
            </View>
          )}

          {/* Context, not a second pass/fail gate (see CLAUDE.md) - only
              shown when a total price was actually mentioned somewhere in
              this conversation and a real liquid balance is on file. */}
          {result.total_price_comparison && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Total price</Text>
              <Text style={styles.smallText}>
                The ${formatDecimal(result.total_price_comparison.total_price)} total price is about{' '}
                {result.total_price_comparison.ratio.toFixed(1)}x your available cash ($
                {formatDecimal(result.total_price_comparison.liquid_balance)}).
              </Text>
            </View>
          )}

          {comparing ? (
            <ActivityIndicator />
          ) : (
            <PrimaryButton title="Compare: buy now vs. wait" onPress={checkComparison} />
          )}

          {comparisonError && <Text style={styles.errorText}>{comparisonError}</Text>}

          {comparison && comparison.available === false && (
            <View style={styles.card}>
              <Text style={styles.smallText}>
                No recurring income has been detected yet, so there's no real payday to compare
                waiting against.
              </Text>
            </View>
          )}

          {comparison && comparison.available === true && (
            <View style={{ gap: 16 }}>
              {(() => {
                const [buyNow, wait] = comparison.comparison.scenarios;
                const [diff] = comparison.comparison.differences;
                return (
                  <>
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      <View style={[styles.card, { flex: 1, alignItems: 'center' }]}>
                        <CarIllustration size={64} />
                        <Text style={styles.cardTitle}>Buy now</Text>
                        {/* Real gap found by /code-review (2026-08-20):
                            trimming status_label out of ScenarioResult
                            (screen 2's own badge/title replaced it there)
                            silently dropped status display from these two
                            comparison sides too, with nothing else showing
                            it - restored here, specific to this call site. */}
                        <Text style={{ color: STATUS_TEXT_COLOR[STATUS_TONE[buyNow.result.status] || 'positive'], fontWeight: '600', fontSize: 13 }}>
                          {buyNow.result.status_label}
                        </Text>
                        <ScenarioResult result={buyNow.result} />
                      </View>
                      <View style={[styles.card, { flex: 1, alignItems: 'center' }]}>
                        <MountainIllustration size={64} />
                        <Text style={styles.cardTitle}>Wait until {formatDateMDY(wait.result.scenario.date)}</Text>
                        <Text style={{ color: STATUS_TEXT_COLOR[STATUS_TONE[wait.result.status] || 'positive'], fontWeight: '600', fontSize: 13 }}>
                          {wait.result.status_label}
                        </Text>
                        <ScenarioResult result={wait.result} />
                      </View>
                    </View>

                    {/* Only 2 rows shown, deliberately - both have real
                        backing computation (charge_this_period,
                        goal_impact). The mockup's other 3 rows
                        (Monthly flexibility, Emergency fund impact,
                        Financial buffer) have no real distinguishing
                        number behind them anywhere in the engine, so they
                        are not shown rather than fabricated - see this
                        restyle's own build notes in CLAUDE.md. */}
                    <View style={styles.card}>
                      <View style={styles.comparisonTableRow}>
                        <Text style={styles.comparisonTableLabel}>Discretionary spending (buy now)</Text>
                        <Text style={styles.comparisonTableValue}>
                          -${formatDecimal(buyNow.result.budget_impact?.charge_this_period) ?? '—'}
                        </Text>
                      </View>
                      <View style={[styles.comparisonTableRow, { borderBottomWidth: 0 }]}>
                        <Text style={styles.comparisonTableLabel}>Goal progress</Text>
                        <Text style={styles.comparisonTableValue}>
                          {shortGoalImpactLabel(buyNow.result.goal_impact)} vs{' '}
                          {shortGoalImpactLabel(wait.result.goal_impact)}
                        </Text>
                      </View>
                    </View>

                    {diff && (
                      <Text style={styles.smallText}>
                        {describeComparisonDifference({
                          diff,
                          buyNowResult: buyNow.result,
                          waitResult: wait.result,
                        })}
                      </Text>
                    )}

                    {/* "Sorrel's take" - comparison.explanation was already
                        fetched from the backend (explainComparison in
                        scenarioExplain.js, same never-invent-a-number
                        guardrail as the single-check explanation) but
                        never rendered before this restyle. */}
                    {comparison.explanation && (
                      <View style={styles.card}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <LeafAvatar size={24} />
                          <Text style={styles.cardTitle}>Sorrel's take</Text>
                        </View>
                        <Text style={styles.text}>{comparison.explanation}</Text>
                      </View>
                    )}

                    {/* "A few things to consider" - pulled from data
                        already fetched app-wide (useAppData), no new
                        network calls. Each card only renders when its own
                        data is actually available - never a placeholder
                        or an invented number. */}
                    {(goalProgress || subscriptionAudit) && (
                      <View style={{ gap: 8 }}>
                        <Text style={styles.cardTitle}>A few things to consider</Text>

                        {goalProgress && (
                          <View style={styles.card}>
                            <Text style={styles.cardTitle}>Goal progress</Text>
                            <Text style={styles.smallText}>{goalProgress.message}</Text>
                          </View>
                        )}

                        {upcomingBillsTotal(subscriptionAudit) != null && (
                          <View style={styles.card}>
                            <Text style={styles.cardTitle}>Upcoming bills</Text>
                            <Text style={styles.smallText}>
                              You have ${formatDecimal(upcomingBillsTotal(subscriptionAudit))} in bills
                              due in the next {UPCOMING_BILLS_CARD_WINDOW_DAYS} days.
                            </Text>
                          </View>
                        )}
                      </View>
                    )}
                  </>
                );
              })()}
            </View>
          )}
        </View>
      )}

      {/* Real bug found by /code-review (2026-08-20): maximum_comfortable_amount
          and affordable_date both return {status: 'result', ...} with NO
          `.result` field (only affordability_check's response has one) - so
          gating these on `result` (= response.result) the way the block
          above is gated made both of these render nothing at all, a full
          regression of two of the three affordability intents. Gated on
          `response?.status === 'result'` directly instead, matching what
          the original pre-restyle code did, and kept as independent
          siblings rather than nested inside the `result &&` block above. */}
      {response?.status === 'result' && response.max_comfortable && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Comfortable up to ${formatDecimal(response.max_comfortable.max_comfortable_amount)}
          </Text>
          <Text
            style={{
              color:
                STATUS_TEXT_COLOR[STATUS_TONE[response.max_comfortable.boundary_result.status] || 'positive'],
              fontWeight: '600',
              fontSize: 13,
            }}
          >
            {response.max_comfortable.boundary_result.status_label}
          </Text>
          <ScenarioResult result={response.max_comfortable.boundary_result} />
        </View>
      )}

      {response?.status === 'result' && response.projection && (
        <View style={styles.card}>
          <Text style={styles.smallText}>{describeProjection(response.projection)}</Text>
        </View>
      )}

      <AffordabilityChat
        key={chatKey}
        visible={!!chatAnchorResult}
        onClose={() => setChatAnchorResult(null)}
        anchorResult={chatAnchorResult}
      />
    </View>
  );
}

const inlineStyles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
  },
  input: {
    width: 220,
  },
  // Solid filled circle + a real Material Icons glyph (Google's own icon
  // set, already ships with Expo - no new native dependency), per direct
  // user request (2026-08-20): "not some emoji mic... the one Google
  // uses." Now palette-derived (colors.primary/colors.error) rather than
  // the original hardcoded #1a73e8/#d93025 - same semantic meaning
  // (color alone signals idle vs. recording state), restyled as part of
  // the Budget-tab Sorrel pass.
  micButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonIdle: {
    backgroundColor: colors.primary,
  },
  micButtonRecording: {
    backgroundColor: colors.error,
  },
});
