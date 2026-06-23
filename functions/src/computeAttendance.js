const NIGHT_START_HOUR = 22; // 22:00
const NIGHT_END_HOUR = 6; // 06:00

function parseTimeString(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return { hour, minute };
}

function anchorTimeToDate(baseDate, hhmm, dayOffset = 0) {
  const { hour, minute } = parseTimeString(hhmm);
  const anchored = new Date(baseDate);
  anchored.setHours(hour, minute, 0, 0);
  anchored.setDate(anchored.getDate() + dayOffset);
  return anchored;
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function pairPunches(sortedPunches) {
  const segments = [];
  let pendingIn = null;
  let incomplete = false;

  for (const punch of sortedPunches) {
    if (punch.type === 'in') {
      if (pendingIn) {
        segments.push({ in: pendingIn, out: null, incomplete: true });
      }
      pendingIn = punch.timestamp;
    } else if (punch.type === 'out') {
      if (pendingIn) {
        segments.push({ in: pendingIn, out: punch.timestamp, incomplete: false });
        pendingIn = null;
      }
    }
  }

  if (pendingIn) {
    segments.push({ in: pendingIn, out: null, incomplete: true });
    incomplete = true;
  }

  return { segments, incomplete };
}

function nightOverlapMinutes(start, end) {
  if (end <= start) return 0;

  let totalOverlap = 0;
  let cursorDayStart = new Date(start);
  cursorDayStart.setHours(0, 0, 0, 0);

  while (cursorDayStart < end) {
    const nightStart = new Date(cursorDayStart);
    nightStart.setHours(NIGHT_START_HOUR, 0, 0, 0);
    const nightEnd = new Date(cursorDayStart);
    nightEnd.setDate(nightEnd.getDate() + 1);
    nightEnd.setHours(NIGHT_END_HOUR, 0, 0, 0);

    const overlapStart = new Date(Math.max(start.getTime(), nightStart.getTime()));
    const overlapEnd = new Date(Math.min(end.getTime(), nightEnd.getTime()));
    if (overlapEnd > overlapStart) {
      totalOverlap += (overlapEnd - overlapStart) / 60000;
    }

    cursorDayStart.setDate(cursorDayStart.getDate() + 1);
  }

  return totalOverlap;
}

function computeShiftSummary(punches, schedule) {
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) {
    return null;
  }

  const { segments, incomplete } = pairPunches(sorted);
  const completeSegments = segments.filter((s) => !s.incomplete);

  // Defensive case: if pairing produced zero segments at all (e.g. the
  // only punches in this window are orphaned 'out's with no matching
  // 'in' — possible after an admin edit flips a punch type), there's no
  // real shift to report. Surface it as incomplete with zero hours rather
  // than crashing on an empty segments array.
  if (segments.length === 0) {
    return {
      date: toDateKey(sorted[0].timestamp),
      incomplete: true,
      regularHours: 0,
      overtimeHours: 0,
      nightDiffHours: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      totalWorkedHours: 0,
      segments: [],
    };
  }

  const shiftDate = sorted[0].timestamp;
  const shiftDateKey = toDateKey(shiftDate);

  const isOvernightSchedule = schedule.end <= schedule.start;
  const scheduledStart = anchorTimeToDate(shiftDate, schedule.start, 0);
  const scheduledEnd = anchorTimeToDate(shiftDate, schedule.end, isOvernightSchedule ? 1 : 0);
  const scheduledShiftMinutes = (scheduledEnd - scheduledStart) / 60000;

  let totalWorkedMinutes = 0;
  let totalNightMinutes = 0;
  for (const seg of completeSegments) {
    totalWorkedMinutes += (seg.out - seg.in) / 60000;
    totalNightMinutes += nightOverlapMinutes(seg.in, seg.out);
  }

  const firstIn = segments[0].in;
  const lateMinutes = Math.max(0, (firstIn - scheduledStart) / 60000);

  let undertimeMinutes = 0;
  if (!incomplete && completeSegments.length > 0) {
    const lastOut = completeSegments[completeSegments.length - 1].out;
    undertimeMinutes = Math.max(0, (scheduledEnd - lastOut) / 60000);
  }

  const regularMinutes = Math.min(totalWorkedMinutes, scheduledShiftMinutes);
  const overtimeMinutes = Math.max(0, totalWorkedMinutes - scheduledShiftMinutes);

  return {
    date: shiftDateKey,
    incomplete,
    regularHours: round2(regularMinutes / 60),
    overtimeHours: round2(overtimeMinutes / 60),
    nightDiffHours: round2(totalNightMinutes / 60),
    lateMinutes: Math.round(lateMinutes),
    undertimeMinutes: Math.round(undertimeMinutes),
    totalWorkedHours: round2(totalWorkedMinutes / 60),
    segments: segments.map((s) => ({
      in: s.in,
      out: s.out,
      incomplete: !!s.incomplete,
    })),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function groupPunchesIntoShifts(allPunchesSorted) {
  const shifts = [];
  let current = [];

  for (const punch of allPunchesSorted) {
    if (punch.type === 'in' && current.length > 0 && startsNewShift(current)) {
      shifts.push(current);
      current = [];
    }
    current.push(punch);
  }
  if (current.length > 0) shifts.push(current);

  return shifts;
}

function startsNewShift(currentBucket) {
  const { incomplete } = pairPunches(currentBucket);
  return !incomplete;
}

module.exports = {
  computeShiftSummary,
  groupPunchesIntoShifts,
  pairPunches,
  nightOverlapMinutes,
  toDateKey,
};