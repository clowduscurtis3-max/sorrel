import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, useAnimatedReaction, withDecay, runOnJS, cancelAnimation } from 'react-native-reanimated';

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
      if (previous !== null && Math.round(current / step) === Math.round(previous / step)) return;
      runOnJS(commit)(current);
    }
  );

  const pan = Gesture.Pan()
    .onStart(() => {
      cancelAnimation(position);
    })
    .onUpdate((event) => {
      'worklet';
      // Dragging the finger UP (negative changeY) increases the value -
      // matches this app's other upward-is-more conventions and is the
      // more common feel for this kind of control.
      // event.changeY has been observed undefined on the very first
      // onUpdate of a gesture (react-native-gesture-handler 2.28.0) -
      // treated as zero movement for that frame rather than propagating
      // NaN into `position`, which otherwise stays NaN forever since it's
      // a Reanimated shared value.
      const changeY = event.changeY ?? 0;
      const next = position.value - changeY / PIXELS_PER_STEP;
      position.value = clamp(next, min, max);
    })
    .onEnd((event) => {
      'worklet';
      const velocityY = event.velocityY ?? 0;
      position.value = withDecay({
        velocity: -velocityY / PIXELS_PER_STEP,
        clamp: [min, max],
      });
    });

  // Rendered from plain React state, not a literal animated/virtualized
  // strip - simpler and more robust than fully animating each row's
  // sub-pixel position during a drag, at the cost of the tick rows
  // themselves only updating step-by-step rather than sliding smoothly in
  // between. The gesture's own responsiveness and the momentum feel don't
  // depend on this, only the visual polish does - worth revisiting with a
  // fancier animated strip only if this reads as too static once actually
  // tried on-device.
  const half = Math.floor(VISIBLE_ROWS / 2);
  const rows = [];
  for (let i = -half; i <= half; i++) {
    rows.push(displayValue + i * step);
  }

  return (
    <GestureDetector gesture={pan}>
      <View style={localStyles.wheel}>
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
      </View>
    </GestureDetector>
  );
}

const localStyles = StyleSheet.create({
  wheel: {
    height: ROW_HEIGHT * VISIBLE_ROWS,
    alignItems: 'center',
    justifyContent: 'center',
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
