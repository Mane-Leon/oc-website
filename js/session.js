// js/session.js

import { auth, db } from "./firebase.js";
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

export let currentUser = null;
export let currentRole = null;
export let currentUserProfile = null;

let usersDirectoryCache = null;

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_TAB_MARKER_KEY = "oc_session_tab_active";
export const SESSION_LEASE_DURATION_MS = 45 * 1000;
export const SESSION_LEASE_HEARTBEAT_MS = 20 * 1000;

const SESSION_LAST_ACTIVITY_KEY = "oc_session_last_activity";
const SESSION_LEASE_COLLECTION = "session_leases";
const SESSION_ACTIVITY_THROTTLE_MS = 15000;
const SESSION_ACTIVITY_EVENTS = [
  "click",
  "keydown",
  "mousedown",
  "pointerdown",
  "scroll",
  "touchstart"
];

let activityTrackingStarted = false;
let lastActivityPersistedAt = 0;
let activityListener = null;
let visibilityListener = null;
let focusListener = null;
let leaseIntervalId = null;
let leaseUid = "";

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function fallbackNameFromEmail(email) {
  const safe = String(email ?? "").trim();
  if (!safe) return "Usuario";
  return safe.split("@")[0];
}

function readLastActivity() {
  const raw = sessionStorage.getItem(SESSION_LAST_ACTIVITY_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function touchSessionActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityPersistedAt < SESSION_ACTIVITY_THROTTLE_MS) {
    return;
  }

  lastActivityPersistedAt = now;
  sessionStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(now));
}

export function hasSessionExpired(now = Date.now()) {
  const lastActivity = readLastActivity();
  if (!lastActivity) return false;
  return now - lastActivity >= SESSION_TIMEOUT_MS;
}

export function clearSessionActivity() {
  lastActivityPersistedAt = 0;
  sessionStorage.removeItem(SESSION_LAST_ACTIVITY_KEY);
}

export function markSessionTabActive() {
  sessionStorage.setItem(SESSION_TAB_MARKER_KEY, "1");
}

export function hasSessionTabMarker() {
  return sessionStorage.getItem(SESSION_TAB_MARKER_KEY) === "1";
}

export function clearSessionTabMarker() {
  sessionStorage.removeItem(SESSION_TAB_MARKER_KEY);
}

export function clearSessionState() {
  clearSessionActivity();
  clearSessionTabMarker();
}

export function navigateWithSession(url, options = {}) {
  const target = String(url ?? "").trim();
  if (!target) return;

  if (options.replace) {
    window.location.replace(target);
    return;
  }
  window.location.href = target;
}

export function purgeBrowserAuthArtifacts() {
  try {
    const localKeys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("firebase:") || key.includes("firebaseLocalStorage")) {
        localKeys.push(key);
      }
    }
    localKeys.forEach((key) => localStorage.removeItem(key));
  } catch (e) {
    console.warn("No se pudo limpiar localStorage de Firebase:", e);
  }

  try {
    const sessionKeys = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (!key) continue;
      if (key.startsWith("firebase:") || key.includes("firebaseLocalStorage")) {
        sessionKeys.push(key);
      }
    }
    sessionKeys.forEach((key) => sessionStorage.removeItem(key));
  } catch (e) {
    console.warn("No se pudo limpiar sessionStorage de Firebase:", e);
  }

  try {
    document.cookie.split(";").forEach((entry) => {
      const name = entry.split("=")[0]?.trim();
      if (!name) return;
      const lower = name.toLowerCase();
      if (lower.includes("firebase") || lower === "__session") {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    });
  } catch (e) {
    console.warn("No se pudieron expirar cookies de Firebase:", e);
  }

  try {
    indexedDB.deleteDatabase("firebaseLocalStorageDb");
  } catch (e) {
    console.warn("No se pudo eliminar IndexedDB firebaseLocalStorageDb:", e);
  }
}

export function setupCloseLogoutLifecycle() {}

async function writeSessionLease(uid) {
  if (!uid) return;

  await setDoc(doc(db, SESSION_LEASE_COLLECTION, uid), {
    uid,
    expires_at: Timestamp.fromMillis(Date.now() + SESSION_LEASE_DURATION_MS),
    updated_at: serverTimestamp()
  }, { merge: true });
}

export async function startSessionLease(user) {
  const uid = String(user?.uid ?? "").trim();
  if (!uid) return;

  if (leaseIntervalId && leaseUid === uid) {
    return;
  }

  if (leaseIntervalId) {
    window.clearInterval(leaseIntervalId);
    leaseIntervalId = null;
  }

  leaseUid = uid;

  try {
    await writeSessionLease(uid);
  } catch (e) {
    console.error("No se pudo crear lease de sesion:", e);
  }

  leaseIntervalId = window.setInterval(() => {
    writeSessionLease(uid).catch((e) => {
      console.error("No se pudo refrescar lease de sesion:", e);
    });
  }, SESSION_LEASE_HEARTBEAT_MS);
}

export async function stopSessionLease(removeRemote = false) {
  if (leaseIntervalId) {
    window.clearInterval(leaseIntervalId);
    leaseIntervalId = null;
  }

  const uid = leaseUid;
  leaseUid = "";

  if (!removeRemote || !uid) return;

  try {
    await deleteDoc(doc(db, SESSION_LEASE_COLLECTION, uid));
  } catch (e) {
    console.error("No se pudo eliminar lease de sesion:", e);
  }
}

export function startSessionActivityTracking() {
  if (activityTrackingStarted) return;

  activityTrackingStarted = true;
  activityListener = () => touchSessionActivity();
  visibilityListener = () => {
    if (document.visibilityState === "visible") {
      touchSessionActivity(true);
    }
  };
  focusListener = () => touchSessionActivity(true);

  SESSION_ACTIVITY_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, activityListener);
  });
  document.addEventListener("visibilitychange", visibilityListener);
  window.addEventListener("focus", focusListener);

  touchSessionActivity(true);
}

export function stopSessionActivityTracking() {
  if (!activityTrackingStarted) return;

  SESSION_ACTIVITY_EVENTS.forEach((eventName) => {
    window.removeEventListener(eventName, activityListener);
  });
  document.removeEventListener("visibilitychange", visibilityListener);
  window.removeEventListener("focus", focusListener);

  activityTrackingStarted = false;
  activityListener = null;
  visibilityListener = null;
  focusListener = null;
}

export function buildUserProfile(authUser, userDoc = {}, fallbackUid = "") {
  const email = firstNonEmpty(
    authUser?.email,
    userDoc.email
  );

  const name = firstNonEmpty(
    userDoc.nombre,
    userDoc.name,
    userDoc.displayName,
    authUser?.displayName
  ) || fallbackNameFromEmail(email);

  const roleRaw = firstNonEmpty(userDoc.role);
  const role = roleRaw ? roleRaw.toLowerCase() : "";
  const uid = firstNonEmpty(authUser?.uid, fallbackUid);

  return { uid, role, name, email };
}

export function formatIdentity(profile) {
  const name = firstNonEmpty(profile?.name) || "Usuario";
  return name;
}

async function resolveProfileFromUsersCollection(authUser) {
  if (!authUser) return null;

  // Estructura esperada: users/<auth.uid> con campos email, name, role
  try {
    const directSnap = await getDoc(doc(db, "users", authUser.uid));
    if (directSnap.exists()) {
      return buildUserProfile(authUser, directSnap.data(), authUser.uid);
    }
  } catch (e) {
    console.error("Error al leer users/<uid>:", e);
  }

  return null;
}

export async function getUsersDirectory(forceRefresh = false) {
  if (usersDirectoryCache && !forceRefresh) {
    return usersDirectoryCache;
  }

  const byUid = new Map();
  const byEmail = new Map();

  const snap = await getDocs(collection(db, "users"));
  snap.forEach((docSnap) => {
    const data = docSnap.data() ?? {};
    const profile = buildUserProfile(null, data, docSnap.id);

    if (profile.uid) {
      byUid.set(profile.uid, profile);
    }

    const emailKey = normalizeEmail(profile.email);
    if (emailKey) {
      byEmail.set(emailKey, profile);
    }
  });

  usersDirectoryCache = { byUid, byEmail };
  return usersDirectoryCache;
}

export function initSession(callback) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    if (hasSessionExpired()) return;

    await startSessionLease(user);

    currentUser = user;
    let profile = buildUserProfile(user, {});

    try {
      const resolved = await resolveProfileFromUsersCollection(user);
      if (resolved) {
        profile = resolved;
      }
    } catch (e) {
      console.error("No se pudo cargar perfil de usuario:", e);
    }

    currentUserProfile = profile;
    currentRole = profile.role || null;

    if (callback) callback(profile);
  });
}
