const digits = (p: string) => p.replace(/\D/g, '');

const Icon = ({ d, size }: { d: string; size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d={d} /></svg>;
const CALL = 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z';
const MAIL = 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z';
const WA = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z';

/** Round, thumb-sized action buttons: call (tel:), WhatsApp (wa.me, no pre-filled text) and email (mailto:). */
export function ContactButtons({ phone, email, size = 'md' }: { phone: string | null; email: string | null; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-9 w-9' : 'h-8 w-8';
  const ic = size === 'lg' ? 18 : 16;
  const base = `inline-flex ${box} shrink-0 items-center justify-center rounded-full transition active:scale-95`;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <span className="inline-flex items-center gap-1.5">
      {phone && (
        /* tel: only opens the device dialer; the user still taps Call (and picks a SIM where supported). */
        <a href={`tel:${phone}`} onClick={stop} title="Call (opens your phone's dialer)" aria-label={`Call ${phone}`} className={`${base} bg-sky-100 text-sky-700 hover:bg-sky-200`}><Icon d={CALL} size={ic} /></a>
      )}
      {phone && (
        /* wa.me opens a chat with no pre-filled text; nothing is ever sent automatically. */
        <a href={`https://wa.me/${digits(phone)}`} target="_blank" rel="noopener noreferrer" onClick={stop} title="Open WhatsApp chat" aria-label={`WhatsApp ${phone}`} className={`${base} bg-green-100 text-green-700 hover:bg-green-200`}><Icon d={WA} size={ic} /></a>
      )}
      {email && (
        <a href={`mailto:${email}`} onClick={stop} title={`Email ${email}`} aria-label={`Email ${email}`} className={`${base} bg-amber-100 text-amber-700 hover:bg-amber-200`}><Icon d={MAIL} size={ic} /></a>
      )}
    </span>
  );
}

export function PhoneCell({ phone, email, size = 'md' }: { phone: string | null; email?: string | null; size?: 'md' | 'lg' }) {
  if (!phone && !email) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      {phone && <span className="whitespace-nowrap font-medium tabular-nums text-slate-800">{phone}</span>}
      <ContactButtons phone={phone} email={email ?? null} size={size} />
    </span>
  );
}
