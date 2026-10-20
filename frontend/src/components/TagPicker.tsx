import { useState } from 'react';
import { post } from '../lib/api';
import type { SelectableValue, Tag } from '../lib/types';
import { useData } from '../store';
import { useRealtime } from '../realtime';
import { errMsg } from './ui';

export function TagChip({ tag, small }: { tag: Tag; small?: boolean }) {
  const c = tag.colour || '#64748b';
  return <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-semibold ${small ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]'}`} style={{ backgroundColor: `${c}1a`, color: c, border: `1px solid ${c}40` }}>{tag.label}</span>;
}

/** Tap tags to attach them to a remark. "＋ New tag" creates your own on the spot (shared with the team). */
export function TagPicker({ selected, onChange }: { selected: number[]; onChange(ids: number[]): void }) {
  const { byCategory, reload } = useData();
  const { toast } = useRealtime();
  const tags: SelectableValue[] = byCategory('remark_tag');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await post<SelectableValue>('/settings/tags', { label: name });
      await reload();
      if (!selected.includes(r.data.id)) onChange([...selected, r.data.id]);
      setName(''); setAdding(false);
    } catch (e) { toast('error', 'Could not create tag', errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Remark tags">
      {tags.map((t) => {
        const on = selected.includes(t.id); const c = t.colour || '#64748b';
        return (
          <button type="button" key={t.id} onClick={() => toggle(t.id)} aria-pressed={on}
            className="rounded-full px-2.5 py-1 text-xs font-semibold transition active:scale-95"
            style={on ? { backgroundColor: c, color: '#fff', border: `1px solid ${c}` } : { backgroundColor: `${c}12`, color: c, border: `1px solid ${c}40` }}>
            {on && '✓ '}{t.label}
          </button>
        );
      })}
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input autoFocus className="input !h-7 !w-32 !py-0 text-xs" maxLength={40} placeholder="Tag name" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } if (e.key === 'Escape') setAdding(false); }} aria-label="New tag name" />
          <button type="button" className="btn btn-primary !px-2 !py-0.5 text-xs" disabled={busy || !name.trim()} onClick={create}>Add</button>
          <button type="button" className="px-1 text-slate-400 hover:text-slate-700" onClick={() => { setAdding(false); setName(''); }} aria-label="Cancel new tag">✕</button>
        </span>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 hover:border-brand-500 hover:text-brand-600">＋ New tag</button>
      )}
    </div>
  );
}
