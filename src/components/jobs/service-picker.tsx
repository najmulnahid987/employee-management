import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Palette, Radii, Spacing, Typography } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export const COMMON_SERVICE_SUGGESTIONS = [
  'Emergency Leak Repair',
  'Pipe & Drain Cleaning',
  'Water Heater Maintenance',
  'Electrical Diagnostic & Repair',
  'Panel & Breaker Inspection',
  'HVAC Seasonal Tune-up',
  'AC System Diagnostic',
  'Appliance Hookup & Install',
  'General Facility Maintenance',
] as const;

export interface ServicePickerProps {
  selectedService: string;
  onSelectService: (service: string) => void;
  disabled?: boolean;
}

export function ServicePicker({
  selectedService,
  onSelectService,
  disabled = false,
}: ServicePickerProps) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <ThemedText type="captionMedium" themeColor="textSecondary" style={styles.title}>
        Suggested Services
      </ThemedText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled">
        {COMMON_SERVICE_SUGGESTIONS.map((item) => {
          const isSelected = selectedService.trim().toLowerCase() === item.toLowerCase();
          return (
            <Pressable
              key={item}
              disabled={disabled}
              onPress={() => onSelectService(item)}
              accessibilityRole="button"
              accessibilityLabel={`Select ${item}`}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: isSelected ? theme.primary : theme.surfaceSecondary,
                  borderColor: isSelected ? theme.primary : theme.border,
                  opacity: disabled ? 0.6 : pressed ? 0.8 : 1,
                },
              ]}>
              <ThemedText
                type="captionMedium"
                style={[
                  styles.chipText,
                  { color: isSelected ? theme.primaryForeground : theme.text },
                ]}>
                {item}
              </ThemedText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: Spacing.sm,
  },
  title: {
    marginBottom: Spacing.xs,
  },
  scrollContent: {
    gap: Spacing.xs,
    paddingVertical: 2,
  },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: Radii.full,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    lineHeight: 16,
  },
});
