import { useEffect, useMemo, useState } from 'react';
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
  onInteractionStart,
  onInteractionEnd,
}) {
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
  }

  return (
    <View
      style={localStyles.wrapper}
      onTouchStart={onInteractionStart}
      onTouchEnd={onInteractionEnd}
      onTouchCancel={onInteractionEnd}
    >
      <VirtualizedDrumPicker
        items={items}
        selectedIndex={selectedIndex}
        itemHeight={ITEM_HEIGHT}
        visibleItemCount={VISIBLE_ITEM_COUNT}
        hapticFeedback
        onChange={handleChange}
        style={localStyles.picker}
      />
    </View>
  );
}

const localStyles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  picker: {
    width: '100%',
    height: ITEM_HEIGHT * VISIBLE_ITEM_COUNT,
  },
});
