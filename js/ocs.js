import { db } from "./firebase.js";
import { collection, getDocs } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

async function cargarOCs() {
  const tbody = document.getElementById("tabla-ocs");
  tbody.innerHTML = "";

  const snapshot = await getDocs(collection(db, "ordenes_compra"));

  snapshot.forEach(doc => {
    const d = doc.data();
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${doc.id}</td>
      <td>${d.cliente ?? ""}</td>
      <td>${d.estado ?? ""}</td>
      <td>${d.prioridad ?? ""}</td>
      <td>${d.fecha_oc ?? ""}</td>
      <td>${d.vendedor_nombre ?? ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

cargarOCs();
