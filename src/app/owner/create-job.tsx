import { router } from 'expo-router';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { SchedulePicker } from '@/components/jobs/schedule-picker';
import { ServicePicker } from '@/components/jobs/service-picker';
import { WorkerSelectorSheet } from '@/components/jobs/worker-selector-sheet';
import { JobLocationMapPicker } from '@/components/map/job-location-map-picker';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { geocodeAddress, reverseGeocodeCoordinates } from '@/lib/geocoding';
import {
  AssignableWorker,
  createJob,
  fetchAssignableWorkers,
  formatScheduledTime,
  Job,
} from '@/lib/jobs';
import { safeBack } from '@/lib/navigation';
import { validatePhoneNumber } from '@/lib/phone';

export default function CreateJobScreen() {
  const theme = useTheme();
  const { businessId, role } = useAuth();

  // Form Fields
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [service, setService] = useState('');
  const [scheduledAt, setScheduledAt] = useState<string>(() => {
    // Default to today at 10:00 AM in local timezone
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0, 0);
    return d.toISOString();
  });
  const [notes, setNotes] = useState('');
  const [selectedWorker, setSelectedWorker] = useState<AssignableWorker | null>(null);

  // Validation Errors
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [geocodingNotice, setGeocodingNotice] = useState<string | null>(null);

  // Map Coordinates & Geocoding
  const [resolvedCoordinates, setResolvedCoordinates] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [isGeocoding, setIsGeocoding] = useState(false);

  // Loading States
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWorkerSheetVisible, setIsWorkerSheetVisible] = useState(false);
  const [workers, setWorkers] = useState<AssignableWorker[]>([]);
  const [isLoadingWorkers, setIsLoadingWorkers] = useState(false);

  // Success Confirmation State
  const [createdJob, setCreatedJob] = useState<Job | null>(null);

  // Load assignable workers for the authenticated owner's business
  const loadWorkers = useCallback(async () => {
    if (!businessId || role !== 'owner') return;
    setIsLoadingWorkers(true);
    try {
      const scheduledDate = new Date(scheduledAt);
      const { workers: loadedWorkers, error } = await fetchAssignableWorkers(
        businessId,
        isNaN(scheduledDate.getTime()) ? new Date() : scheduledDate
      );
      if (!error) {
        setWorkers(loadedWorkers);
      }
    } finally {
      setIsLoadingWorkers(false);
    }
  }, [businessId, role, scheduledAt]);

  useEffect(() => {
    loadWorkers();
  }, [loadWorkers]);

  // Client validation
  const validateForm = (): boolean => {
    let isValid = true;
    setNameError(null);
    setPhoneError(null);
    setAddressError(null);
    setServiceError(null);
    setServerError(null);

    if (!customerName.trim()) {
      setNameError('Customer name is required.');
      isValid = false;
    }

    const phoneValidation = validatePhoneNumber(customerPhone);
    if (!phoneValidation.isValid) {
      setPhoneError(phoneValidation.error || 'Please enter a valid phone number.');
      isValid = false;
    }

    if (!service.trim()) {
      setServiceError('Service scope & description is required.');
      isValid = false;
    }

    if (!address.trim()) {
      setAddressError('Service site address is required.');
      isValid = false;
    }

    return isValid;
  };

  const handleGeocodeAddress = async () => {
    if (!address.trim()) {
      setAddressError('Please enter a service address first.');
      return;
    }
    setIsGeocoding(true);
    setAddressError(null);
    setGeocodingNotice(null);
    try {
      const geoResult = await geocodeAddress(address, 4000);
      if (geoResult.coordinates) {
        setResolvedCoordinates(geoResult.coordinates);
      } else {
        setGeocodingNotice(
          'Could not find this address on the map. You can still save the job with the text address.'
        );
      }
    } catch {
      setGeocodingNotice('Geocoding service timed out. You can still save the job.');
    } finally {
      setIsGeocoding(false);
    }
  };

  const handleUseCurrentLocation = async () => {
    setIsGeocoding(true);
    setGeocodingNotice(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setGeocodingNotice('Location permission was denied. Please enter address manually.');
        setIsGeocoding(false);
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setResolvedCoordinates(coords);

      // Reverse geocode to populate address if currently empty
      if (!address.trim()) {
        const rev = await reverseGeocodeCoordinates(coords.latitude, coords.longitude);
        if (rev.address) {
          setAddress(rev.address);
        }
      }
    } catch {
      setGeocodingNotice('Could not retrieve current device location.');
    } finally {
      setIsGeocoding(false);
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting || !businessId) return;

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    setServerError(null);
    setGeocodingNotice(null);

    try {
      // 1. Normalize phone input
      const phoneValidation = validatePhoneNumber(customerPhone);
      const normalizedPhone = phoneValidation.normalized;

      // 2. Use user-pinned coordinates or fallback to on-submit geocoding
      let resolvedCoords: { latitude: number; longitude: number } | null = resolvedCoordinates;
      if (!resolvedCoords) {
        try {
          const geoResult = await geocodeAddress(address, 3000);
          resolvedCoords = geoResult.coordinates;
          if (!resolvedCoords) {
            setGeocodingNotice(
              'Address coordinates could not be resolved automatically. The job is being saved with the textual address.'
            );
          }
        } catch {
          resolvedCoords = null;
        }
      }

      // 3. Dispatch secure atomic job creation
      const result = await createJob({
        businessId,
        customerName: customerName.trim(),
        customerPhone: normalizedPhone,
        service: service.trim(),
        address: address.trim(),
        scheduledAt,
        notes: notes.trim() ? notes.trim() : null,
        workerId: selectedWorker?.id || null,
        latitude: resolvedCoords?.latitude ?? null,
        longitude: resolvedCoords?.longitude ?? null,
      });

      if (!result.success || !result.job) {
        setServerError(result.error || 'Failed to create job.');
        setIsSubmitting(false);
        return;
      }

      // Success: display confirmation state
      setCreatedJob(result.job);
      setIsSubmitting(false);
    } catch (err) {
      setIsSubmitting(false);
      setServerError(
        err instanceof Error ? err.message : 'An unexpected error occurred while creating the job.'
      );
    }
  };

  // ---------------------------------------------------------------------------
  // Success Confirmation View
  // ---------------------------------------------------------------------------
  if (createdJob) {
    const isAssigned = createdJob.status === 'assigned' && Boolean(createdJob.worker_id);
    const workerName = selectedWorker?.full_name || 'Assigned Technician';

    return (
      <ScreenContainer scrollable withPadding>
        <View style={styles.container}>
          <Card variant="surface" style={styles.successCard}>
            <View style={[styles.successIconBadge, { backgroundColor: theme.primary }]}>
              <ThemedText type="title" style={{ color: theme.primaryForeground }}>
                ✓
              </ThemedText>
            </View>

            <ThemedText type="headline" style={styles.successHeadline}>
              Job Created Successfully
            </ThemedText>

            <ThemedText type="body" themeColor="textSecondary" style={styles.successSubtext}>
              {isAssigned
                ? `Dispatched to ${workerName} and recorded in operations.`
                : 'Saved in unassigned queue ready for field dispatch.'}
            </ThemedText>

            <View style={styles.summaryBox}>
              <View style={styles.summaryRow}>
                <ThemedText type="captionMedium" themeColor="textSecondary">
                  STATUS
                </ThemedText>
                <StatusBadge status={createdJob.status as JobStatus} size="sm" />
              </View>

              <View style={styles.summaryRow}>
                <ThemedText type="captionMedium" themeColor="textSecondary">
                  SERVICE
                </ThemedText>
                <ThemedText type="bodyMedium" numberOfLines={1} style={styles.summaryValue}>
                  {createdJob.service}
                </ThemedText>
              </View>

              <View style={styles.summaryRow}>
                <ThemedText type="captionMedium" themeColor="textSecondary">
                  CUSTOMER
                </ThemedText>
                <ThemedText type="bodyMedium" numberOfLines={1} style={styles.summaryValue}>
                  {createdJob.customer_name} • {createdJob.customer_phone}
                </ThemedText>
              </View>

              <View style={styles.summaryRow}>
                <ThemedText type="captionMedium" themeColor="textSecondary">
                  ADDRESS
                </ThemedText>
                <ThemedText type="caption" numberOfLines={2} style={styles.summaryValue}>
                  {createdJob.address}
                </ThemedText>
              </View>

              <View style={styles.summaryRow}>
                <ThemedText type="captionMedium" themeColor="textSecondary">
                  SCHEDULED
                </ThemedText>
                <ThemedText type="captionMedium" style={styles.summaryValue}>
                  {formatScheduledTime(createdJob.scheduled_at)}
                </ThemedText>
              </View>

              {isAssigned ? (
                <View style={styles.summaryRow}>
                  <ThemedText type="captionMedium" themeColor="textSecondary">
                    TECHNICIAN
                  </ThemedText>
                  <ThemedText type="captionMedium" style={styles.summaryValue}>
                    {workerName}
                  </ThemedText>
                </View>
              ) : null}
            </View>

            <View style={styles.successActions}>
              <Button
                label="View Job Details"
                variant="primary"
                fullWidth
                onPress={() => {
                  router.replace({
                    pathname: '/owner/job-details',
                    params: { id: createdJob.id },
                  });
                }}
              />
              <Button
                label="Return to Dashboard"
                variant="outline"
                fullWidth
                onPress={() => safeBack('/owner/dashboard')}
              />
            </View>
          </Card>
        </View>
      </ScreenContainer>
    );
  }

  // ---------------------------------------------------------------------------
  // Create Job Entry Form
  // ---------------------------------------------------------------------------
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">New Service Job</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Enter job details, customer contact, and assign a technician.
          </ThemedText>
        </View>

        {serverError ? (
          <Card
            variant="outline"
            style={[
              styles.errorCard,
              { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
            ]}>
            <ThemedText type="captionMedium" style={{ color: theme.danger }}>
              {serverError}
            </ThemedText>
          </Card>
        ) : null}

        {geocodingNotice ? (
          <Card
            variant="outline"
            style={[
              styles.noticeCard,
              { borderColor: Palette.amberBorder, backgroundColor: Palette.amberBg },
            ]}>
            <ThemedText type="caption" style={{ color: Palette.amberText }}>
              {geocodingNotice}
            </ThemedText>
          </Card>
        ) : null}

        <Card variant="surface" style={styles.formCard}>
          {/* Customer Name */}
          <Input
            label="Customer Name *"
            placeholder="e.g. John Smith"
            value={customerName}
            onChangeText={(text) => {
              setCustomerName(text);
              if (nameError) setNameError(null);
            }}
            error={nameError ?? undefined}
            autoCapitalize="words"
            editable={!isSubmitting}
          />

          {/* Customer Phone */}
          <Input
            label="Customer Phone *"
            placeholder="e.g. +1 (555) 234-5678"
            value={customerPhone}
            onChangeText={(text) => {
              setCustomerPhone(text);
              if (phoneError) setPhoneError(null);
            }}
            error={phoneError ?? undefined}
            helperText="Local or international format with leading +"
            keyboardType="phone-pad"
            editable={!isSubmitting}
          />

          {/* Service Scope & Suggestions */}
          <Input
            label="Service Scope & Description *"
            placeholder="e.g. Emergency water pipe leak inspection"
            value={service}
            onChangeText={(text) => {
              setService(text);
              if (serviceError) setServiceError(null);
            }}
            error={serviceError ?? undefined}
            editable={!isSubmitting}
          />
          <ServicePicker
            selectedService={service}
            onSelectService={(s) => {
              setService(s);
              if (serviceError) setServiceError(null);
            }}
            disabled={isSubmitting}
          />

          {/* Physical Service Address with Location Pin Button */}
          <View style={styles.addressSection}>
            <View style={styles.addressInputRow}>
              <View style={styles.addressInputContainer}>
                <Input
                  label="Service Site Address *"
                  placeholder="e.g. 742 Evergreen Terrace, Springfield"
                  value={address}
                  onChangeText={(text) => {
                    setAddress(text);
                    if (addressError) setAddressError(null);
                    if (geocodingNotice) setGeocodingNotice(null);
                  }}
                  error={addressError ?? undefined}
                  helperText="Physical address where work will be performed"
                  editable={!isSubmitting}
                />
              </View>
              <Pressable
                onPress={handleGeocodeAddress}
                disabled={isGeocoding || isSubmitting}
                style={({ pressed }) => [
                  styles.pinIconButton,
                  {
                    backgroundColor: resolvedCoordinates
                      ? Palette.greenBg
                      : theme.surfaceSecondary,
                    borderColor: resolvedCoordinates
                      ? Palette.greenBorder
                      : theme.border,
                    opacity: isGeocoding || isSubmitting ? 0.6 : pressed ? 0.7 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Locate address on map">
                <ThemedText style={styles.pinIconText}>
                  {isGeocoding ? '⏳' : '📍'}
                </ThemedText>
              </Pressable>
            </View>

            {/* Interactive Map Picker & Preview */}
            <JobLocationMapPicker
              coordinates={resolvedCoordinates}
              onCoordinatesChange={(newCoords) => setResolvedCoordinates(newCoords)}
              address={address}
              isGeocoding={isGeocoding}
              onFindAddressOnMap={handleGeocodeAddress}
              onUseCurrentLocation={handleUseCurrentLocation}
            />
          </View>

          {/* Schedule Picker */}
          <SchedulePicker
            value={scheduledAt}
            onChange={setScheduledAt}
            disabled={isSubmitting}
          />

          {/* Worker Selector Card */}
          <View style={styles.workerSection}>
            <ThemedText type="headline" style={styles.workerLabel}>
              Technician Assignment (Optional)
            </ThemedText>

            <Pressable
              disabled={isSubmitting}
              onPress={() => setIsWorkerSheetVisible(true)}
              style={({ pressed }) => [
                styles.workerTriggerCard,
                {
                  backgroundColor: theme.surfaceSecondary,
                  borderColor: selectedWorker ? theme.primary : theme.border,
                  opacity: isSubmitting ? 0.6 : pressed ? 0.8 : 1,
                },
              ]}>
              {selectedWorker ? (
                <View style={styles.selectedWorkerRow}>
                  <View style={[styles.avatarDot, { backgroundColor: theme.primary }]}>
                    <ThemedText type="captionMedium" style={{ color: theme.primaryForeground }}>
                      {selectedWorker.full_name.charAt(0).toUpperCase()}
                    </ThemedText>
                  </View>
                  <View style={styles.selectedWorkerInfo}>
                    <ThemedText type="headline" style={styles.selectedWorkerName}>
                      {selectedWorker.full_name}
                    </ThemedText>
                    <ThemedText type="caption" themeColor="textSecondary">
                      {selectedWorker.workloadBadge.label}
                    </ThemedText>
                  </View>
                  <Button
                    label="Change"
                    variant="outline"
                    size="sm"
                    onPress={() => setIsWorkerSheetVisible(true)}
                  />
                </View>
              ) : (
                <View style={styles.unassignedTriggerRow}>
                  <ThemedText type="body" themeColor="textSecondary">
                    Unassigned — tap to select a field technician
                  </ThemedText>
                  <ThemedText type="captionMedium" style={{ color: theme.primary }}>
                    Assign
                  </ThemedText>
                </View>
              )}
            </Pressable>
          </View>

          {/* Optional Internal Notes */}
          <Input
            label="Internal Notes (Optional)"
            placeholder="Gate code, parking instructions, or equipment notes..."
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
            editable={!isSubmitting}
          />

          {/* Submit Action Button */}
          <Button
            label={
              isSubmitting
                ? 'Creating Job...'
                : selectedWorker
                ? 'Create & Dispatch Job'
                : 'Create Unassigned Job'
            }
            variant="primary"
            fullWidth
            loading={isSubmitting}
            disabled={isSubmitting}
            onPress={handleSubmit}
            style={styles.submitButton}
          />
        </Card>
      </View>

      {/* Worker Selector Bottom Sheet Modal */}
      <WorkerSelectorSheet
        visible={isWorkerSheetVisible}
        onClose={() => setIsWorkerSheetVisible(false)}
        workers={workers}
        isLoading={isLoadingWorkers}
        selectedWorkerId={selectedWorker?.id ?? null}
        onSelectWorker={(w) => setSelectedWorker(w)}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.base,
  },
  header: {
    gap: Spacing.xs,
  },
  formCard: {
    padding: Spacing.base,
  },
  addressSection: {
    marginBottom: Spacing.xs,
  },
  addressInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.xs,
  },
  addressInputContainer: {
    flex: 1,
  },
  pinIconButton: {
    marginTop: 22,
    width: 48,
    height: 48,
    borderRadius: Radii.base,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinIconText: {
    fontSize: 22,
  },
  errorCard: {
    padding: Spacing.md,
  },
  noticeCard: {
    padding: Spacing.md,
  },
  workerSection: {
    marginBottom: Spacing.base,
  },
  workerLabel: {
    fontSize: 14,
    lineHeight: 18,
    marginBottom: Spacing.xs,
  },
  workerTriggerCard: {
    padding: Spacing.base,
    borderRadius: Radii.base,
    borderWidth: 1,
  },
  selectedWorkerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  avatarDot: {
    width: 38,
    height: 38,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedWorkerInfo: {
    flex: 1,
  },
  selectedWorkerName: {
    fontSize: 15,
  },
  unassignedTriggerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  submitButton: {
    marginTop: Spacing.sm,
  },
  // Success Confirmation Styles
  successCard: {
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.md,
  },
  successIconBadge: {
    width: 56,
    height: 56,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successHeadline: {
    fontSize: 20,
    textAlign: 'center',
  },
  successSubtext: {
    textAlign: 'center',
    lineHeight: 20,
  },
  summaryBox: {
    width: '100%',
    padding: Spacing.base,
    borderRadius: Radii.base,
    backgroundColor: Palette.neutral50,
    gap: Spacing.sm,
    marginVertical: Spacing.xs,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  summaryValue: {
    flex: 1,
    textAlign: 'right',
  },
  successActions: {
    width: '100%',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
});
