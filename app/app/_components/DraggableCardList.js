import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { MaterialIcons } from '@expo/vector-icons';
import { colors } from '../_lib/styles';

// Phase 38 Step 3, replacing up/down arrows per direct user feedback
// ("i dont like the way there are up and down arrows to move each box up
// and down. would rather long press on them to make them shake, then drag
// them to an x to delete, or drop in a new order, exactly like apple does
// there home screen"). Long-press any row to enter edit mode (every row
// wiggles, a delete badge appears); drag a row to reorder within this
// list; tap a row's badge to remove it (hide the card, in
// settings/home.js's case) instead of dragging to a fixed trash target -
// simpler to reach reliably on a short list than a drop-zone elsewhere on
// screen, same end result.
//
// Same Gesture.Pan + reanimated shared-value idiom as this codebase's one
// existing hand-built drag control, NumberScrollWheel.js - no new
// dependency for the drag/wiggle itself.
const SLOT_HEIGHT = 76;

function Row({ itemKey, node, index, editing, onLongPress, onEditingChange, onDragUpdate, onDragEnd, onDelete }) {
  const translateY = useSharedValue(index * SLOT_HEIGHT);
  const isDragging = useSharedValue(false);
  const wiggle = useSharedValue(0);
  // Mirrors the `index` prop on the UI thread so the gesture worklets
  // below can read a live value without closing over the plain JS prop
  // directly - what actually lets `pan`/`tap`/`longPress` be built once
  // (useMemo, below) instead of torn down and rebuilt on every
  // reorder-triggered re-render.
  const indexShared = useSharedValue(index);
  // Snapshotted once when a drag starts and held fixed for its entire
  // duration. Real bug found by code review, 2026-09-03: the old version
  // computed `translateY` from the LIVE `index` every frame
  // (`index * SLOT_HEIGHT + event.translationY`) - but `index` changes
  // mid-drag the instant the drag crosses another row's boundary
  // (onUpdate -> parent reorders `liveOrder` -> this row's own `index`
  // prop changes), so the very next frame's `translateY` jumped by a
  // full SLOT_HEIGHT with `event.translationY` roughly unchanged -
  // visible on-device as the dragged card suddenly snapping. Basing the
  // drag's visual position on where the row STARTED (fixed) instead of
  // "wherever the list currently thinks it is" is the standard fix for
  // this class of drag-reorder bug.
  const dragStartIndex = useSharedValue(index);

  // Always-current refs for the callbacks the memoized gesture below
  // calls via runOnJS. Necessary specifically because the gestures are
  // now built once per mount (see the useMemo calls below) rather than
  // fresh every render: without this indirection, a memoized gesture
  // would close over whichever render's onDragEnd/onLongPress/etc. it
  // happened to be built from and keep calling THAT one forever - for
  // onDragEnd in particular, the parent's own handler closes over
  // `liveOrder` state that changes on every reorder, so a stale closure
  // would commit a stale order instead of the list's current one.
  const onDragUpdateRef = useRef(onDragUpdate);
  onDragUpdateRef.current = onDragUpdate;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;

  useEffect(() => {
    indexShared.value = index;
    if (!isDragging.value) {
      translateY.value = withSpring(index * SLOT_HEIGHT, { damping: 20, stiffness: 200 });
    }
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Dialed back per direct user feedback, 2026-09-03 ("dial back the
    // wiggling just a tad, its a bit intense") - was ±1.5deg/100ms per
    // leg (a 200ms full cycle); now ±0.9deg/140ms (a 280ms cycle), a
    // calmer wiggle without losing the "these are now editable" signal.
    if (editing) {
      wiggle.value = withRepeat(
        withSequence(withTiming(-0.9, { duration: 140 }), withTiming(0.9, { duration: 140 })),
        -1,
        true
      );
    } else {
      wiggle.value = withTiming(0, { duration: 100 });
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleDragUpdate(proposedIndex) {
    onDragUpdateRef.current(itemKey, proposedIndex);
  }
  function handleDragEnd() {
    onDragEndRef.current();
  }
  function handleLongPress() {
    onLongPressRef.current();
  }
  function handleEditingChange(next) {
    onEditingChangeRef.current(next);
  }

  // `editing` deliberately switches which gesture is attached at the
  // GestureDetector level below (the ternary), not via a per-gesture
  // `.enabled()` call - that's what lets these be built exactly once per
  // row (empty dep arrays) instead of on every render. Shared values
  // (translateY/isDragging/dragStartIndex/indexShared) are themselves
  // stable references across re-renders, so closing over them here is
  // safe by Reanimated's own design.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          'worklet';
          isDragging.value = true;
          dragStartIndex.value = indexShared.value;
        })
        .onUpdate((event) => {
          'worklet';
          translateY.value = dragStartIndex.value * SLOT_HEIGHT + event.translationY;
          const proposedIndex = Math.round(translateY.value / SLOT_HEIGHT);
          runOnJS(handleDragUpdate)(proposedIndex);
        })
        .onEnd(() => {
          'worklet';
          isDragging.value = false;
          translateY.value = withSpring(indexShared.value * SLOT_HEIGHT, { damping: 20, stiffness: 200 });
          runOnJS(handleDragEnd)();
        }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Real gap found by direct user feedback, 2026-09-03: while editing, a
  // plain tap on a row (no drag) did nothing - Pan's own gesture consumed
  // the touch without acting on it, and there was no way to exit edit
  // mode except the "Done" link. Raced against Pan (Gesture.Race - RNGH's
  // standard tap-vs-drag disambiguation): Tap only activates on release
  // with minimal movement, so a real drag still wins and reorders as
  // before; a plain tap now exits edit mode, matching "the user should be
  // able to just tap the screen when done."
  const tap = useMemo(
    () =>
      Gesture.Tap().onEnd(() => {
        'worklet';
        runOnJS(handleEditingChange)(false);
      }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const longPress = useMemo(
    () =>
      Gesture.LongPress().onStart(() => {
        'worklet';
        runOnJS(handleLongPress)();
      }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { rotate: `${wiggle.value}deg` }],
    zIndex: isDragging.value ? 10 : 1,
    elevation: isDragging.value ? 10 : 0,
  }));

  return (
    <GestureDetector gesture={editing ? Gesture.Race(pan, tap) : longPress}>
      <Animated.View style={[localStyles.row, animatedStyle]}>
        {editing && (
          <Pressable
            style={localStyles.deleteBadge}
            onPress={() => onDelete(itemKey)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Remove"
          >
            <MaterialIcons name="close" size={14} color={colors.background} />
          </Pressable>
        )}
        {node}
      </Animated.View>
    </GestureDetector>
  );
}

// `items`: [{ key, node }] in the currently-committed order. `onReorder`
// fires once per completed drag with the full new key order (not on every
// intermediate frame) - the caller decides how/when to persist it.
// `onDelete(key)` and `editing`/`onEditingChange` are lifted to the parent
// so multiple lists on one screen (this screen's two stat-boundary groups)
// can share one edit-mode toggle - entering edit mode on any row's long
// press puts every list on the screen into edit mode together, matching
// the iOS home-screen behavior this is modeled on.
export default function DraggableCardList({ items, onReorder, onDelete, editing, onEditingChange }) {
  const [liveOrder, setLiveOrder] = useState(items.map((i) => i.key));

  useEffect(() => {
    // Re-sync from the committed order whenever it changes for a reason
    // other than this list's own drag (a delete, a color change re-render,
    // or the initial load) - but never while a drag from THIS list is in
    // progress, which already owns liveOrder until it commits.
    setLiveOrder(items.map((i) => i.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.key).join(',')]);

  function handleDragUpdate(draggedKey, proposedIndex) {
    setLiveOrder((current) => {
      const from = current.indexOf(draggedKey);
      const to = Math.max(0, Math.min(current.length - 1, proposedIndex));
      if (from === -1 || from === to) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, draggedKey);
      return next;
    });
  }

  function handleDragEnd() {
    onReorder(liveOrder);
  }

  const nodeByKey = Object.fromEntries(items.map((i) => [i.key, i.node]));

  return (
    // The 8px gap below each row (SLOT_HEIGHT minus the row's own height,
    // see localStyles.row) isn't covered by any Row's own GestureDetector -
    // wrapping the whole stack in one Pressable catches a tap that lands
    // in that gap too, same "tap the screen when done" exit as tapping a
    // row directly (Row's own Race(pan,tap) handles that case; this
    // Pressable is purely a backstop for the small gaps between rows,
    // matching plain RN Pressable already used for deleteBadge in this
    // same file rather than mixing in a second gesture-handler primitive
    // for what's just a plain tap target).
    <Pressable
      style={{ height: liveOrder.length * SLOT_HEIGHT }}
      onPress={() => editing && onEditingChange(false)}
      disabled={!editing}
    >
      {liveOrder.map((key) => (
        <Row
          key={key}
          itemKey={key}
          node={nodeByKey[key]}
          index={liveOrder.indexOf(key)}
          editing={editing}
          onLongPress={() => onEditingChange(true)}
          onEditingChange={onEditingChange}
          onDragUpdate={handleDragUpdate}
          onDragEnd={handleDragEnd}
          onDelete={onDelete}
        />
      ))}
    </Pressable>
  );
}

const localStyles = StyleSheet.create({
  row: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SLOT_HEIGHT - 8,
  },
  deleteBadge: {
    position: 'absolute',
    top: -6,
    left: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    borderWidth: 2,
    borderColor: colors.background,
  },
});
