import { useCallback, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch, apiErrorMessage, patchSettings } from '../_lib/api';
import { styles, colors, isValidHexColor, readableTextColor } from '../_lib/styles';
import { HOME_CARD_GROUP_BEFORE_STATS, HOME_CARD_GROUP_AFTER_STATS, HOME_CARD_TITLES, orderCardGroup } from '../_lib/homeCards';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import SettingsFetchGate from '../_components/SettingsFetchGate';
import DraggableCardList from '../_components/DraggableCardList';
import HomeCardColorPicker from '../_components/HomeCardColorPicker';

const SECTION = 'home_settings';

export default function HomeSettings() {
  const router = useRouter();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);

  const fetchSettings = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/settings');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setSettings(await res.json());
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchSettings();
    }, [fetchSettings])
  );

  async function patchHomeSettings(next) {
    setSettings((prev) => ({ ...prev, [SECTION]: next }));
    setSaving(true);
    setError(null);
    try {
      setSettings(await patchSettings(SECTION, next));
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      fetchSettings();
    } finally {
      setSaving(false);
    }
  }

  const homeSettings = settings?.[SECTION] || {};
  const hiddenCards = homeSettings.hidden_cards || [];
  const cardColors = homeSettings.card_colors || {};
  const cardOrder = homeSettings.card_order || [];
  const orderedBefore = orderCardGroup(HOME_CARD_GROUP_BEFORE_STATS, cardOrder);
  const orderedAfter = orderCardGroup(HOME_CARD_GROUP_AFTER_STATS, cardOrder);

  function enterEditMode(next) {
    if (next) setExpandedKey(null);
    setEditing(next);
  }

  function hideCard(key) {
    setExpandedKey(null);
    patchHomeSettings({ ...homeSettings, hidden_cards: [...hiddenCards, key] });
  }

  function unhideCard(key) {
    const nextHidden = hiddenCards.filter((k) => k !== key);
    // Re-added at the end of its own half - HOME_CARD_GROUP_BEFORE_STATS
    // membership decides which half, same grouping every other read/write
    // in this feature already respects (see _lib/homeCards.js).
    const isBefore = HOME_CARD_GROUP_BEFORE_STATS.includes(key);
    const currentOrder = isBefore ? orderedBefore : orderedAfter;
    const nextOrder = isBefore
      ? [...currentOrder, key, ...orderedAfter]
      : [...orderedBefore, ...currentOrder, key];
    patchHomeSettings({ ...homeSettings, hidden_cards: nextHidden, card_order: nextOrder });
  }

  function reorderGroup(groupKeys, newOrderWithinGroup) {
    const isBeforeGroup = groupKeys === HOME_CARD_GROUP_BEFORE_STATS;
    const nextOrder = isBeforeGroup
      ? [...newOrderWithinGroup, ...orderedAfter]
      : [...orderedBefore, ...newOrderWithinGroup];
    patchHomeSettings({ ...homeSettings, card_order: nextOrder });
  }

  function setCardColor(key, hex) {
    patchHomeSettings({ ...homeSettings, card_colors: { ...cardColors, [key]: hex } });
  }

  function resetCardColor(key) {
    const nextColors = { ...cardColors };
    delete nextColors[key];
    patchHomeSettings({ ...homeSettings, card_colors: nextColors });
  }

  // The color picker deliberately does NOT expand inline inside a card's
  // own row: every row inside DraggableCardList is fixed-height and
  // absolutely positioned (needed for the drag math), so anything taller
  // than that slot would overflow into the row below it. Selecting a card
  // instead shows a picker panel directly below whichever group (before-
  // or after-stats) contains it - close enough to "a dropdown below that
  // specific tab" per direct user feedback (2026-09-03) without needing
  // to break the drag list's fixed-position layout for an exact per-row
  // placement.
  function cardNode(key) {
    const currentColor = isValidHexColor(cardColors[key]) ? cardColors[key] : null;
    const previewTextColor = readableTextColor(currentColor, colors) || colors.darkest;
    const isSelected = expandedKey === key;

    return (
      <Pressable
        style={[styles.card, homeSettingsStyles.cardRow, isSelected && homeSettingsStyles.cardRowSelected]}
        onPress={() => !editing && setExpandedKey(isSelected ? null : key)}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${HOME_CARD_TITLES[key]} color`}
      >
        <MaterialIcons name="drag-indicator" size={20} color={colors.sage} />
        <View
          style={[
            homeSettingsStyles.colorSwatch,
            { backgroundColor: currentColor || colors.card },
          ]}
        >
          <Text style={[homeSettingsStyles.colorSwatchText, { color: previewTextColor }]}>Aa</Text>
        </View>
        <Text style={homeSettingsStyles.cardName}>{HOME_CARD_TITLES[key]}</Text>
        {!editing && (
          <MaterialIcons name="palette" size={20} color={isSelected ? colors.primary : colors.dark} />
        )}
      </Pressable>
    );
  }

  const expandedInBefore = expandedKey && HOME_CARD_GROUP_BEFORE_STATS.includes(expandedKey);
  const expandedInAfter = expandedKey && HOME_CARD_GROUP_AFTER_STATS.includes(expandedKey);

  function colorPanel() {
    return (
      <View style={[styles.card, homeSettingsStyles.colorPanel]}>
        <Text style={styles.cardTitle}>{HOME_CARD_TITLES[expandedKey]} color</Text>
        <HomeCardColorPicker
          value={isValidHexColor(cardColors[expandedKey]) ? cardColors[expandedKey] : null}
          onChange={(hex) => setCardColor(expandedKey, hex)}
        />
        <View style={homeSettingsStyles.colorPanelFooter}>
          {isValidHexColor(cardColors[expandedKey]) ? (
            <Pressable onPress={() => resetCardColor(expandedKey)} accessibilityRole="button" accessibilityLabel="Reset to default color">
              <Text style={homeSettingsStyles.resetLink}>Reset to default</Text>
            </Pressable>
          ) : (
            <View />
          )}
          {/* "OK" rather than a bare close icon (direct user feedback,
              2026-09-03: "needs an ok button to lock in the color instead
              of an x") - the color is already applied live as you pick
              (same swatch-tap/slider-drag behavior as before), this button
              just confirms you're done and collapses the panel. */}
          <Pressable
            style={homeSettingsStyles.okButton}
            onPress={() => setExpandedKey(null)}
            accessibilityRole="button"
            accessibilityLabel="Lock in color"
          >
            <Text style={homeSettingsStyles.okButtonText}>OK</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <SettingsScreenChrome
      title="Home Settings"
      subtitle={
        editing
          ? 'Drag to reorder, tap × to remove. Tap anywhere when done.'
          : 'Choose which cards show in Home and what order. Tap and hold any card to make edits.'
      }
      onBack={() => router.back()}
    >
      <SettingsFetchGate loaded={settings !== null} error={error} onRetry={fetchSettings}>
        {/* Tapping any non-interactive area (padding, the notice card, the
            hidden section) also exits edit mode, matching each
            DraggableCardList's own equivalent backstop for its internal
            row gaps (see that component's own comment) - together these
            cover "tap the screen when done" across the whole screen, not
            just on a card. */}
        <Pressable
          style={{ flex: 1 }}
          onPress={() => editing && setEditing(false)}
          disabled={!editing}
        >
          <ScrollView
            style={homeSettingsStyles.body}
            contentContainerStyle={homeSettingsStyles.bodyContent}
            scrollEnabled={!editing}
          >
            {error && <Text style={styles.errorText}>{error}</Text>}

            <View style={homeSettingsStyles.toolbar}>
              {saving && <ActivityIndicator size="small" />}
            </View>

            <DraggableCardList
              items={orderedBefore.map((key) => ({ key, node: cardNode(key) }))}
              editing={editing}
              onEditingChange={enterEditMode}
              onReorder={(order) => reorderGroup(HOME_CARD_GROUP_BEFORE_STATS, order)}
              onDelete={hideCard}
            />

            {expandedInBefore && !editing && colorPanel()}

            <View style={homeSettingsStyles.groupDivider} />

            <DraggableCardList
              items={orderedAfter.map((key) => ({ key, node: cardNode(key) }))}
              editing={editing}
              onEditingChange={enterEditMode}
              onReorder={(order) => reorderGroup(HOME_CARD_GROUP_AFTER_STATS, order)}
              onDelete={hideCard}
            />

            {expandedInAfter && !editing && colorPanel()}

            {hiddenCards.length > 0 && (
              <View style={homeSettingsStyles.hiddenSection}>
                <Text style={homeSettingsStyles.hiddenTitle}>HIDDEN</Text>
                {hiddenCards.map((key) => (
                  <Pressable
                    key={key}
                    style={homeSettingsStyles.hiddenRow}
                    onPress={() => unhideCard(key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${HOME_CARD_TITLES[key]} on Home`}
                  >
                    <Text style={homeSettingsStyles.hiddenRowText}>{HOME_CARD_TITLES[key]}</Text>
                    <MaterialIcons name="add-circle-outline" size={20} color={colors.primary} />
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        </Pressable>
      </SettingsFetchGate>
    </SettingsScreenChrome>
  );
}

const homeSettingsStyles = StyleSheet.create({
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 40,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 24,
    marginBottom: 4,
  },
  cardRow: {
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardRowSelected: {
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  colorSwatch: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sage,
  },
  colorSwatchText: {
    fontSize: 12,
    fontWeight: '700',
  },
  cardName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.darkest,
  },
  colorPanel: {
    marginTop: 8,
    marginBottom: 12,
    gap: 10,
  },
  colorPanelFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  resetLink: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: '600',
  },
  okButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 20,
  },
  okButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.background,
  },
  groupDivider: {
    height: 12,
  },
  hiddenSection: {
    marginTop: 12,
    gap: 4,
  },
  hiddenTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.muted,
    marginBottom: 4,
  },
  hiddenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.sage,
  },
  hiddenRowText: {
    fontSize: 14,
    color: colors.dark,
  },
});
