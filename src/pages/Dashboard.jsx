/**
 * Dashboard.jsx
 *
 * History view: shows the last 7 days of computed daily summaries in a
 * table, plus a small KPI strip aggregated from that same data (no extra
 * query needed — we already have the week's worth of rows in memory).
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { getSummaryHistory } from '../services/attendanceService';
import { toDateKey } from '../services/computeAttendance';

const DAYS_TO_SHOW = 7;

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
    });
    return unsubscribe;
  }, []);

  const loadHistory = useCallback(async (userId) => {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (DAYS_TO_SHOW - 1));

    const startKey = toDateKey(startDate);
    const endKey = toDateKey(today);

    const rows = await getSummaryHistory(userId, startKey, endKey);
    setHistory(rows);
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError('');
    loadHistory(user.uid)
      .catch((err) => {
        console.error(err);
        setError('Could not load history.');
      })
      .finally(() => setLoading(false));
  }, [user, loadHistory]);

  // KPIs derived from the already-fetched week of data - no extra query.
  const totals = history.reduce(
    (acc, row) => ({
      regularHours: acc.regularHours + (row.regularHours || 0),
      overtimeHours: acc.overtimeHours + (row.overtimeHours || 0),
      nightDiffHours: acc.nightDiffHours + (row.nightDiffHours || 0),
      lateMinutes: acc.lateMinutes + (row.lateMinutes || 0),
      undertimeMinutes: acc.undertimeMinutes + (row.undertimeMinutes || 0),
    }),
    { regularHours: 0, overtimeHours: 0, nightDiffHours: 0, lateMinutes: 0, undertimeMinutes: 0 }
  );

  return (
    <div className="dashboard-page">
      <header className="punch-header">
        <h1>Dashboard</h1>
        <nav className="dashboard-nav">
          <Link to="/punch">Punch Clock</Link>
          <button className="link-button" onClick={() => signOut(auth)}>
            Log out
          </button>
        </nav>
      </header>

      {error && <p className="auth-error">{error}</p>}

      <section className="kpi-strip">
        <KpiCard label="Regular Hours" value={totals.regularHours.toFixed(2)} />
        <KpiCard label="Overtime" value={totals.overtimeHours.toFixed(2)} />
        <KpiCard label="Night Diff" value={totals.nightDiffHours.toFixed(2)} />
        <KpiCard label="Late (min)" value={Math.round(totals.lateMinutes)} />
        <KpiCard label="Undertime (min)" value={Math.round(totals.undertimeMinutes)} />
      </section>

      <h2>Last {DAYS_TO_SHOW} Days</h2>

      {loading ? (
        <p>Loading...</p>
      ) : history.length === 0 ? (
        <p>No attendance records yet for this period.</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Regular</th>
              <th>OT</th>
              <th>ND</th>
              <th>Late (min)</th>
              <th>Undertime (min)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {history.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{row.regularHours}</td>
                <td>{row.overtimeHours}</td>
                <td>{row.nightDiffHours}</td>
                <td>{row.lateMinutes}</td>
                <td>{row.undertimeMinutes}</td>
                <td>{row.incomplete ? 'Incomplete' : 'Complete'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function KpiCard({ label, value }) {
  return (
    <div className="kpi-card">
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </div>
  );
}