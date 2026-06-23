/**
 * AdminDashboard.jsx
 *
 * Admin-only screen: employee picker + punch editing, daily report,
 * and weekly report. Gated at the UI level by checking the logged-in
 * user's role — but the REAL enforcement is in Firestore rules
 * (isAdmin()), so even a bypassed UI check can't expose data.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import {
  getAllUsers,
  getPunchesForUser,
  updatePunch,
  deletePunch,
  getDailyReportForAllUsers,
  getWeeklyReportForAllUsers,
} from '../services/attendanceService';
import { toDateKey } from '../services/computeAttendance';

export default function AdminDashboard() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [punches, setPunches] = useState([]);
  const [punchesLoading, setPunchesLoading] = useState(false);

  const [dailyReportDate, setDailyReportDate] = useState(toDateKey(new Date()));
  const [dailyReport, setDailyReport] = useState([]);

  const [weeklyReport, setWeeklyReport] = useState([]);

  const [error, setError] = useState('');

  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthChecked(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, 'users', user.uid)).then((snap) => {
      if (snap.exists()) setProfile(snap.data());
      setProfileLoaded(true);
    });
  }, [user]);

  useEffect(() => {
    if (profile?.role !== 'admin') return;
    getAllUsers()
      .then(setUsers)
      .catch((err) => {
        console.error(err);
        setError('Could not load employee list.');
      });
  }, [profile]);

  const loadPunchesForSelectedUser = useCallback(async (userId) => {
    setPunchesLoading(true);
    setError('');
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 7);
      const rows = await getPunchesForUser(userId, start, end);
      setPunches(rows);
    } catch (err) {
      console.error(err);
      setError('Could not load punches for this employee.');
    } finally {
      setPunchesLoading(false);
    }
  }, []);

  function handleSelectUser(userId) {
    setSelectedUserId(userId);
    if (userId) loadPunchesForSelectedUser(userId);
  }

  async function handleEditPunchType(punch, newType) {
    const selectedUser = users.find((u) => u.id === selectedUserId);
    if (!selectedUser?.schedule) return;
    try {
      await updatePunch(punch.id, { type: newType }, selectedUserId, selectedUser.schedule, punch.timestamp);
      await loadPunchesForSelectedUser(selectedUserId);
    } catch (err) {
      console.error(err);
      setError('Failed to update punch.');
    }
  }

  async function handleDeletePunch(punch) {
    const selectedUser = users.find((u) => u.id === selectedUserId);
    if (!selectedUser?.schedule) return;
    if (!window.confirm('Delete this punch? This cannot be undone.')) return;
    try {
      await deletePunch(punch.id, selectedUserId, selectedUser.schedule, punch.timestamp);
      await loadPunchesForSelectedUser(selectedUserId);
    } catch (err) {
      console.error(err);
      setError('Failed to delete punch.');
    }
  }

  async function loadDailyReport() {
    setError('');
    try {
      const rows = await getDailyReportForAllUsers(dailyReportDate);
      setDailyReport(rows);
    } catch (err) {
      console.error(err);
      setError('Could not load daily report.');
    }
  }

  async function loadWeeklyReport() {
    setError('');
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 6);
      const rows = await getWeeklyReportForAllUsers(toDateKey(start), toDateKey(end));
      setWeeklyReport(rows);
    } catch (err) {
      console.error(err);
      setError('Could not load weekly report.');
    }
  }

  function userName(userId) {
    return users.find((u) => u.id === userId)?.name || userId;
  }

  if (authChecked && !user) {
    return <Navigate to="/login" replace />;
  }

  // Wait for profile to load before deciding whether to gate access -
  // avoids briefly redirecting a real admin before their role is fetched.
  if (!profileLoaded) {
    return <div className="admin-page">Loading...</div>;
  }

  if (profile?.role !== 'admin') {
    return <Navigate to="/punch" replace />;
  }

  return (
    <div className="admin-page">
      <header className="punch-header">
        <h1>Admin Tools</h1>
        <nav className="dashboard-nav">
          <Link to="/punch">Punch Clock</Link>
          <Link to="/dashboard">My Dashboard</Link>
          <button className="link-button" onClick={() => signOut(auth)}>
            Log out
          </button>
        </nav>
      </header>

      {error && <p className="auth-error">{error}</p>}

      <section className="admin-section">
        <h2>Employee Punches</h2>
        <label>
          Select employee:
          <select value={selectedUserId} onChange={(e) => handleSelectUser(e.target.value)}>
            <option value="">-- Choose --</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </select>
        </label>

        {punchesLoading ? (
          <p>Loading punches...</p>
        ) : selectedUserId && punches.length === 0 ? (
          <p>No punches in the last 7 days for this employee.</p>
        ) : selectedUserId ? (
          <table className="history-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Type</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {punches.map((p) => (
                <tr key={p.id}>
                  <td>{p.timestamp.toLocaleString()}</td>
                  <td>{p.type}</td>
                  <td>
                    <button onClick={() => handleEditPunchType(p, p.type === 'in' ? 'out' : 'in')}>
                      Flip to {p.type === 'in' ? 'out' : 'in'}
                    </button>
                    <button onClick={() => handleDeletePunch(p)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="admin-section">
        <h2>Daily Report (All Employees)</h2>
        <label>
          Date:
          <input
            type="date"
            value={dailyReportDate}
            onChange={(e) => setDailyReportDate(e.target.value)}
          />
        </label>
        <button onClick={loadDailyReport}>Load Report</button>

        {dailyReport.length > 0 && (
          <table className="history-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Regular</th>
                <th>OT</th>
                <th>ND</th>
                <th>Late (min)</th>
                <th>Undertime (min)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {dailyReport.map((row) => (
                <tr key={row.userId}>
                  <td>{userName(row.userId)}</td>
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
      </section>

      <section className="admin-section">
        <h2>Weekly Report (All Employees, Last 7 Days)</h2>
        <button onClick={loadWeeklyReport}>Load Report</button>

        {weeklyReport.length > 0 && (
          <table className="history-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Days Worked</th>
                <th>Total Regular</th>
                <th>Total OT</th>
                <th>Total ND</th>
                <th>Total Late (min)</th>
                <th>Total Undertime (min)</th>
              </tr>
            </thead>
            <tbody>
              {weeklyReport.map((row) => (
                <tr key={row.userId}>
                  <td>{userName(row.userId)}</td>
                  <td>{row.daysWorked}</td>
                  <td>{row.regularHours.toFixed(2)}</td>
                  <td>{row.overtimeHours.toFixed(2)}</td>
                  <td>{row.nightDiffHours.toFixed(2)}</td>
                  <td>{Math.round(row.lateMinutes)}</td>
                  <td>{Math.round(row.undertimeMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}