/**
 * Dispatcher Native Device Launchers
 *
 * Implements safe tel: and maps: external deep links for field technicians.
 * Handles device platform differences (iOS vs Android vs Web) and gracefully catches errors.
 */

import { Alert, Linking, Platform } from 'react-native';

/**
 * Initiates a native phone call to the customer phone number.
 */
export async function launchPhoneCall(phoneNumber: string): Promise<void> {
  const trimmed = phoneNumber.trim();
  if (!trimmed) {
    Alert.alert('Phone Unavailable', 'No valid phone number is available for this customer.');
    return;
  }

  // Remove non-dialable characters while preserving leading +
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  const url = `tel:${cleaned}`;

  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported && Platform.OS !== 'web') {
      Alert.alert(
        'Calling Unavailable',
        `This device does not support direct phone calls. Customer number: ${trimmed}`
      );
      return;
    }
    await Linking.openURL(url);
  } catch (err) {
    Alert.alert(
      'Unable to Place Call',
      `Could not open phone dialer: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
  }
}

/**
 * Opens the service site address in the user's default navigation/map application
 * (Apple Maps on iOS, Google Maps on Android, web search on web/desktop).
 *
 * Never fabricates coordinates: uses verified latitude/longitude if non-null,
 * otherwise falls back cleanly to the encoded physical street address.
 */
export async function launchNativeMaps(
  address: string,
  coordinates?: { latitude: number | null; longitude: number | null } | null
): Promise<void> {
  const trimmedAddress = address.trim();
  if (!trimmedAddress && (!coordinates?.latitude || !coordinates?.longitude)) {
    Alert.alert('Address Unavailable', 'No site address is specified for this service job.');
    return;
  }

  const encodedAddress = encodeURIComponent(trimmedAddress);
  const hasCoords =
    typeof coordinates?.latitude === 'number' &&
    typeof coordinates?.longitude === 'number' &&
    !isNaN(coordinates.latitude) &&
    !isNaN(coordinates.longitude);

  let url: string;

  if (Platform.OS === 'ios') {
    if (hasCoords) {
      url = `maps:0,0?q=${encodedAddress}&ll=${coordinates!.latitude},${coordinates!.longitude}`;
    } else {
      url = `maps:0,0?q=${encodedAddress}`;
    }
  } else if (Platform.OS === 'android') {
    if (hasCoords) {
      url = `geo:${coordinates!.latitude},${coordinates!.longitude}?q=${encodedAddress}`;
    } else {
      url = `geo:0,0?q=${encodedAddress}`;
    }
  } else {
    // Web / Desktop browser fallback
    if (hasCoords) {
      url = `https://www.google.com/maps/search/?api=1&query=${coordinates!.latitude},${coordinates!.longitude}`;
    } else {
      url = `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`;
    }
  }

  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported && Platform.OS !== 'web') {
      // Fallback to web Google Maps if native map scheme is unsupported
      const webUrl = `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`;
      await Linking.openURL(webUrl);
      return;
    }
    await Linking.openURL(url);
  } catch (err) {
    Alert.alert(
      'Unable to Open Maps',
      `Could not launch maps application: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
  }
}
