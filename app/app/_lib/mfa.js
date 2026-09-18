import { supabase } from '../../lib/supabase';

// Phase 21 (Two-factor authentication, 2026-08-25). Thin wrappers around
// Supabase Auth's own MFA client (supabase.auth.mfa) - TOTP only (the only
// factor type this app offers; Supabase also supports phone/WebAuthn
// factors, unused here). Every function here is a pass-through with error
// normalization, no business logic of its own - when to show the
// challenge screen and how enrollment gates the Account-tab UI both live
// in _layout.js/account.js respectively, not here.

// Real, verified TOTP factors only - an enrolled-but-never-verified factor
// (abandoned mid-setup) doesn't count as real 2FA and shouldn't be shown
// as "enabled."
export async function listVerifiedTotpFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.totp || []).filter((f) => f.status === 'verified');
}

export async function enrollTotp() {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Sorrel',
  });
  if (error) throw error;
  return data; // { id, totp: { qr_code, secret, uri }, ... }
}

// Completes enrollment. A factor stays "unverified" (and doesn't count
// toward getAuthenticatorAssuranceLevel's nextLevel) until this succeeds -
// separate from challengeAndVerifyTotp below because enrollment challenges
// right when the QR/secret is first shown, before the user has typed
// anything, while sign-in's challenge only happens once they already have
// a code ready.
export async function verifyTotpEnrollment(factorId, code) {
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeError) throw challengeError;
  const { data, error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (error) throw error;
  return data;
}

export async function unenrollTotp(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

// Sign-in-time verification - one call handles challenge+verify together,
// matching this flow's shape ("the user already has a code ready to type
// right now").
export async function challengeAndVerifyTotp(factorId, code) {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw error;
  return data;
}

// { currentLevel, nextLevel, currentAuthenticationMethods }. nextLevel is
// 'aal2' whenever the account has any verified factor, regardless of
// whether the CURRENT session has completed that challenge yet -
// currentLevel !== nextLevel is exactly "this session needs to pass an MFA
// challenge before it's fully trusted."
export async function getAuthenticatorAssuranceLevel() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  return data;
}
