// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  browserSessionPersistence,
  initializeAuth
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Configuracion unica del proyecto
const firebaseConfig = {
  apiKey: "AIzaSyAodTMF0_ZDJ7W2nHCFy1EfupXGeRDh0eY",
  authDomain: "leon-ops.firebaseapp.com",
  projectId: "leon-ops",
  appId: "1:1029693367169:web:ff85b95791e5ddd49b7e80",
};

// Inicializar Firebase UNA sola vez
const app = initializeApp(firebaseConfig);

// Exportar servicios que usara el resto del website
export const auth = initializeAuth(app, {
  persistence: browserSessionPersistence
});
export const db = getFirestore(app);
