import { auth } from "./firebase.js";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// LOGIN
const loginBtn = document.getElementById("loginBtn");
if (loginBtn) {
  loginBtn.onclick = async () => {
    const email = email.value;
    const password = password.value;

    try {
      await signInWithEmailAndPassword(auth, email, password);
      window.location.href = "dashboard.html";
    } catch (e) {
      document.getElementById("msg").innerText = e.message;
    }
  };
}

// PROTECCIÓN GLOBAL
onAuthStateChanged(auth, (user) => {
  const isLogin = window.location.pathname.includes("login");
  if (!user && !isLogin) {
    window.location.href = "login.html";
  }
});

// LOGOUT (se usará en otras páginas)
window.logout = async () => {
  await signOut(auth);
  window.location.href = "login.html";
};
