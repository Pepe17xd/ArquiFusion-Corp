type ErrorWithStatus = { status?: unknown; message?: unknown };

/** Converts transport and service failures into calm, user-facing language. */
export function toUserMessage(reason: unknown, fallback = "No pudimos completar la operación."): string {
  const error = reason && typeof reason === "object" ? reason as ErrorWithStatus : undefined;
  const message = typeof error?.message === "string" ? error.message : typeof reason === "string" ? reason : "";
  const parsedStatus = message.match(/\b(?:HTTP\s*)?(400|401|403|404|408|409|422|429|500|502|503|504)\b/i)?.[1];
  const status = typeof error?.status === "number" ? error.status : parsedStatus ? Number(parsedStatus) : undefined;
  if (status === 401) return "Tu sesión ha finalizado. Vuelve a ingresar.";
  if (status === 403) return "No tienes permiso para realizar esta acción.";
  if (status === 404) return "No encontramos la información solicitada.";
  if (status === 408) return "Está tardando más de lo esperado.";
  if (status === 409) return "La información cambió. Actualízala y vuelve a intentarlo.";
  if (status === 400 || status === 422) return "Revisa la información ingresada y vuelve a intentarlo.";
  if (status === 429) return "Hay varias solicitudes en curso. Espera un momento y vuelve a intentarlo.";
  if (status === 502 || status === 503 || status === 504 || (status !== undefined && status >= 500)) return "No pudimos cargar esta información.";
  if (status === 0) return "Esta acción no está disponible en la vista de demostración.";

  if (/timeout|timed out|aborterror/i.test(message)) return "Está tardando más de lo esperado.";
  if (/failed to fetch|network|fetch error|econnrefused|could not connect|no se pudo conectar/i.test(message)) return "No pudimos obtener los datos.";
  // Never echo arbitrary service text: it can contain implementation details or identifiers.
  return fallback;
}
