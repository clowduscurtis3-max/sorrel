import { Redirect } from 'expo-router';

// Real bug found on-device, 2026-08-13: GMAIL_REDIRECT
// ('pocketaccountant://gmail-linked', see _lib/api.js) is meant purely as
// a signal URL for WebBrowser.openAuthSessionAsync (in AccountMenu.js's
// linkGmail) to catch and resolve its promise with - it was never
// supposed to need a real screen. But Android delivers the same incoming
// deep link to Expo Router's own linking integration independently of
// whatever WebBrowser does internally to capture it, and Router tries to
// navigate to whatever path is present. Sign-in's own redirect
// (`redirectTo` = makeRedirectUri() with no path) happens to resolve to
// the bare scheme, which Router already treats as '/' - a real route - so
// that flow never showed this symptom. `gmail-linked` was never a
// registered route at all, so Router showed its default "Unmatched
// Route" 404 screen on top of the account menu after every successful
// Gmail link, until manually dismissed - the link itself always
// completed correctly underneath, this was purely a spurious screen.
// Redirecting straight back to '/' avoids it entirely: by the time this
// could ever render, the user is always already deep in an authenticated
// session (Gmail linking only starts from the account menu), so '/'
// safely resolves back to (tabs) via the root gate.
export default function GmailLinked() {
  return <Redirect href="/" />;
}
