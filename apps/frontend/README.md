# Cloudflare Pages: frontend

Aplicación React 18 y Vite. En Cloudflare Pages configura la raíz del proyecto como la raíz del monorepo para que `npm ci` use el lockfile raíz. El frontend consume la API pública de AWS desde un cliente HTTP centralizado y nunca conecta directamente con Gemini.

## Build y prueba local

Desde la raíz:

```powershell
npm ci
npm run test --workspace @arquifusion/frontend
npm run build --workspace @arquifusion/frontend
```

El comando de build de Pages es `npm run build --workspace @arquifusion/frontend`; el directorio de salida es `apps/frontend/dist`. Configura el directorio raíz como `/` (raíz del monorepo) para que Cloudflare use el `package-lock.json` raíz. `public/_redirects` conserva las rutas de React (incluida `/auth/callback`) al refrescar una URL profunda.

### Comprobación manual de la navegación

En el entorno local abre `/app` y comprueba en escritorio y móvil que la barra aparece al inicio, se oculta al bajar y vuelve al subir. Con la barra oculta, usa «Mostrar navegación» con toque y teclado. Abre los menús de módulos, perfil y navegación móvil y desplázate: la barra debe permanecer visible; repite con el foco del teclado en un control de la barra. Comprueba que pequeños movimientos no producen parpadeo, que las secciones no saltan al ocultarla y que, con movimiento reducido activado, no hay transición animada. Prueba también las rutas y la landing. La selección de organización actual se muestra en el perfil; no existe un menú de cambio de organización en esta barra.

Para desplegar, crea un proyecto Pages en Cloudflare, conecta el repositorio, usa esos valores de build y configura las variables `VITE_*` por entorno. Como alternativa, genera el build local y publica `apps/frontend/dist` con Wrangler Pages, instalado/configurado por separado. No se ha publicado el sitio.

## Variables de build

- `VITE_API_URL`: URL HTTPS pública de API Gateway, `https://ep40dq915l.execute-api.us-east-1.amazonaws.com`. Si no se define en producción, se usa esa URL; en desarrollo sin valor usa `/api` y Vite la proxya a `http://localhost:3001`.
- `VITE_AUTH_MODE`: `local` para desarrollo, `cognito` para autenticación alojada.
- `VITE_COGNITO_CLIENT_ID`: ID público del app client de Cognito sin secreto.
- `VITE_COGNITO_DOMAIN`: dominio HTTPS de Hosted UI.
- `VITE_COGNITO_REDIRECT_URI`: URL de callback registrada en Cognito, normalmente `https://<sitio>/auth/callback`.

Para el proyecto Pages de producción define `VITE_API_URL`, `VITE_AUTH_MODE=cognito`, `VITE_COGNITO_CLIENT_ID`, `VITE_COGNITO_DOMAIN` y `VITE_COGNITO_REDIRECT_URI=https://arquifusion-corp.pages.dev/auth/callback` en **Settings → Variables and Secrets → Variables de entorno** y vuelve a ejecutar el build después de guardarlas. El ID de cliente y el dominio Hosted UI son configuración pública; las claves privadas y secretos no son variables `VITE_*`. Registra también las URL de callback y logout exactas en Cognito.

El cliente actual consume `VITE_API_URL` (no `VITE_API_BASE_URL`) y Cognito Hosted UI consume el client ID, el dominio y la URL de callback. La región y el User Pool ID no son leídos por el frontend OAuth actual. Se conservaron los nombres ya usados por el código; no añadas variables con secretos ni valores privados al build de Pages.

## Sistema visual Enterprise 2.0

Los tokens y reglas compartidas están en `src/design-system.css`: paleta industrial grafito/rojo, tipografía, espaciado, radios, sombras, controles de formulario, focos accesibles y breakpoints. La landing y el acceso usan `mine-hero.jpg`, con atribución y licencia documentadas en `public/PHOTO-CREDITS.md`; el centro de mando utiliza esa misma fotografía como detalle visual atenuado para mantener legible la interfaz operativa. No se agregan cifras de demostración a la landing.


## Cierre de sesión Cognito

El frontend abre `https://<dominio-cognito>/logout` con únicamente `client_id` y `logout_uri`. El retorno se construye como la raíz pública con barra final: `https://arquifusion-corp.pages.dev/`. En Cognito, abre el user pool correspondiente, **App integration → App clients → el cliente web → Login pages**, y comprueba que **Allowed sign-out URLs** incluya exactamente ese valor; añádelo si falta, sin borrar otros valores necesarios. Para pruebas locales, registra `http://localhost:5173/` si corresponde. La URL de callback de inicio de sesión (`.../auth/callback`) es distinta y no se usa para cerrar sesión. No se puede confirmar la lista real sin acceso a la configuración AWS. El cierre usa `/logout`, no `/login`; Cognito conserva su cookie hasta completar la salida alojada. La aplicación elimina sus tokens y datos de organización, intenta revocar el refresh token en segundo plano y reemplaza la entrada protegida del historial antes de navegar. Si la URL de salida no está autorizada exactamente, Cognito puede mostrar `Invalid request`; borrar los tokens locales no cierra por sí solo esa sesión alojada.
