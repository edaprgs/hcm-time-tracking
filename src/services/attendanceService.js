/**
 * attendanceService.js
 *
 * Thin data-access layer between React components and Firestore for
 * attendance-related operations. Keeping this separate from the UI means
 * PunchClock.jsx (and later, admin screens) can call these functions
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
 * Fetches a window of punches around "now" wide enough to safely contain
 * one full shift (including overnight shifts), then recomputes and writes
 * the daily summary. Mirrors the 36-hour window logic from index.js.
 */
export async function recomputeAroundNow(userId, schedule) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 36 * 60 * 60 * 1000);

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
