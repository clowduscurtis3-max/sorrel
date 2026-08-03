import { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Button,
  ActivityIndicator,
  SectionList,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import * as QueryParams from 'expo-auth-session/build/QueryParams';
import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';
import { supabase } from './lib/supabase';

// Our own backend, reachable through the ngrok tunnel while developing.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Required so the in-app browser can hand control back to the app after
// the OAuth redirect completes (no-op on native, needed on web).
WebBrowser.maybeCompleteAuthSession();

// Builds the deep link Supabase should send the browser back to once
// Google sign-in finishes, e.g. exp://192.168.x.x:8081/--/ in Expo Go.
const redirectTo = makeRedirectUri();

async function createSessionFromUrl(url) {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  if (errorCode) throw new Error(errorCode);

  const { access_token, refresh_token } = params;
  if (!access_token) return;

  const { error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (error) throw error;
}

// Wraps a backend call with a plain-language error a screen can show:
// a thrown network error becomes "can't reach the server", and a 401
// (expired/invalid Supabase session) signs the user out so they can
// re-authenticate rather than getting stuck on a broken screen.
async function apiFetch(path, options = {}) {
  const {
    data: { session: currentSession },
  } = await supabase.auth.getSession();
  if (!currentSession) throw new Error('SESSION_EXPIRED');

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${currentSession.access_token}`,
      },
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (res.status === 401) {
    await supabase.auth.signOut();
    throw new Error('SESSION_EXPIRED');
  }

  return res;
}

function apiErrorMessage(err) {
  if (err.message === 'SESSION_EXPIRED') {
    return 'Your session expired. Please sign in again.';
  }
  if (err.message === 'NETWORK_ERROR') {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return 'Something went wrong. Please try again.';
}

// Groups a flat transaction list into the shape SectionList expects,
// one section per category, alphabetically ordered.
function groupByCategory(transactions) {
  const groups = {};
  for (const t of transactions) {
    const key = t.category || 'Other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return Object.keys(groups)
    .sort()
    .map((title) => ({ title, data: groups[title] }));
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [error, setError] = useState(null);
  const url = Linking.useLinkingURL();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      }
    );

    return () => authListener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (url) createSessionFromUrl(url).catch((err) => console.error(err));
  }, [url]);

  useEffect(() => {
    if (session) fetchTransactions();
  }, [session]);

  // Doubles as "does this user already have a linked account?" — the
  // backend returns 404 until /exchange-token has run at least once.
  async function fetchTransactions() {
    setLoadingTransactions(true);
    setError(null);
    try {
      const res = await apiFetch('/transactions');
      if (res.status === 404) {
        setLinked(false);
        setTransactions([]);
        return;
      }
      if (!res.ok) throw new Error('SERVER_ERROR');
      const data = await res.json();
      setTransactions(data.transactions || []);
      setLinked(true);
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
    } finally {
      setLoadingTransactions(false);
    }
  }

  async function signInWithGoogle() {
    setError(null);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;

      const result = await WebBrowser.openAuthSessionAsync(
        data?.url ?? '',
        redirectTo
      );
      if (result.type === 'success') {
        await createSessionFromUrl(result.url);
      }
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function linkBankAccount() {
    setLinking(true);
    setError(null);
    try {
      const linkTokenRes = await apiFetch('/link-token', { method: 'POST' });
      if (!linkTokenRes.ok) throw new Error('SERVER_ERROR');
      const { link_token } = await linkTokenRes.json();

      const plaidSession = await createPlaidLinkSession({
        token: link_token,
        onSuccess: async (success) => {
          try {
            const exchangeRes = await apiFetch('/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: success.publicToken }),
            });
            if (!exchangeRes.ok) throw new Error('SERVER_ERROR');
            setLinking(false);
            await fetchTransactions();
          } catch (err) {
            console.error(err);
            setError(apiErrorMessage(err));
            setLinking(false);
          }
        },
        onExit: (exit) => {
          if (exit.error) console.error(exit.error);
          setLinking(false);
        },
        onEvent: () => {},
      });

      await plaidSession.open();
    } catch (err) {
      console.error(err);
      setError(apiErrorMessage(err));
      setLinking(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.text}>Pocket Accountant</Text>
        <Button title="Sign in with Google" onPress={signInWithGoogle} />
        {error && <Text style={styles.errorText}>{error}</Text>}
        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.text}>Signed in as {session.user.email}</Text>
        <Button title="Sign out" onPress={signOut} />
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Retry" onPress={fetchTransactions} />
        </View>
      )}

      {loadingTransactions ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : !linked ? (
        <View style={styles.centered}>
          {linking ? (
            <ActivityIndicator />
          ) : (
            <Button title="Link bank account" onPress={linkBankAccount} />
          )}
        </View>
      ) : (
        <SectionList
          style={styles.list}
          sections={groupByCategory(transactions)}
          keyExtractor={(item) => item.transaction_id}
          renderSectionHeader={({ section: { title } }) => (
            <Text style={styles.sectionHeader}>{title}</Text>
          )}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowName}>
                {item.merchant_name || item.name}
              </Text>
              <Text style={styles.rowAmount}>${item.amount.toFixed(2)}</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.text}>No transactions yet.</Text>
          }
        />
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 60,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  header: {
    alignItems: 'center',
    gap: 8,
    paddingBottom: 16,
  },
  text: {
    fontSize: 16,
  },
  errorBanner: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  errorText: {
    fontSize: 14,
    color: '#b00020',
    textAlign: 'center',
  },
  list: {
    flex: 1,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: '#f2f2f2',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  rowName: {
    fontSize: 15,
    flexShrink: 1,
    paddingRight: 8,
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '500',
  },
});
