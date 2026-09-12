import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { cn } from './primitives';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show: (tone: ToastTone, message: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TONE_STYLES: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: 'border-signal-green/40 text-signal-green' },
  error: { icon: XCircle, className: 'border-signal-red/40 text-signal-red' },
  info: { icon: Info, className: 'border-signal-cyan/40 text-signal-cyan' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, message: string) => {
      const id = `${Date.now()}-${Math.random()}`;
      setItems((prev) => [...prev, { id, tone, message }].slice(-4));
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {items.map((item) => {
          const { icon: Icon, className } = TONE_STYLES[item.tone];
          return (
            <div
              key={item.id}
              className={cn(
                'pointer-events-auto flex items-start gap-2.5 rounded-panel border bg-ink-850 px-3.5 py-3 shadow-panel animate-slide-up',
                className,
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="flex-1 text-xs leading-relaxed text-ink-100">{item.message}</p>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="text-ink-400 hover:text-ink-100"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
