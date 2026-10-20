import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useNavigate } from 'react-router-dom';
import { get, post, put } from './lib/api';
import { getSoundState, playChime, subscribeSound, unlockSound, wasEverUnlocked, type SoundState } from './lib/sound';
import { fmtTime } from './lib/time';
import { useAuth } from './store';
import type { NewLeadEvent, Summary } from './lib/types';

interface Toast { id: string; kind: 'lead' | 'info' | 'error' | 'warn'; title: string; body?: string; lead?: NewLeadEvent }
interface RtCtx {
  version: number; summary: Summary; refreshSummary(): void; refresh(): void; connected: boolean;
  soundState: SoundState; enableSound(): Promise<void>; setSoundEnabled(on: boolean): Promise<void>;
  setBrowserNotifications(on: boolean): Promise<void>;
  /** 'info' confirmations are intentionally silent (the screen already shows the result); 'warn' and 'error' are shown. */
  toast(kind: 'info' | 'error' | 'warn', title: string, body?: string): void;
  markLeadRead(leadId: number): void;
}
const Rt = createContext<RtCtx>(null!);
export const useRealtime = () => useContext(Rt);

const SEQ_KEY = 'piweb_crm_last_seq';
const readSeq = () => { try { return Number(localStorage.getItem(SEQ_KEY)) || 0; } catch { return 0; } };
const writeSeq = (n: number) => { try { localStorage.setItem(SEQ_KEY, String(n)); } catch { /* storage unavailable */ } };

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { me, setPrefs } = useAuth();
  const nav = useNavigate();
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<Summary>({ unread_new_leads: 0, overdue_followups: 0, scheduled_followups: 0, removed: 0, payment_followups: 0 });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
  const [soundState, setSoundState] = useState<SoundState>(getSoundState());
  const seen = useRef(new Set<string>()); // eventIds already handled in this session (dedupe)
  const prefs = useRef(me?.preferences);
  prefs.current = me?.preferences;

  useEffect(() => subscribeSound(() => setSoundState(getSoundState())), []);
  useEffect(() => { if (wasEverUnlocked()) void unlockSound(); }, []);

  const refreshSummary = useCallback(() => {
    get<Summary>('/leads/summary').then((r) => setSummary(r.data)).catch(() => {});
  }, []);
  const bump = useCallback(() => { setVersion((v) => v + 1); refreshSummary(); }, [refreshSummary]);

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((kind: 'info' | 'error' | 'warn', title: string, body?: string) => {
    if (kind === 'info') return; // no pop-ups for routine updates
    const id = `t${Date.now()}${Math.random()}`;
    setToasts((t) => [...t, { id, kind, title, body }]);
    window.setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);

  useEffect(() => {
    if (!me) return undefined;
    refreshSummary();
    const socket: Socket = io({ path: '/socket.io', withCredentials: true, auth: (cb) => cb({ lastSeq: readSeq() }) });
    socket.on('connect', () => { setConnected(true); bump(); });
    socket.on('disconnect', () => setConnected(false));

    let chimeThisTick = false;
    socket.on('lead:new', (e: NewLeadEvent) => {
      if (seen.current.has(e.eventId)) return; // duplicate delivery (reconnect/replay overlap)
      seen.current.add(e.eventId);
      if (e.seq > readSeq()) writeSeq(e.seq);
      setToasts((t) => [...t, { id: e.eventId, kind: 'lead', title: 'New Lead Received', lead: e }]);
      window.setTimeout(() => dismiss(e.eventId), 30000);
      // One chime per burst, only when the user wants sound and the browser allows it.
      if (!chimeThisTick && prefs.current?.sound_enabled) {
        chimeThisTick = true; window.setTimeout(() => { chimeThisTick = false; }, 800);
        if (!playChime()) setSoundState(getSoundState());
      }
      if (prefs.current?.browser_notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('New Lead Received', { body: `${e.enquiry}${e.phone ? ` · ${e.phone}` : ''}`, tag: e.eventId });
      }
      bump();
    });
    // Someone allocated leads to me: tell me, chime once (if allowed) and refresh so they appear at the top.
    socket.on('leads:allocated', (e: { count: number; by: string }) => {
      const id = `alloc${Date.now()}`;
      setToasts((t) => [...t, { id, kind: 'info', title: `${e.count} lead${e.count === 1 ? '' : 's'} allocated to you`, body: `By ${e.by}. They are at the top of Leads.` }]);
      window.setTimeout(() => dismiss(id), 8000);
      if (prefs.current?.sound_enabled) playChime();
      bump();
    });
    socket.on('leads:assigned', (e: { count: number; by: string }) => {
      const id = `assign${Date.now()}`;
      setToasts((t) => [...t, { id, kind: 'info', title: `${e.count} lead${e.count === 1 ? '' : 's'} assigned to you`, body: `By ${e.by}.` }]);
      window.setTimeout(() => dismiss(id), 8000);
      if (prefs.current?.sound_enabled) playChime();
      bump();
    });
    let t: number | undefined;
    socket.on('lead:changed', () => { clearTimeout(t); t = window.setTimeout(bump, 400); });
    return () => { clearTimeout(t); socket.close(); };
  }, [me?.id, bump, dismiss, refreshSummary]);

  const enableSound = useCallback(async () => { setSoundState(await unlockSound()); if (getSoundState() === 'ready') playChime(); }, []);
  const setSoundEnabled = useCallback(async (on: boolean) => {
    await put('/preferences', { sound_enabled: on }); setPrefs({ sound_enabled: on });
    if (on) await enableSound();
  }, [setPrefs, enableSound]);
  const setBrowserNotifications = useCallback(async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission === 'default') {
      if ((await Notification.requestPermission()) !== 'granted') { toast('error', 'Browser notifications blocked', 'Allow notifications in your browser settings to enable them.'); return; }
    }
    if (on && 'Notification' in window && Notification.permission === 'denied') { toast('error', 'Browser notifications blocked', 'Allow notifications in your browser settings to enable them.'); return; }
    await put('/preferences', { browser_notifications: on }); setPrefs({ browser_notifications: on });
  }, [setPrefs, toast]);
  const markLeadRead = useCallback((leadId: number) => {
    post('/notifications/read', { lead_id: leadId }).then(refreshSummary).catch(() => {});
  }, [refreshSummary]);

  const value = useMemo(() => ({ version, summary, refreshSummary, refresh: bump, connected, soundState, enableSound, setSoundEnabled, setBrowserNotifications, toast, markLeadRead }),
    [version, summary, refreshSummary, bump, connected, soundState, enableSound, setSoundEnabled, setBrowserNotifications, toast, markLeadRead]);

  return (
    <Rt.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-3 top-3 z-[60] flex w-[calc(100vw-1.5rem)] max-w-sm flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto rounded-lg border bg-white p-3 shadow-lg ${t.kind === 'error' ? 'border-red-300' : t.kind === 'warn' ? 'border-amber-300' : t.kind === 'lead' ? 'border-brand-500' : 'border-slate-200'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{t.kind === 'lead' && <span aria-hidden>🔔 </span>}{t.title}</p>
                {t.lead ? (
                  <div className="mt-1 space-y-0.5 text-xs text-slate-600">
                    <p>A new enquiry has arrived.</p>
                    <p><span className="text-slate-500">Lead:</span> <b>{t.lead.enquiry}</b></p>
                    <p><span className="text-slate-500">Phone:</span> {t.lead.phone ?? '—'}</p>
                    <p><span className="text-slate-500">Received:</span> {fmtTime(t.lead.receivedAt, me?.timezone || 'Asia/Kolkata')}</p>
                  </div>
                ) : t.body && <p className="mt-0.5 text-xs text-slate-600">{t.body}</p>}
              </div>
              <button className="text-slate-400 hover:text-slate-700" aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button>
            </div>
            {t.lead && (
              <div className="mt-2 flex gap-2">
                <button className="btn btn-primary !py-1 text-xs" onClick={() => { nav(`/leads?lead=${t.lead!.leadId}`); markLeadRead(t.lead!.leadId); dismiss(t.id); }}>View Lead</button>
                <button className="btn btn-ghost !py-1 text-xs" onClick={() => dismiss(t.id)}>Dismiss</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Rt.Provider>
  );
}
