import React from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import { Radii, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { Button, ButtonProps } from './button';

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
  variant?: ButtonProps['variant'];
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export interface EmptyStateProps {
  /** Primary title clearly summarizing the empty condition */
  title: string;
  /** Short explanatory message guiding the user */
  description?: string;
  /** Optional icon or decorative visual element */
  icon?: React.ReactNode;
  /** Optional primary action configuration */
  action?: EmptyStateAction;
  /** Convenience shorthand for action button label */
  actionLabel?: string;
  /** Convenience shorthand for action button press callback */
  onAction?: () => void;
  /** Style applied to the outer container */
  style?: StyleProp<ViewStyle>;
  /** Style applied to the title */
  titleStyle?: StyleProp<TextStyle>;
  /** Style applied to the description */
  descriptionStyle?: StyleProp<TextStyle>;
  /** Unique test identifier */
  testID?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  actionLabel,
  onAction,
  style,
  titleStyle,
  descriptionStyle,
  testID,
}: EmptyStateProps) {
  const theme = useTheme();

  // Resolve action configuration from either structured action prop or shorthand props
  const resolvedAction: EmptyStateAction | undefined = action
    ? action
    : actionLabel && onAction
    ? { label: actionLabel, onPress: onAction }
    : undefined;

  return (
    <View
      testID={testID}
      accessibilityRole="none"
      style={[styles.container, style]}>
      {icon ? (
        <View
          style={[
            styles.iconWrapper,
            { backgroundColor: theme.surfaceSecondary },
          ]}>
          {icon}
        </View>
      ) : null}

      <Text
        accessibilityRole="header"
        style={[styles.title, { color: theme.text }, titleStyle]}>
        {title}
      </Text>

      {description ? (
        <Text
          style={[
            styles.description,
            { color: theme.textSecondary },
            descriptionStyle,
          ]}>
          {description}
        </Text>
      ) : null}

      {resolvedAction ? (
        <View style={styles.actionWrapper}>
          <Button
            label={resolvedAction.label}
            onPress={resolvedAction.onPress}
            variant={resolvedAction.variant ?? 'primary'}
            size="md"
            loading={resolvedAction.loading}
            disabled={resolvedAction.disabled}
            testID={resolvedAction.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xxl,
    paddingHorizontal: Spacing.xl,
    width: '100%',
  },
  iconWrapper: {
    width: 56,
    height: 56,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.base,
  },
  title: {
    ...Typography.subtitle,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  description: {
    ...Typography.body,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
    marginBottom: Spacing.base,
  },
  actionWrapper: {
    marginTop: Spacing.sm,
  },
});
