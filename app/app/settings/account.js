import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Switch,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Picker } from '@react-native-picker/picker';
import { apiFetch, apiErrorMessage } from '../_lib/api';
import { useTheme } from '../_lib/theme';
import { useSessionContext } from '../_lib/session';
import { supabase } from '../../lib/supabase';
import { getBiometricLockEnabled, setBiometricLockEnabled } from '../_lib/biometricPreference';
import {
  getSessionTimeoutMinutes,
  setSessionTimeoutMinutes,
} from '../_lib/sessionTimeoutPreference';
import {
  listVerifiedTotpFactors,
  enrollTotp,
  verifyTotpEnrollment,
  unenrollTotp,
} from '../_lib/mfa';
import SettingsScreenChrome from '../_components/SettingsScreenChrome';
import PrimaryButton from '../_components/PrimaryButton';

const SESSION_TIMEOUT_OPTIONS = [
  { value: '1', label: '1 minute' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: 'off', label: 'Off' },
];

// Phase 38 Step 6: relocated verbatim from (tabs)/account.js, per the
// brief's own "relocate, not rebuild" instruction - username/password
// linking (Phase 25-ish, the authenticated replacement for the
// account-takeover bug in server/usernameAuth.js), two-factor
// authentication (Phase 21, entirely client-driven via Supabase Auth's
// own MFA client, no server route needed), and the biometric-lock
// preference toggle (Phase 20) all used to live on the Account tab -
// same state/handlers/logic, moved here unchanged, and removed from
// (tabs)/account.js so there's exactly one copy of each, not two that
// could drift.
export default function AccountSecuritySettings() {
  const { colors, styles } = useTheme();
  const accountSecurityStyles = useMemo(() => buildAccountSecurityStyles(colors), [colors]);
  const router = useRouter();
  const { session, signOut } = useSessionContext();

  // Phase 38 Step 6: delete account. The real "are you sure" friction is
  // this typed-confirmation step, not a native Alert (which can't hold a
  // text field) - matches the brief's own "confirmation step required."
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Phase 38 Step 6: display name. Stored in Supabase Auth's own
  // user_metadata (supabase.auth.updateUser), not a new table - this app
  // already reads user_metadata.full_name for Home's greeting (Google
  // Sign-In populates it), so a custom display_name slots into the exact
  // same mechanism Supabase already gives every user, no new schema
  // needed. Home's greeting (index.js) now prefers this over full_name
  // once set. `session` (from useSessionContext, provided at the root
  // layout - unlike useAppData, safe to use outside (tabs)) already
  // carries user_metadata, so no separate fetch is needed to seed the
  // initial value.
  const [displayNameInput, setDisplayNameInput] = useState(
    session?.user?.user_metadata?.display_name || session?.user?.user_metadata?.full_name || ''
  );
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState(null);
  const [displayNameSaved, setDisplayNameSaved] = useState(false);

  // Change password - only reachable once usernameStatus.has_username is
  // known true (rendered conditionally below); a Google-only account has
  // no password of its own to change.
  const [showChangePasswordForm, setShowChangePasswordForm] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordForChange, setNewPasswordForChange] = useState('');
  const [showChangePasswordFields, setShowChangePasswordFields] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState(null);

  const [usernameStatus, setUsernameStatus] = useState(null);
  const [showUsernameForm, setShowUsernameForm] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [linkingUsername, setLinkingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState(null);

  const [mfaFactors, setMfaFactors] = useState(null);
  const [showMfaSetup, setShowMfaSetup] = useState(false);
  const [enrollingMfa, setEnrollingMfa] = useState(false);
  const [mfaEnrollment, setMfaEnrollment] = useState(null); // { id, totp: { secret } }
  const [mfaCode, setMfaCode] = useState('');
  const [verifyingMfa, setVerifyingMfa] = useState(false);
  const [mfaError, setMfaError] = useState(null);
  const [disablingMfa, setDisablingMfa] = useState(false);

  const [biometricLockEnabled, setBiometricLockEnabledState] = useState(true);

  // Phase 38 Step 6: session timeout. `'5'` (a string, matching the
  // Picker's own value type) while loading, the same real default
  // DEFAULT_SESSION_TIMEOUT_MINUTES already used before this setting had
  // a UI. 'off' is its own string value here, not null - Picker.Item
  // values must be strings/numbers, the null<->'off' translation happens
  // only at the sessionTimeoutPreference.js boundary (handleSessionTimeoutChange
  // below).
  const [sessionTimeoutValue, setSessionTimeoutValue] = useState('5');
  const [syncingNow, setSyncingNow] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncedJustNow, setSyncedJustNow] = useState(false);

  async function fetchUsernameStatus() {
    try {
      const res = await apiFetch('/auth/username-status');
      if (!res.ok) throw new Error('SERVER_ERROR');
      setUsernameStatus(await res.json());
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchMfaFactors() {
    try {
      setMfaFactors(await listVerifiedTotpFactors());
    } catch (err) {
      console.error(err);
    }
  }

  useFocusEffect(
    useCallback(() => {
      fetchUsernameStatus();
      fetchMfaFactors();
      getBiometricLockEnabled().then(setBiometricLockEnabledState);
      getSessionTimeoutMinutes().then((minutes) =>
        setSessionTimeoutValue(minutes === null ? 'off' : String(minutes))
      );
    }, [])
  );

  // Direct user decision (2026-09-06): choosing "Off" doesn't disable the
  // harder 30-minute forced-sign-out backstop (_layout.js/
  // sessionTimeouts.js's SIGN_OUT_AFTER_BACKGROUND_MS still always
  // applies) - only the shorter biometric re-lock prompt goes away. The
  // brief's own "show a one-time nudge... informational, not blocking"
  // instruction: fires once, right when "Off" is actually chosen (not on
  // every screen visit), and only if there's nothing else standing in
  // for it (biometric lock already on means the device still locks on
  // its own terms, just not from this app's own background-elapsed
  // check specifically - still worth knowing, but a materially smaller
  // gap than having neither).
  async function handleSessionTimeoutChange(value) {
    setSessionTimeoutValue(value);
    await setSessionTimeoutMinutes(value === 'off' ? null : parseInt(value, 10));
    if (value === 'off' && !biometricLockEnabled) {
      Alert.alert(
        'Session timeout is off',
        "Sorrel won't automatically lock or sign you out just from sitting in the background anymore (after 30 minutes, it will still sign out as a last resort). Since Face ID/Fingerprint isn't turned on either, there's nothing else standing between someone picking up your unlocked phone and your financial data. You can turn Face ID/Fingerprint on above at any time."
      );
    }
  }

  async function handleSyncNow() {
    setSyncingNow(true);
    setSyncError(null);
    setSyncedJustNow(false);
    try {
      const res = await apiFetch('/admin/sync-now', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'SERVER_ERROR');
      }
      setSyncedJustNow(true);
    } catch (err) {
      console.error(err);
      setSyncError(apiErrorMessage(err));
    } finally {
      setSyncingNow(false);
    }
  }

  async function startMfaEnrollment() {
    setEnrollingMfa(true);
    setMfaError(null);
    try {
      const data = await enrollTotp();
      setMfaEnrollment(data);
      setShowMfaSetup(true);
    } catch (err) {
      console.error(err);
      setMfaError('Could not start two-factor setup. Try again.');
    } finally {
      setEnrollingMfa(false);
    }
  }

  function cancelMfaSetup() {
    setShowMfaSetup(false);
    setMfaEnrollment(null);
    setMfaCode('');
    setMfaError(null);
  }

  async function submitMfaVerification() {
    if (!mfaEnrollment || mfaCode.trim().length !== 6) return;
    setVerifyingMfa(true);
    setMfaError(null);
    try {
      await verifyTotpEnrollment(mfaEnrollment.id, mfaCode.trim());
      setShowMfaSetup(false);
      setMfaEnrollment(null);
      setMfaCode('');
      await fetchMfaFactors();
    } catch (err) {
      console.error(err);
      setMfaError('That code didn’t work - check your authenticator app and try again.');
    } finally {
      setVerifyingMfa(false);
    }
  }

  function handleDisableMfa() {
    if (!mfaFactors || mfaFactors.length === 0) return;
    Alert.alert(
      'Turn off two-factor authentication?',
      'Signing in will no longer require a code from your authenticator app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: async () => {
            setDisablingMfa(true);
            setMfaError(null);
            try {
              await unenrollTotp(mfaFactors[0].id);
              await fetchMfaFactors();
            } catch (err) {
              console.error(err);
              setMfaError('Could not turn off two-factor authentication. Try again.');
            } finally {
              setDisablingMfa(false);
            }
          },
        },
      ]
    );
  }

  async function handleToggleBiometricLock(nextEnabled) {
    setBiometricLockEnabledState(nextEnabled);
    await setBiometricLockEnabled(nextEnabled);
  }

  async function submitLinkUsername() {
    setUsernameError(null);
    if (newUsername.trim().length < 3) {
      setUsernameError('Username must be at least 3 characters.');
      return;
    }
    if (newPassword.length < 8) {
      setUsernameError('Password must be at least 8 characters.');
      return;
    }
    setLinkingUsername(true);
    try {
      const res = await apiFetch('/auth/link-username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set up username and password.');
      setShowUsernameForm(false);
      setNewUsername('');
      setNewPassword('');
      await fetchUsernameStatus();
    } catch (err) {
      console.error(err);
      setUsernameError(err.message || apiErrorMessage(err));
    } finally {
      setLinkingUsername(false);
    }
  }

  async function submitDisplayName() {
    setDisplayNameError(null);
    setDisplayNameSaved(false);
    const trimmed = displayNameInput.trim();
    if (!trimmed) {
      setDisplayNameError('Enter a name.');
      return;
    }
    setSavingDisplayName(true);
    try {
      const { error } = await supabase.auth.updateUser({ data: { display_name: trimmed } });
      if (error) throw error;
      setDisplayNameSaved(true);
    } catch (err) {
      console.error(err);
      setDisplayNameError('Could not save your name. Try again.');
    } finally {
      setSavingDisplayName(false);
    }
  }

  async function submitChangePassword() {
    setChangePasswordError(null);
    if (newPasswordForChange.length < 8) {
      setChangePasswordError('New password must be at least 8 characters.');
      return;
    }
    setChangingPassword(true);
    try {
      const res = await apiFetch('/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: currentPasswordInput,
          new_password: newPasswordForChange,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to change password.');
      setShowChangePasswordForm(false);
      setCurrentPasswordInput('');
      setNewPasswordForChange('');
      Alert.alert('Password changed', 'Your password has been updated.');
    } catch (err) {
      console.error(err);
      setChangePasswordError(err.message || apiErrorMessage(err));
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleteError(null);
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Type DELETE (in all caps) to confirm.');
      return;
    }
    setDeletingAccount(true);
    try {
      const res = await apiFetch('/account/delete', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'SERVER_ERROR');
      }
      // The account and every row tied to it are already gone server-side
      // at this point - this just clears the now-invalid local session so
      // the app's own existing sign-out redirect (root _layout.js's
      // requiredRoute, reacting to session becoming null) takes over, the
      // same mechanism a normal sign-out already uses.
      await signOut();
    } catch (err) {
      console.error(err);
      setDeleteError(apiErrorMessage(err));
      setDeletingAccount(false);
    }
  }

  return (
    <SettingsScreenChrome title="Account & Security" onBack={() => router.back()}>
      <ScrollView
        style={accountSecurityStyles.bodyScroll}
        contentContainerStyle={accountSecurityStyles.body}
      >
        <View style={[styles.card, accountSecurityStyles.cardMargin]}>
          <Text style={styles.cardTitle}>Display name</Text>
          <Text style={[styles.smallText, accountSecurityStyles.description]}>
            Shown in your greeting on the Home tab.
          </Text>
          <View style={accountSecurityStyles.formFieldRow}>
            <MaterialIcons name="person-outline" size={18} color={colors.dark} />
            <TextInput
              style={accountSecurityStyles.formFieldInput}
              placeholder="e.g. Curtis"
              placeholderTextColor={colors.placeholder}
              value={displayNameInput}
              onChangeText={(t) => {
                setDisplayNameInput(t);
                setDisplayNameSaved(false);
              }}
            />
          </View>
          {displayNameError && <Text style={styles.errorText}>{displayNameError}</Text>}
          {savingDisplayName ? (
            <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
          ) : (
            <View style={accountSecurityStyles.addAccountSpacing}>
              <PrimaryButton
                title={displayNameSaved ? 'SAVED' : 'SAVE'}
                onPress={submitDisplayName}
              />
            </View>
          )}

          <View style={[accountSecurityStyles.iconRow, accountSecurityStyles.linkedEmailRow]}>
            <View style={accountSecurityStyles.iconCircle}>
              <MaterialIcons name="mail-outline" size={18} color={colors.dark} />
            </View>
            <Text style={accountSecurityStyles.iconRowText}>
              Signed in with:{'\n'}
              <Text style={accountSecurityStyles.iconRowTextBold}>{session?.user?.email}</Text>
            </Text>
          </View>
        </View>

        {usernameStatus && (
          <View style={[styles.card, accountSecurityStyles.cardMargin]}>
            {usernameStatus.has_username ? (
              <>
                <View style={accountSecurityStyles.iconRow}>
                  <View style={accountSecurityStyles.iconCircle}>
                    <MaterialIcons name="badge" size={18} color={colors.dark} />
                  </View>
                  <Text style={accountSecurityStyles.iconRowText}>
                    Signed in with username:{'\n'}
                    <Text style={accountSecurityStyles.iconRowTextBold}>
                      {usernameStatus.username}
                    </Text>
                  </Text>
                </View>
                {showChangePasswordForm ? (
                  <View style={accountSecurityStyles.addAccountSpacing}>
                    <View style={accountSecurityStyles.formFieldRow}>
                      <MaterialIcons name="lock-outline" size={18} color={colors.dark} />
                      <TextInput
                        style={accountSecurityStyles.formFieldInput}
                        placeholder="Current password"
                        placeholderTextColor={colors.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        value={currentPasswordInput}
                        onChangeText={setCurrentPasswordInput}
                      />
                    </View>
                    <View style={accountSecurityStyles.formFieldRow}>
                      <MaterialIcons name="lock-outline" size={18} color={colors.dark} />
                      <TextInput
                        style={accountSecurityStyles.formFieldInput}
                        placeholder="New password"
                        placeholderTextColor={colors.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry={!showChangePasswordFields}
                        value={newPasswordForChange}
                        onChangeText={setNewPasswordForChange}
                      />
                      <Pressable
                        onPress={() => setShowChangePasswordFields((v) => !v)}
                        accessibilityRole="button"
                        accessibilityLabel={
                          showChangePasswordFields ? 'Hide password' : 'Show password'
                        }
                      >
                        <MaterialIcons
                          name={showChangePasswordFields ? 'visibility-off' : 'visibility'}
                          size={18}
                          color={colors.dark}
                        />
                      </Pressable>
                    </View>
                    {changePasswordError && (
                      <Text style={styles.errorText}>{changePasswordError}</Text>
                    )}
                    {changingPassword ? (
                      <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
                    ) : (
                      <View style={accountSecurityStyles.addAccountSpacing}>
                        <PrimaryButton title="CHANGE PASSWORD" onPress={submitChangePassword} />
                      </View>
                    )}
                    <Pressable
                      onPress={() => {
                        setShowChangePasswordForm(false);
                        setChangePasswordError(null);
                        setCurrentPasswordInput('');
                        setNewPasswordForChange('');
                      }}
                      accessibilityRole="button"
                    >
                      <Text style={accountSecurityStyles.textLink}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    style={[
                      accountSecurityStyles.outlineButton,
                      accountSecurityStyles.outlineButtonFull,
                      accountSecurityStyles.addAccountSpacing,
                    ]}
                    onPress={() => setShowChangePasswordForm(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Change password"
                  >
                    <Text style={accountSecurityStyles.outlineButtonText}>CHANGE PASSWORD</Text>
                  </Pressable>
                )}
              </>
            ) : showUsernameForm ? (
              <>
                <Text style={styles.smallText}>
                  Optional: add a username and password as a second way to sign in, alongside
                  Google.
                </Text>
                <View style={accountSecurityStyles.formFieldRow}>
                  <MaterialIcons name="person" size={18} color={colors.dark} />
                  <TextInput
                    style={accountSecurityStyles.formFieldInput}
                    placeholder="Username"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={newUsername}
                    onChangeText={setNewUsername}
                  />
                </View>
                <View style={accountSecurityStyles.formFieldRow}>
                  <MaterialIcons name="lock-outline" size={18} color={colors.dark} />
                  <TextInput
                    style={accountSecurityStyles.formFieldInput}
                    placeholder="Password"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!showNewPassword}
                    value={newPassword}
                    onChangeText={setNewPassword}
                  />
                  <Pressable
                    onPress={() => setShowNewPassword((v) => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={showNewPassword ? 'Hide password' : 'Show password'}
                  >
                    <MaterialIcons
                      name={showNewPassword ? 'visibility-off' : 'visibility'}
                      size={18}
                      color={colors.dark}
                    />
                  </Pressable>
                </View>
                {usernameError && <Text style={styles.errorText}>{usernameError}</Text>}
                {linkingUsername ? (
                  <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
                ) : (
                  <View style={accountSecurityStyles.addAccountSpacing}>
                    <PrimaryButton title="SAVE USERNAME & PASSWORD" onPress={submitLinkUsername} />
                  </View>
                )}
                <Pressable
                  onPress={() => {
                    setShowUsernameForm(false);
                    setUsernameError(null);
                    setNewUsername('');
                    setNewPassword('');
                  }}
                  accessibilityRole="button"
                >
                  <Text style={accountSecurityStyles.textLink}>Cancel</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={[
                  accountSecurityStyles.outlineButton,
                  accountSecurityStyles.outlineButtonFull,
                ]}
                onPress={() => setShowUsernameForm(true)}
                accessibilityRole="button"
                accessibilityLabel="Set up username and password (optional)"
              >
                <MaterialIcons name="badge" size={16} color={colors.primary} />
                <Text style={accountSecurityStyles.outlineButtonText}>
                  SET UP USERNAME & PASSWORD (OPTIONAL)
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {mfaFactors && (
          <View style={[styles.card, accountSecurityStyles.cardMargin]}>
            {mfaFactors.length > 0 ? (
              <>
                <View style={accountSecurityStyles.iconRow}>
                  <View style={accountSecurityStyles.iconCircle}>
                    <MaterialIcons name="verified-user" size={18} color={colors.dark} />
                  </View>
                  <Text style={accountSecurityStyles.iconRowText}>
                    Two-factor authentication is on
                  </Text>
                </View>
                {mfaError && <Text style={styles.errorText}>{mfaError}</Text>}
                {disablingMfa ? (
                  <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
                ) : (
                  <Pressable
                    style={[
                      accountSecurityStyles.outlineButton,
                      accountSecurityStyles.outlineButtonFull,
                      accountSecurityStyles.addAccountSpacing,
                    ]}
                    onPress={handleDisableMfa}
                    accessibilityRole="button"
                    accessibilityLabel="Turn off two-factor authentication"
                  >
                    <Text style={accountSecurityStyles.outlineButtonText}>TURN OFF</Text>
                  </Pressable>
                )}
              </>
            ) : showMfaSetup && mfaEnrollment ? (
              <>
                <Text style={styles.smallText}>
                  Open your authenticator app (Google Authenticator, Authy, etc.), choose "Enter a
                  setup key" / "Enter code manually," and enter this secret:
                </Text>
                <Text style={accountSecurityStyles.mfaSecret} selectable>
                  {mfaEnrollment.totp.secret}
                </Text>
                <Text style={styles.smallText}>Then enter the 6-digit code it generates:</Text>
                <View style={accountSecurityStyles.formFieldRow}>
                  <MaterialIcons name="pin" size={18} color={colors.dark} />
                  <TextInput
                    style={accountSecurityStyles.formFieldInput}
                    placeholder="123456"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="number-pad"
                    maxLength={6}
                    value={mfaCode}
                    onChangeText={(t) => setMfaCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
                  />
                </View>
                {mfaError && <Text style={styles.errorText}>{mfaError}</Text>}
                {verifyingMfa ? (
                  <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
                ) : (
                  <View style={accountSecurityStyles.addAccountSpacing}>
                    <PrimaryButton title="VERIFY & TURN ON" onPress={submitMfaVerification} />
                  </View>
                )}
                <Pressable onPress={cancelMfaSetup} accessibilityRole="button">
                  <Text style={accountSecurityStyles.textLink}>Cancel</Text>
                </Pressable>
              </>
            ) : enrollingMfa ? (
              <ActivityIndicator />
            ) : (
              <>
                <Pressable
                  style={[
                    accountSecurityStyles.outlineButton,
                    accountSecurityStyles.outlineButtonFull,
                  ]}
                  onPress={startMfaEnrollment}
                  accessibilityRole="button"
                  accessibilityLabel="Set up two-factor authentication (optional)"
                >
                  <MaterialIcons name="verified-user" size={16} color={colors.primary} />
                  <Text style={accountSecurityStyles.outlineButtonText}>
                    SET UP TWO-FACTOR AUTHENTICATION (OPTIONAL)
                  </Text>
                </Pressable>
                {mfaError && <Text style={styles.errorText}>{mfaError}</Text>}
              </>
            )}
          </View>
        )}

        <View
          style={[styles.card, accountSecurityStyles.cardMargin, accountSecurityStyles.faceIdRow]}
        >
          <View style={[accountSecurityStyles.iconRow, accountSecurityStyles.iconRowGrow]}>
            <View style={accountSecurityStyles.iconCircle}>
              <MaterialIcons name="fingerprint" size={18} color={colors.dark} />
            </View>
            <Text style={accountSecurityStyles.iconRowText}>
              Require Face ID / Fingerprint to unlock
            </Text>
          </View>
          <Switch
            value={biometricLockEnabled}
            onValueChange={handleToggleBiometricLock}
            trackColor={{ false: colors.sage, true: colors.primary }}
          />
        </View>

        <View style={[styles.card, accountSecurityStyles.cardMargin]}>
          <Text style={styles.cardTitle}>Session timeout</Text>
          <Text style={[styles.smallText, accountSecurityStyles.description]}>
            How long Sorrel can sit in the background before it asks you to unlock again.
          </Text>
          <View style={[styles.picker, accountSecurityStyles.picker]}>
            <Picker
              selectedValue={sessionTimeoutValue}
              onValueChange={handleSessionTimeoutChange}
              style={accountSecurityStyles.pickerControl}
              dropdownIconColor={colors.darkest}
              mode="dropdown"
            >
              {SESSION_TIMEOUT_OPTIONS.map((opt) => (
                <Picker.Item
                  key={opt.value}
                  label={opt.label}
                  value={opt.value}
                  color={colors.darkest}
                  style={accountSecurityStyles.pickerItem}
                />
              ))}
            </Picker>
          </View>
        </View>

        <View style={[styles.card, accountSecurityStyles.cardMargin]}>
          <Text style={styles.cardTitle}>Sync now</Text>
          <Text style={[styles.smallText, accountSecurityStyles.description]}>
            Manually check your linked banks for new transactions right now, instead of waiting for
            the next automatic sync.
          </Text>
          {syncError && <Text style={styles.errorText}>{syncError}</Text>}
          {syncingNow ? (
            <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
          ) : (
            <Pressable
              style={[accountSecurityStyles.outlineButton, accountSecurityStyles.outlineButtonFull]}
              onPress={handleSyncNow}
              accessibilityRole="button"
              accessibilityLabel="Sync now"
            >
              <MaterialIcons name="sync" size={16} color={colors.primary} />
              <Text style={accountSecurityStyles.outlineButtonText}>
                {syncedJustNow ? 'SYNCED' : 'SYNC NOW'}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={[styles.card, accountSecurityStyles.cardMargin]}>
          <Text style={styles.cardTitle}>Delete account</Text>
          <Text style={[styles.smallText, accountSecurityStyles.description]}>
            Permanently deletes your account and everything tied to it - linked banks, transactions,
            budgets, goals, everything. This can't be undone.
          </Text>
          {!showDeleteConfirm ? (
            <Pressable
              style={[
                accountSecurityStyles.destructiveButton,
                accountSecurityStyles.addAccountSpacing,
              ]}
              onPress={() => setShowDeleteConfirm(true)}
              accessibilityRole="button"
              accessibilityLabel="Delete account"
            >
              <MaterialIcons name="delete-forever" size={16} color={colors.error} />
              <Text style={accountSecurityStyles.destructiveButtonText}>DELETE ACCOUNT</Text>
            </Pressable>
          ) : (
            <View style={accountSecurityStyles.addAccountSpacing}>
              <Text style={[styles.smallText, accountSecurityStyles.description]}>
                Type DELETE to confirm.
              </Text>
              <View style={accountSecurityStyles.formFieldRow}>
                <TextInput
                  style={accountSecurityStyles.formFieldInput}
                  placeholder="DELETE"
                  placeholderTextColor={colors.placeholder}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  value={deleteConfirmText}
                  onChangeText={setDeleteConfirmText}
                />
              </View>
              {deleteError && <Text style={styles.errorText}>{deleteError}</Text>}
              {deletingAccount ? (
                <ActivityIndicator style={accountSecurityStyles.addAccountSpacing} />
              ) : (
                <Pressable
                  style={[
                    accountSecurityStyles.destructiveButton,
                    accountSecurityStyles.addAccountSpacing,
                  ]}
                  onPress={handleDeleteAccount}
                  accessibilityRole="button"
                  accessibilityLabel="Permanently delete account"
                >
                  <Text style={accountSecurityStyles.destructiveButtonText}>
                    PERMANENTLY DELETE
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText('');
                  setDeleteError(null);
                }}
                accessibilityRole="button"
              >
                <Text style={accountSecurityStyles.textLink}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>
    </SettingsScreenChrome>
  );
}

// Theme redesign (2026-09-11): converted to a builder function, called
// via useMemo inside the component (keyed on colors).
function buildAccountSecurityStyles(colors) {
  return StyleSheet.create({
    bodyScroll: {
      flex: 1,
    },
    body: {
      paddingTop: 8,
      paddingBottom: 40,
    },
    description: {
      textAlign: 'left',
    },
    picker: {
      marginTop: 8,
    },
    // Both needed directly on the Picker/Picker.Item themselves, not just
    // the wrapping View - confirmed on-device, 2026-09-05/06 (see
    // settings/goal.js's identical styles for the full on-device history):
    // the ancestor View's own color/backgroundColor reaches neither the
    // closed box's text nor the open dropdown list's own rendering.
    pickerControl: {
      color: colors.darkest,
      backgroundColor: colors.background,
    },
    pickerItem: {
      color: colors.darkest,
      backgroundColor: colors.background,
    },
    cardMargin: {
      marginHorizontal: 16,
      marginBottom: 12,
    },
    iconRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    linkedEmailRow: {
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.sage,
    },
    iconRowGrow: {
      flex: 1,
    },
    iconCircle: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconRowText: {
      flex: 1,
      fontSize: 13,
      color: colors.dark,
      lineHeight: 18,
    },
    iconRowTextBold: {
      fontWeight: '700',
      color: colors.darkest,
    },
    formFieldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.background,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginTop: 8,
    },
    formFieldInput: {
      flex: 1,
      fontSize: 14,
      color: colors.darkest,
    },
    mfaSecret: {
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 1.5,
      color: colors.darkest,
      backgroundColor: colors.background,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginTop: 8,
      textAlign: 'center',
    },
    faceIdRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    outlineButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.sage,
      backgroundColor: colors.background,
      borderRadius: 22,
      paddingVertical: 10,
      minHeight: 40,
    },
    outlineButtonFull: {
      marginTop: 4,
    },
    outlineButtonText: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.primary,
      letterSpacing: 0.3,
    },
    // Same visual pattern as settings/budget.js's own "Regenerate entire
    // budget" destructive button, for consistency across Settings screens.
    destructiveButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.error,
      backgroundColor: colors.background,
      borderRadius: 22,
      paddingVertical: 10,
      minHeight: 40,
    },
    destructiveButtonText: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.error,
      letterSpacing: 0.3,
    },
    addAccountSpacing: {
      marginTop: 4,
    },
    textLink: {
      fontSize: 13,
      color: colors.muted,
      textAlign: 'center',
      marginTop: 4,
    },
  });
}
