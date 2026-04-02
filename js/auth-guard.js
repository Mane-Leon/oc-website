import { auth } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  SESSION_TIMEOUT_MS,
  clearSessionState,
  formatIdentity,
  hasSessionExpired,
  initSession,
  startSessionLease,
  startSessionActivityTracking,
  stopSessionLease,
  stopSessionActivityTracking,
  setupCloseLogoutLifecycle,
  touchSessionActivity,
  purgeBrowserAuthArtifacts,
  navigateWithSession
} from "./session.js";

const SESSION_TIMEOUT_NOTICE_KEY = "oc_session_timeout_notice";
const SESSION_CHECK_INTERVAL_MS = 15000;

let sessionCheckTimer = null;
let autoLogoutInProgress = false;
setupCloseLogoutLifecycle();
window.navigateWithSession = (url) => navigateWithSession(url);

function isLoginPage() {
  return window.location.pathname.endsWith("login.html");
}

function showLoginNotice() {
  if (!isLoginPage()) return;

  const notice = sessionStorage.getItem(SESSION_TIMEOUT_NOTICE_KEY);
  if (!notice) return;

  const msgEl = document.getElementById("msg");
  if (msgEl) {
    msgEl.innerText = notice;
  }

  sessionStorage.removeItem(SESSION_TIMEOUT_NOTICE_KEY);
}

function stopSessionCheck() {
  if (!sessionCheckTimer) return;
  window.clearInterval(sessionCheckTimer);
  sessionCheckTimer = null;
}

async function expireSessionByInactivity() {
  if (autoLogoutInProgress) return;

  autoLogoutInProgress = true;
  stopSessionCheck();
  stopSessionActivityTracking();
  await stopSessionLease(true);
  sessionStorage.setItem(
    SESSION_TIMEOUT_NOTICE_KEY,
    `Sesion cerrada por ${SESSION_TIMEOUT_MS / 60000} minutos de inactividad.`
  );

  try {
    await signOut(auth);
  } catch (e) {
    console.error("Error al cerrar sesion por inactividad:", e);
  } finally {
    purgeBrowserAuthArtifacts();
    clearSessionState();
    window.location.replace("login.html");
  }
}

function ensureSessionCheck() {
  if (sessionCheckTimer) return;

  sessionCheckTimer = window.setInterval(() => {
    if (hasSessionExpired()) {
      expireSessionByInactivity();
    }
  }, SESSION_CHECK_INTERVAL_MS);
}

// Guard global
showLoginNotice();

onAuthStateChanged(auth, async (user) => {
  const isLogin = isLoginPage();

  if (!user && !isLogin) {
    stopSessionCheck();
    stopSessionActivityTracking();
    await stopSessionLease(false);
    clearSessionState();
    window.location.replace("login.html");
    return;
  }

  if (!user && isLogin) {
    stopSessionCheck();
    stopSessionActivityTracking();
    await stopSessionLease(false);
    clearSessionState();
    autoLogoutInProgress = false;
    showLoginNotice();
    return;
  }

  if (hasSessionExpired()) {
    await expireSessionByInactivity();
    return;
  }

  touchSessionActivity(true);
  startSessionActivityTracking();
  await startSessionLease(user);
  ensureSessionCheck();
  autoLogoutInProgress = false;

  if (user && isLogin) {
    window.location.replace("index.html");
    return;
  }
});

initSession((profile) => {
  const estado = document.getElementById("estado");
  if (estado) {
    estado.innerText = "Sesion: " + formatIdentity(profile);
  }

  const roleEl = document.getElementById("role");
  if (roleEl && profile?.role) {
    roleEl.innerText = "Role: " + profile.role;
  }
});

window.logout = async function () {
  try {
    stopSessionCheck();
    stopSessionActivityTracking();
    await stopSessionLease(true);
    await signOut(auth);
  } catch (e) {
    console.error("Error al cerrar sesion:", e);
  } finally {
    purgeBrowserAuthArtifacts();
    clearSessionState();
    sessionStorage.removeItem(SESSION_TIMEOUT_NOTICE_KEY);
    window.location.replace("login.html");
  }
};
