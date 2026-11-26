import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed } from '../src/db.js';
import { createApp } from '../src/server.js';

let srv, base; const tk = {};
const call = async (m, p, b, t) => {
  const r = await fetch(base + '/api/' + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: r.status === 204 ? null : await r.json() };
};
before(async () => {
  const db = openDb(':memory:'); seed(db); srv = createApp(db);
  await new Promise(r => srv.listen(0, r)); base = 'http://localhost:' + srv.address().port;
  for (const [k, u, p] of [['admin', 'admin', 'admin123'], ['dueno', 'dueno', 'dueno123'], ['rec', 'recepcion', 'recepcion123']])
    tk[k] = (await call('POST', 'login', { usuario: u, password: p })).d.token;
});
after(() => srv.close());

test('login inválido y rutas sin sesión', async () => {
  assert.equal((await call('POST', 'login', { usuario: 'admin', password: 'x' })).s, 401);
  assert.equal((await call('GET', 'huespedes')).s, 401);
});

test('flujo completo: huésped, reserva, pago, check-in, check-out', async () => {
  const t = tk.rec;
  const h = (await call('POST', 'huespedes', { nombres: 'Ana Prueba', documento: '11111111' }, t)).d;
  assert.equal((await call('POST', 'huespedes', { nombres: 'X', documento: '11111111' }, t)).s, 409);
  const r = (await call('POST', 'reservas', { huesped_id: h.id, habitacion_id: 1, entrada: '2030-01-10', salida: '2030-01-12' }, t)).d;
  assert.equal(r.total, 120); assert.equal(r.estado, 'Pendiente');
  // RV_007: no hay doble reserva
  assert.equal((await call('POST', 'reservas', { huesped_id: h.id, habitacion_id: 1, entrada: '2030-01-11', salida: '2030-01-13' }, t)).s, 409);
  assert.equal((await call('POST', 'checkin/' + r.id, null, t)).s, 409); // aún no confirmada
  await call('POST', `reservas/${r.id}/confirmar`, null, t);
  assert.equal((await call('POST', 'checkin/' + r.id, null, t)).d.estado, 'Confirmada');
  assert.equal((await call('GET', 'habitaciones?estado=Ocupada', null, t)).d.length, 1);
  // pagos: transferencia exige datos; no se excede el saldo; no hay tarjeta
  assert.equal((await call('POST', `pagos/reserva/${r.id}`, { monto: 50, medio: 'transferencia' }, t)).s, 400);
  assert.equal((await call('POST', `pagos/reserva/${r.id}`, { monto: 50, medio: 'tarjeta' }, t)).s, 400);
  assert.equal((await call('POST', `pagos/reserva/${r.id}`, { monto: 500, medio: 'efectivo' }, t)).s, 409);
  await call('POST', `pagos/reserva/${r.id}`, { monto: 50, medio: 'yape', banco: 'Yape', fecha_operacion: '2030-01-10', nro_operacion: '123' }, t);
  const out = (await call('POST', 'checkout/' + r.id, null, t)).d;
  assert.equal(out.estado, 'Concluida'); assert.match(out.aviso, /70/);
  assert.equal((await call('GET', 'habitaciones?estado=Disponible', null, t)).d.length, 6);
  assert.equal((await call('GET', `huespedes/${h.id}/historial`, null, t)).d.length, 1);
});

test('roles: recepción sin reportes ni montos; dueño solo consulta; admin todo', async () => {
  assert.equal((await call('GET', 'reportes/saldos', null, tk.rec)).s, 403);
  assert.equal('dinero_acumulado' in (await call('GET', 'estadisticas', null, tk.rec)).d, false);
  assert.equal('dinero_acumulado' in (await call('GET', 'estadisticas', null, tk.dueno)).d, true);
  assert.equal((await call('POST', 'huespedes', { nombres: 'a', documento: '2' }, tk.dueno)).s, 403);
  assert.equal((await call('GET', 'reportes/saldos', null, tk.dueno)).s, 200);
  assert.equal((await call('GET', 'usuarios', null, tk.rec)).s, 403);
  assert.equal((await call('POST', 'usuarios', { nombre: 'N', usuario: 'n', password: 'corta', rol: 'recepcionista' }, tk.admin)).s, 400);
  assert.equal((await call('POST', 'usuarios', { nombre: 'N', usuario: 'n', password: 'larga1234', rol: 'recepcionista' }, tk.admin)).s, 201);
});

test('pago solo se elimina en reserva Pendiente/Cancelada y mantenimiento exige sin reservas activas', async () => {
  const t = tk.admin;
  const h = (await call('POST', 'huespedes', { nombres: 'Beto', documento: '22222222' }, t)).d;
  const r = (await call('POST', 'reservas', { huesped_id: h.id, habitacion_id: 3, entrada: '2031-05-01', salida: '2031-05-03', origen: 'booking', comision: 10 }, t)).d;
  const p = (await call('POST', `pagos/reserva/${r.id}`, { monto: 20, medio: 'efectivo' }, t)).d;
  assert.equal((await call('PUT', '/habitaciones/3/estado'.slice(1), { estado: 'Mantenimiento' }, t)).s, 409);
  await call('POST', `reservas/${r.id}/confirmar`, null, t);
  assert.equal((await call('DELETE', 'pagos/' + p.id, null, t)).s, 409);
  await call('POST', `reservas/${r.id}/cancelar`, null, t);
  assert.equal((await call('DELETE', 'pagos/' + p.id, null, t)).s, 204);
  assert.equal((await call('PUT', 'habitaciones/3/estado', { estado: 'Mantenimiento' }, t)).s, 200);
  assert.equal((await call('POST', 'reservas', { huesped_id: h.id, habitacion_id: 3, entrada: '2031-06-01', salida: '2031-06-02' }, t)).s, 409);
  assert.ok((await call('GET', 'bitacora', null, t)).d.some(x => x.accion === 'pago.eliminar'));
});

test('estadía por horas y habitaciones libres', async () => {
  const t = tk.admin;
  const h = (await call('POST', 'huespedes', { nombres: 'Cris', documento: '33333333' }, t)).d;
  const r = (await call('POST', 'reservas', { huesped_id: h.id, habitacion_id: 2, entrada: '2032-02-02', salida: '2032-02-02', tipo_estadia: 'horas', num_huespedes: 2 }, t)).d;
  assert.equal(r.total, 60);
  const libres = (await call('GET', 'habitaciones/libres?entrada=2032-02-02&salida=2032-02-03', null, t)).d;
  assert.equal(libres.some(x => x.id === 2), false);
});
