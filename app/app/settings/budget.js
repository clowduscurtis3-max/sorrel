import SettingsSectionShell from '../_components/SettingsSectionShell';

// Real content lands in Phase 38 Step 2 (regenerate-entire-budget button,
// category-reasoning toggle, Budget Insight pill toggle).
export default function BudgetSettings() {
  return (
    <SettingsSectionShell
      section="budget_settings"
      title="Budget Settings"
      subtitle="Regenerate budget, category reasoning, insight pill."
    />
  );
}
