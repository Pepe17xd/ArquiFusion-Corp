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

Para desplegar, crea un proyecto Pages en Cloudflare, conecta el repositorio, usa esos valores de build y configura las variables `VITE_*` por entorno. Como alternativa, genera el build local y publica `apps/frontend/dist` con Wrangler Pages, instalado/configurado por separado. No se ha publicado el sitio.

## Variables de build

- `VITE_API_URL`: URL HTTPS de la API AWS, por ejemplo el endpoint HTTP API del stage. Vacía en desarrollo usa `/api` y Vite lo proxya a `http://localhost:3001`.
- `VITE_AUTH_MODE`: `local` para desarrollo, `cognito` para autenticación alojada.
- `VITE_COGNITO_CLIENT_ID`: ID público del app client de Cognito sin secreto.
- `VITE_COGNITO_DOMAIN`: dominio HTTPS de Hosted UI.
- `VITE_COGNITO_REDIRECT_URI`: URL de callback registrada en Cognito, normalmente `https://<sitio>/auth/callback`.

Las variables `VITE_*` se incorporan al bundle y son visibles para cualquier visitante. Nunca pongas claves privadas, client secrets, tokens ni credenciales cloud en ellas. Registra también callback y logout URLs exactas en Cognito, solo si AWS Academy permite usarlo.
