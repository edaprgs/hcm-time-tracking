/**
 * firebase.js
 */

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyD_CTjdGtLfJuJCYOfZYcANnnpe9K31pZA",
  authDomain: "mini-hcm-edagraceparagoso.firebaseapp.com",
  projectId: "mini-hcm-edagraceparagoso",
  storageBucket: "mini-hcm-edagraceparagoso.firebasestorage.app",
  messagingSenderId: "162567243282",
  appId: "1:162567243282:web:591eb58bfe6d6673e97acb",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);