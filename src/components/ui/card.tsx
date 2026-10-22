import React from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

import { Radii, Shadows, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type CardVariant = 'surface' | 'subtle' | 'outline';

export interface CardProps {
  children: React.ReactNode;
  variant?: CardVariant;
  padding?: keyof typeof Spacing;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({
  children,
  variant = 'surface',
  padding = 'base',
  onPress,
  style,
  testID,
}: CardProps) {
  const theme = useTheme();

  const getVariantStyle = (): ViewStyle => {
    switch (variant) {
      case 'surface':
        return {
          backgroundColor: theme.surface,
          borderColor: theme.border,
          borderWidth: 1,
          ...Shadows.subtle,
        };
      case 'subtle':
        return {
          backgroundColor: theme.surfaceSecondary,
          borderColor: 'transparent',
          borderWidth: 0,
        };
      case 'outline':
        return {
          backgroundColor: 'transparent',
          borderColor: theme.border,
          borderWidth: 1,
        };
    }
  };

  const containerPadding = Spacing[padding];

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          { padding: containerPadding },
          getVariantStyle(),
          pressed && styles.pressed,
          style,
        ]}>
        {children}
      </Pressable>
    );
  }

  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { padding: containerPadding },
        getVariantStyle(),
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radii.lg,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.88,
  },
});
