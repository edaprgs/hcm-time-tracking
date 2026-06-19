/**
 * PunchClock.jsx
 *
 * The core daily-use screen. Status (in vs out) is NEVER stored as its
 * own field anywhere — it's derived from the most recent punch record,
 * so `attendance` stays the single source of truth (see Day 1 notes on
 * layering raw facts vs. derived meaning).
 */

import { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { auth, db } from '../firebase';
import { getLatestPunch, recordPunch, recomputeAroundNow } from '../services/attendanceService';

export default function PunchClock() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [latestPunch, setLatestPunch] = useState(null);
  const [todaySummary, setTodaySummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [punchInFlight, setPunchInFlight] = useState(false);
  const [error, setError] = useState('');

  // Track auth state so we know which user's data to load.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
    });
    return unsubscribe;
  }, []);

  const loadStatus = useCallback(async (userId) => {
    const [profileSnap, latest] = await Promise.all([
      getDoc(doc(db, 'users', userId)),
      getLatestPunch(userId),
    ]);

    if (profileSnap.exists()) {
      setProfile(profileSnap.data());
    }
    setLatestPunch(latest);
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    loadStatus(user.uid).finally(() => setLoading(false));
  }, [user, loadStatus]);

  // Currently "in" only if the most recent punch exists and is type 'in'.
  const isClockedIn = latestPunch?.type === 'in';

  async function handlePunch() {
    if (!user || !profile) return;
    setError('');
    setPunchInFlight(true);

    try {
      const nextType = isClockedIn ? 'out' : 'in';
      await recordPunch(user.uid, nextType);

      // Refresh status and recompute today's summary with the user's schedule.
      await loadStatus(user.uid);
      const summary = await recomputeAroundNow(user.uid, profile.schedule);
      setTodaySummary(summary);
    } catch (err) {
      setError('Something went wrong recording your punch. Please try again.');
      console.error(err);
    } finally {
      setPunchInFlight(false);
    }
  }

  if (loading) {
    return <div className="punch-page">Loading...</div>;
  }

  return (
    <div className="punch-page">
      <header className="punch-header">
        <div>
          <h1>Hi, {profile?.name || 'there'}</h1>
          <p className="punch-status-label">
            Status: <strong>{isClockedIn ? 'Clocked In' : 'Clocked Out'}</strong>
          </p>
        </div>
        <div className="dashboard-nav">
          <Link to="/dashboard">View Dashboard</Link>
          <button className="link-button" onClick={() => signOut(auth)}>
            Log out
          </button>
        </div>
      </header>

      {error && <p className="auth-error">{error}</p>}

      <button
        className={isClockedIn ? 'punch-button punch-out' : 'punch-button punch-in'}
        onClick={handlePunch}
        disabled={punchInFlight}
      >
        {punchInFlight ? 'Recording...' : isClockedIn ? 'Punch Out' : 'Punch In'}
      </button>

      {latestPunch && (
        <p className="punch-last-action">
          Last action: {latestPunch.type === 'in' ? 'Punched in' : 'Punched out'} at{' '}
          {latestPunch.timestamp.toLocaleString()}
        </p>
      )}

      {todaySummary && (
        <section className="summary-preview">
          <h2>Today's Summary</h2>
          {todaySummary.incomplete && (
            <p className="summary-incomplete-flag">
              Shift incomplete — missing a punch-out.
            </p>
          )}
          <ul>
            <li>Regular hours: {todaySummary.regularHours}</li>
            <li>Overtime: {todaySummary.overtimeHours}</li>
            <li>Night differential: {todaySummary.nightDiffHours}</li>
            <li>Late: {todaySummary.lateMinutes} min</li>
            <li>Undertime: {todaySummary.undertimeMinutes} min</li>
          </ul>
        </section>
      )}
    </div>
  );
}