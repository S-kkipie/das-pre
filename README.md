# das-pre — Luxor PMS (prototipo)

Prototipo simple de un sistema de gestión hotelera para un hotel pequeño, hecho para el curso
**Diseño y Arquitectura de Software**. Implementa la arquitectura definida en el curso:
**monolito modular en capas** con una única base de datos.

| Capa | Archivo | Rol |
|---|---|---|
| Presentación | `public/index.html`, `src/server.js` | UI web y API REST con control de acceso por rol |
| Aplicación / negocio | `src/services.js` | Un servicio por módulo (huéspedes, habitaciones, reservas, check-in/out, pagos, reportes, usuarios) |
| Datos | `src/db.js` | Esquema SQLite, transacciones, respaldo |

Sin dependencias externas: solo Node.js ≥ 22.5 (usa `node:sqlite`).

## Ejecutar

```bash
npm start            # http://localhost:3000
npm test             # pruebas de la API
```

Usuarios de **demo** (cambiarlos antes de cualquier uso real): `admin/admin123`, `dueno/dueno123`, `recepcion/recepcion123`.
Variables: `PORT`, `DB_FILE` (por defecto `luxor.db`), `BACKUP_DIR`.

## Requisitos implementados

- **Huéspedes e historial:** registro (nombres, documento, procedencia, contacto), autocompletado por documento, historial de 3 años.
- **Habitaciones:** tipos matrimonial/doble/triple/familiar con precio; estados Disponible, Reservada, Ocupada, Mantenimiento; listado de libres por fechas; no se elimina con reservas enlazadas; no pasa a Mantenimiento con reservas activas.
- **Reservas:** estados Pendiente → Confirmada → Concluida / Cancelada; sin doble reserva (solapamiento); estadía por noche u horas; N.º de huéspedes; origen directo/booking/airbnb con comisión manual (sin API).
- **Check-in / check-out:** solo desde reserva Confirmada; actualiza el estado de la habitación; permite salir con saldo (cuenta por cobrar) avisando al operador.
- **Pagos:** efectivo, transferencia y Yape (sin tarjetas ni pasarelas). Transferencia/Yape exigen banco, fecha y N.º de operación. No se excede el saldo. Un pago solo se elimina si la reserva está Pendiente o Cancelada, y queda en bitácora.
- **Reportes y estadísticas:** cuentas con saldo pendiente, reporte financiero por rango y medio, tablero (ocupación, entradas del día, dinero acumulado, cuentas pendientes).
- **Usuarios y roles:** administrador (todo), gerente/dueño (solo consulta), recepcionista (operación diaria; no ve montos globales ni reportes). Bitácora de acciones.
- **RNF:** autenticación y roles (RNF-0002), índices para búsqueda rápida (RNF-0003), respaldo automático diario a las 00:00 con `VACUUM INTO` (RNF-0004), transacciones para evitar carreras (concurrencia).

## Fuera de alcance (a propósito)

Pasarelas de pago, integración por API con OTAs, facturación electrónica, exportación a PDF/Excel y multi-hotel.

## Limitaciones conocidas

Las sesiones viven en memoria (se pierden al reiniciar) y no hay HTTPS ni límite de intentos de login: poner detrás de un proxy (p. ej. Nginx con TLS) para uso real.
