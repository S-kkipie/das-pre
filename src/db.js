// Capa de datos: SQLite embebido (node:sqlite). Un solo archivo = base unificada del monolito.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function openDb(file = process.env.DB_FILE || 'luxor.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, usuario TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL, rol TEXT NOT NULL CHECK (rol IN ('administrador','gerente','recepcionista')));
    CREATE TABLE IF NOT EXISTS huespedes (
      id INTEGER PRIMARY KEY, nombres TEXT NOT NULL, documento TEXT NOT NULL UNIQUE,
      procedencia TEXT, contacto TEXT);
    CREATE TABLE IF NOT EXISTS habitaciones (
      id INTEGER PRIMARY KEY, numero TEXT NOT NULL UNIQUE,
      tipo TEXT NOT NULL CHECK (tipo IN ('matrimonial','doble','triple','familiar')),
      precio REAL NOT NULL CHECK (precio > 0),
      estado TEXT NOT NULL DEFAULT 'Disponible'
        CHECK (estado IN ('Disponible','Reservada','Ocupada','Mantenimiento')));
    CREATE TABLE IF NOT EXISTS reservas (
      id INTEGER PRIMARY KEY,
      huesped_id INTEGER NOT NULL REFERENCES huespedes(id),
      habitacion_id INTEGER NOT NULL REFERENCES habitaciones(id),
      entrada TEXT NOT NULL, salida TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'Pendiente'
        CHECK (estado IN ('Pendiente','Confirmada','Cancelada','Concluida')),
      origen TEXT NOT NULL DEFAULT 'directo',
      num_huespedes INTEGER NOT NULL DEFAULT 1 CHECK (num_huespedes > 0),
      tipo_estadia TEXT NOT NULL DEFAULT 'noche' CHECK (tipo_estadia IN ('noche','horas')),
      comision REAL NOT NULL DEFAULT 0,
      creado TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY, reserva_id INTEGER NOT NULL UNIQUE REFERENCES reservas(id),
      entrada_real TEXT NOT NULL, salida_real TEXT);
    CREATE TABLE IF NOT EXISTS pagos (
      id INTEGER PRIMARY KEY, reserva_id INTEGER NOT NULL REFERENCES reservas(id),
      monto REAL NOT NULL CHECK (monto > 0),
      medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','yape')),
      banco TEXT, fecha_operacion TEXT, nro_operacion TEXT,
      creado TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS bitacora (
      id INTEGER PRIMARY KEY, usuario TEXT, accion TEXT, detalle TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now')));
    -- RNF-0003: búsqueda/historial de huésped en <= 2 s
    CREATE INDEX IF NOT EXISTS ix_reservas_huesped ON reservas(huesped_id, entrada);
    CREATE INDEX IF NOT EXISTS ix_reservas_hab ON reservas(habitacion_id, estado, entrada, salida);
    CREATE INDEX IF NOT EXISTS ix_pagos_reserva ON pagos(reserva_id);
  `);
  return db;
}

// Ejecuta fn dentro de una transacción (BEGIN IMMEDIATE evita carreras entre reservas).
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM usuarios').get().c) return;
  const u = db.prepare('INSERT INTO usuarios (nombre,usuario,hash,rol) VALUES (?,?,?,?)');
  // Contraseñas de DEMO. Cambiarlas antes de cualquier uso real.
  u.run('Administrador', 'admin', hashPassword('admin123'), 'administrador');
  u.run('Dueño', 'dueno', hashPassword('dueno123'), 'gerente');
  u.run('Recepción', 'recepcion', hashPassword('recepcion123'), 'recepcionista');
  const h = db.prepare('INSERT INTO habitaciones (numero,tipo,precio) VALUES (?,?,?)');
  [['101', 'matrimonial', 60], ['102', 'matrimonial', 60], ['201', 'doble', 90],
   ['202', 'doble', 90], ['301', 'triple', 120], ['302', 'familiar', 140]]
    .forEach(r => h.run(...r));
}

// RNF-0004: respaldo automático cada 24 h (copia consistente con VACUUM INTO).
export function respaldar(db, dir = process.env.BACKUP_DIR || 'respaldos') {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `luxor-${new Date().toISOString().slice(0, 10)}.db`);
  rmSync(f, { force: true });
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  return f;
}

export function programarRespaldo(db) { // todos los días a las 00:00
  const sig = new Date(); sig.setHours(24, 0, 0, 0);
  const t = setTimeout(() => { respaldar(db); programarRespaldo(db); }, sig - Date.now());
  t.unref();
}
