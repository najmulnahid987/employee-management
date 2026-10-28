import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Storage adapter for Supabase client.
 * Uses expo-secure-store on native (iOS/Android) for hardware-backed encryption (Keychain / EncryptedSharedPreferences).
 * Falls back to AsyncStorage on Web or if SecureStore is unavailable.
 * Seamlessly migrates legacy session tokens stored in AsyncStorage to SecureStore.
 */
export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        if (typeof window === 'undefined') return null;
        return await AsyncStorage.getItem(key);
      } catch {
        return null;
      }
    }

    try {
      const value = await SecureStore.getItemAsync(key);
      if (value !== null) {
        return value;
      }

      // Fallback & migration check: see if session exists in AsyncStorage
      const legacyValue = await AsyncStorage.getItem(key);
      if (legacyValue !== null) {
        // Migrate to SecureStore and clean up AsyncStorage
        await SecureStore.setItemAsync(key, legacyValue);
        await AsyncStorage.removeItem(key);
        return legacyValue;
      }

      return null;
    } catch {
      // If SecureStore fails, attempt AsyncStorage fallback
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        return null;
      }
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        if (typeof window === 'undefined') return;
        await AsyncStorage.setItem(key, value);
      } catch {
        // No-op
      }
      return;
    }

    try {
      await SecureStore.setItemAsync(key, value);
      // Clean up legacy AsyncStorage copy if any
      await AsyncStorage.removeItem(key).catch(() => {});
    } catch {
      // Fallback to AsyncStorage if SecureStore encounters an error
      try {
        await AsyncStorage.setItem(key, value);
      } catch {
        // No-op
      }
    }
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        if (typeof window === 'undefined') return;
        await AsyncStorage.removeItem(key);
      } catch {
        // No-op
      }
      return;
    }

    try {
      await SecureStore.deleteItemAsync(key);
      await AsyncStorage.removeItem(key).catch(() => {});
    } catch {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        // No-op
      }
    }
  },
};
