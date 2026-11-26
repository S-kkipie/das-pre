// Capa de presentación/API: router HTTP mínimo + control de acceso por rol (RNF-0002).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { openDb, seed, respaldar, programarRespaldo } from './db.js';
import { createServices } from './services.js';
import { AppError, forbidden } from './errors.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// Permisos: administrador = todo; gerente (dueño) = solo consulta; recepcionista = operación diaria sin montos globales.
const RECEP = /^(huespedes|habitaciones|reservas|checkin|checkout|pagos|estadisticas)/;
function permitido(rol, metodo, ruta) {
  if (rol === 'administrador') return true;
  if (rol === 'gerente') return metodo === 'GET';
  if (ruta.startsWith('reportes') || ruta.startsWith('usuarios') || ruta.startsWith('bitacora')) return false;
  if (metodo === 'DELETE' || metodo === 'PUT' && ruta.startsWith('habitaciones')) return false;
  if (metodo === 'POST' && ruta === 'habitaciones') return false;
  return RECEP.test(ruta);
}

export function createApp(db) {
  const S = createServices(db);

  // [metodo, patrón, handler(ctx)] ; ctx = {p: params de ruta, q: query, b: body, u: usuario}
  const rutas = [
    ['GET', 'huespedes', c => S.huespedes.listar(c.q)],
    ['POST', 'huespedes', c => S.huespedes.crear(c.b, c.u)],
    ['PUT', 'huespedes/:id', c => S.huespedes.editar(+c.p.id, c.b, c.u)],
    ['GET', 'huespedes/:id/historial', c => S.huespedes.historial(+c.p.id)],
    ['GET', 'habitaciones', c => S.habitaciones.listar(c.q)],
    ['GET', 'habitaciones/libres', c => S.habitaciones.libres(c.q)],
    ['POST', 'habitaciones', c => S.habitaciones.crear(c.b, c.u)],
    ['PUT', 'habitaciones/:id', c => S.habitaciones.editar(+c.p.id, c.b, c.u)],
    ['PUT', 'habitaciones/:id/estado', c => S.habitaciones.estado(+c.p.id, c.b.estado, c.u)],
    ['DELETE', 'habitaciones/:id', c => S.habitaciones.eliminar(+c.p.id, c.u)],
    ['GET', 'reservas', c => S.reservas.listar(c.q)],
    ['GET', 'reservas/:id', c => S.reservas.obtener(+c.p.id)],
    ['POST', 'reservas', c => S.reservas.crear(c.b, c.u)],
    ['POST', 'reservas/:id/confirmar', c => S.reservas.confirmar(+c.p.id, c.u)],
    ['POST', 'reservas/:id/cancelar', c => S.reservas.cancelar(+c.p.id, c.u)],
    ['POST', 'checkin/:id', c => S.estancias.checkIn(+c.p.id, c.u)],
    ['POST', 'checkout/:id', c => S.estancias.checkOut(+c.p.id, c.u)],
    ['GET', 'pagos/reserva/:id', c => S.pagos.listar(+c.p.id)],
    ['POST', 'pagos/reserva/:id', c => S.pagos.registrar(+c.p.id, c.b, c.u)],
    ['DELETE', 'pagos/:id', c => S.pagos.eliminar(+c.p.id, c.u)],
    ['GET', 'reportes/saldos', () => S.reportes.saldos()],
    ['GET', 'reportes/financiero', c => S.reportes.financiero(c.q)],
    ['GET', 'estadisticas', c => S.reportes.estadisticas(c.u.rol)],
    ['GET', 'usuarios', () => S.usuarios.listar()],
    ['POST', 'usuarios', c => S.usuarios.crear(c.b, c.u)],
    ['PUT', 'usuarios/:id/rol', c => S.usuarios.rol(+c.p.id, c.b.rol, c.u)],
    ['DELETE', 'usuarios/:id', c => S.usuarios.eliminar(+c.p.id, c.u)],
    ['GET', 'bitacora', () => S.usuarios.bitacora()],
  ].map(([m, patron, h]) => [m, new RegExp('^' + patron.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h]);

  async function api(req, res, url) {
    const ruta = url.pathname.replace(/^\/api\//, '');
    const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o ?? {})); };
    const body = await new Promise((ok, ko) => {
      let d = ''; req.on('data', x => { d += x; if (d.length > 1e6) { req.destroy(); ko(new AppError(413, 'Cuerpo muy grande')); } });
      req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ko(new AppError(400, 'JSON inválido')); } });
    });
    if (ruta === 'login' && req.method === 'POST') return json(200, S.auth.login(body));
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const u = S.auth.sesion(token);
    if (!u) throw new AppError(401, 'No autenticado');
    if (ruta === 'logout' && req.method === 'POST') { S.auth.logout(token); return json(200, {}); }
    if (ruta === 'yo') return json(200, u);
    if (!permitido(u.rol, req.method, ruta)) throw forbidden('Sin permiso para esta operación');
    for (const [m, re, h] of rutas) {
      const x = m === req.method && re.exec(ruta);
      if (x) {
        const r = h({ p: x.groups ?? {}, q: Object.fromEntries(url.searchParams), b: body, u });
        return r === undefined ? json(204) : json(req.method === 'POST' ? 201 : 200, r);
      }
    }
    throw new AppError(404, 'Ruta no encontrada');
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const f = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
      if (f.includes('..')) throw new AppError(404, 'No encontrado');
      const data = await readFile(join(PUBLIC, f)).catch(() => { throw new AppError(404, 'No encontrado'); });
      res.writeHead(200, { 'content-type': TIPOS[extname(f)] ?? 'application/octet-stream' }); res.end(data);
    } catch (e) {
      const st = e instanceof AppError ? e.status : 500;
      if (st === 500) console.error(e);
      res.writeHead(st, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: st === 500 ? 'Error interno' : e.message }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb(); seed(db);
  programarRespaldo(db);
  const port = process.env.PORT || 3000;
  createApp(db).listen(port, () => console.log(`Luxor PMS en http://localhost:${port}`));
  if (process.argv.includes('--respaldo')) console.log('Respaldo:', respaldar(db));
}
