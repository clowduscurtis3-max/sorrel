// Shared formatting for AffordabilityQuery.js and GoalForm.js's amount fields.
export function formatAmountLabel(value) {
  return `$${Number(value).toLocaleString()}`;
}
