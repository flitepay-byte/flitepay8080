import { useState } from 'react';
import { Bell, Trash2 } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { cn } from './primitives';

/**
 * App-wide notification center. Every role (admin, party, captain) gets the
 * same live feed of socket events, scoped server-side to what that role is
 * allowed to see (see sockets/index.ts room membership) — this component is
 * just the one shared place it renders.
 */
export function NotificationBell() {
  const { events, clearEvents } = useSocket();
  const [open, setOpen] = useState(false);
  const [seenCount, setSeenCount] = useState(0);

  const unread = Math.max(0, events.length - seenCount);

  const toggle = (): void => {
    setOpen((v) => {
      const next = !v;
      if (next) setSeenCount(events.length);
      return next;
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="Notifications"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-ink-700 bg-ink-900 text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-50"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-signal-red px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-label="Close notifications" />
          <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-panel border border-ink-700 bg-ink-900 shadow-panel animate-slide-up">
            <header className="flex items-center justify-between border-b border-ink-800 px-3.5 py-2.5">
              <p className="eyebrow">Notifications</p>
              {events.length > 0 && (
                <button
                  type="button"
                  onClick={clearEvents}
                  className="inline-flex items-center gap-1 text-2xs text-ink-400 transition-colors hover:text-ink-100"
                >
                  <Trash2 className="h-3 w-3" /> Clear
                </button>
              )}
            </header>

            <div className="max-h-80 overflow-y-auto">
              {events.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-xs text-ink-500">Nothing yet — live events appear here.</p>
              ) : (
                <ul className="divide-y divide-ink-800">
                  {events.map((event) => (
                    <li key={event.id} className="px-3.5 py-2.5">
                      <p className="text-xs text-ink-200">{event.message}</p>
                      <p className="mt-0.5 flex items-baseline gap-2">
                        {event.taskCode && <span className="font-mono tnum text-2xs text-ink-400">{event.taskCode}</span>}
                        <span className={cn('font-mono tnum text-2xs text-ink-500', !event.taskCode && 'ml-auto')}>
                          {new Date(event.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
