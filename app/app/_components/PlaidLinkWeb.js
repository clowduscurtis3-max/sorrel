import { useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';

// Phase 39 Step 2 (web build): react-native-plaid-link-sdk has no web
// implementation at all - Plaid's real web equivalent is the separate
// react-plaid-link package (wraps Plaid's own Link.js). This component is
// only ever mounted on web (the caller platform-branches before rendering
// it), and normalizes react-plaid-link's onSuccess(public_token, metadata)/
// onExit(error, metadata) callback shapes to the same
// { publicToken }/{ error } shape react-native-plaid-link-sdk's onSuccess/
// onExit already use, so the calling code's exchange-token logic is
// identical on both platforms - only how Link itself gets launched
// differs.
export default function PlaidLinkWeb({ token, onSuccess, onExit, onLoadError }) {
  const { open, ready, error } = usePlaidLink({
    token,
    onSuccess: (publicToken, metadata) => onSuccess({ publicToken, metadata }),
    onExit: (exitError, metadata) => onExit({ error: exitError, metadata }),
  });

  useEffect(() => {
    if (ready) open();
    // Only fire once Link's own script has finished loading and this
    // exact token is ready - re-running on every render would reopen
    // Link repeatedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    // A real, distinct failure mode from a normal onExit (the user closing
    // Link themselves) - Plaid's own link-initialize.js script failing to
    // load at all (offline, an ad/script blocker, a network blip). Without
    // this, `ready` simply never becomes true and the caller's own
    // loading spinner (set before this component ever mounts) spins
    // forever with no way to recover short of reloading the whole app.
    if (error) onLoadError(error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return null;
}
