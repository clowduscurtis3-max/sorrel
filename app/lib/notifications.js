import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

// Android requires an explicit notification channel (API 26+) or a pushed
// notification silently uses default/no importance instead of actually
// alerting the user - set up once, before ever requesting a token.
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Sorrel',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

// Best-effort: returns the device's Expo push token, or null if permission
// is denied or this isn't a physical device (push tokens don't work in a
// simulator/emulator). Never throws - the caller treats registration as
// non-fatal, same as the Gmail scan/recurring detection best-effort passes
// elsewhere in this app.
export async function registerForPushNotificationsAsync() {
  if (!Device.isDevice) return null;

  await ensureAndroidChannel();

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== 'granted') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return null;

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  return token;
}

export function getDeviceTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
