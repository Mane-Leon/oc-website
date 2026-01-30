// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// 🔐 Configuración única del proyecto
const firebaseConfig = {
  apiKey: "AIzaSyAodTMF0_ZDJ7W2nHCFy1EfupXGeRDh0eY",
  authDomain: "leon-ops.firebaseapp.com",
  projectId: "leon-ops,
  appId: "1:1029693367169:web:ff85b95791e5ddd49b7e80""
};

// Inicializar Firebase UNA sola vez
const app = initializeApp(firebaseConfig);

// Exportar servicios que usará el resto del website
export const auth = getAuth(app);
export const db = getFirestore(app);
