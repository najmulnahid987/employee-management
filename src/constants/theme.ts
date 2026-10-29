/**
 * Dispatcher Design System Tokens
 *
 * Minimal professional B2B design foundation for field-service operations.
 * - Primary: near-black (#171717)
 * - Canvas/Background: soft off-white (#F7F7F5)
 * - Surfaces: white (#FFFFFF)
 * - Borders: subtle light gray (#E5E5E5)
 * - Text: near-black (#171717) / neutral gray (#737373)
 * - Status: muted, accessible tones for all 8 job lifecycle stages
 */

import '@/global.css';

import { Platform, ViewStyle } from 'react-native';

import { JobStatus } from '@/lib/lifecycle';

export const Palette = {
  // Brand & Neutrals
  neutral900: '#171717',
  neutral800: '#262626',
  neutral700: '#404040',
  neutral600: '#525252',
  neutral500: '#737373',
  neutral400: '#A3A3A3',
  neutral300: '#D4D4D4',
  neutral200: '#E5E5E5',
  neutral100: '#F0F0EE',
  neutral50: '#F7F7F5',
  white: '#FFFFFF',
  black: '#000000',

  // Soft Status Colors (Accessible B2B tones)
  slateBg: '#F4F4F5',
  slateText: '#52525B',
  slateBorder: '#E4E4E7',
  slateDot: '#71717A',

  blueBg: '#EFF6FF',
  blueText: '#1D4ED8',
  blueBorder: '#DBEAFE',
  blueDot: '#3B82F6',

  purpleBg: '#F5F3FF',
  purpleText: '#6D28D9',
  purpleBorder: '#EDE9FE',
  purpleDot: '#8B5CF6',

  amberBg: '#FEFCE8',
  amberText: '#854D0E',
  amberBorder: '#FEF08A',
  amberDot: '#EAB308',

  cyanBg: '#ECFEFF',
  cyanText: '#0E7490',
  cyanBorder: '#CFFAFE',
  cyanDot: '#06B6D4',

  orangeBg: '#FFF7ED',
  orangeText: '#9A3412',
  orangeBorder: '#FFEDD5',
  orangeDot: '#F97316',

  greenBg: '#F0FDF4',
  greenText: '#15803D',
  greenBorder: '#DCFCE7',
  greenDot: '#22C55E',

  redBg: '#FEF2F2',
  redText: '#991B1B',
  redBorder: '#FEE2E2',
  redDot: '#EF4444',
} as const;

export const Colors = {
  light: {
    // Canvas & Surfaces
    background: Palette.neutral50,
    surface: Palette.white,
    surfaceSecondary: Palette.neutral100,
    surfaceSubtle: '#FAFAFA',

    // Primary & Action
    primary: Palette.neutral900,
    primaryForeground: Palette.white,

    // Typography
    text: Palette.neutral900,
    textSecondary: Palette.neutral500,
    textMuted: Palette.neutral400,
    textInverse: Palette.white,

    // Borders
    border: Palette.neutral200,
    borderSubtle: Palette.neutral100,
    borderStrong: Palette.neutral300,

    // Feedback
    danger: Palette.redText,
    dangerBackground: Palette.redBg,
    dangerBorder: Palette.redBorder,

    // Backward compatibility with starter components
    backgroundElement: Palette.neutral100,
    backgroundSelected: '#E0E1E6',
  },
  dark: {
    // Canvas & Surfaces
    background: '#121212',
    surface: '#1C1C1E',
    surfaceSecondary: '#242426',
    surfaceSubtle: '#18181A',

    // Primary & Action
    primary: '#F5F5F5',
    primaryForeground: Palette.neutral900,

    // Typography
    text: '#F5F5F5',
    textSecondary: '#A3A3A3',
    textMuted: '#737373',
    textInverse: Palette.neutral900,

    // Borders
    border: '#2E2E32',
    borderSubtle: '#222226',
    borderStrong: '#3E3E42',

    // Feedback
    danger: '#F87171',
    dangerBackground: '#450A0A',
    dangerBorder: '#7F1D1D',

    // Backward compatibility with starter components
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * 8-Stage Job Lifecycle as specified in AGENTS.md (centralized in @/lib/lifecycle)
 */
export type { JobStatus };

export interface StatusStyle {
  background: string;
  text: string;
  border: string;
  dot: string;
  label: string;
}

export const StatusColors: Record<JobStatus, StatusStyle> = {
  unassigned: {
    background: Palette.slateBg,
    text: Palette.slateText,
    border: Palette.slateBorder,
    dot: Palette.slateDot,
    label: 'Unassigned',
  },
  assigned: {
    background: Palette.blueBg,
    text: Palette.blueText,
    border: Palette.blueBorder,
    dot: Palette.blueDot,
    label: 'Assigned',
  },
  accepted: {
    background: Palette.purpleBg,
    text: Palette.purpleText,
    border: Palette.purpleBorder,
    dot: Palette.purpleDot,
    label: 'Accepted',
  },
  on_the_way: {
    background: Palette.amberBg,
    text: Palette.amberText,
    border: Palette.amberBorder,
    dot: Palette.amberDot,
    label: 'On the way',
  },
  arrived: {
    background: Palette.cyanBg,
    text: Palette.cyanText,
    border: Palette.cyanBorder,
    dot: Palette.cyanDot,
    label: 'Arrived',
  },
  in_progress: {
    background: Palette.orangeBg,
    text: Palette.orangeText,
    border: Palette.orangeBorder,
    dot: Palette.orangeDot,
    label: 'In progress',
  },
  completed: {
    background: Palette.greenBg,
    text: Palette.greenText,
    border: Palette.greenBorder,
    dot: Palette.greenDot,
    label: 'Completed',
  },
  cancelled: {
    background: Palette.redBg,
    text: Palette.redText,
    border: Palette.redBorder,
    dot: Palette.redDot,
    label: 'Cancelled',
  },
};

export const Spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  huge: 48,

  // Compatibility aliases
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const Radii = {
  none: 0,
  xs: 4,
  sm: 6,
  md: 8,
  base: 10,
  lg: 12,
  xl: 16,
  pill: 9999,
  full: 9999,
} as const;

export const TouchTarget = {
  min: 44,
  comfortable: 48,
} as const;

export const Typography = {
  hero: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700' as const,
  },
  title: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700' as const,
  },
  subtitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600' as const,
  },
  headline: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600' as const,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400' as const,
  },
  bodyMedium: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '500' as const,
  },
  bodyBold: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600' as const,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400' as const,
  },
  captionMedium: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500' as const,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600' as const,
    letterSpacing: 0.3,
  },
  code: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500' as const,
  },
} as const;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Shadows = {
  none: {},
  subtle: Platform.select<ViewStyle>({
    ios: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 2,
    },
    android: {
      elevation: 1,
    },
    default: {
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
    } as ViewStyle,
  }),
  card: Platform.select<ViewStyle>({
    ios: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 4,
    },
    android: {
      elevation: 2,
    },
    default: {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.05)',
    } as ViewStyle,
  }),
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
