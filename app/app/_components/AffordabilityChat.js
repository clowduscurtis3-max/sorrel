import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  ScrollView,
  Button,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from 'react-native';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { styles, colors } from '../_lib/styles';
import { ScenarioResult } from './ScenarioResult';
import { describeProjection } from './AffordabilityQuery';
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
function renderToolResult({ tool, result }) {
  if (tool === 'evaluate_scenario') {
    return <ScenarioResult result={result} />;
  }

  if (tool === 'find_max_comfortable_amount') {
    if (!result.available) return <Text style={styles.smallText}>{result.detail}</Text>;
    return (
      <>
        <Text style={styles.cardTitle}>Comfortable up to ${result.max_comfortable_amount.toFixed(2)}</Text>
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
        <Text style={styles.cardTitle}>Wait until {wait.result.scenario.date}</Text>
        <ScenarioResult result={wait.result} />
      </>
    );
  }

  if (tool === 'project_affordable_date') {
    if (!result.available) return <Text style={styles.smallText}>{result.detail}</Text>;
    return <Text style={styles.smallText}>{describeProjection(result)}</Text>;
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
    if (hasDownPayment) reductionParts.push(`a $${result.down_payment.toFixed(2)} down payment`);
    if (hasTradeIn) reductionParts.push(`a $${result.trade_in_value.toFixed(2)} trade-in`);
    const hasReduction = reductionParts.length > 0;
    // annual_rate_percent may be undefined on a 0%-promo Shopping default
    // (no explicit rate line needed there) - only shown when it's a real
    // number worth surfacing (a fetched Transportation rate, or any
    // hypothetical rate the user proposed on either category).
    const showRate = typeof result.annual_rate_percent === 'number' && (result.is_hypothetical_rate || result.annual_rate_percent > 0);
    return (
      <Text style={styles.smallText}>
        Estimated payment: ${result.estimated_payment.toFixed(2)}/month over {result.term_months} months
        {hasReduction
          ? ` financing $${result.financed_amount.toFixed(2)} (the $${result.total_price.toFixed(2)} price minus ${reductionParts.join(' and ')})`
          : ` on $${result.total_price.toFixed(2)}`}
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
// The opening message reuses `anchorResult.explanation` verbatim (the
// already-generated, already-paid-for Claude paragraph from
// /affordability/query or /scenarios/compare-buy-now-vs-wait) rather than
// a fresh call - zero new cost for the first line of this thread.
// Real gap found by /code-review (2026-08-22): if the original
// explainScenario call failed (a Claude outage/timeout - a real,
// already-handled case elsewhere, see ScenarioResult.js's own tradeoffs/
// limitations fallback for when `explanation` is null), the chat opened
// completely empty instead of showing the deterministic facts that are
// always present regardless of that call's outcome - a silent gap this
// project's own standing rule ("never goes fully silent on a Claude
// outage") explicitly doesn't allow elsewhere.
function openingMessage(anchorResult) {
  if (anchorResult?.explanation) return anchorResult.explanation;
  const fallback = [anchorResult?.tradeoffs?.[0]?.text, anchorResult?.limitations?.[0]]
    .filter(Boolean)
    .join(' ');
  return fallback || null;
}

export default function AffordabilityChat({ visible, onClose, anchorResult }) {
  const [messages, setMessages] = useState(() => {
    const opening = openingMessage(anchorResult);
    return opening ? [{ role: 'assistant', text: opening }] : [];
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
    const opening = openingMessage(anchorResult);
    setMessages(opening ? [{ role: 'assistant', text: opening }] : []);
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
          <View />
          <View>
            <Button title="Close" onPress={handleClose} />
          </View>
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
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <View key={i} style={styles.chatBubbleUser}>
                  <Text style={styles.chatBubbleUserText}>{m.text}</Text>
                </View>
              ) : (
                <View key={i} style={styles.chatBubbleAssistant}>
                  <Text style={styles.chatBubbleAssistantText}>{m.text}</Text>
                </View>
              )
            )}

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
            {latestResult && <View style={styles.card}>{renderToolResult(latestResult)}</View>}

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
