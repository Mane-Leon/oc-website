import { auth } from "./firebase.js";
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Guard global
onAuthStateChanged(auth, (user) => {
  const path = window.location.pathname;

  const isLogin = path.endsWith("login.html") || path.endsWith("/");

  // No autenticado → solo puede estar en login
  if (!user && !isLogin) {
    window.location.replace("login.html");
    return;
  }

  // Autenticado → no debe ver login
  if (user && isLogin) {
    window.location.replace("index.html");
    return;
  }

  // Mostrar estado si existe
  const estado = document.getElementById("estado");
  if (estado && user) {
    estado.innerText = "Sesión iniciada como: " + user.email;
  }
});

// Logout único y global
window.logout = async function () {
  await auth.signOut();
  sessionStorage.clear();
  localStorage.clear();
  window.location.replace("login.html");
};

