/** Notification chime synthesised with WebAudio (no asset to load). Browsers keep the context suspended until a user gesture. */
export type SoundState = 'ready' | 'blocked' | 'unsupported';

const FLAG = 'piweb_crm_sound_unlocked';
/** True once this browser has ever unlocked audio for the CRM; the "Enable sound" prompt never returns after that. */
export function wasEverUnlocked(): boolean { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } }
function markUnlocked() { try { localStorage.setItem(FLAG, '1'); } catch { /* storage unavailable */ } }

let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();
const Ctor: typeof AudioContext | undefined = typeof window !== 'undefined' ? (window.AudioContext || (window as any).webkitAudioContext) : undefined;

function ensure(): AudioContext | null {
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    ctx.onstatechange = () => { if (ctx?.state === 'running') markUnlocked(); listeners.forEach((l) => l()); };
  }
  return ctx;
}

export function getSoundState(): SoundState {
  if (!Ctor) return 'unsupported';
  return ctx && ctx.state === 'running' ? 'ready' : 'blocked';
}
export function subscribeSound(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Must be called from a user gesture handler (click/keydown) to take effect. */
export async function unlockSound(): Promise<SoundState> {
  const c = ensure();
  if (!c) return 'unsupported';
  try { await c.resume(); } catch { /* still blocked */ }
  if (c.state === 'running') markUnlocked();
  listeners.forEach((l) => l());
  return getSoundState();
}

/** Returns false when the browser still blocks audio (caller shows the Enable Sound control). */
export function playChime(): boolean {
  const c = ensure();
  if (!c || c.state !== 'running') return false;
  const t0 = c.currentTime;
  [[880, 0], [1318.5, 0.16]].forEach(([freq, off]) => {
    const osc = c.createOscillator(); const gain = c.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + off);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + off + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.38);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + off); osc.stop(t0 + off + 0.4);
  });
  return true;
}

// The first real interaction anywhere on the page unlocks audio for later notifications.
if (typeof window !== 'undefined') {
  const events = ['pointerdown', 'touchstart', 'click', 'keydown'] as const;
  const unlock = () => { void unlockSound().then((s) => { if (s === 'ready') events.forEach((e) => window.removeEventListener(e, unlock)); }); };
  events.forEach((e) => window.addEventListener(e, unlock, { passive: true }));
}
