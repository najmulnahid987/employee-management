import { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dispatcher Dynamic App Configuration
 *
 * Extends static app.json with runtime / environment-derived configuration:
 * - Injects Android Google Maps API key from environment variable (never hardcoded)
 * - Defines explicit native bundle identifier and package name for CNG
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'project',
  slug: config.slug ?? 'project',
  ios: {
    ...config.ios,
    bundleIdentifier: config.ios?.bundleIdentifier ?? 'com.dispatcher.mobile',
  },
  android: {
    ...config.android,
    package: config.android?.package ?? 'com.dispatcher.mobile',
    config: {
      ...config.android?.config,
      googleMaps: {
        apiKey:
          process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
          process.env.GOOGLE_MAPS_API_KEY ||
          '',
      },
    },
  },
  extra: {
    ...config.extra,
    eas: {
      projectId:
        process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
        process.env.EAS_PROJECT_ID ||
        config.extra?.eas?.projectId ||
        undefined,
    },
  },
});
