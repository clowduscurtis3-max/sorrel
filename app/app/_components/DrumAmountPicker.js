import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { DrumPicker, withVirtualized } from 'react-native-drum-picker';

// Decided 2026-08-19: NumberScrollWheel (Phase 5 Step 3, hand-rolled on
// react-native-gesture-handler + react-native-reanimated) was "fairly
// smooth" once its real drag-tracking bug was finally fixed (Phase 13,
// see that file's own header comment), but still not One UI/native-picker
// smooth on direct on-device comparison - its row *text* updates via plain
// React state on every step crossed, a real JS-thread re-render each time,
// unlike a genuinely native widget which never touches the JS bridge for
// content at all.
//
// react-native-drum-picker wraps a real native widget (Kotlin/RecyclerView
// on Android, Swift/UIPickerView on iOS) - purpose-built for New
// Architecture (requires RN 0.76+ with Fabric, which this app already has).
// Scoped as a spike per the user's own explicit direction: wire up only
// this one call site (AffordabilityQuery.js's amount wheel) first, not
// GoalForm.js's usage yet, so there's a clean single before/after
// comparison point before deciding whether to swap the rest.
//
// This wrapper mimics NumberScrollWheel's exact prop contract
// (value/onValueChange/min/max/step/formatLabel) so swapping either call
// site later is a one-line import change, not a rewrite.
//
// withVirtualized is required here, not optional - the library's own docs
// recommend it for 1000+ items, and a $1-$9999 range at $1 steps is 9999
// items. Each item must be a unique string, which formatLabel's dollar
// strings ("$1", "$2", ...) already satisfy.
const VirtualizedDrumPicker = withVirtualized(DrumPicker);

const ITEM_HEIGHT = 40;
const VISIBLE_ITEM_COUNT = 5;

export default function DrumAmountPicker({
  value,
  onValueChange,
  min = 0,
  max = 9999,
  step = 1,
  formatLabel = (v) => String(v),
  // Real bug found on-device (2026-08-19): dragging this picker sometimes
  // scrolled the surrounding ScrollView at the same time - an intermittent
  // Android nested-touch race, not a fixed border/hitbox issue as it first
  // looked. The native picker (android/.../DrumPickerView.kt) does call
  // requestDisallowInterceptTouchEvent once its RecyclerView recognizes a
  // scroll, but Android decides whether an ancestor ScrollView intercepts
  // a given touch *before* that event reaches the child on each move, so a
  // fast/early drag can still get stolen on the very first move, before
  // the picker's own disallow call has had a chance to land - matching the
  // "sometimes" in the report exactly, not a border being too generous.
  // Fixing the race itself would mean patching the library's native code;
  // instead these two optional callbacks let a parent ScrollView disable
  // its own scrolling for the duration of the touch, so there's no race to
  // lose in the first place - same "sidestep it, don't out-guess a native
  // touch-timing race" instinct as this app's own NumberScrollWheel fixes.
  //
  // Second real bug found on-device (2026-08-19), diagnosed via a live
  // adb logcat pull rather than guessed: the first version of this drove
  // these two callbacks off a plain View's onTouchStart/onTouchEnd/
  // onTouchCancel wrapped around the native picker. That's exactly the
  // shape React Native's own touch responder system warns about - the
  // native picker calls NativeGestureUtil.notifyNativeGestureStarted/Ended
  // (confirmed in its Kotlin source) to tell RN's bridge "I'm handling
  // this gesture myself, don't track it" - which left RN's JS-side
  // responder bookkeeping out of sync with what the wrapper View's touch
  // handlers assumed. Logcat showed the exact symptom:
  // `E/ReactNative: Unexpected state: received touch event but didn't get
  // starting ACTION_DOWN for this gesture before` /
  // `W/ReactNative: Can't cancel already finished gesture. Is a child View
  // trying to start a gesture from an UP/CANCEL event?` - RN's own error
  // message describing precisely this wrapper. When that desync hit,
  // onTouchEnd could silently never fire after a real onTouchStart,
  // leaving the parent ScrollView's scroll permanently disabled ("freezes")
  // until some later, unrelated touch happened to fire the missed unlock
  // mid-gesture ("and then scrolls the screen instead") - matching the
  // user's report exactly.
  //
  // Fixed by not touching RN's touch responder system at all: driven off
  // the picker's own onValueChanging (fires on every real scroll tick,
  // per the library's own docs - "may fire many times per second") instead
  // of raw touch events. A short debounce timer calls onInteractionEnd
  // once ticks stop arriving; onChange (fires once the picker settles)
  // clears it immediately too, whichever comes first.
  onInteractionStart,
  onInteractionEnd,
}) {
  const interactionEndTimer = useRef(null);

  function clearInteractionEndTimer() {
    if (interactionEndTimer.current) {
      clearTimeout(interactionEndTimer.current);
      interactionEndTimer.current = null;
    }
  }

  function handleValueChanging() {
    onInteractionStart?.();
    clearInteractionEndTimer();
    interactionEndTimer.current = setTimeout(() => {
      interactionEndTimer.current = null;
      onInteractionEnd?.();
    }, 200);
  }

  useEffect(() => clearInteractionEndTimer, []);
  const items = useMemo(() => {
    const list = [];
    for (let v = min; v <= max; v += step) list.push(formatLabel(v));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, step, formatLabel]);

  function indexForValue(v) {
    const clamped = Math.min(Math.max(v, min), max);
    return Math.min(Math.max(Math.round((clamped - min) / step), 0), items.length - 1);
  }

  const [selectedIndex, setSelectedIndex] = useState(() => indexForValue(value));

  // Same "genuinely controlled" reasoning as NumberScrollWheel: only
  // re-sync from an external `value` change (e.g. GoalForm's Cancel/
  // reset()) when it actually disagrees with the current index, so this
  // never fights an in-progress scroll by re-snapping every render.
  useEffect(() => {
    const idx = indexForValue(value);
    setSelectedIndex((current) => (current === idx ? current : idx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, min, max, step]);

  function handleChange({ nativeEvent }) {
    const idx = nativeEvent.index;
    setSelectedIndex(idx);
    onValueChange(min + idx * step);
    // The picker has settled - no need to wait out the debounce timer.
    clearInteractionEndTimer();
    onInteractionEnd?.();
  }

  return (
    <View style={localStyles.wrapper}>
      <VirtualizedDrumPicker
        items={items}
        selectedIndex={selectedIndex}
        itemHeight={ITEM_HEIGHT}
        visibleItemCount={VISIBLE_ITEM_COUNT}
        hapticFeedback
        onChange={handleChange}
        onValueChanging={handleValueChanging}
        style={localStyles.picker}
      />
    </View>
  );
}

const localStyles = StyleSheet.create({
  // Real bug found on-device (2026-08-19): the parent this renders inside
  // (budgetRow, styles.js) sets `alignItems: 'center'`, which makes a
  // child with no explicit width shrink to its own content width instead
  // of stretching to fill the row - so `picker` below's `width: '100%'`
  // was resolving against this wrapper's own undetermined width, not the
  // row's real width. In practice that collapsed the picker's actual
  // native touchable area down to something barely wider than the number
  // text itself - not a border/hitSlop issue, a real narrow hitbox. Fixed
  // with `alignSelf: 'stretch'`, which overrides the parent's alignItems
  // for just this child so it fills the row's full width, giving `picker`
  // a real, full-width parent to resolve its own 100% against.
  wrapper: {
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  picker: {
    width: '100%',
    height: ITEM_HEIGHT * VISIBLE_ITEM_COUNT,
  },
});
