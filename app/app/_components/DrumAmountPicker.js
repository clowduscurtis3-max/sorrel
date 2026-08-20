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

// This component used to also expose onInteractionStart/onInteractionEnd
// so a parent ScrollView could disable itself while the wheel was being
// touched. Removed (2026-08-19) after three straight attempts at fixing a
// real on-device bug (dragging this wheel can partially scroll the parent
// Budget ScrollView) all either failed to fully stop it or made things
// worse - see budget.js's own header comment for the full history and
// current open-bug status. Not fixed as of this note.
export default function DrumAmountPicker({
  value,
  onValueChange,
  min = 0,
  max = 9999,
  step = 1,
  formatLabel = (v) => String(v),
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
    <View style={localStyles.wrapper}>
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
