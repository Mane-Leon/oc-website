Firestore rules source of truth
================================

Archivo principal:
- firestore/firestore.rules

Como aplicarlas en Firebase Console:
1) Abre Firestore Database > Rules
2) Copia todo el contenido de firestore/firestore.rules
3) Pega y publica (Publish)

Incluye:
- Estructura users: users/{uid} con fields email, name, role
- Roles con role: admin, admin_principal, operaciones/operativo, ventas
- users read para usuarios autenticados (dropdowns de asignacion)
- ordenes_compra con create para admin/ventas/operaciones
- pendientes con:
  - creacion: cualquier usuario autenticado puede crear y asignar
  - lectura: solo admin, asignador o responsables (por UID)
  - edicion: solo admin y asignador (sin validaciones de campos redundantes)
  - cierre: responsable solicita, asignador acepta/rechaza
  - borrado: solo admin

Checklist rapido si un usuario asignado no ve su pendiente:
1) Verifica que el auth.uid del usuario exista en pendientes.responsable_uids.
2) Confirma que el doc users/<auth.uid> exista y tenga campo role valido.
3) En users, el ID del documento debe ser el uid real de Firebase Auth.
4) Re-publica reglas despues de pegar cambios.
