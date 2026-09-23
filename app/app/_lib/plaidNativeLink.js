import { Platform } from 'react-native';

// react-native-plaid-link-sdk has no web implementation - importing it
// unconditionally crashes the web build at load time ("Cannot find native
// module 'ReactNativePlaidLinkSdk'"). One shared module, not a copy of
// this same require-guard hand-duplicated in every screen that links a
// bank account (account.js, index.js) - a future change to how the
// native SDK is loaded only needs to happen here.
export const createPlaidLinkSession =
  Platform.OS === 'web' ? null : require('react-native-plaid-link-sdk').createPlaidLinkSession;
