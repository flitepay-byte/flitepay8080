import { create } from 'zustand';
import { api } from '@/lib/api';
import type { AuthUser } from '@/types';

interface AuthState {
  user: AuthUser | null;
  status: 'idle' | 'loading' | 'authenticated' | 'unauthenticated';
  setUser: (user: AuthUser | null) => void;
  /** Verifies the session against the server on boot and after refresh. */
  hydrate: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'idle',

  setUser: (user) => set({ user, status: user ? 'authenticated' : 'unauthenticated' }),

  hydrate: async () => {
    set({ status: 'loading' });
    try {
      const user = await api.get<AuthUser>('/auth/me');
      set({ user, status: 'authenticated' });
    } catch {
      set({ user: null, status: 'unauthenticated' });
    }
  },

  logout: async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      set({ user: null, status: 'unauthenticated' });
    }
  },
}));

/** Landing route for each role after sign-in. */
export function homeRouteFor(role: AuthUser['role']): string {
  switch (role) {
    case 'ADMIN':
      return '/admin';
    case 'PARTY':
      return '/party';
    case 'CAPTAIN':
      return '/captain';
    default:
      return '/login';
  }
}
