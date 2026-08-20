import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { DrumPicker } from 'react-native-drum-picker';

// Replaces both the earlier single continuous wheel (DrumAmountPicker.js,
// deleted) and its tiered-step follow-up (buildTieredDollarValues,
// amountPicker.js, also deleted) - both ran into the same real tradeoff:
// covering a wide dollar range without a long/fast swipe meant either
// losing exact-value precision (tiering - couldn't land on $437, only
// $430/$440) or needing huge swipes (uniform steps), and huge/fast swipes
// are exactly what's been triggering the still-not-fully-solved Budget
// ScrollView conflict all night.
//
// Fixed properly (2026-08-20), per direct user request: an odometer -
// one independent 0-9 wheel per digit, composed into a single number.
// Every wheel only ever has 10 rows, so no single swipe - however fast or
// long - can travel through more than 10 values; reaching any 6-digit
// number is a handful of short spins per digit, never one long drag. Full
// exact-value precision is preserved by construction (there's no tiering
// at all, every digit 0-9 is directly selectable), which the tiered
// version had given up. Plain DrumPicker per digit, not withVirtualized -
// 10 items is far under the library's own 1000+-item recommendation for
// virtualizing, so the extra wrapper would be pure overhead here.
const DIGIT_COUNT = 6; // supports up to 999,999
const ITEM_HEIGHT = 56;
const VISIBLE_ITEM_COUNT = 5;
const TEXT_SIZE = 20;
const SELECTED_TEXT_SIZE = 26;
const DIGIT_ITEMS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function digitsFromValue(value, count) {
  const max = 10 ** count - 1;
  const clamped = Math.min(Math.max(Math.round(value) || 0, 0), max);
  return String(clamped).padStart(count, '0').split('').map(Number);
}

function valueFromDigits(digits) {
  return digits.reduce((acc, d) => acc * 10 + d, 0);
}

export default function DigitAmountPicker({ value, onValueChange, digitCount = DIGIT_COUNT }) {
  const [digits, setDigits] = useState(() => digitsFromValue(value, digitCount));

  // Same "genuinely controlled" reasoning as the deleted DrumAmountPicker:
  // only re-sync from an external `value` change when it actually
  // disagrees with the current digits, so this never fights an
  // in-progress spin by re-snapping every render.
  useEffect(() => {
    const next = digitsFromValue(value, digitCount);
    setDigits((current) => (current.join('') === next.join('') ? current : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, digitCount]);

  function handleDigitChange(position, newDigit) {
    setDigits((current) => {
      if (current[position] === newDigit) return current;
      const next = current.slice();
      next[position] = newDigit;
      onValueChange(valueFromDigits(next));
      return next;
    });
  }

  return (
    <View style={localStyles.card}>
      <Text style={localStyles.dollarSign}>$</Text>
      {digits.map((digit, i) => (
        <View key={i} style={localStyles.digitGroup}>
          {/* A comma every 3 digits from the right, e.g. 6 digits ->
              comma before index 3, matching normal thousands grouping. */}
          {i > 0 && (digitCount - i) % 3 === 0 && <Text style={localStyles.separator}>,</Text>}
          <DrumPicker
            items={DIGIT_ITEMS}
            selectedIndex={digit}
            itemHeight={ITEM_HEIGHT}
            visibleItemCount={VISIBLE_ITEM_COUNT}
            textSize={TEXT_SIZE}
            selectedTextSize={SELECTED_TEXT_SIZE}
            hapticFeedback
            onChange={({ nativeEvent }) => handleDigitChange(i, nativeEvent.index)}
            style={localStyles.digitPicker}
          />
        </View>
      ))}
    </View>
  );
}

const localStyles = StyleSheet.create({
  // "Make it look sharp" per direct user request (2026-08-20) - a real
  // bordered card instead of the wheel just floating unframed in the
  // page, same general idea as this app's other bordered inputs
  // (styles.input).
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  dollarSign: {
    fontSize: SELECTED_TEXT_SIZE,
    fontWeight: '600',
    color: '#333',
    marginRight: 4,
  },
  digitGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  separator: {
    fontSize: SELECTED_TEXT_SIZE,
    fontWeight: '600',
    color: '#333',
    marginHorizontal: 2,
  },
  digitPicker: {
    width: 44,
    height: ITEM_HEIGHT * VISIBLE_ITEM_COUNT,
  },
});
