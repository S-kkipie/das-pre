export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = m => new AppError(400, m);
export const forbidden = m => new AppError(403, m);
export const notFound = m => new AppError(404, m);
export const conflict = m => new AppError(409, m);
