export const PAGE_SIZES = [10, 20, 50, 100];

function pages(cur: number, total: number): (number | '…')[] {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const lo = Math.max(2, cur - 1); const hi = Math.min(total - 1, cur + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < total - 1) out.push('…');
  out.push(total);
  return out;
}

/** Fixed footer: only numbers and pagination. */
export function Pager({ page, totalPages, total, size, onPage, onSize }: { page: number; totalPages: number; total: number; size: number; onPage(p: number): void; onSize(s: number): void }) {
  const btn = 'flex h-8 min-w-[2rem] items-center justify-center rounded-lg px-2 text-xs font-semibold tabular-nums transition disabled:opacity-35';
  return (
    <footer className="pb-safe shrink-0 border-t border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-5">
        <span className="hidden text-xs tabular-nums text-slate-500 sm:inline">{total === 0 ? '0' : `${(page - 1) * size + 1}–${Math.min(page * size, total)}`} of {total}</span>
        <nav className="mx-auto flex items-center gap-1 sm:mx-0" aria-label="Pagination">
          <button className={`${btn} text-slate-600 hover:bg-slate-100`} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
          {pages(page, totalPages).map((n, i) => n === '…'
            ? <span key={`e${i}`} className="px-1 text-slate-400">…</span>
            : <button key={n} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined} className={`${btn} ${n === page ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>{n}</button>)}
          <button className={`${btn} text-slate-600 hover:bg-slate-100`} disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
        </nav>
        <select className="h-8 rounded-lg border border-slate-200 bg-white px-1.5 text-xs font-medium text-slate-600" value={size} onChange={(e) => onSize(Number(e.target.value))} aria-label="Rows per page">
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>
    </footer>
  );
}
