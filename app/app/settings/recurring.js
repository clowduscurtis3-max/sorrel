import SettingsSectionShell from '../_components/SettingsSectionShell';

// Real content lands in Phase 38 Step 5 (default grouping, price-alert
// sensitivity threshold).
export default function RecurringSettings() {
  return (
    <SettingsSectionShell
      section="recurring_settings"
      title="Recurring Settings"
      subtitle="Default grouping and price-alert sensitivity."
    />
  );
}
