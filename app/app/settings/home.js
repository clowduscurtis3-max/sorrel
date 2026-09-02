import SettingsSectionShell from '../_components/SettingsSectionShell';

// Real content lands in Phase 38 Step 3 (Home card picker, reorder,
// per-card color).
export default function HomeSettings() {
  return (
    <SettingsSectionShell
      section="home_settings"
      title="Home Settings"
      subtitle="Choose which cards show on Home, and in what order."
    />
  );
}
