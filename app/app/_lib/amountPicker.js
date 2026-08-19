// Shared formatting for AffordabilityQuery.js and GoalForm.js's amount fields,
// both rendered via NumberScrollWheel.js (a continuous velocity-based
// scroll wheel, not a fixed list of options) - this file used to also
// generate tiered-step option arrays for @react-native-picker/picker, but
// a continuous wheel has no fixed item list to generate or reconcile a
// pre-existing value against, so that's gone. Kept as its own small shared
// file rather than duplicated in both components.
export function formatAmountLabel(value) {
  return `$${Number(value).toLocaleString()}`;
}
