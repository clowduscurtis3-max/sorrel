import SettingsSectionShell from '../_components/SettingsSectionShell';

// Real content lands in Phase 38 Step 7 (per-feature notification
// on/off, low-balance threshold per linked account).
export default function NotificationSettings() {
  return (
    <SettingsSectionShell
      section="notification_settings"
      title="Notifications"
      subtitle="Per-feature alerts and low-balance thresholds."
    />
  );
}
