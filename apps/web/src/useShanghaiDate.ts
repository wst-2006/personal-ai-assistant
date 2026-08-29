import { useEffect, useState } from "react";
import { shanghaiDateKey } from "./solar-terms";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

function nextShanghaiMidnight(now: number) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(24, 0, 0, 0);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
}

/** Keeps calendar-scoped UI in sync without requiring a reload or a new build. */
export function useShanghaiDate() {
  const [date, setDate] = useState(() => shanghaiDateKey(new Date()));

  useEffect(() => {
    let timer = 0;
    const sync = () => {
      const next = shanghaiDateKey(new Date());
      setDate((current) => current === next ? current : next);
    };
    const schedule = () => {
      const delay = Math.max(1_000, nextShanghaiMidnight(Date.now()) - Date.now() + 100);
      timer = window.setTimeout(() => {
        sync();
        schedule();
      }, delay);
    };
    const resync = () => sync();

    schedule();
    window.addEventListener("focus", resync);
    window.addEventListener("pageshow", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", resync);
      window.removeEventListener("pageshow", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, []);

  return date;
}
