import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, post, setUnauthorizedHandler } from './lib/api';
import type { Me, SelectableValue, UserLite } from './lib/types';

interface AuthCtx { me: Me | null; ready: boolean; login(email: string, password: string): Promise<void>; logout(): Promise<void>; setPrefs(p: Partial<Me['preferences']>): void }
const Auth = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Auth);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    get<Me>('/auth/me').then((r) => setMe(r.data)).catch(() => setMe(null)).finally(() => setReady(true));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await post('/auth/login', { email, password });
    setMe((await get<Me>('/auth/me')).data);
  }, []);
  const logout = useCallback(async () => { await post('/auth/logout').catch(() => {}); setMe(null); }, []);
  const setPrefs = useCallback((p: Partial<Me['preferences']>) => setMe((m) => (m ? { ...m, preferences: { ...m.preferences, ...p } } : m)), []);
  const value = useMemo(() => ({ me, ready, login, logout, setPrefs }), [me, ready, login, logout, setPrefs]);
  return <Auth.Provider value={value}>{children}</Auth.Provider>;
}

interface DataCtx {
  values: SelectableValue[]; users: UserLite[]; reload(): Promise<void>;
  byCategory(c: string): SelectableValue[]; statuses(cat: 'active' | 'not_interested' | 'converted'): SelectableValue[];
}
const Data = createContext<DataCtx>(null!);
export const useData = () => useContext(Data);

/** Active selectable values + the user directory, loaded once and refreshed after Settings edits. */
export function DataProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<SelectableValue[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const reload = useCallback(async () => {
    const [v, u] = await Promise.all([get<SelectableValue[]>('/settings/values'), get<UserLite[]>('/users')]);
    setValues(v.data); setUsers(u.data.filter((x) => x.is_active !== false));
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const value = useMemo<DataCtx>(() => ({
    values, users, reload,
    byCategory: (c) => values.filter((v) => v.category === c),
    statuses: (cat) => values.filter((v) => v.category === 'lead_status' && v.status_category === cat),
  }), [values, users, reload]);
  return <Data.Provider value={value}>{children}</Data.Provider>;
}
