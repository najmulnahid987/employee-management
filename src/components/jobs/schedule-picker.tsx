import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface SchedulePickerProps {
  /** Initial ISO string or null */
  value: string;
  /** Callback returning authoritative ISO 8601 timestamp */
  onChange: (isoString: string) => void;
  disabled?: boolean;
}

interface DayOption {
  date: Date;
  label: string;
  sublabel: string;
  isToday: boolean;
}

const DEFAULT_TIME_SLOTS = [
  { label: '8:00 AM', hour: 8, minute: 0 },
  { label: '10:00 AM', hour: 10, minute: 0 },
  { label: '12:00 PM', hour: 12, minute: 0 },
  { label: '2:00 PM', hour: 14, minute: 0 },
  { label: '4:00 PM', hour: 16, minute: 0 },
  { label: '6:00 PM', hour: 18, minute: 0 },
];

export function SchedulePicker({ value, onChange, disabled = false }: SchedulePickerProps) {
  const theme = useTheme();

  // Generate next 7 days starting from today
  const days: DayOption[] = useMemo(() => {
    const list: DayOption[] = [];
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      let label = '';
      if (i === 0) label = 'Today';
      else if (i === 1) label = 'Tomorrow';
      else label = d.toLocaleDateString(undefined, { weekday: 'short' });

      const sublabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      list.push({ date: d, label, sublabel, isToday: i === 0 });
    }
    return list;
  }, []);

  const [selectedDayIndex, setSelectedDayIndex] = useState<number>(0);
  const [selectedTimeSlotIndex, setSelectedTimeSlotIndex] = useState<number>(1); // 10:00 AM default

  const handleDaySelect = (index: number) => {
    if (disabled) return;
    setSelectedDayIndex(index);
    const day = days[index].date;
    const slot = DEFAULT_TIME_SLOTS[selectedTimeSlotIndex];
    const combined = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      slot.hour,
      slot.minute,
      0,
      0
    );
    onChange(combined.toISOString());
  };

  const handleTimeSelect = (index: number) => {
    if (disabled) return;
    setSelectedTimeSlotIndex(index);
    const day = days[selectedDayIndex].date;
    const slot = DEFAULT_TIME_SLOTS[index];
    const combined = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      slot.hour,
      slot.minute,
      0,
      0
    );
    onChange(combined.toISOString());
  };

  // Formatted preview
  const formattedPreview = useMemo(() => {
    try {
      const d = new Date(value);
      if (isNaN(d.getTime())) return 'Scheduled time not set';
      return d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }) + ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return 'Scheduled time';
    }
  }, [value]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <ThemedText type="headline" style={styles.label}>
          Scheduled Arrival Time *
        </ThemedText>
        <ThemedText type="captionMedium" style={{ color: theme.primary }}>
          {formattedPreview}
        </ThemedText>
      </View>

      {/* Date Pill Strip */}
      <ThemedText type="caption" themeColor="textSecondary" style={styles.sectionTitle}>
        Select Day
      </ThemedText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollList}
        keyboardShouldPersistTaps="handled">
        {days.map((day, idx) => {
          const isSelected = selectedDayIndex === idx;
          return (
            <Pressable
              key={day.sublabel}
              disabled={disabled}
              onPress={() => handleDaySelect(idx)}
              style={({ pressed }) => [
                styles.dayCard,
                {
                  backgroundColor: isSelected ? theme.primary : theme.surfaceSecondary,
                  borderColor: isSelected ? theme.primary : theme.border,
                  opacity: disabled ? 0.6 : pressed ? 0.8 : 1,
                },
              ]}>
              <ThemedText
                type="captionMedium"
                style={{
                  color: isSelected ? theme.primaryForeground : theme.text,
                  fontWeight: '600',
                }}>
                {day.label}
              </ThemedText>
              <ThemedText
                type="caption"
                style={{
                  color: isSelected ? theme.primaryForeground : theme.textSecondary,
                  fontSize: 11,
                }}>
                {day.sublabel}
              </ThemedText>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Time Slot Pill Strip */}
      <ThemedText type="caption" themeColor="textSecondary" style={styles.sectionTitle}>
        Select Time Window
      </ThemedText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollList}
        keyboardShouldPersistTaps="handled">
        {DEFAULT_TIME_SLOTS.map((slot, idx) => {
          const isSelected = selectedTimeSlotIndex === idx;
          return (
            <Pressable
              key={slot.label}
              disabled={disabled}
              onPress={() => handleTimeSelect(idx)}
              style={({ pressed }) => [
                styles.timePill,
                {
                  backgroundColor: isSelected ? theme.primary : theme.surfaceSecondary,
                  borderColor: isSelected ? theme.primary : theme.border,
                  opacity: disabled ? 0.6 : pressed ? 0.8 : 1,
                },
              ]}>
              <ThemedText
                type="captionMedium"
                style={{
                  color: isSelected ? theme.primaryForeground : theme.text,
                  fontSize: 13,
                }}>
                {slot.label}
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: Spacing.xs,
  },
  label: {
    fontSize: 14,
    lineHeight: 18,
  },
  sectionTitle: {
    marginTop: Spacing.xs,
    marginBottom: Spacing.xxs,
  },
  scrollList: {
    gap: Spacing.xs,
    paddingVertical: 2,
  },
  dayCard: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: Radii.base,
    borderWidth: 1,
    alignItems: 'center',
    minWidth: 78,
  },
  timePill: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: Radii.full,
    borderWidth: 1,
    alignItems: 'center',
  },
});
