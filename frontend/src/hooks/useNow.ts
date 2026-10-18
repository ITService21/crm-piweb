import { useEffect, useState } from 'react';

/** Re-renders on every minute boundary so countdown labels stay current without a reload. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    };
    timer = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    const onVisible = () => { if (!document.hidden) setNow(new Date()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return now;
}
