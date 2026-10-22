import React from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import { Radii, Spacing, TouchTarget, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: (event: GestureResponderEvent) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  icon,
  style,
  textStyle,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const getContainerStyle = (pressed: boolean): ViewStyle => {
    let bg: string = theme.primary;
    let borderColor: string = 'transparent';
    let borderWidth: number = 0;

    switch (variant) {
      case 'primary':
        bg = theme.primary;
        break;
      case 'secondary':
        bg = theme.surface;
        borderColor = theme.border;
        borderWidth = 1;
        break;
      case 'outline':
        bg = 'transparent';
        borderColor = theme.border;
        borderWidth = 1;
        break;
      case 'ghost':
        bg = 'transparent';
        break;
      case 'danger':
        bg = theme.dangerBackground;
        borderColor = theme.dangerBorder;
        borderWidth = 1;
        break;
    }

    return {
      backgroundColor: bg,
      borderColor,
      borderWidth,
      opacity: isDisabled ? 0.45 : pressed ? 0.85 : 1,
    };
  };

  const getTextColor = (): string => {
    switch (variant) {
      case 'primary':
        return theme.primaryForeground;
      case 'secondary':
      case 'outline':
      case 'ghost':
        return theme.text;
      case 'danger':
        return theme.danger;
      default:
        return theme.primaryForeground;
    }
  };

  const textColor = getTextColor();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[size],
        fullWidth && styles.fullWidth,
        getContainerStyle(pressed),
        style,
      ]}>
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <View style={styles.content}>
          {icon ? <View style={styles.iconContainer}>{icon}</View> : null}
          <Text
            style={[
              styles.textBase,
              styles[`text_${size}` as keyof typeof styles],
              { color: textColor },
              textStyle,
            ]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radii.base,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullWidth: {
    width: '100%',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Sizes
  sm: {
    minHeight: 36,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
  },
  md: {
    minHeight: TouchTarget.comfortable,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
  },
  lg: {
    minHeight: 54,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  // Typography per size
  textBase: {
    ...Typography.bodyMedium,
    textAlign: 'center',
  },
  text_sm: {
    ...Typography.captionMedium,
  },
  text_md: {
    ...Typography.bodyMedium,
    fontWeight: '600',
  },
  text_lg: {
    ...Typography.headline,
  },
});
