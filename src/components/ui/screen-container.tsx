import React from 'react';
import {
  ScrollView,
  ScrollViewProps,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface ScreenContainerProps {
  children: React.ReactNode;
  scrollable?: boolean;
  withPadding?: boolean;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  refreshControl?: ScrollViewProps['refreshControl'];
}

export function ScreenContainer({
  children,
  scrollable = true,
  withPadding = true,
  style,
  contentContainerStyle,
  edges = ['top', 'bottom', 'left', 'right'],
  refreshControl,
}: ScreenContainerProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const paddingTop = edges.includes('top') ? insets.top + Spacing.sm : 0;
  const paddingBottom = edges.includes('bottom')
    ? Math.max(insets.bottom, Spacing.base)
    : 0;
  const paddingLeft = edges.includes('left') ? insets.left : 0;
  const paddingRight = edges.includes('right') ? insets.right : 0;

  const insetsStyle: ViewStyle = {
    paddingTop,
    paddingBottom,
    paddingLeft,
    paddingRight,
  };

  const horizontalPadding: ViewStyle = withPadding
    ? { paddingHorizontal: Spacing.base }
    : {};

  if (scrollable) {
    return (
      <View style={[styles.root, { backgroundColor: theme.background }, style]}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            insetsStyle,
            horizontalPadding,
            contentContainerStyle,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}>
          <View style={styles.inner}>{children}</View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: theme.background },
        insetsStyle,
        horizontalPadding,
        style,
      ]}>
      <View style={[styles.inner, styles.flexOne, contentContainerStyle]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  flexOne: {
    flex: 1,
    alignSelf: 'center',
  },
});
