import { router } from 'expo-router';

/**
 * Safely navigates back if a prior screen exists in the navigation stack.
 * If there is no previous screen to go back to, it navigates to the provided
 * fallback route using router.replace(), preventing "The action 'GO_BACK' was not
 * handled by any navigator" console errors.
 *
 * @param fallbackRoute Route to replace with if history stack is empty
 */
export function safeBack(fallbackRoute: string = '/'): void {
  try {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(fallbackRoute as any);
    }
  } catch {
    router.replace(fallbackRoute as any);
  }
}

