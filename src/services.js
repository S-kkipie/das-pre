// Capa de aplicación/negocio. Cada módulo del monolito es un objeto de servicio.
// Las reglas citan los requisitos levantados en las entrevistas (ver README).
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { tx, hashPassword } from './db.js';
import { bad, conflict, forbidden, notFound, AppError } from './errors.js';

const DIA = 86400000;
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const noches = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / DIA)); // estadía por horas = 1 unidad
const salidaEf = (a, b) => (b > a ? b : new Date(Date.parse(a) + DIA).toISOString().slice(0, 10));
const SAL_EF = "CASE WHEN salida>entrada THEN salida ELSE date(entrada,'+1 day') END";
const req = (o, ...campos) => campos.forEach(c => {
  if (o[c] === undefined || o[c] === null || String(o[c]).trim() === '') throw bad(`Falta el campo: ${c}`);
});

export function createServices(db) {
  const log = (usuario, accion, detalle) =>
    db.prepare('INSERT INTO bitacora (usuario,accion,detalle) VALUES (?,?,?)').run(usuario, accion, detalle);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const totalReserva = r => noches(r.entrada, r.salida) * get('SELECT precio FROM habitaciones WHERE id=?', r.habitacion_id).precio;
  const pagado = id => get('SELECT COALESCE(SUM(monto),0) s FROM pagos WHERE reserva_id=?', id).s;
  const conSaldo = r => {
    const total = totalReserva(r), p = pagado(r.id);
    return { ...r, total, pagado: p, saldo: total - p };
  };

  // ---- Autenticación y control de acceso ----
  const sesiones = new Map();
  const auth = {
    login({ usuario, password }) {
      req({ usuario, password }, 'usuario', 'password');
      const u = get('SELECT * FROM usuarios WHERE usuario=?', usuario);
      const ok = u && (() => {
        const [salt, h] = u.hash.split(':');
        const a = Buffer.from(h, 'hex'), b = scryptSync(password, salt, 32);
        return a.length === b.length && timingSafeEqual(a, b);
      })();
      if (!ok) throw new AppError(401, 'Credenciales inválidas');
      const token = randomBytes(24).toString('hex');
      sesiones.set(token, { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol });
      log(u.usuario, 'login', '');
      return { token, nombre: u.nombre, rol: u.rol };
    },
    logout: token => sesiones.delete(token),
    sesion: token => sesiones.get(token),
  };

  // ---- Huéspedes e historial ----
  const huespedes = {
    listar: ({ documento } = {}) => documento
      ? all("SELECT * FROM huespedes WHERE documento LIKE ? ORDER BY nombres LIMIT 10", `${documento}%`)
      : all('SELECT * FROM huespedes ORDER BY nombres'),
    crear(d, u) {
      req(d, 'nombres', 'documento');
      if (get('SELECT 1 FROM huespedes WHERE documento=?', d.documento)) throw conflict('Ya existe un huésped con ese documento');
      const r = db.prepare('INSERT INTO huespedes (nombres,documento,procedencia,contacto) VALUES (?,?,?,?)')
        .run(d.nombres, d.documento, d.procedencia ?? null, d.contacto ?? null);
      log(u.usuario, 'huesped.crear', d.documento);
      return get('SELECT * FROM huespedes WHERE id=?', r.lastInsertRowid);
    },
    editar(id, d, u) {
      const h = get('SELECT * FROM huespedes WHERE id=?', id); if (!h) throw notFound('Huésped no encontrado');
      const n = { ...h, ...d };
      db.prepare('UPDATE huespedes SET nombres=?,procedencia=?,contacto=? WHERE id=?').run(n.nombres, n.procedencia, n.contacto, id);
      log(u.usuario, 'huesped.editar', String(id));
      return get('SELECT * FROM huespedes WHERE id=?', id);
    },
    historial(id) { // Historial conservado 3 años (entrevista 2)
      const limite = new Date(Date.now() - 3 * 365 * DIA).toISOString().slice(0, 10);
      return all('SELECT r.*, h.numero FROM reservas r JOIN habitaciones h ON h.id=r.habitacion_id WHERE r.huesped_id=? AND r.entrada>=? ORDER BY r.entrada DESC', id, limite);
    },
  };

  // ---- Habitaciones ----
  const habitaciones = {
    listar: ({ estado } = {}) => estado
      ? all('SELECT * FROM habitaciones WHERE estado=? ORDER BY numero', estado)
      : all('SELECT * FROM habitaciones ORDER BY numero'),
    libres({ entrada, salida }) { // Al elegir tipo se listan solo las libres (entrevista 4)
      if (!esFecha(entrada) || !esFecha(salida)) throw bad('Fechas inválidas (AAAA-MM-DD)');
      return all(`SELECT * FROM habitaciones h WHERE estado<>'Mantenimiento' AND NOT EXISTS (
        SELECT 1 FROM reservas r WHERE r.habitacion_id=h.id AND r.estado IN ('Pendiente','Confirmada')
        AND r.entrada<? AND ?<(CASE WHEN r.salida>r.entrada THEN r.salida ELSE date(r.entrada,'+1 day') END))`, salidaEf(entrada, salida), entrada);
    },
    crear(d, u) {
      req(d, 'numero', 'tipo', 'precio');
      if (get('SELECT 1 FROM habitaciones WHERE numero=?', d.numero)) throw conflict('Número de habitación duplicado');
      try { db.prepare('INSERT INTO habitaciones (numero,tipo,precio) VALUES (?,?,?)').run(d.numero, d.tipo, Number(d.precio)); }
      catch { throw bad('Tipo o precio inválido'); }
      log(u.usuario, 'habitacion.crear', d.numero);
      return get('SELECT * FROM habitaciones WHERE numero=?', d.numero);
    },
    estado(id, estado, u) {
      const h = get('SELECT * FROM habitaciones WHERE id=?', id); if (!h) throw notFound('Habitación no encontrada');
      if (!['Disponible', 'Mantenimiento'].includes(estado)) throw bad('Solo se puede fijar Disponible o Mantenimiento a mano');
      if (h.estado === 'Ocupada') throw conflict('La habitación está ocupada');
      if (estado === 'Mantenimiento' && get("SELECT 1 FROM reservas WHERE habitacion_id=? AND estado IN ('Pendiente','Confirmada') AND salida>date('now')", id))
        throw conflict('Tiene reservas activas; cancélelas antes de pasar a Mantenimiento');
      db.prepare('UPDATE habitaciones SET estado=? WHERE id=?').run(estado, id);
      log(u.usuario, 'habitacion.estado', `${h.numero}->${estado}`);
      return get('SELECT * FROM habitaciones WHERE id=?', id);
    },
    editar(id, d, u) {
      const h = get('SELECT * FROM habitaciones WHERE id=?', id); if (!h) throw notFound('Habitación no encontrada');
      const n = { ...h, ...d };
      try { db.prepare('UPDATE habitaciones SET tipo=?,precio=? WHERE id=?').run(n.tipo, Number(n.precio), id); }
      catch { throw bad('Tipo o precio inválido'); }
      log(u.usuario, 'habitacion.editar', h.numero);
      return get('SELECT * FROM habitaciones WHERE id=?', id);
    },
    eliminar(id, u) { // No se elimina con registros enlazados (ESP-0008)
      if (get('SELECT 1 FROM reservas WHERE habitacion_id=?', id)) throw conflict('Tiene reservas enlazadas');
      db.prepare('DELETE FROM habitaciones WHERE id=?').run(id);
      log(u.usuario, 'habitacion.eliminar', String(id));
    },
  };

  // ---- Reservas ----
  const reservas = {
    listar: ({ estado } = {}) => (estado ? all('SELECT * FROM reservas WHERE estado=? ORDER BY entrada', estado) : all('SELECT * FROM reservas ORDER BY entrada DESC')).map(conSaldo),
    obtener(id) { const r = get('SELECT * FROM reservas WHERE id=?', id); if (!r) throw notFound('Reserva no encontrada'); return conSaldo(r); },
    crear(d, u) {
      req(d, 'huesped_id', 'habitacion_id', 'entrada', 'salida');
      if (!esFecha(d.entrada) || !esFecha(d.salida)) throw bad('Fechas inválidas (AAAA-MM-DD)');
      const tipo = d.tipo_estadia ?? 'noche';
      if (!['noche', 'horas'].includes(tipo)) throw bad('Tipo de estadía inválido');
      if (tipo === 'noche' && d.salida <= d.entrada) throw bad('La salida debe ser posterior a la entrada');
      if (tipo === 'horas' && d.salida !== d.entrada) throw bad('Una estadía por horas es de un solo día');
      const nh = Number(d.num_huespedes ?? 1);
      if (!Number.isInteger(nh) || nh < 1) throw bad('Número de huéspedes inválido');
      const origen = d.origen ?? 'directo';
      if (!['directo', 'booking', 'airbnb'].includes(origen)) throw bad('Origen inválido');
      return tx(db, () => {
        if (!get('SELECT 1 FROM huespedes WHERE id=?', d.huesped_id)) throw notFound('Huésped no encontrado');
        const h = get('SELECT * FROM habitaciones WHERE id=?', d.habitacion_id);
        if (!h) throw notFound('Habitación no encontrada');
        if (h.estado === 'Mantenimiento') throw conflict('La habitación está en mantenimiento');
        // RV_007: sin doble reserva (solapamiento) sobre la misma habitación
        if (get(`SELECT 1 FROM reservas WHERE habitacion_id=? AND estado IN ('Pendiente','Confirmada') AND entrada<? AND ?<${SAL_EF}`, h.id, salidaEf(d.entrada, d.salida), d.entrada))
          throw conflict('La habitación ya está reservada en esas fechas');
        const r = db.prepare('INSERT INTO reservas (huesped_id,habitacion_id,entrada,salida,origen,comision,num_huespedes,tipo_estadia) VALUES (?,?,?,?,?,?,?,?)')
          .run(d.huesped_id, h.id, d.entrada, d.salida, origen, Number(d.comision ?? 0), nh, tipo);
        log(u.usuario, 'reserva.crear', String(r.lastInsertRowid));
        return reservas.obtener(r.lastInsertRowid);
      });
    },
    confirmar(id, u) {
      const r = reservas.obtener(id);
      if (r.estado !== 'Pendiente') throw conflict(`No se puede confirmar una reserva ${r.estado}`);
      db.prepare("UPDATE reservas SET estado='Confirmada' WHERE id=?").run(id);
      log(u.usuario, 'reserva.confirmar', String(id));
      return reservas.obtener(id);
    },
    cancelar(id, u) {
      const r = reservas.obtener(id);
      if (!['Pendiente', 'Confirmada'].includes(r.estado)) throw conflict(`No se puede cancelar una reserva ${r.estado}`);
      db.prepare("UPDATE reservas SET estado='Cancelada' WHERE id=?").run(id);
      log(u.usuario, 'reserva.cancelar', String(id));
      return reservas.obtener(id);
    },
  };

  // ---- Check-in / Check-out ----
  const estancias = {
    checkIn(id, u) {
      return tx(db, () => {
        const r = reservas.obtener(id);
        if (r.estado !== 'Confirmada') throw conflict('Solo se hace check-in de reservas Confirmadas');
        const h = get('SELECT * FROM habitaciones WHERE id=?', r.habitacion_id);
        if (h.estado === 'Ocupada' || h.estado === 'Mantenimiento') throw conflict(`Habitación ${h.estado}`);
        db.prepare('INSERT INTO checkins (reserva_id,entrada_real) VALUES (?,?)').run(id, new Date().toISOString());
        db.prepare("UPDATE habitaciones SET estado='Ocupada' WHERE id=?").run(h.id);
        log(u.usuario, 'checkin', String(id));
        return reservas.obtener(id);
      });
    },
    checkOut(id, u) {
      return tx(db, () => {
        const c = get('SELECT * FROM checkins WHERE reserva_id=?', id);
        if (!c) throw conflict('La reserva no tiene check-in');
        if (c.salida_real) throw conflict('Check-out ya realizado');
        const r = reservas.obtener(id);
        db.prepare('UPDATE checkins SET salida_real=? WHERE reserva_id=?').run(new Date().toISOString(), id);
        db.prepare("UPDATE reservas SET estado='Concluida' WHERE id=?").run(id);
        db.prepare("UPDATE habitaciones SET estado='Disponible' WHERE id=?").run(r.habitacion_id);
        log(u.usuario, 'checkout', `${id} saldo=${r.saldo}`);
        // Se permite salir con saldo (cuentas por cobrar): se informa al operador.
        return { ...reservas.obtener(id), aviso: r.saldo > 0 ? `Saldo pendiente: S/ ${r.saldo}` : null };
      });
    },
  };

  // ---- Pagos: efectivo, transferencia, yape (sin pasarelas) ----
  const pagos = {
    listar: reserva_id => all('SELECT * FROM pagos WHERE reserva_id=? ORDER BY id', reserva_id),
    registrar(reserva_id, d, u) {
      req(d, 'monto', 'medio');
      const monto = Number(d.monto);
      if (!(monto > 0)) throw bad('El monto debe ser mayor a 0');
      if (!['efectivo', 'transferencia', 'yape'].includes(d.medio)) throw bad('Medio de pago inválido (sin tarjeta ni pasarelas)');
      if (d.medio !== 'efectivo') req(d, 'banco', 'fecha_operacion', 'nro_operacion'); // entrevista 3
      return tx(db, () => {
        const r = reservas.obtener(reserva_id);
        if (r.estado === 'Cancelada') throw conflict('La reserva está cancelada');
        if (monto > r.saldo + 1e-9) throw conflict(`El monto excede el saldo (S/ ${r.saldo})`);
        const x = db.prepare('INSERT INTO pagos (reserva_id,monto,medio,banco,fecha_operacion,nro_operacion) VALUES (?,?,?,?,?,?)')
          .run(reserva_id, monto, d.medio, d.banco ?? null, d.fecha_operacion ?? null, d.nro_operacion ?? null);
        log(u.usuario, 'pago.registrar', `reserva=${reserva_id} S/${monto} ${d.medio}`);
        return get('SELECT * FROM pagos WHERE id=?', x.lastInsertRowid);
      });
    },
    eliminar(id, u) { // Solo si la reserva está Pendiente o Cancelada, con bitácora (entrevista 3)
      const p = get('SELECT * FROM pagos WHERE id=?', id); if (!p) throw notFound('Pago no encontrado');
      const r = get('SELECT estado FROM reservas WHERE id=?', p.reserva_id);
      if (!['Pendiente', 'Cancelada'].includes(r.estado)) throw conflict('Solo se elimina un pago de reservas Pendientes o Canceladas');
      db.prepare('DELETE FROM pagos WHERE id=?').run(id);
      log(u.usuario, 'pago.eliminar', JSON.stringify(p));
    },
  };

  // ---- Reportes y estadísticas ----
  const reportes = {
    saldos: () => all("SELECT * FROM reservas WHERE estado IN ('Confirmada','Concluida')").map(conSaldo).filter(r => r.saldo > 0),
    financiero({ desde, hasta }) {
      if (!esFecha(desde) || !esFecha(hasta)) throw bad('Rango inválido (desde/hasta AAAA-MM-DD)');
      const porMedio = all("SELECT medio, SUM(monto) total, COUNT(*) n FROM pagos WHERE date(creado) BETWEEN ? AND ? GROUP BY medio", desde, hasta);
      return { desde, hasta, porMedio, total: porMedio.reduce((a, m) => a + m.total, 0) };
    },
    estadisticas(rol) {
      const total = get('SELECT COUNT(*) c FROM habitaciones').c;
      const ocupadas = get("SELECT COUNT(*) c FROM habitaciones WHERE estado='Ocupada'").c;
      const out = {
        habitaciones: total, ocupadas, ocupacion: total ? +(ocupadas / total * 100).toFixed(1) : 0,
        entradas_hoy: get("SELECT COUNT(*) c FROM reservas WHERE entrada=date('now') AND estado IN ('Pendiente','Confirmada')").c,
      };
      // Recepción no ve montos totales ni cierres de caja (entrevista 2)
      if (rol !== 'recepcionista') {
        out.dinero_acumulado = get('SELECT COALESCE(SUM(monto),0) s FROM pagos').s;
        out.cuentas_pendientes = reportes.saldos().reduce((a, r) => a + r.saldo, 0);
      }
      return out;
    },
  };

  const usuarios = {
    listar: () => all('SELECT id,nombre,usuario,rol FROM usuarios'),
    crear(d, u) {
      req(d, 'nombre', 'usuario', 'password', 'rol');
      if (String(d.password).length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
      if (!['administrador', 'gerente', 'recepcionista'].includes(d.rol)) throw bad('Rol inválido');
      if (get('SELECT 1 FROM usuarios WHERE usuario=?', d.usuario)) throw conflict('Usuario ya existe');
      db.prepare('INSERT INTO usuarios (nombre,usuario,hash,rol) VALUES (?,?,?,?)').run(d.nombre, d.usuario, hashPassword(d.password), d.rol);
      log(u.usuario, 'usuario.crear', d.usuario);
      return get('SELECT id,nombre,usuario,rol FROM usuarios WHERE usuario=?', d.usuario);
    },
    rol(id, rol, u) {
      if (!['administrador', 'gerente', 'recepcionista'].includes(rol)) throw bad('Rol inválido');
      if (id === u.id) throw conflict('No puede cambiar su propio rol');
      if (!db.prepare('UPDATE usuarios SET rol=? WHERE id=?').run(rol, id).changes) throw notFound('Usuario no encontrado');
      for (const [t, s] of sesiones) if (s.id === id) sesiones.delete(t); // fuerza nuevo login con el rol nuevo
      log(u.usuario, 'usuario.rol', `${id}->${rol}`);
    },
    eliminar(id, u) {
      if (id === u.id) throw conflict('No puede eliminarse a sí mismo');
      if (!db.prepare('DELETE FROM usuarios WHERE id=?').run(id).changes) throw notFound('Usuario no encontrado');
      for (const [t, s] of sesiones) if (s.id === id) sesiones.delete(t);
      log(u.usuario, 'usuario.eliminar', String(id));
    },
    bitacora: () => all('SELECT * FROM bitacora ORDER BY id DESC LIMIT 200'),
  };

  return { auth, huespedes, habitaciones, reservas, estancias, pagos, reportes, usuarios };
}
