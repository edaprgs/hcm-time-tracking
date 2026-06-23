/**
 * attendanceService.js
 *
 * Thin data-access layer between React components and Firestore for
 * attendance-related operations. Keeping this separate from the UI means
 * PunchClock.jsx, Dashboard.jsx, and admin screens can call these functions
 * without knowing Firestore query details directly.
 *
 * This is also where client-side computation gets wired in, replacing
 * the Cloud Functions trigger we chose not to deploy (see decision log).
 */

import {
  collection,
  addDoc,
  doc,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { computeShiftSummary } from './computeAttendance';

/**
 * Fetches the single most recent punch for a user, to determine current
 * clock-in/out status. Returns null if the user has never punched at all.
 */
export async function getLatestPunch(userId) {
  const q = query(
    collection(db, 'attendance'),
    where('userId', '==', userId),
    orderBy('timestamp', 'desc'),
    limit(1)
  );
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  const docSnap = snapshot.docs[0];
  const data = docSnap.data();
  return {
    type: data.type,
    timestamp: data.timestamp.toDate(),
  };
}

/**
 * Records a punch (in or out) for a user, then triggers recomputation
 * of that shift's daily summary. This mirrors what the Firestore trigger
 * (index.js) would have done automatically — we just call it explicitly
 * here since computation runs client-side instead.
 */
export async function recordPunch(userId, type) {
  await addDoc(collection(db, 'attendance'), {
    userId,
    type,
    timestamp: Timestamp.now(),
  });

  await recomputeAroundNow(userId);
}

/**
 * Fetches a window of punches centered on `centerTime` wide enough to
 * safely contain one full shift (including overnight shifts), recomputes
 * via computeShiftSummary, and writes the resulting dailySummary.
 *
 * `centerTime` defaults to "now" for the common case (just punched),
 * but admin edits to OLDER punches must pass the punch's own timestamp
 * here — otherwise the 36-hour window would be centered on today and
 * miss the actual shift being edited entirely.
 */
export async function recomputeAroundTime(userId, schedule, centerTime = new Date()) {
  const windowStart = new Date(centerTime.getTime() - 36 * 60 * 60 * 1000);
  const windowEnd = new Date(centerTime.getTime() + 36 * 60 * 60 * 1000);

  const q = query(
    collection(db, 'attendance'),
    where('userId', '==', userId),
    where('timestamp', '>=', Timestamp.fromDate(windowStart)),
    where('timestamp', '<=', Timestamp.fromDate(windowEnd)),
    orderBy('timestamp', 'asc')
  );
  const snapshot = await getDocs(q);
  const punches = snapshot.docs.map((d) => {
    const data = d.data();
    return { type: data.type, timestamp: data.timestamp.toDate() };
  });

  if (punches.length === 0 || !schedule) return null;

  const summary = computeShiftSummary(punches, schedule);
  if (!summary) return null;

  const summaryDocId = `${userId}_${summary.date}`;
  await setDoc(
    doc(db, 'dailySummary', summaryDocId),
    {
      userId,
      date: summary.date,
      incomplete: summary.incomplete,
      regularHours: summary.regularHours,
      overtimeHours: summary.overtimeHours,
      nightDiffHours: summary.nightDiffHours,
      lateMinutes: summary.lateMinutes,
      undertimeMinutes: summary.undertimeMinutes,
      totalWorkedHours: summary.totalWorkedHours,
      computedAt: Timestamp.now(),
    },
    { merge: true }
  );

  return summary;
}

// Thin wrapper preserving the original name/signature for existing callers
// (PunchClock.jsx) that always recompute around the current moment.
export async function recomputeAroundNow(userId, schedule) {
  return recomputeAroundTime(userId, schedule);
}

/**
 * Fetches a user's dailySummary documents within a date range (inclusive),
 * ordered most-recent-first. Dates are "YYYY-MM-DD" strings, matching the
 * `date` field format computeShiftSummary produces.
 */
export async function getSummaryHistory(userId, startDateKey, endDateKey) {
  const q = query(
    collection(db, 'dailySummary'),
    where('userId', '==', userId),
    where('date', '>=', startDateKey),
    where('date', '<=', endDateKey),
    orderBy('date', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => d.data());
}

/**
 * ADMIN: fetches all user profiles, for the employee list/picker.
 * Firestore rules allow this only when the requester is an admin.
 */
export async function getAllUsers() {
  const snapshot = await getDocs(collection(db, 'users'));
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * ADMIN: fetches all punches for a specific user within a date range,
 * for the punch-editing view. Returns raw punch docs (with their Firestore
 * doc id, needed for edit/delete).
 */
export async function getPunchesForUser(userId, startDate, endDate) {
  const q = query(
    collection(db, 'attendance'),
    where('userId', '==', userId),
    where('timestamp', '>=', Timestamp.fromDate(startDate)),
    where('timestamp', '<=', Timestamp.fromDate(endDate)),
    orderBy('timestamp', 'asc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp.toDate() }));
}

/**
 * ADMIN: updates a single punch's timestamp or type, then recomputes that
 * user's summary for the affected date(s).
 *
 * `originalTimestamp` (the punch's time BEFORE this edit) is required so
 * the recompute window correctly covers the shift being edited, even if
 * it happened days ago — not just "today."
 */
export async function updatePunch(punchId, updates, userId, schedule, originalTimestamp) {
  await setDoc(doc(db, 'attendance', punchId), updates, { merge: true });

  // Recompute centered on the punch's ORIGINAL time, not "now" — if an
  // admin edits a 3-day-old punch, we still need the window to cover
  // that actual shift, not today's.
  await recomputeAroundTime(userId, schedule, originalTimestamp);

  // If the edit changed the punch's date entirely (e.g. corrected a typo
  // that moved it to a different day), also recompute centered on the
  // NEW time, so both the old and new day's summaries end up correct.
  if (updates.timestamp) {
    const newTime = updates.timestamp.toDate ? updates.timestamp.toDate() : updates.timestamp;
    await recomputeAroundTime(userId, schedule, newTime);
  }
}

/**
 * ADMIN: deletes a punch, then recomputes centered on that punch's
 * original time (same reasoning as updatePunch above).
 */
export async function deletePunch(punchId, userId, schedule, originalTimestamp) {
  await deleteDoc(doc(db, 'attendance', punchId));
  await recomputeAroundTime(userId, schedule, originalTimestamp);
}

/**
 * ADMIN: fetches all employees' dailySummary for one specific date — the
 * "daily report" view. Firestore rules permit this cross-user read only
 * for admins.
 */
export async function getDailyReportForAllUsers(dateKey) {
  const q = query(collection(db, 'dailySummary'), where('date', '==', dateKey));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => d.data());
}

/**
 * ADMIN: fetches all employees' dailySummary within a date range, then
 * aggregates per user — the "weekly report" view. Aggregation happens
 * client-side since Firestore can't sum across documents server-side
 * without Cloud Functions (which we scoped out — see decision log).
 */
export async function getWeeklyReportForAllUsers(startDateKey, endDateKey) {
  const q = query(
    collection(db, 'dailySummary'),
    where('date', '>=', startDateKey),
    where('date', '<=', endDateKey)
  );
  const snapshot = await getDocs(q);
  const rows = snapshot.docs.map((d) => d.data());

  const byUser = {};
  for (const row of rows) {
    if (!byUser[row.userId]) {
      byUser[row.userId] = {
        userId: row.userId,
        regularHours: 0,
        overtimeHours: 0,
        nightDiffHours: 0,
        lateMinutes: 0,
        undertimeMinutes: 0,
        daysWorked: 0,
      };
    }
    const agg = byUser[row.userId];
    agg.regularHours += row.regularHours || 0;
    agg.overtimeHours += row.overtimeHours || 0;
    agg.nightDiffHours += row.nightDiffHours || 0;
    agg.lateMinutes += row.lateMinutes || 0;
    agg.undertimeMinutes += row.undertimeMinutes || 0;
    agg.daysWorked += 1;
  }

  return Object.values(byUser);
}