import assert from "node:assert/strict";
import test from "node:test";
import { toUserMessage } from "./user-message.ts";

test("translates authentication and permission failures", () => {
  assert.equal(toUserMessage({ status: 401 }), "Tu sesión ha finalizado. Vuelve a ingresar.");
  assert.equal(toUserMessage({ status: 403 }), "No tienes permiso para realizar esta acción.");
});

test("translates unavailable services, timeout and network failures", () => {
  assert.equal(toUserMessage(new Error("HTTP 502")), "No pudimos cargar esta información.");
  assert.equal(toUserMessage(new Error("Failed to fetch")), "No pudimos obtener los datos.");
  assert.equal(toUserMessage(new Error("request timeout")), "Está tardando más de lo esperado.");
});

test("uses operation-specific fallback without exposing service details", () => {
  assert.equal(toUserMessage(new Error("internal server trace: /private/path"), "No pudimos guardar el repuesto."), "No pudimos guardar el repuesto.");
  assert.equal(toUserMessage({ message: "local-preview", status: 0 }), "Esta acción no está disponible en la vista de demostración.");
});
