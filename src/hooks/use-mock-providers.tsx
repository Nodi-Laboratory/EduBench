'use client';

import { createContext, useContext, type ReactNode } from 'react';

// MOCK_PROVIDERS=true lets every provider feature run without API keys.
const MockProvidersContext = createContext(false);

export function MockProvidersProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <MockProvidersContext.Provider value={value}>{children}</MockProvidersContext.Provider>;
}

export function useMockProviders(): boolean {
  return useContext(MockProvidersContext);
}
