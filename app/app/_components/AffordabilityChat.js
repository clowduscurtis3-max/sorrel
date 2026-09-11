import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch, apiErrorMessage, formatDecimal, formatDateMDY } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import { ScenarioResult } from './ScenarioResult';
import { describeProjection, buildOpeningSections } from './AffordabilityQuery';
import PrimaryButton from './PrimaryButton';

// Real bug found by adversarial review (2026-08-22): the five chat tools
// (server/affordabilityChat.js) return five genuinely different shapes -
// only evaluate_scenario's matches ScenarioResult.js's own `.explanation`/
// `.tradeoffs`/`.limitations` contract. `new_result` is now tagged
// `{ tool, result }` server-side specifically so this can render each shape
// correctly instead of assuming every result looks like evaluate_scenario's
// and crashing on the other four. Mirrors the equivalent per-intent
// branches AffordabilityQuery.js already has for the single-shot flow
// (`response.max_comfortable`/`response.projection`), just keyed off the
// tool name instead of a response status.
function renderToolResult({ tool, result }, styles) {
  if (tool === 'evaluate_scenario') {
    return <ScenarioResult result={result} />;
  }

  if (tool === 'find_max_comfortable_amount') {
    if (!result.available) return <Text style={styles.smallText}>{result.detail}</Text>;
    return (
      <>
        <Text style={styles.cardTitle}>Comfortable up to ${formatDecimal(result.max_comfortable_amount)}</Text>
        <ScenarioResult result={result.boundary_result} />
      </>
    );
  }

  if (tool === 'compare_buy_now_vs_wait') {
    if (!result.available) return <Text style={styles.smallText}>{result.detail}</Text>;
    const [buyNow, wait] = result.comparison.scenarios;
    return (
      <>
        <Text style={styles.cardTitle}>Buy now</Text>
        <ScenarioResult result={buyNow.result} />
        <Text style={styles.cardTitle}>Wait until {formatDateMDY(wait.result.scenario.date)}</Text>
        <ScenarioResult result={wait.result} />
      </>
    );
  }

  if (tool === 'project_affordable_date') {
    // Phase 42 (multi-goal tracking, 2026-09-08): this now answers per
    // goal ({ available, goals: [...] }) since the chat has no way to know
    // which goal the user means - one line per goal, prefixed with its
    // name only when there's more than one to disambiguate.
    const projectionGoals = result.goals || [];
    if (!result.available || projectionGoals.length === 0) {
      return (
        <Text style={styles.smallText}>
          {result.detail || "No goal is set, so there's no observed saving rate to project from."}
        </Text>
      );
    }
    return (
      <>
        {projectionGoals.map((g) => (
          <Text key={g.goal_id} style={styles.smallText}>
            {projectionGoals.length > 1 ? `${g.notes || g.goal_type}: ` : ''}
            {g.available ? describeProjection(g) : g.detail || 'Not available for this goal.'}
          </Text>
        ))}
      </>
    );
  }

  if (tool === 'estimate_financing_payment') {
    const hasDownPayment = result.down_payment > 0;
    const hasTradeIn = result.trade_in_value > 0;
    // Describes whichever of down payment / trade-in (or both) reduced the
    // financed amount below the full price - down payment and trade-in are
    // two separate, independently-verified numbers (see affordabilityChat.js's
    // own header note on why they're never folded into one), so both get
    // named here rather than only ever showing one.
    let reductionParts = [];
    if (hasDownPayment) reductionParts.push(`a $${formatDecimal(result.down_payment)} down payment`);
    if (hasTradeIn) reductionParts.push(`a $${formatDecimal(result.trade_in_value)} trade-in`);
    const hasReduction = reductionParts.length > 0;
    // annual_rate_percent may be undefined on a 0%-promo Shopping default
    // (no explicit rate line needed there) - only shown when it's a real
    // number worth surfacing (a fetched Transportation rate, or any
    // hypothetical rate the user proposed on either category).
    const showRate = typeof result.annual_rate_percent === 'number' && (result.is_hypothetical_rate || result.annual_rate_percent > 0);
    return (
      <Text style={styles.smallText}>
        Estimated payment: ${formatDecimal(result.estimated_payment)}/month over {result.term_months} months
        {hasReduction
          ? ` financing $${formatDecimal(result.financed_amount)} (the $${formatDecimal(result.total_price)} price minus ${reductionParts.join(' and ')})`
          : ` on $${formatDecimal(result.total_price)}`}
        {showRate ? ` at ${result.annual_rate_percent}%${result.is_hypothetical_rate ? ' (hypothetical)' : ''}.` : '.'}
      </Text>
    );
  }

  return null;
}

// "AI-narrated responses + conversation memory" follow-up (CLAUDE.md) - a
// "More details" link opened from a result card (AffordabilityQuery.js)
// opens this into a real, if scoped, back-and-forth about that ONE
// purchase. Additive on top of /affordability/query - that route, its
// endpoint contract, and its own UI are all completely unchanged; this is a
// second, independent front door, not a replacement.
//
// SESSION-ONLY MEMORY, NEVER PERSISTED: `messages` is plain component state
// that's gone the moment this Modal closes - there is no server-side
// conversation storage anywhere (see server/affordabilityChat.js's own
// header). The full history is resent to /affordability/chat on every
// message, same statelessness AffordabilityQuery.js's own pendingContext
// echo already uses for the single clarification round trip, just
// generalized to a whole thread.
//
// Deliberately a plain <Modal>, not a router route - this app has already
// paid for that lesson once (see AccountMenu.js's own header: a
// router-route-based modal caused three compounding bugs, including a real
// infinite navigation loop, before being rebuilt this way). A conversation
// thread with its own back-and-forth state is exactly the kind of thing
// that has no business being independently resolvable by a cold app
// launch/deep link.
//
// The opening reuses `anchorResult.explanation` (the already-generated,
// already-paid-for Claude call from /affordability/query) rather than a
// fresh call - zero new cost for the first thing this chat shows. Direct
// user request (2026-08-25): the old single paragraph read as a wall of
// text once several tradeoffs/caveats stacked up - restructured
// server-side (see scenarioExplain.js) into three short, separately
// labeled sections instead: why (reasoning), where money could come from
// (possible_room), and what Sorrel would actually do (recommended_actions).
// `buildOpeningSections` itself now lives in AffordabilityQuery.js
// (2026-08-28) - the main result screen shows two of its three sections
// directly (see that file's own "Why" card), so this chat and that screen
// share one implementation rather than two copies that could drift apart.

// Plain-text version of the sections, sent as the conversation's first
// assistant turn so a follow-up like "what did you mean by that" still has
// real context - anchor_result is already given to the model separately
// (see server/affordabilityChat.js's systemPrompt), this is purely for
// natural conversational continuity, not the model's only source of facts.
function sectionsToPlainText(sections) {
  if (!sections) return null;
  return [
    sections.reasoning,
    `Possible room: ${sections.possible_room}`,
    `What Sorrel would do: ${sections.recommended_actions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export default function AffordabilityChat({ visible, onClose, anchorResult }) {
  const { colors, styles } = useTheme();
  const chatStyles = useMemo(() => buildChatStyles(colors), [colors]);
  const [messages, setMessages] = useState(() => {
    const sections = buildOpeningSections(anchorResult);
    const text = sectionsToPlainText(sections);
    return text ? [{ role: 'assistant', text, sections }] : [];
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [latestResult, setLatestResult] = useState(null);
  const [endedTooLong, setEndedTooLong] = useState(false);
  // The 72px gesture-bar clearance below only makes sense with the
  // keyboard closed - once it's open, KeyboardAvoidingView has already
  // pushed the input up above the keyboard, so stacking the same fixed
  // padding on top of that just leaves a big empty gap between the input
  // and the keyboard (confirmed on-device, 2026-08-22, screenshot showed
  // it). Android fires 'keyboardDidShow'/'keyboardDidHide'; iOS would need
  // the 'Will' variants for the same smoothness, but this app is
  // Android-only in current testing (see CLAUDE.md).
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const scrollRef = useRef(null);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending || endedTooLong) return;

    const nextMessages = [...messages, { role: 'user', text }];
    setMessages(nextMessages);
    setInput('');
    setError(null);
    setSending(true);
    try {
      const res = await apiFetch('/affordability/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor_result: anchorResult, messages: nextMessages }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 400 ? body.error || 'SERVER_ERROR' : 'SERVER_ERROR');
      }
      const body = await res.json();
      setMessages((prev) => [...prev, { role: 'assistant', text: body.text }]);
      setLatestResult(body.new_result || null);
      if (body.too_long) setEndedTooLong(true);
    } catch (err) {
      console.error(err);
      // The failed message stays visible in the thread (same "don't hide
      // what was already typed/sent" convention as AffordabilityQuery.js's
      // own error handling) - only a separate error line is shown, not a
      // silent retry or a removed bubble.
      setError(err.message === 'SERVER_ERROR' ? apiErrorMessage(err) : err.message);
    } finally {
      setSending(false);
    }
  }

  function startNewConversation() {
    const sections = buildOpeningSections(anchorResult);
    const text = sectionsToPlainText(sections);
    setMessages(text ? [{ role: 'assistant', text, sections }] : []);
    setInput('');
    setError(null);
    setLatestResult(null);
    setEndedTooLong(false);
  }

  function handleClose() {
    // Closing genuinely discards the thread - there is nothing to save, by
    // design (see this file's own header). A fresh open next time starts
    // from the same anchor_result's explanation, not where this one left
    // off.
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Pressable
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
          >
            <MaterialIcons name="arrow-back" size={24} color={colors.darkest} />
          </Pressable>
          <View />
        </View>

        <View style={styles.header}>
          <Text style={styles.cardTitle}>More about this purchase</Text>
          <Text style={styles.smallText}>
            Ask a follow-up or a genuine what-if - Sorrel stays focused on this one purchase.
          </Text>
        </View>

        {/* This app has never needed KeyboardAvoidingView before this
            screen - a plain <Modal> renders in its own native window on
            Android and doesn't automatically follow the parent Activity's
            windowSoftInputMode resize behavior, so without this the
            keyboard just covers the input entirely (confirmed on-device,
            2026-08-22). "height" (not "padding") on Android - "padding"
            can leave a gap under the keyboard on some devices/Android
            versions; "height" reliably shrinks the content area instead.
            iOS keeps "padding", the standard choice there. */}
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1, paddingHorizontal: 24 }}
            contentContainerStyle={{ gap: 12, paddingBottom: 16 }}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.map((m, i) => {
              if (m.role === 'user') {
                return (
                  <View key={i} style={styles.chatBubbleUser}>
                    <Text style={styles.chatBubbleUserText}>{m.text}</Text>
                  </View>
                );
              }
              // The opening message (the only one that ever carries
              // `sections`) renders as three short, separately-labeled
              // blocks instead of one paragraph - every later assistant
              // reply is a real conversational turn and stays a plain
              // bubble.
              if (m.sections) {
                return (
                  <View key={i} style={[styles.card, chatStyles.sectionsCard]}>
                    <View style={chatStyles.sectionBlock}>
                      <Text style={chatStyles.sectionLabel}>WHY</Text>
                      <Text style={styles.text}>{m.sections.reasoning}</Text>
                    </View>
                    <View style={chatStyles.sectionBlock}>
                      <Text style={chatStyles.sectionLabel}>POSSIBLE ROOM</Text>
                      <Text style={styles.text}>{m.sections.possible_room}</Text>
                    </View>
                    <View style={chatStyles.sectionBlock}>
                      <Text style={chatStyles.sectionLabel}>SORREL'S RECOMMENDED ACTIONS</Text>
                      <Text style={styles.text}>{m.sections.recommended_actions}</Text>
                    </View>
                  </View>
                );
              }
              return (
                <View key={i} style={styles.chatBubbleAssistant}>
                  <Text style={styles.chatBubbleAssistantText}>{m.text}</Text>
                </View>
              );
            })}

            {/* A tool-triggered what-if surfaces its own real, freshly-computed
                result inline - renderToolResult (this file's own dispatcher,
                defined above) picks the right rendering for whichever of the
                five tools actually ran, reusing ScenarioResult wherever a
                result is evaluate_scenario-shaped rather than a second
                rendering of the same status/tradeoffs/limitations shape.
                Real bug found by the user's own /code-review pass
                (2026-08-22): this call site still passed the raw {tool,
                result} wrapper straight into ScenarioResult instead of
                through the dispatcher that exists specifically to unwrap
                it - the dispatcher was defined but never actually wired in,
                so the crash this same session's own adversarial review
                found and "fixed" was never actually fixed on this line. */}
            {latestResult && <View style={styles.card}>{renderToolResult(latestResult, styles)}</View>}

            {sending && <ActivityIndicator />}
            {error && <Text style={styles.errorText}>{error}</Text>}
          </ScrollView>

          {endedTooLong ? (
            <View style={{ paddingHorizontal: 24, paddingBottom: 24, gap: 8 }}>
              <PrimaryButton title="Start a new conversation" onPress={startNewConversation} />
            </View>
          ) : (
            // paddingBottom: 72 (keyboard closed) matches this app's own
            // established gesture-bar-clearance value (see
            // styles.goalScreen) - scoped to this one row rather than added
            // to the shared `container` style, since that exact mistake
            // (padding leaking into every screen that uses `container`)
            // was already made and fixed once before in this app (Phase 7,
            // Home's "white box" bug). Drops to a small 8px once the
            // keyboard is open, since KeyboardAvoidingView has already
            // positioned the input just above it at that point - keeping
            // 72 there stacked on top of the keyboard's own offset and
            // left a large empty gap.
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 24,
                paddingBottom: keyboardVisible ? 8 : 72,
              }}
            >
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={input}
                onChangeText={setInput}
                placeholder="Ask a follow-up..."
                placeholderTextColor={colors.placeholder}
                editable={!sending}
                onSubmitEditing={sendMessage}
              />
              <PrimaryButton title="Send" onPress={sendMessage} disabled={!input.trim()} loading={sending} />
            </View>
          )}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function buildChatStyles(colors) {
  return StyleSheet.create({
    sectionsCard: {
      gap: 14,
    },
    sectionBlock: {
      gap: 4,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: colors.dark,
    },
  });
}
