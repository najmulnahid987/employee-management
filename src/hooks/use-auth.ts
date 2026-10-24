import { useContext } from 'react';

import { AuthContext, AuthContextValue } from '@/contexts/auth-context';

/**
 * Accesses the authoritative authentication session and user state.
 * Throws an error if invoked outside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return context;
}
