/**
 * NOTIFICATION BEEP
 * =================
 * A short two-tone chime synthesised with the Web Audio API rather than loaded
 * from an audio file — nothing to ship, cache, or fail to download, and it
 * works offline.
 *
 * One AudioContext is created lazily and reused: browsers cap how many a page
 * may open, and creating one per beep leaks them. Browsers also start it
 * suspended until the page has had a user gesture, so every call resumes it
 * first; if the browser still refuses (autoplay policy, no audio device), the
 * failure is swallowed — a missing beep must never break the socket handler
 * that triggered it.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (context) return context;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

/** One tone: a sine with a quick attack and decay, so it reads as a chime rather than a click. */
function playTone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startAt);

  // Ramping the gain rather than starting/stopping at full volume is what
  // avoids the audible click an abrupt square edge would produce.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/** Rising two-note chime — distinct enough to notice, short enough not to nag. */
export function playNotificationBeep(): void {
  const ctx = getContext();
  if (!ctx) return;

  const run = (): void => {
    try {
      const now = ctx.currentTime;
      playTone(ctx, 880, now, 0.11);
      playTone(ctx, 1318.5, now + 0.1, 0.16);
    } catch {
      // An audio failure is never worth surfacing to the user.
    }
  };

  if (ctx.state === 'suspended') {
    void ctx.resume().then(run).catch(() => {});
    return;
  }
  run();
}
