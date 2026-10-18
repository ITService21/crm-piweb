import { useEffect, type ReactNode } from 'react';

export function Modal({ title, onClose, children, wide = false, tall = false, footer, headerExtra }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; tall?: boolean; footer?: ReactNode; headerExtra?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`flex w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl ${tall ? 'h-[92vh] sm:h-[85vh] sm:max-w-3xl' : `max-h-[92vh] ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}`}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="ml-auto mr-2 flex items-center gap-2">{headerExtra}</div>
          <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export const Spinner = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />{label}
  </div>
);

export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="mx-auto my-8 max-w-sm rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700" role="alert">
    <p>{message}</p>
    {onRetry && <button className="btn btn-ghost mt-3" onClick={onRetry}>Retry</button>}
  </div>
);

export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="py-12 text-center">
    <p className="text-sm font-medium text-slate-700">{title}</p>
    {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
  </div>
);

export function Badge({ colour, children, title }: { colour?: string | null; children: ReactNode; title?: string }) {
  const c = colour || '#64748b';
  return (
    <span title={title} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: `${c}1a`, color: c, border: `1px solid ${c}40` }}>
      {children}
    </span>
  );
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
