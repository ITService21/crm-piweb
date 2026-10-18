import { createContext, useContext, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth, useData } from './store';
import { useRealtime } from './realtime';
import { NotesModal } from './components/NotesModal';

/** Pages render their primary action (e.g. "Add lead") into the fixed header through this slot. */
export const HeaderSlot = createContext<HTMLElement | null>(null);
export const useHeaderSlot = () => useContext(HeaderSlot);

const NAV: { to: string; label: string; icon: string; badge?: 'leads' }[] = [
  { to: '/leads', label: 'Leads', icon: '👥', badge: 'leads' },
  { to: '/follow-ups', label: 'Follow-up Scheduled', icon: '📅' },
  { to: '/not-interested', label: 'Not Interested', icon: '🚫' },
  { to: '/converted', label: 'Converted', icon: '✅' },
  { to: '/removed', label: 'Removed', icon: '🗑️' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

function CountBadge({ n, tone, title }: { n: number; tone: 'blue' | 'red'; title: string }) {
  if (!n) return null;
  return <span title={title} className={`rounded-full px-1.5 text-[10px] font-bold leading-4 text-white ${tone === 'red' ? 'bg-red-500' : 'bg-brand-500'}`}>{n > 99 ? '99+' : n}</span>;
}

export function Layout() {
  const { me, logout } = useAuth();
  const { summary, connected, soundState, enableSound, refresh } = useRealtime();
  const { reload } = useData();
  const [spinning, setSpinning] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // Re-fetches the current list, counts, badges and dropdown values without a page reload.
  const doRefresh = () => { setSpinning(true); refresh(); void reload().catch(() => {}); window.setTimeout(() => setSpinning(false), 800); };
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const { pathname } = useLocation();
  const title = NAV.find((n) => pathname.startsWith(n.to))?.label ?? 'Leads';

  const nav: ReactNode = (
    <nav className="flex-1 space-y-1 p-3" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'}`}>
          <span aria-hidden className="w-5 text-center">{n.icon}</span><span className="truncate">{n.label}</span>
          <span className="ml-auto flex items-center gap-1">
            {n.badge === 'leads' && <><CountBadge n={summary.unread_new_leads} tone="blue" title="Unread new leads" /><CountBadge n={summary.overdue_followups} tone="red" title="Overdue follow-ups" /></>}
            {n.to === '/removed' && summary.removed > 0 && <span className="text-[11px] tabular-nums text-slate-500" title="Removed leads">{summary.removed}</span>}
            {n.to === '/follow-ups' && summary.scheduled_followups > 0 && <span className="text-[11px] tabular-nums text-slate-500" title="Scheduled follow-ups">{summary.scheduled_followups}</span>}
          </span>
        </NavLink>
      ))}
    </nav>
  );
  const footer = (
    <div className="border-t border-white/10 p-3 text-xs">
      <p className="truncate font-medium text-slate-200">{me!.name}</p>
      <p className="mb-2 capitalize text-slate-500">{me!.role}</p>
      <button className="w-full rounded-lg border border-white/15 py-1.5 text-slate-300 hover:bg-white/10" onClick={() => logout()}>Sign out</button>
    </div>
  );
  const brand = <div className="flex items-center gap-2 px-4 py-4"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white shadow">P</span><span className="text-sm font-semibold tracking-wide text-white">CRM</span></div>;

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 md:flex">{brand}{nav}{footer}</aside>

      {open && <div className="fixed inset-0 z-40 bg-slate-900/50 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-slate-900 shadow-xl transition-transform md:hidden ${open ? 'translate-x-0' : '-translate-x-full'}`} aria-hidden={!open}>
        <div className="flex items-center justify-between pr-3">{brand}<button className="text-slate-400" onClick={() => setOpen(false)} aria-label="Close menu">✕</button></div>
        {nav}{footer}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:px-5">
          <button className="-ml-1 rounded-lg p-1.5 text-lg leading-none text-slate-600 hover:bg-slate-100 md:hidden" onClick={() => setOpen(true)} aria-label="Open menu">☰</button>
          <h1 className="flex items-center text-[15px] font-semibold text-slate-900"><span className="max-[359px]:hidden"><span className="font-medium text-slate-400">CRM</span><span className="mx-1.5 text-slate-300">/</span></span>{title}</h1>
          <button onClick={() => setNotesOpen(true)} title="Notes — copy-ready WhatsApp & email scripts" aria-label="Notes"
            className="ml-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 active:scale-95">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>
          </button>
          <div className="ml-auto flex items-center gap-2">
            {me!.preferences.sound_enabled && soundState === 'blocked' && (
              <button className="flex h-9 shrink-0 items-center rounded-full bg-amber-100 px-2.5 text-xs font-medium text-amber-900 hover:bg-amber-200" onClick={() => enableSound()} title="Browsers block sound until you interact with the page">🔇<span className="hidden sm:inline"> Enable sound</span></button>
            )}
            <button onClick={doRefresh} title="Refresh" aria-label="Refresh data" disabled={spinning}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 active:scale-95">
              <svg className={spinning ? 'animate-spin' : ''} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></svg>
            </button>
            <div ref={setSlot} className="flex items-center gap-2" />
            <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-slate-300'}`} title={connected ? 'Live updates connected' : 'Reconnecting…'} />
          </div>
        </header>
        {/* Pages own their scrolling so toolbars/footers can stay fixed */}
        <main className="min-h-0 flex-1 overflow-hidden"><HeaderSlot.Provider value={slot}><Outlet /></HeaderSlot.Provider></main>
      </div>
      {notesOpen && <NotesModal onClose={() => setNotesOpen(false)} />}
    </div>
  );
}
