'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BKK_TZ, NY_TZ, type DisplayTimeZone } from '@/core/market';

interface Prefs {
  tz: DisplayTimeZone;
  setTz: (tz: DisplayTimeZone) => void;
}

const Ctx = createContext<Prefs>({ tz: BKK_TZ, setTz: () => {} });

/** เก็บการเลือก timezone ไว้ใน localStorage (เฉพาะเบราว์เซอร์นี้) */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const [tz, setTzState] = useState<DisplayTimeZone>(BKK_TZ);
  useEffect(() => {
    try {
      const v = localStorage.getItem('trendlens.tz');
      if (v === NY_TZ || v === BKK_TZ) setTzState(v);
    } catch {}
  }, []);
  const setTz = (v: DisplayTimeZone) => {
    setTzState(v);
    try {
      localStorage.setItem('trendlens.tz', v);
    } catch {}
  };
  return <Ctx.Provider value={{ tz, setTz }}>{children}</Ctx.Provider>;
}

export const usePrefs = () => useContext(Ctx);

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setV(JSON.parse(raw));
    } catch {}
  }, [key]);
  const set = (nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(key, JSON.stringify(nv));
    } catch {}
  };
  return [v, set];
}
