import React, { forwardRef, useState } from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import { Radii, Spacing, TouchTarget, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  /** Label displayed above the input field */
  label?: string;
  /** Helper text displayed beneath the input when there is no error */
  helperText?: string;
  /** Error message string or boolean flag indicating invalid state */
  error?: string | boolean;
  /** Optional icon or element to render on the left side of the input */
  leftIcon?: React.ReactNode;
  /** Optional icon or element to render on the right side of the input */
  rightIcon?: React.ReactNode;
  /** Style applied to the outermost wrapper (label + input + helper/error) */
  containerStyle?: StyleProp<ViewStyle>;
  /** Style applied to the input container border frame */
  inputContainerStyle?: StyleProp<ViewStyle>;
  /** Style applied directly to the TextInput element */
  inputStyle?: StyleProp<TextStyle>;
  /** Style applied to the label text */
  labelStyle?: StyleProp<TextStyle>;
  /** Style applied to the helper text */
  helperStyle?: StyleProp<TextStyle>;
  /** Style applied to the error text */
  errorStyle?: StyleProp<TextStyle>;
  /** Unique test identifier */
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    helperText,
    error,
    leftIcon,
    rightIcon,
    containerStyle,
    inputContainerStyle,
    inputStyle,
    labelStyle,
    helperStyle,
    errorStyle,
    value,
    onChangeText,
    placeholder,
    placeholderTextColor,
    editable = true,
    multiline = false,
    numberOfLines,
    onFocus,
    onBlur,
    testID,
    accessibilityLabel,
    accessibilityHint,
    ...rest
  },
  ref
) {
  const theme = useTheme();
  const [isFocused, setIsFocused] = useState(false);

  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;

  const handleFocus: TextInputProps['onFocus'] = (e) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur: TextInputProps['onBlur'] = (e) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  // Border and background state resolution
  const getBorderColor = (): string => {
    if (hasError) {
      return theme.danger;
    }
    if (isFocused) {
      return theme.primary;
    }
    return theme.border;
  };

  const borderColor = getBorderColor();
  const disabled = !editable;

  return (
    <View style={[styles.wrapper, containerStyle]}>
      {label ? (
        <Text
          style={[
            styles.label,
            { color: hasError ? theme.danger : theme.text },
            labelStyle,
          ]}>
          {label}
        </Text>
      ) : null}

      <View
        style={[
          styles.inputContainer,
          {
            backgroundColor: disabled ? theme.surfaceSecondary : theme.surface,
            borderColor,
            borderWidth: isFocused || hasError ? 1.5 : 1,
            opacity: disabled ? 0.6 : 1,
          },
          multiline && styles.multilineContainer,
          inputContainerStyle,
        ]}>
        {leftIcon ? <View style={styles.leftIconContainer}>{leftIcon}</View> : null}

        <TextInput
          ref={ref}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={placeholderTextColor ?? theme.textMuted}
          editable={editable}
          multiline={multiline}
          numberOfLines={numberOfLines}
          onFocus={handleFocus}
          onBlur={handleBlur}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={accessibilityHint ?? errorMessage ?? helperText}
          accessibilityState={{ disabled }}
          aria-invalid={hasError}
          style={[
            styles.input,
            { color: theme.text },
            multiline && styles.multilineInput,
            inputStyle,
          ]}
          {...rest}
        />

        {rightIcon ? <View style={styles.rightIconContainer}>{rightIcon}</View> : null}
      </View>

      {errorMessage ? (
        <Text
          accessibilityRole="alert"
          style={[styles.feedbackText, { color: theme.danger }, errorStyle]}>
          {errorMessage}
        </Text>
      ) : helperText ? (
        <Text
          style={[
            styles.feedbackText,
            { color: theme.textSecondary },
            helperStyle,
          ]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    marginBottom: Spacing.sm,
  },
  label: {
    ...Typography.headline,
    fontSize: 14,
    lineHeight: 18,
    marginBottom: Spacing.xs,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radii.base,
    minHeight: TouchTarget.comfortable,
    paddingHorizontal: Spacing.base,
  },
  multilineContainer: {
    minHeight: 96,
    alignItems: 'flex-start',
    paddingVertical: Spacing.sm,
  },
  input: {
    flex: 1,
    ...Typography.body,
    paddingVertical: Spacing.sm,
    paddingHorizontal: 0,
  },
  multilineInput: {
    textAlignVertical: 'top',
    height: '100%',
  },
  leftIconContainer: {
    marginRight: Spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rightIconContainer: {
    marginLeft: Spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  feedbackText: {
    ...Typography.caption,
    marginTop: Spacing.xs,
    marginLeft: Spacing.xxs,
  },
});
