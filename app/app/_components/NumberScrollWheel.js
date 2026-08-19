import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  withDecay,
  runOnJS,
  cancelAnimation,
} from 'react-native-reanimated';

// Phase 5 Step 3 (later revision, 2026-08-13): a real velocity-based
// numeric scroll wheel, per direct user feedback - the native
// @react-native-picker/picker (still used for the category dropdown
// elsewhere in this app - a short, unordered list, where a native dropdown
// is the right tool) has no concept of scroll speed at all; every item is
// a fixed, equally-weighted row, so a flick and a slow drag move through
// the list identically. That's fine for ~10 categories, but wrong for a
// wide numeric range (a purchase amount, a savings goal) - the user
// explicitly wants a fast flick to cover a lot of ground (e.g. 1-9999) and
// a slow drag to land precisely, which a fixed-item-list picker structurally
// can't do no matter how its items are tiered.
//
// Built on react-native-gesture-handler + react-native-reanimated - both
// already installed for Phase 7's router/navigation work, so this needed
// no new native dependency and no further EAS build. withDecay is
// Reanimated's own momentum-animation primitive (built for exactly this:
// take a release velocity and let a value coast to a stop under
// deceleration), which is what actually produces "fast flick = big jump,"
// not a hand-rolled physics approximation.
//
// NOT yet tuned on a real device - the user was away from home when this
// was built, so PIXELS_PER_STEP (how many pixels of drag equal one `step`)
// and the deceleration rate are reasonable starting guesses, not measured.
// If dragging feels too twitchy or too sluggish once actually tried, this
// is the first place to adjust.
const PIXELS_PER_STEP = 6;
const ROW_HEIGHT = 36;
const VISIBLE_ROWS = 5; // must be odd - equal rows above/below the center

function clamp(v, min, max) {
  'worklet';
  return Math.min(max, Math.max(min, v));
}

// value/onValueChange: plain numbers, not strings - callers already
// converting to/from a string-based form field (GoalForm.js's goalAmount)
// do that conversion at the call site, same as the native Picker version
// this replaces did.
export default function NumberScrollWheel({
  value,
  onValueChange,
  min = 0,
  max = 9999,
  step = 1,
  formatLabel = (v) => String(v),
}) {
  // The live position while dragging/decelerating, UI-thread only.
  // `displayValue` (plain React state) is the throttled, step-rounded
  // reflection of it that's actually rendered and reported to the parent.
  const position = useSharedValue(clamp(value, min, max));
  const [displayValue, setDisplayValue] = useState(clamp(value, min, max));
  // Snapshot of `position` taken at the start of each gesture - see the
  // onUpdate comment below for why this replaced a changeY-based delta.
  const startPosition = useSharedValue(clamp(value, min, max));

  // Keeps this genuinely controlled: `position`/`displayValue` are only
  // initialized from `value` once (the useState/useSharedValue calls
  // above), so without this, an external change to `value` after mount
  // would be silently ignored - GoalForm.js's "Clear target amount" and
  // Cancel/reset() both happen to work today only because that wheel is
  // conditionally rendered and remounts fresh on every open, not because
  // this component actually tracks external changes. Guarded on an actual
  // mismatch so this never fights an in-progress drag/decay by re-snapping
  // to the same value every render.
  useEffect(() => {
    const clamped = clamp(value, min, max);
    if (clamped !== displayValue) {
      position.value = clamped;
      setDisplayValue(clamped);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, min, max]);

  function commit(raw) {
    const snapped = clamp(Math.round(raw / step) * step, min, max);
    setDisplayValue(snapped);
    onValueChange(snapped);
  }

  // Bridges the UI-thread position back to JS state/the parent callback.
  // Only fires when the *rounded* value actually changes frame-to-frame,
  // not on every sub-pixel movement - naturally throttled to at most once
  // per native frame (~60/sec) even during a fast flung decay that sweeps
  // through many steps, since this compares against the previous frame's
  // value rather than enumerating every step crossed.
  useAnimatedReaction(
    () => position.value,
    (current, previous) => {
      // Reanimated's mapper always fires once at registration with
      // `previous === null` - a real bug found by /code-review (2026-08-14):
      // the old guard only compared rounded current/previous when previous
      // wasn't null, so that first, gesture-less call fell through and
      // called commit() on every mount, silently reporting `value` right
      // back to the caller before any drag. Skip that initial call outright
      // rather than trying to make it compare equal to something.
      if (previous === null) return;
      if (Math.round(current / step) === Math.round(previous / step)) return;
      runOnJS(commit)(current);
    }
  );

  // Phase 13: memoized - this used to be rebuilt from scratch on every
  // render, and `commit()` above triggers a render on every single step
  // crossed (via `setDisplayValue`). At PIXELS_PER_STEP = 6 (already
  // flagged above as untuned/sensitive), an ordinary drag crosses many
  // steps per second, so a fresh `Gesture.Pan()` was being handed to
  // `GestureDetector` - and its native gesture recognizer re-attached -
  // dozens of times per second. That's a real native-thread cost, not
  // just cheap JS work, and independent of whatever the JS-rendered rows
  // are doing - almost certainly the actual source of the wheel reading
  // as choppy even after the row-strip sliding fix below. `position` is a
  // stable shared-value ref (never changes identity), so only `min`/`max`
  // can actually invalidate this memo in practice.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          cancelAnimation(position);
          startPosition.value = position.value;
        })
        .onUpdate((event) => {
          'worklet';
          // Real bug found on-device (2026-08-19), confirmed via a logcat
          // trace (adb, device connected over USB) rather than guessed:
          // `event.changeY` was `undefined` on every single onUpdate call
          // throughout an entire drag, not just the first one as the old
          // comment here assumed - so `changeY ?? 0` silently meant
          // `position` never moved during a drag at all, only on release
          // (onEnd's `velocityY` populates fine, so a flick's decay
          // animation was the only thing that ever visibly worked). The
          // same trace confirmed `event.translationY` (total movement
          // since gesture start, not frame-to-frame delta) populates
          // correctly and reliably on this react-native-gesture-handler
          // version (2.28.0) - switched to that, computed against
          // `startPosition` (snapshotted in onStart) rather than
          // accumulating a per-frame delta.
          //
          // Dragging the finger UP (negative translationY) increases the
          // value - matches this app's other upward-is-more conventions
          // and is the more common feel for this kind of control.
          const next = startPosition.value - event.translationY / PIXELS_PER_STEP;
          position.value = clamp(next, min, max);
        })
        .onEnd((event) => {
          'worklet';
          const velocityY = event.velocityY ?? 0;
          position.value = withDecay({
            velocity: -velocityY / PIXELS_PER_STEP,
            clamp: [min, max],
          });
        }),
    [position, startPosition, min, max]
  );

  // Phase 13: the row *contents* still only update step-by-step (rows are
  // re-derived from `displayValue`, the snapped React state, exactly as
  // before) - what's new is that the strip's on-screen position slides
  // continuously between those updates instead of jumping. `BUFFER_ROWS`
  // extra rows are rendered on each end so a row is always available to
  // fill the edge the strip is sliding toward; the container below clips
  // them at rest via `overflow: 'hidden'`, so this is invisible until a
  // drag is in progress.
  //
  // Second bug found after the first version of this fix, on-device
  // (2026-08-19): a single buffer row assumed `position` never drifts more
  // than half a step from `displayValue` before `commit()` re-centers it -
  // true only if the JS thread keeps up every frame. Under a fast flick,
  // `useAnimatedReaction` fires once per *frame*, not once per step - a
  // high-velocity `withDecay` can move `position` several steps within one
  // frame, and the JS round-trip through `runOnJS(commit)` can lag behind
  // that for a few frames under load. During that lag, the real offset
  // between `position` and the still-stale `displayValue` can exceed one
  // row's worth of buffer, translating the strip past every rendered row -
  // the reported "numbers disappear" gap, not just choppiness.
  const BUFFER_ROWS = 3;
  const half = Math.floor(VISIBLE_ROWS / 2);
  const rows = [];
  for (let i = -half - BUFFER_ROWS; i <= half + BUFFER_ROWS; i++) {
    rows.push(displayValue + i * step);
  }

  const animatedStyle = useAnimatedStyle(() => {
    const rawOffsetSteps = (position.value - displayValue) / step;
    // Clamped to the buffer actually rendered above - without this, a
    // fast-flick desync translates past the last rendered row into blank
    // space instead of just briefly holding at the buffer's edge until the
    // next commit re-centers things. A visible momentary hold reads as a
    // minor rough edge; a blank gap reads as a bug.
    const offsetSteps = clamp(rawOffsetSteps, -BUFFER_ROWS, BUFFER_ROWS);
    return { transform: [{ translateY: -offsetSteps * ROW_HEIGHT }] };
  }, [displayValue, step]);

  return (
    <GestureDetector gesture={pan}>
      <View style={localStyles.wheel}>
        <Animated.View style={animatedStyle}>
          {rows.map((v) => (
            <Text
              key={v}
              style={[
                localStyles.row,
                v === displayValue ? localStyles.rowSelected : localStyles.rowDim,
              ]}
            >
              {v >= min && v <= max ? formatLabel(v) : ''}
            </Text>
          ))}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const localStyles = StyleSheet.create({
  wheel: {
    height: ROW_HEIGHT * VISIBLE_ROWS,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  row: {
    height: ROW_HEIGHT,
    lineHeight: ROW_HEIGHT,
    fontSize: 16,
  },
  rowSelected: {
    fontSize: 22,
    fontWeight: '700',
    color: '#000',
  },
  rowDim: {
    color: '#999',
  },
});
