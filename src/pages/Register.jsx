/**
 * Register.jsx
 *
 * Two-step registration, made explicit in code (not hidden):
 *   1. Firebase Auth creates the account -> returns a uid
 *   2. We separately write a Firestore doc at users/{uid} with profile
 *      fields Auth doesn't know about: name, role, timezone, schedule.
 *
 * Default role is always 'employee' on self-registration. Admin role is
 * assigned manually via the Firestore console for this assessment's scope
 * — a real system would have HR/admin assign roles, not let users self-select.
 *
 * Schedule defaults to 09:00-18:00 and is NOT user-editable at signup,
 * for the same reason: schedule assignment is realistically an admin action.
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

const DEFAULT_SCHEDULE = { start: '09:00', end: '18:00' };

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    let createdUid = null;

    try {
      // Step 1: create the Auth account.
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      createdUid = credential.user.uid;

      // Step 2: write the Firestore profile document.
      // If this fails, the user exists in Auth but has no profile —
      // we surface that clearly rather than pretending registration succeeded.
      await setDoc(doc(db, 'users', createdUid), {
        name,
        email,
        role: 'employee',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        schedule: DEFAULT_SCHEDULE,
      });

      navigate('/dashboard');
    } catch (err) {
      if (createdUid) {
        // Auth account was created but the Firestore profile write failed.
        // We tell the user plainly instead of silently leaving a broken account.
        setError(
          'Your account was created, but setting up your profile failed. Please contact support or try logging in.'
        );
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <form onSubmit={handleSubmit} className="auth-form">
        <h1>Create Account</h1>

        {error && <p className="auth-error">{error}</p>}

        <label>
          Full Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
        </label>

        <button type="submit" disabled={loading}>
          {loading ? 'Creating account...' : 'Register'}
        </button>

        <p>
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}