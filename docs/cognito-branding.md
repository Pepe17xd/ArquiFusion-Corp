# Branding de acceso de ArquiFusion

La página de credenciales se sirve desde Cognito, no desde React. En la revisión del sitio publicado se observó Hosted UI clásico: `/login` presenta el formulario clásico. La plantilla `cloud/aws/infrastructure/cognito.yml` tampoco especifica una versión de branding; no demuestra por sí sola el estado actual del dominio. El sitio publicado sigue mostrando el diseño anterior hasta aplicar cambios en AWS.

Para conseguir el fondo fotográfico y el panel oscuro, usar **Managed Login** con un plan compatible (Essentials o superior). Cambiar la versión del dominio afecta a todos los app clients de ese dominio; revisar impacto, costes y permisos antes de hacerlo. No cambia por sí mismo el flujo OAuth, pero hay que comprobar todos los clientes y sus estilos. La interfaz clásica admite solo un conjunto limitado de propiedades CSS y un logo: no ofrece la misma libertad para este diseño. No hay que cambiar a formularios propios ni recoger contraseñas en React.

## Recursos y configuración propuesta

Los archivos existentes están listos para el editor de Managed Login:

- Fondo de página: `apps/frontend/public/mine-hero.jpg` (fotografía y licencia en `apps/frontend/public/PHOTO-CREDITS.md`).
- Logo del formulario: `apps/frontend/public/arquifusion-mark.svg`. El editor admite SVG para el logo y JPEG para el fondo.
- Modo oscuro; fondo de respaldo `#070b0e`; superficie del formulario `#0b1720`; texto `#eaf2f3`; texto secundario `#b8cbd0`; borde `#29424a`; color principal `#63dce8` con texto oscuro `#071015`. Ajustar los estados de foco, error y deshabilitado en la vista previa, garantizando contraste legible.

## Procedimiento en AWS

1. En la región `us-east-1`, identificar el user pool por el dominio `arquifusion-624578925414-dev.auth.us-east-1.amazoncognito.com` y verificar el app client `c5uacuvtu0ju26tq06pvpl5cl`. Confirmar que el dominio y los demás clientes son los correctos y registrar su configuración actual para reversión.
2. En **Domain**, comprobar **Branding version** y el plan. Si se autoriza la migración, seleccionar **Managed login**; el cambio se aplica a todos los clientes del dominio. Revisar costes y estilos de cada cliente. Mantener el dominio y el app client actuales.
3. En **Managed login → Styles**, crear o editar el estilo asignado al cliente web. En **Launch editor → Quick setup**, elegir Dark, cargar la fotografía como Page background y el SVG como Form logo. Aplicar la paleta anterior en Foundation y Components; usar el control de fondo y borde del formulario disponible en el editor. AWS controla la estructura y no garantiza CSS arbitrario, desenfoque glassmorphism ni transiciones personalizadas.
4. Usar Preview para inicio, registro, verificación, recuperación y errores en escritorio y móvil. Verificar foco y contraste. Guardar/publicar el estilo únicamente cuando esté revisado; los cambios de estilo se aplican inmediatamente. Si el navegador de AWS no acepta el SVG, exportarlo a PNG y volver a cargarlo.
5. Confirmar en el app client que siguen activos `code`, los scopes `openid email profile arquifusion/read arquifusion/write`, Cognito como proveedor, callback `https://arquifusion-corp.pages.dev/auth/callback` y logout `https://arquifusion-corp.pages.dev`. Mantener registro, verificación por email y recuperación configurados. No habilitar client secret para esta SPA.
6. Probar con una cuenta de prueba real: registro y verificación, inicio, recuperación, logout, retorno al centro de mando y selección de organización; repetir en móvil. Verificar también el resto de clientes que comparten el dominio. Para revertir, restaurar la versión y los estilos previamente registrados y repetir las pruebas.

El editor no permite editar libremente el texto. Managed Login admite localización mediante `lang`; comprobar los idiomas y la propagación entre pantallas antes de incorporarlo al flujo. En Hosted UI clásico, un logo PNG/JPEG y CSS admitido se pueden aplicar como alternativa limitada (logo máximo 100 KB y CSS máximo 3 KB), pero no cumplen el objetivo fotográfico completo.

Referencias: [editor de branding](https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-brandingeditor.html), [migración desde clásico](https://docs.aws.amazon.com/cognito/latest/developerguide/migrate-classic-hosted-ui-to-managed-login.html), [branding clásico](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html), [planes](https://docs.aws.amazon.com/cognito/latest/developerguide/feature-plans-features-essentials.html).
