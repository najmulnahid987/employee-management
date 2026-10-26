import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { CustomerTrackingView } from '@/components/tracking/customer-tracking-view';

export default function TrackIndexScreen() {
  const params = useLocalSearchParams<{ token?: string }>();

  return <CustomerTrackingView tokenProp={params.token} />;
}
