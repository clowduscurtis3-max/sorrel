import { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS, clamp } from 'react-native-reanimated';
import { colors } from '../_lib/styles';
import { hslToHex, hexToHsl } from '../_lib/color';

// Phase 38 Step 3, replacing an earlier hex-text-input version per direct
// user feedback ("the user isnt going to know color codes... just have
// like a little square for each color of the rainbow, and then a bar below
// them to drag to control ... the shade. dragging all the way to the right
// is white, and all the way to the left is black"). Two-step picker: tap a
// hue swatch, then drag the shade slider - together they cover the same
// "free-form, not a curated palette" requirement the brief asks for
// (millions of reachable hex values via hue x lightness), just via a
// visual control instead of typing one.
//
// Gesture/reanimated pattern (Gesture.Pan + useSharedValue +
// useAnimatedStyle + runOnJS to commit) matches this codebase's one
// existing hand-built drag control, NumberScrollWheel.js - same library
// versions, same idioms, no new native dependency for the drag itself
// (expo-linear-gradient, added this step, is the only new package - a
// thin, no-native-config Expo SDK module for the gradient bar's visual,
// unrelated to the gesture handling).
const HUE_SWATCHES = [0, 30, 55, 120, 175, 220, 265, 320];
const SWATCH_SATURATION = 78;
const THUMB_SIZE = 24;
const SLIDER_HEIGHT = 28;

export default function HomeCardColorPicker({ value, onChange }) {
  // Re-derive a starting hue/lightness from an already-saved color so
  // reopening this picker on a card that already has a color shows the
  // right swatch/slider position, rather than always resetting to red/50%.
  const initial = useMemo(() => (value ? hexToHsl(value) : { h: HUE_SWATCHES[0], l: 50 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [hue, setHue] = useState(initial.h);
  const [sliderWidth, setSliderWidth] = useState(240);

  const lightness = useSharedValue(clamp(initial.l, 0, 100));
  const startLightness = useSharedValue(lightness.value);

  function commitColor(nextHue, nextLightness) {
    onChange(hslToHex(nextHue, SWATCH_SATURATION, nextLightness));
  }

  function selectHue(nextHue) {
    setHue(nextHue);
    commitColor(nextHue, lightness.value);
  }

  // Real bug found by code review, 2026-09-03: `onUpdate` used to call
  // `runOnJS(commitColor)` - a real network PATCH (onChange ->
  // patchSettings, _lib/api.js) - on every single gesture frame during a
  // drag, dozens of queued requests per drag with almost every one
  // immediately superseded by the next. `lightness`/the thumb still
  // update every frame for a smooth live drag (local, no network cost);
  // the actual commit now only fires once, in `.onEnd()`, same "commit
  // once per gesture, not every frame" pattern DraggableCardList.js's own
  // onDragEnd already established for reordering.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          startLightness.value = lightness.value;
        })
        .onUpdate((event) => {
          'worklet';
          const deltaLightness = (event.translationX / sliderWidth) * 100;
          lightness.value = clamp(startLightness.value + deltaLightness, 0, 100);
        })
        .onEnd(() => {
          'worklet';
          runOnJS(commitColor)(hue, lightness.value);
        }),
    [sliderWidth, hue] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (lightness.value / 100) * (sliderWidth - THUMB_SIZE) }],
  }));

  const gradientHue = hslToHex(hue, SWATCH_SATURATION, 50);

  return (
    <View style={pickerStyles.container}>
      <View style={pickerStyles.swatchRow}>
        {HUE_SWATCHES.map((h) => (
          <Pressable
            key={h}
            onPress={() => selectHue(h)}
            accessibilityRole="button"
            accessibilityLabel={`Hue ${h}`}
            style={[
              pickerStyles.swatch,
              { backgroundColor: hslToHex(h, SWATCH_SATURATION, 50) },
              h === hue && pickerStyles.swatchSelected,
            ]}
          />
        ))}
      </View>

      <View
        style={pickerStyles.sliderTrack}
        onLayout={(e) => setSliderWidth(e.nativeEvent.layout.width)}
      >
        <LinearGradient
          colors={['#000000', gradientHue, '#FFFFFF']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={pickerStyles.gradient}
        />
        <GestureDetector gesture={pan}>
          <Animated.View style={[pickerStyles.thumb, thumbStyle]} />
        </GestureDetector>
      </View>
      <Text style={pickerStyles.hint}>Drag the bar for a darker or lighter shade.</Text>
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  container: {
    gap: 10,
  },
  swatchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
  },
  swatchSelected: {
    borderWidth: 2,
    borderColor: colors.darkest,
  },
  sliderTrack: {
    height: SLIDER_HEIGHT,
    borderRadius: SLIDER_HEIGHT / 2,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  gradient: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: SLIDER_HEIGHT / 2,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: colors.background,
    borderWidth: 2,
    borderColor: colors.darkest,
  },
  hint: {
    fontSize: 11,
    color: colors.muted,
  },
});
