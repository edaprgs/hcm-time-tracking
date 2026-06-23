/**
 * Login.jsx
 *
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);

      // Check role to decide landing page. Falls back to /punch if the
      // profile read fails for any reason — never block login over this.
      try {
        const profileSnap = await getDoc(doc(db, 'users', credential.user.uid));
        const role = profileSnap.exists() ? profileSnap.data().role : null;
        navigate(role === 'admin' ? '/admin' : '/punch');
      } catch {
        navigate('/punch');
      }
    } catch (err) {
      // Firebase's default error messages are reasonably user-friendly
      // (e.g. "wrong-password", "user-not-found"), so we show them directly
      // rather than writing a custom mapping for this assessment's scope.
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <form onSubmit={handleSubmit} className="auth-form">
        <h1>Log In</h1>

        {error && <p className="auth-error">{error}</p>}

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
            required
          />
        </label>

        <button type="submit" disabled={loading}>
          {loading ? 'Logging in...' : 'Log In'}
        </button>

        <p>
          Don't have an account? <Link to="/register">Register</Link>
        </p>
      </form>
    </div>
  );
}