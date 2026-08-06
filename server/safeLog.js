// Central place for logging errors from external API calls (Plaid,
// Anthropic, Google) without ever leaking secrets. Axios-based clients
// (Plaid's SDK) attach the full outgoing request - including
// PLAID-SECRET/Authorization headers and the request body, which can
// contain a user's decrypted access_token - to err.config on ANY error,
// not just ones with err.response. Logging `err` or `err.config` directly
// (the previous pattern here: `console.error(err.response?.data || err)`)
// means a network-level failure (timeout, DNS blip, connection reset -
// anything that never reaches err.response) writes that credential
// straight into server logs.
function safeErrorDetails(err) {
  if (err?.response?.data) {
    // HTTP-level error from the provider - this is *their* error body
    // (e.g. Plaid's { error_code, error_message }), safe to log as-is.
    return { status: err.response.status, data: err.response.data };
  }
  // Anything else (network failure, thrown before a response exists) -
  // log only a minimal, known-safe shape. Never spread `err` itself or
  // touch `err.config`/`err.request`, which is where secrets live on an
  // axios error.
  return { message: err?.message, code: err?.code, name: err?.name };
}

function logError(context, err) {
  console.error(context, safeErrorDetails(err));
}

module.exports = { logError, safeErrorDetails };
