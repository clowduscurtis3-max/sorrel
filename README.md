# Pocket Accountant

AI-powered personal finance app. React Native + Expo mobile app (`app/`),
Node/Express backend (`server/`, holds all secrets), Supabase (auth +
Postgres), Plaid (bank linking, Sandbox mode only), Anthropic Claude Haiku
(categorization/extraction), optional Gmail receipt scanning.

**This file is a setup guide — accounts, keys, and tools needed to run and
develop the app.** For architecture, decisions, what's built, and current
phase status, see `CLAUDE.md` — that's the actively-maintained source of
truth for everything else.

Nothing is hardcoded in source. Every credential below goes in a gitignored
`.env` file (or, for a couple of items noted below, a dashboard setting
outside this repo entirely) — never commit a real key.

## Accounts & API keys you'll need

Each of these is a service you sign up for yourself and get your own
credentials from — this repo never ships real values, only `.env.example`
files showing what's expected.

| Service | Where to get it | Used for |
|---|---|---|
| **Supabase** | [supabase.com](https://supabase.com) → your project → Project Settings → API | Auth + Postgres database. You'll need the project URL, the `anon` key (client-safe), and the `service_role` key (server-only, never expose to the app). |
| **Plaid** | [dashboard.plaid.com](https://dashboard.plaid.com) → Developers → Keys | Bank account linking and transaction sync. **Sandbox environment only** — this app has never used Plaid Production. |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) → API Keys | Claude Haiku — transaction categorization, budget generation, re-balance proposals, receipt extraction. This project deliberately runs a low monthly spend cap (Settings → Billing) — worth setting your own. |
| **Google Cloud Console** | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials | An OAuth client for the *optional* Gmail receipt-scanning link. Requires the Gmail API enabled and this backend's `/auth/google/callback` URL added as an authorized redirect URI. This is **separate** from Google Sign-In (see below). |
| **Google Sign-In (via Supabase)** | Supabase Dashboard → Authentication → Providers → Google | The app's actual sign-in method. This is a *different* Google OAuth client, configured directly in Supabase's dashboard, not in this repo's `.env` files. |
| **Firebase** | [console.firebase.google.com](https://console.firebase.google.com) | Android push notifications (Cloud Messaging). Needs a project with an Android app registered under package `com.curt182.pocketaccountant`, which produces `google-services.json` (already committed in `app/` — not a secret) and an **FCM V1 service account key** (a real secret, uploaded to EAS directly via `eas credentials`, never stored in this repo). |
| **Expo / EAS** | [expo.dev](https://expo.dev) account | Building the Android dev-client (`eas build`) and managing push credentials (`eas credentials`). Free tier is fine. |
| **ngrok** | [ngrok.com](https://ngrok.com) account + authtoken | Tunnels the local backend to a public HTTPS URL — required for Google OAuth redirects and for testing on a phone that isn't on the same network as the dev machine. |

## Tools to install

- **Node.js + npm**
- **Supabase CLI** — `brew install supabase/tap/supabase` (or via `npx`). Needed for database migrations (`supabase db push`); requires running `supabase login` and `supabase link` once (interactive, uses your own Supabase account).
- **ngrok CLI**
- **Expo CLI / EAS CLI** — used via `npx expo ...` / `npx eas-cli ...`, no global install needed.
- **Android platform tools (`adb`)** — `brew install android-platform-tools`. Needed to install the dev-client build on a physical device. Sideloading the APK by tapping it directly on the phone can silently trigger Android's "Restricted settings" block on some devices (a known Samsung One UI issue) — installing via `adb install` avoids it.
- **A physical Android device** for testing. Expo Go and the iOS Simulator/emulator have not been used for this project — testing has been exclusively on a real Android device via a custom EAS dev-client build, since Expo Go can't reliably complete this app's OAuth redirects on Android. iOS is untested (the data model supports it, but no iOS build has been made).
- **Git**

## Setup

1. Clone the repo.
2. `cp server/.env.example server/.env` and `cp app/.env.example app/.env`, then fill in real values using the accounts above. See the `.env.example` files themselves for exactly which variables are needed and where each one comes from.
3. Add your email to `ALLOWED_EMAILS` in `server/.env` (comma-separated) — the backend rejects sign-in from any email not on this list, even with a valid Google session, so this is required for you to be able to use the app at all, not just an optional setting.
4. `cd server && npm install`, then `cd ../app && npm install`.
5. Run `supabase login` and `supabase link` (interactive) once, then `supabase db push` to apply migrations.

## Running locally

Three processes run simultaneously (see `CLAUDE.md`'s "Local dev environment" section for the full detail, including a real gotcha about stale processes surviving a laptop sleep):

1. Backend: `cd server && node index.js`
2. ngrok tunnel to the backend: `ngrok http 3000` — the resulting URL has to match `EXPO_PUBLIC_API_URL` (app) and `BACKEND_URL` (server), **and** be registered as the Google OAuth redirect URI.
3. Metro in tunnel mode: `cd app && npx expo start --dev-client --tunnel`

A native rebuild (`eas build --profile development --platform android`) is only needed when a native module changes — plain JS/`App.js` changes hot-reload via Metro.
