import { Platform, StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?:
    | 'default'
    | 'hero'
    | 'title'
    | 'subtitle'
    | 'headline'
    | 'body'
    | 'bodyMedium'
    | 'bodyBold'
    | 'caption'
    | 'captionMedium'
    | 'label'
    | 'small'
    | 'smallBold'
    | 'link'
    | 'linkPrimary'
    | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      style={[
        { color: theme[themeColor ?? 'text'] },
        type === 'default' && styles.body,
        type === 'hero' && styles.hero,
        type === 'title' && styles.title,
        type === 'subtitle' && styles.subtitle,
        type === 'headline' && styles.headline,
        type === 'body' && styles.body,
        type === 'bodyMedium' && styles.bodyMedium,
        type === 'bodyBold' && styles.bodyBold,
        type === 'caption' && styles.caption,
        type === 'captionMedium' && styles.captionMedium,
        type === 'label' && styles.label,
        type === 'small' && styles.small,
        type === 'smallBold' && styles.smallBold,
        type === 'link' && styles.link,
        type === 'linkPrimary' && styles.linkPrimary,
        type === 'code' && styles.code,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  hero: {
    ...Typography.hero,
  },
  title: {
    ...Typography.title,
  },
  subtitle: {
    ...Typography.subtitle,
  },
  headline: {
    ...Typography.headline,
  },
  body: {
    ...Typography.body,
  },
  bodyMedium: {
    ...Typography.bodyMedium,
  },
  bodyBold: {
    ...Typography.bodyBold,
  },
  caption: {
    ...Typography.caption,
  },
  captionMedium: {
    ...Typography.captionMedium,
  },
  label: {
    ...Typography.label,
    textTransform: 'uppercase',
  },
  small: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  smallBold: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  link: {
    lineHeight: 24,
    fontSize: 14,
  },
  linkPrimary: {
    lineHeight: 24,
    fontSize: 14,
    color: '#1D4ED8',
  },
  code: {
    fontFamily: Fonts?.mono,
    fontWeight: Platform.select({ android: '700' }) ?? '500',
    fontSize: 12,
  },
});
