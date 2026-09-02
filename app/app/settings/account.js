import SettingsSectionShell from '../_components/SettingsSectionShell';

// Real content lands in Phase 38 Step 6 - relocates (doesn't rebuild)
// biometric lock/2FA from the Account tab, plus session timeout, account
// management, delete account, linked-account health/re-link, manual sync.
export default function AccountSettings() {
  return (
    <SettingsSectionShell
      section="account_settings"
      title="Account & Security"
      subtitle="Biometric lock, two-factor, session timeout, linked accounts."
    />
  );
}
