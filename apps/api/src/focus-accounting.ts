export type FocusAccountingRow = {
  id: string;
  focusStructureId: string | null;
  state: string;
  rawActiveSeconds: number;
  effectiveFocusSeconds: number;
};

export type FocusSegmentRunAccountingRow = {
  focusSessionId: string;
  segmentType: string;
  elapsedSeconds: number;
};

export function indexFocusSecondsBySession(runs: FocusSegmentRunAccountingRow[]) {
  const result = new Map<string, number>();
  for (const run of runs) {
    const current = result.get(run.focusSessionId) ?? 0;
    result.set(run.focusSessionId, current + (run.segmentType === "focus" ? run.elapsedSeconds : 0));
  }
  return result;
}

export function recordedFocusSeconds(session: FocusAccountingRow, focusSecondsBySession: ReadonlyMap<string, number> = new Map()) {
  if (session.state !== "ended" && session.state !== "evaluated") return 0;
  const structuredSeconds = session.focusStructureId ? focusSecondsBySession.get(session.id) : undefined;
  if (structuredSeconds !== undefined) return structuredSeconds;
  return session.effectiveFocusSeconds > 0
    ? session.effectiveFocusSeconds
    : session.rawActiveSeconds;
}

export function normalizeRecordedFocus<T extends FocusAccountingRow>(session: T, focusSecondsBySession: ReadonlyMap<string, number> = new Map()): T {
  return {
    ...session,
    effectiveFocusSeconds: recordedFocusSeconds(session, focusSecondsBySession)
  };
}
