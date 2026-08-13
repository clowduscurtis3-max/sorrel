import { createContext, useContext } from 'react';

// Phase 7 Step 1 sub-step 1.2: minimal auth/goal context - just enough for
// root-layout gating and the goal-intake/edit-goal flow. Sub-step 1.3's
// AppDataProvider absorbs this (adding transactions/alerts/pushTokenRef/
// etc.) rather than this being a second, permanently-separate context -
// this is deliberately narrow for now, not a premature abstraction.
export const SessionContext = createContext(null);

export function useSessionContext() {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSessionContext must be used within the root layout\'s SessionContext.Provider');
  }
  return ctx;
}
