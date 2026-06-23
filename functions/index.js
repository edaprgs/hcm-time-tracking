/**
 * index.js
 *
 * Firestore trigger layer. This file's only job is to:
 *  1. Detect when a punch is written to `attendance`
 *  2. Fetch the relevant punches for that user/shift window
 *  3. Hand them to the pure computeAttendance engine
 *  4. Write the result to `dailySummary`
 *  
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions');

const { computeShiftSummary } = require('./src/computeAttendance');

initializeApp();
const db = getFirestore();

setGlobalOptions({ maxInstances: 10 });

/**
 * Fires whenever a document in `attendance` is created, updated, or deleted.
 * We don't actually care which — any change to a user's punches means we
 * should recompute, so we treat all write types the same way.
 */
exports.onPunchWritten = onDocumentWritten('attendance/{punchId}', async (event) => {
  const punchData = event.data.after.exists ? event.data.after.data() : event.data.before.data();

  if (!punchData || !punchData.userId || !punchData.timestamp) {
    console.warn('Punch document missing required fields, skipping recompute', punchData);
    return;
  }

  const { userId } = punchData;

  // Fetch the user's schedule — required to compute late/undertime/OT.
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    console.warn(`User ${userId} not found, skipping recompute`);
    return;
  }
  const { schedule } = userDoc.data();
  if (!schedule || !schedule.start || !schedule.end) {
    console.warn(`User ${userId} has no schedule configured, skipping recompute`);
    return;
  }

  // Fetch a window of this user's punches wide enough to safely contain
  // any single shift, including overnight ones. We look back/forward
  // 36 hours from the punch that triggered this, then let
  // groupPunchesIntoShifts + computeShiftSummary do the precise pairing.
  const triggerTimestamp = punchData.timestamp.toDate
    ? punchData.timestamp.toDate()
    : new Date(punchData.timestamp);

  const windowStart = new Date(triggerTimestamp.getTime() - 36 * 60 * 60 * 1000);
  const windowEnd = new Date(triggerTimestamp.getTime() + 36 * 60 * 60 * 1000);

  const punchesSnapshot = await db
    .collection('attendance')
    .where('userId', '==', userId)
    .where('timestamp', '>=', Timestamp.fromDate(windowStart))
    .where('timestamp', '<=', Timestamp.fromDate(windowEnd))
    .orderBy('timestamp', 'asc')
    .get();

  const punches = punchesSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      type: data.type,
      timestamp: data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp),
    };
  });

  if (punches.length === 0) {
    return;
  }

  // Compute the summary for the shift that contains our trigger punch.
  const summary = computeShiftSummary(punches, schedule);
  if (!summary) {
    return;
  }

  const summaryDocId = `${userId}_${summary.date}`;

  await db.collection('dailySummary').doc(summaryDocId).set(
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

  console.log(`Recomputed dailySummary for ${summaryDocId}`, summary);
}); 