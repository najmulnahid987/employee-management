import React from 'react';
import {
  ActivityIndicator,
  ActivityIndicatorProps,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import { Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface LoadingProps {
  /** Optional descriptive text displayed beneath the spinner */
  label?: string;
  /** Size of the activity indicator spinner */
  size?: ActivityIndicatorProps['size'];
  /** Custom spinner color (defaults to theme.primary) */
  color?: string;
  /** Whether the loading indicator should occupy the entire screen or parent container */
  fullScreen?: boolean;
  /** Style applied to the outer container */
  style?: StyleProp<ViewStyle>;
  /** Style applied to the descriptive text */
  textStyle?: StyleProp<TextStyle>;
  /** Unique test identifier */
  testID?: string;
}

export function Loading({
  label,
  size = 'small',
  color,
  fullScreen = false,
  style,
  textStyle,
  testID,
}: LoadingProps) {
  const theme = useTheme();
  const spinnerColor = color ?? theme.primary;

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label ?? 'Loading'}
      style={[
        styles.container,
        fullScreen && [styles.fullScreen, { backgroundColor: theme.background }],
        style,
      ]}>
      <ActivityIndicator size={size} color={spinnerColor} />
      {label ? (
        <Text
          style={[
            styles.label,
            { color: theme.textSecondary },
            textStyle,
          ]}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.base,
  },
  fullScreen: {
    flex: 1,
    padding: Spacing.xl,
  },
  label: {
    ...Typography.bodyMedium,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
});
