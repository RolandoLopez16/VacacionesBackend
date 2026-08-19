# Sistema Web Vaca EFA

Sistema empresarial para controlar empleados, vínculos, períodos causados, períodos en formación, saldos, programación, liquidaciones y auditoría de vacaciones.

## Estado de esta entrega

La aplicación ya incluye una base ejecutable de monorepo con:

- dominio de vacaciones independiente de Express, React y MongoDB;
- causación automática idempotente y días faltantes derivados;
- saldos legales y disponibles para programación derivados de movimientos;
- API REST `/api/v1` con login, empleados y vínculos históricos, dashboard, períodos, programación completa, liquidaciones editables, importación masiva idempotente, reportes CSV y auditoría;
- SPA React responsive con dashboard, empleados, detalle, períodos, cronograma y alertas;
- persistencia MongoDB Atlas sobre la base dedicada `efagram_vacaciones` y repositorio en memoria para pruebas;
- autenticación JWT con access/refresh token en cookies HttpOnly, usuario administrador persistido y hash de contraseña con scrypt;
- empleados con cédula, nombre, fecha de contrato, fecha de retiro, tipo de contrato, proceso, cargo y supervisor;
- alta individual, exportación CSV y carga masiva CSV con vista previa y confirmación;
- pruebas unitarias de fechas, causación, saldos, reservas, reingresos, idempotencia y concurrencia optimista;
- sesiones rotatorias persistidas en Mongo, revocación de refresh tokens, permisos ADMIN/HR/VIEWER, scheduler idempotente, festivos y catálogos administrables;
- pantalla de Configuración activa para consultar y administrar política de vacaciones, catálogos, festivos, usuarios, alertas y ejecuciones del scheduler;
- reportes en CSV, XLSX y PDF con protección contra inyección de fórmulas;
- cierre automático del ciclo de vacaciones al retiro, regularización histórica por lotes transaccionales y exclusión de períodos cerrados del saldo pendiente;
- documentación de cobertura de requisitos en `docs/requirements-coverage.md` y contrato OpenAPI en `docs/openapi.yaml`.

## Requisitos

Node.js 24 LTS, npm 11 y acceso al clúster MongoDB Atlas configurado en `.env`.

## Inicio rápido

```bash
npm install
npm run dev
```

Abrir `http://localhost:5173`. El acceso inicial utiliza el usuario y la contraseña definidos por `BOOTSTRAP_ADMIN_USERNAME` y `BOOTSTRAP_ADMIN_PASSWORD` en el entorno; nunca se muestran ni se almacenan en el código fuente.

La configuración actual usa la base nueva `efagram_vacaciones`, separada de `efagram_nomina`. El administrador bootstrap debe cambiar su contraseña después del primer acceso.

Para limpiar exclusivamente las colecciones de vacaciones y recrear el administrador:

```bash
npm run db:reset --workspace @vaca-efa/api
```

El reset no usa `dropDatabase` porque el usuario de Atlas no tiene permisos administrativos; borra solamente las colecciones del sistema de vacaciones.

## Validación

```bash
npm run typecheck
npm test
npm run build
```

Los health checks públicos son `/api/v1/health`, `/api/v1/health/live` y `/api/v1/health/ready`. Las operaciones que modifican datos generan eventos en `auditEvents`; las ediciones admiten `If-Match` con el número de versión para evitar sobrescrituras concurrentes.

La política inicial utiliza 15 días por año causado, alerta en 30/60/90 días y atraso administrativo 12 meses después de la causación. Las fechas empresariales se tratan como `YYYY-MM-DD`, sin instantes horarios.

Después de cargar y validar los disfrutes históricos, los contratos retirados pueden regularizarse con sesión ADMIN mediante `POST /api/v1/admin/retired-employments/close-pending`. La operación es idempotente, no elimina información y deja el cierre en el historial.

El CSV de carga masiva debe tener estas columnas: `Cédula,Nombre,Fecha contrato,Fecha de retiro,Tipo de contrato,Proceso,Cargo,Supervisor`. La fecha de retiro puede quedar vacía.

## Arquitectura

`apps/api/src/domain` contiene las reglas puras. `application` orquesta casos de uso por puertos. `adapters` conecta HTTP y persistencia. `apps/web` consume solamente contratos HTTP.
