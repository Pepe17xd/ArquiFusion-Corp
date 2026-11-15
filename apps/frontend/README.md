# Cloudflare Pages: frontend

Aplicación React 18 y Vite. En Cloudflare Pages configura la raíz del proyecto como la raíz del monorepo para que `npm ci` use el lockfile raíz.

## Build y prueba local

Desde la raíz:

```powershell
npm ci
npm run test --workspace @arquifusion/frontend
npm run build --workspace @arquifusion/frontend
```

El comando de build de Pages es `npm run build --workspace @arquifusion/frontend`; el directorio de salida es `apps/frontend/dist`. `public/_redirects` conserva las rutas de React (incluida `/auth/callback`) al refrescar una URL profunda.

### Comprobación manual de la navegación

En el entorno local abre `/app` y comprueba en escritorio y móvil que la barra aparece al inicio, se oculta al bajar y vuelve al subir. Con la barra oculta, usa «Mostrar navegación» con toque y teclado. Abre los menús de módulos, perfil y navegación móvil y desplázate: la barra debe permanecer visible; repite con el foco del teclado en un control de la barra. Comprueba que pequeños movimientos no producen parpadeo, que las secciones no saltan al ocultarla y que, con movimiento reducido activado, no hay transición animada. Prueba también las rutas y la landing. La selección de organización actual se muestra en el perfil; no existe un menú de cambio de organización en esta barra.

Para desplegar, crea un proyecto Pages en Cloudflare, conecta el repositorio, usa esos valores de build y configura las variables `VITE_*` por entorno. Como alternativa, genera el build local y publica `apps/frontend/dist` con Wrangler Pages, instalado/configurado por separado. No se ha publicado el sitio.

## Variables de build

- `VITE_API_URL`: URL HTTPS de la API AWS, por ejemplo el endpoint HTTP API del stage. Vacía en desarrollo usa `/api` y Vite lo proxya a `http://localhost:3001`.
- `VITE_AUTH_MODE`: `local` para desarrollo, `cognito` para autenticación alojada.
- `VITE_COGNITO_CLIENT_ID`: ID público del app client de Cognito sin secreto.
- `VITE_COGNITO_DOMAIN`: dominio HTTPS de Hosted UI.
- `VITE_COGNITO_REDIRECT_URI`: URL de callback registrada en Cognito, normalmente `https://<sitio>/auth/callback`.

Las variables `VITE_*` se incorporan al bundle y son visibles para cualquier visitante. Nunca pongas claves privadas, client secrets, tokens ni credenciales cloud en ellas. Registra también callback y logout URLs exactas en Cognito, solo si AWS Academy permite usarlo.


## Cierre de sesión Cognito

El frontend abre `https://<dominio-cognito>/logout` con únicamente `client_id` y `logout_uri`. El valor enviado es exactamente `window.location.origin`, sin barra final: para el sitio de producción, `https://arquifusion-corp.pages.dev`. En Cognito, abre el user pool de `us-east-1`, **App clients → arquifusion-web → Login pages**, edita la configuración y comprueba que **Allowed sign-out URLs** incluya exactamente ese valor; añádelo si falta, sin borrar otros valores necesarios. Para pruebas locales en `http://localhost:5173`, autoriza exactamente `http://localhost:5173` si corresponde. No se puede confirmar la lista real sin acceso a la configuración AWS. Si se observa `/login?client_id=...&logout_uri=...`, comprueba la primera petición y el destino de cualquier redirección: `/login` no es el endpoint correcto para esos parámetros. Cognito también conserva su cookie hasta completar `/logout`; revocar el refresh token por sí solo no cierra esa sesión. El frontend elimina sus tokens inmediatamente y hace un intento limitado de revocación antes de navegar.
