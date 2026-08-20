import { useState } from 'react';
import { View, Text, Button } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../lib/supabase';
import { redirectTo, createSessionFromUrl } from './_lib/api';
import { styles } from './_lib/styles';

// Ported from the old app/App.js's `!session` branch (Phase 7 Step 1
// sub-step 1.2) - same signInWithGoogle behavior, just its own route now.
export default function SignIn() {
  const [error, setError] = useState(null);

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

      const result = await WebBrowser.openAuthSessionAsync(data?.url ?? '', redirectTo);
      if (result.type === 'success') {
        await createSessionFromUrl(result.url);
      }
    } catch (err) {
      console.error(err);
      setError('Sign-in failed. Please try again.');
    }
  }

  return (
    <View style={styles.centered}>
      <Text style={styles.text}>Sorrel</Text>
      <Button title="Sign in with Google" onPress={signInWithGoogle} />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <StatusBar style="auto" />
    </View>
  );
}
