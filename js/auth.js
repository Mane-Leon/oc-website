import { auth } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/**
 * PROTECCIÓN GLOBAL
 * - Si no hay usuario → login
 * - Si hay usuario → muestra email
 */
onAuthStateChanged(auth, (user) => {
  const path = window.location.pathname;

  // Si no hay sesión y NO estás en login → redirige
  if (!user && !path.endsWith("login.html")) {
    window.location.href = "login.html";
    return;
  }

  // Si hay sesión y estás en login → dashboard
  if (user && path.endsWith("login.html")) {
    window.location.href = "index.html";
    return;
  }

  // Mostrar usuario si existe el placeholder
  const estado = document.getElementById("estado");
  if (estado && user) {
    estado.innerText = "Sesión iniciada como: " + user.email;
  }
});

/**
 * LOGOUT ÚNICO Y DEFINITIVO
 */
window.logout = async function () {
  try {
    await signOut(auth);

    // Limpieza dura de estado del navegador
    sessionStorage.clear();
    localStorage.clear();

    // Redirección forzada
    window.location.replace("login.html");
  } catch (e) {
    console.error("Error al cerrar sesión:", e);
  }
};
