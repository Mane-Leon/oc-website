import { db } from "./firebase.js";
import {
  initSession,
  currentRole,
  currentUserProfile,
  formatIdentity
} from "./session.js";
import {
  addDoc,
  collection,
  doc as fsDoc,
  getDoc,
  getDocs,
  query,
  where,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const ROLES_CREAR_OC = new Set(["ventas", "admin", "operativo", "operaciones"]);
const MANUAL_OPTION_VALUE = "__manual__";
const SALES_ROLE_KEYS = new Set(["ventas", "venta", "vendedor", "vendedora", "sales", "seller"]);
const SALES_QUERY_VALUES = [
  "ventas",
  "Ventas",
  "VENTAS",
  "vendedor",
  "Vendedor",
  "vendedora",
  "Vendedora",
  "sales",
  "Sales",
  "seller"
];

const form = document.getElementById("form-oc");
const msg = document.getElementById("msg");
const vendedorSelect = document.getElementById("vendedor_uid");
const formTitle = document.getElementById("oc-form-title");
const btnGuardar = document.getElementById("btn-guardar-oc");

let vendedoresVentas = [];
let manualVendedorNombre = "";

const ocIdEdicion = new URLSearchParams(window.location.search).get("edit")?.trim() || "";
const isEditMode = Boolean(ocIdEdicion);

function puedeCrearOC(role) {
  return ROLES_CREAR_OC.has(role);
}

function getIsoFromInputDate(value) {
  if (!value) return new Date().toISOString();
  return new Date(value + "T00:00:00").toISOString();
}

function inputDateFromAny(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function extraerCorreo(texto) {
  const match = String(texto ?? "")
    .trim()
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? normalizeEmail(match[0]) : "";
}

function normalizeRole(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function esRoleVentas(value) {
  return SALES_ROLE_KEYS.has(normalizeRole(value));
}

function buildProfileFromUserDoc(data, fallbackUid = "") {
  const uid = String(data?.uid ?? fallbackUid).trim();
  const name = String(data?.nombre ?? data?.name ?? data?.displayName ?? "").trim();
  const email = String(data?.correo ?? data?.email ?? "").trim();
  const role = String(data?.role ?? "").trim().toLowerCase();
  return { uid, name: name || "Usuario", email, role };
}

function setManualVendedorNombre(nombre) {
  manualVendedorNombre = String(nombre ?? "").trim();
  if (!vendedorSelect) return;

  const manualOption = vendedorSelect.querySelector(`option[value="${MANUAL_OPTION_VALUE}"]`);
  if (!manualOption) return;

  manualOption.textContent = manualVendedorNombre
    ? `Manual: ${manualVendedorNombre}`
    : "Escribir vendedor manualmente...";
}

function poblarVendedoresSelect(vendedores, defaultUid = "") {
  if (!vendedorSelect) return;

  vendedorSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Sin vendedor";
  vendedorSelect.appendChild(placeholder);

  vendedores.forEach((vendedor) => {
    const option = document.createElement("option");
    option.value = vendedor.uid;
    option.textContent = vendedor.name || "Usuario";
    vendedorSelect.appendChild(option);
  });

  const manualOption = document.createElement("option");
  manualOption.value = MANUAL_OPTION_VALUE;
  manualOption.textContent = "Escribir vendedor manualmente...";
  vendedorSelect.appendChild(manualOption);

  setManualVendedorNombre(manualVendedorNombre);

  if (defaultUid && vendedores.some((v) => v.uid === defaultUid)) {
    vendedorSelect.value = defaultUid;
    return;
  }

  if (manualVendedorNombre) {
    vendedorSelect.value = MANUAL_OPTION_VALUE;
    return;
  }

  vendedorSelect.value = "";
}

function configurarEventosVendedor() {
  if (!vendedorSelect) return;

  vendedorSelect.addEventListener("change", () => {
    if (vendedorSelect.value !== MANUAL_OPTION_VALUE) return;

    const input = prompt(
      "Escribe el nombre del vendedor manual:",
      manualVendedorNombre || ""
    );

    if (input === null) {
      if (!manualVendedorNombre) {
        vendedorSelect.value = "";
      }
      return;
    }

    const nombre = input.trim();
    setManualVendedorNombre(nombre);

    if (!nombre) {
      vendedorSelect.value = "";
      return;
    }

    vendedorSelect.value = MANUAL_OPTION_VALUE;
  });
}

function agregarVendedoresDesdeSnap(snap, map) {
  snap.forEach((docSnap) => {
    const data = docSnap.data() ?? {};
    const roleRaw = data.role;
    if (!esRoleVentas(roleRaw)) return;

    const profile = buildProfileFromUserDoc(data, docSnap.id);
    if (!profile.uid) return;
    map.set(profile.uid, profile);
  });
}

async function cargarVendedoresVentas() {
  const map = new Map();
  let pudoLeerColeccionCompleta = false;

  try {
    const usersRef = collection(db, "users");
    msg.textContent = "";

    try {
      const snap = await getDocs(usersRef);
      pudoLeerColeccionCompleta = true;
      agregarVendedoresDesdeSnap(snap, map);
    } catch (e) {
      console.warn("Lectura completa de users no permitida, usando consultas filtradas:", e);
    }

    if (!pudoLeerColeccionCompleta || map.size === 0) {
      try {
        const byRoleSnap = await getDocs(
          query(usersRef, where("role", "==", "ventas"))
        );
        agregarVendedoresDesdeSnap(byRoleSnap, map);
      } catch (e) {
        console.warn("No se pudo consultar users por campo role:", e);
      }

      if (map.size === 0) {
        try {
          const byRoleInSnap = await getDocs(
            query(usersRef, where("role", "in", SALES_QUERY_VALUES))
          );
          agregarVendedoresDesdeSnap(byRoleInSnap, map);
        } catch (e) {
          console.warn("No se pudo consultar variantes de role para ventas:", e);
        }
      }
    }

    vendedoresVentas = [...map.values()]
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "es", { sensitivity: "base" }));

    const uidActual = currentUserProfile?.uid || "";
    poblarVendedoresSelect(vendedoresVentas, uidActual);

    if (vendedoresVentas.length === 0) {
      msg.textContent = "No hay vendedores con role ventas. Puedes elegir vendedor manual o guardar sin vendedor.";
    }
  } catch (e) {
    console.error("No se pudo cargar lista de vendedores:", e);
    msg.textContent = "No se pudo cargar vendedores desde users. Puedes elegir vendedor manual o guardar sin vendedor.";
    vendedoresVentas = [];
    poblarVendedoresSelect([], "");
  }
}

async function cargarOcParaEditar() {
  if (!isEditMode) return;

  try {
    const snap = await getDoc(fsDoc(db, "ordenes_compra", ocIdEdicion));
    if (!snap.exists()) {
      msg.textContent = "La OC a editar no existe.";
      return;
    }

    const oc = snap.data();

    const clienteEl = document.getElementById("cliente");
    const prioridadEl = document.getElementById("prioridad");
    const fechaEl = document.getElementById("fecha_oc");
    const notasEl = document.getElementById("notas");

    if (clienteEl) clienteEl.value = oc.cliente ?? "";
    if (prioridadEl) prioridadEl.value = oc.prioridad ?? "media";
    if (fechaEl) fechaEl.value = inputDateFromAny(oc.fecha_oc);
    if (notasEl) notasEl.value = oc.notas ?? "";

    const vendedorUid = String(oc.vendedor_uid ?? "").trim();
    if (vendedorUid && vendedorSelect && vendedoresVentas.some((v) => v.uid === vendedorUid)) {
      vendedorSelect.value = vendedorUid;
      setManualVendedorNombre("");
      return;
    }

    const correo = normalizeEmail(oc.vendedor_correo ?? "");
    if (correo && vendedorSelect) {
      const match = vendedoresVentas.find((v) => normalizeEmail(v.email) === correo);
      if (match) {
        vendedorSelect.value = match.uid;
        setManualVendedorNombre("");
        return;
      }
    }

    const nombreManual = String(oc.vendedor_nombre ?? "").trim();
    if (nombreManual) {
      setManualVendedorNombre(nombreManual);
      if (vendedorSelect) {
        vendedorSelect.value = MANUAL_OPTION_VALUE;
      }
      return;
    }

    if (vendedorSelect) {
      vendedorSelect.value = "";
    }
    setManualVendedorNombre("");
  } catch (e) {
    console.error("No se pudo cargar OC para edicion:", e);
    msg.textContent = "No se pudo cargar la OC para editar.";
  }
}

initSession(async () => {
  const roleActivo = currentRole || "ventas";

  if (formTitle && btnGuardar) {
    formTitle.textContent = isEditMode ? "Editar Orden de Compra" : "Nueva Orden de Compra";
    btnGuardar.textContent = isEditMode ? "Actualizar OC" : "Guardar OC";
  }

  const estadoEl = document.getElementById("estado");
  if (estadoEl && currentUserProfile) {
    estadoEl.textContent = "Sesion: " + formatIdentity(currentUserProfile);
  }

  const roleEl = document.getElementById("role");
  if (roleEl) {
    roleEl.textContent = "Role: " + roleActivo;
  }

  if (!puedeCrearOC(roleActivo)) {
    alert("No tienes permisos para crear OCs.");
    window.navigateWithSession("ocs.html");
    return;
  }

  if (isEditMode && roleActivo !== "admin") {
    alert("Solo admin puede editar OCs.");
    window.navigateWithSession("ocs.html");
    return;
  }

  await cargarVendedoresVentas();
  await cargarOcParaEditar();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const roleActivo = currentRole || "ventas";
  if (!puedeCrearOC(roleActivo)) {
    alert("No tienes permisos para crear OCs.");
    window.navigateWithSession("ocs.html");
    return;
  }

  const cliente = document.getElementById("cliente")?.value.trim();
  const prioridad = document.getElementById("prioridad")?.value || "media";
  const fechaInput = document.getElementById("fecha_oc")?.value;
  const vendedorUid = vendedorSelect?.value || "";
  const notas = document.getElementById("notas")?.value.trim();

  if (!cliente) {
    msg.textContent = "El cliente es obligatorio.";
    return;
  }

  const vendedorSeleccionado = vendedoresVentas.find((v) => v.uid === vendedorUid);
  let vendedorNombre = "";
  let vendedorCorreo = "";
  let vendedorUidFinal = "";

  if (vendedorSeleccionado) {
    vendedorNombre = vendedorSeleccionado.name || "Usuario";
    vendedorCorreo = vendedorSeleccionado.email || "";
    vendedorUidFinal = vendedorSeleccionado.uid || "";
  } else if (vendedorUid === MANUAL_OPTION_VALUE && manualVendedorNombre) {
    vendedorNombre = manualVendedorNombre;
    vendedorCorreo = extraerCorreo(manualVendedorNombre);
    vendedorUidFinal = "";
  }

  try {
    const payload = {
      cliente,
      prioridad,
      fecha_oc: getIsoFromInputDate(fechaInput),
      vendedor_nombre: vendedorNombre,
      vendedor_correo: vendedorCorreo,
      vendedor_uid: vendedorUidFinal,
      notas: notas || ""
    };

    if (isEditMode) {
      if (roleActivo !== "admin") {
        msg.textContent = "Solo admin puede editar OCs.";
        return;
      }

      await updateDoc(fsDoc(db, "ordenes_compra", ocIdEdicion), payload);
    } else {
      await addDoc(collection(db, "ordenes_compra"), {
        ...payload,
        estado: "por_surtir",
        estado_index: 0,
        ruta: null
      });
    }

    window.navigateWithSession("ocs.html");
  } catch (e) {
    console.error("Error al guardar OC:", e);
    msg.textContent = "No se pudo guardar la OC.";
  }
});

configurarEventosVendedor();
