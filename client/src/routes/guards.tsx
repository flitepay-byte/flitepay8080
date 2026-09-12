import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuthStore, homeRouteFor } from '@/stores/auth.store';
import type { Role } from '@/types';

function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-950">
      <Loader2 className="h-5 w-5 animate-spin text-ink-400" />
    </div>
  );
}

/**
 * Route guard. This is convenience and navigation correctness only — the
 * server enforces authorisation on every request regardless of what the
 * client renders.
 */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, status } = useAuthStore();
  const location = useLocation();

  if (status === 'idle' || status === 'loading') return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!roles.includes(user.role)) return <Navigate to={homeRouteFor(user.role)} replace />;

  return <>{children}</>;
}

export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { user, status } = useAuthStore();
  if (status === 'idle' || status === 'loading') return <FullPageSpinner />;
  if (user) return <Navigate to={homeRouteFor(user.role)} replace />;
  return <>{children}</>;
}
