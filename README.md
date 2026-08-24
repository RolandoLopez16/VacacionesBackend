# Sistema Web Vaca EFA

Sistema empresarial para gestionar empleados, vínculos laborales históricos, causación, saldos, programación, liquidaciones, importaciones, alertas y auditoría de vacaciones.

## Capacidades

- causación idempotente, período en formación y saldos derivados de períodos, liquidaciones y reservas;
- empleados con cédula, nombre, fechas de contrato y retiro, tipo de contrato, proceso, cargo y supervisor;
- cronogramas y liquidaciones con asignación por período, control de versión y transacciones compuestas;
- importaciones de empleados, períodos pendientes, vacaciones disfrutadas y cierres administrativos;
- importación de empleados idempotente, transaccional, recuperable y con estados y métricas persistidos;
- autenticación JWT en cookies HttpOnly, rotación de sesiones y permisos `ADMIN`, `HR`, `VIEWER` y `READ_ONLY`;
- scheduler idempotente, alertas, festivos, catálogos, usuarios y política administrable;
- reportes JSON, CSV, XLSX y PDF; XLSX usa `exceljs`, PDF usa `pdfkit` y las celdas exportadas se protegen contra inyección de fórmulas;
- SPA React responsive con navegación móvil, listados paginados, búsqueda remota, detalle de indicadores del dashboard, estados de carga/error/vacío y pruebas Vitest + Testing Library.

## Estructura

```text
apps/api/
  src/domain/                         Reglas puras, LocalDate y errores tipados
  src/application/ports/              Puertos pequeños, compuestos por VacationStore
  src/application/services/vacation/  Servicios por capacidad
  src/application/services/vacationService.ts
                                      Facade de compatibilidad para los casos de uso
  src/adapters/outbound/memory/        Repositorios y transacciones para pruebas
  src/adapters/outbound/mongodb/       Repositorios Mongo, índices y transacciones
  src/bootstrap/routes/                Routers Express por capacidad
  src/bootstrap/schemas/               Validación Zod de HTTP
  src/bootstrap/middleware/            Sesión, autorización, request-id y errores
  src/infrastructure/                  Configuración, importación, reportes y reset
apps/web/
  src/components/                      Vistas y componentes por capacidad
  src/components/ui/                   Controles compartidos
  src/hooks/                           Paginación y búsqueda diferida
  tests/                               Pruebas jsdom de cliente, hooks y componentes
packages/contracts/                    DTO TypeScript compartidos por API y SPA
```

El flujo principal es `router -> VacationService -> servicio de capacidad -> puerto -> repositorio`. `VacationService` conserva una API estable mientras delega en servicios de empleos, causación, cronogramas, liquidaciones, retiros, reportes e importaciones. `MemoryStore` y `MongoStore` también son facades: componen los puertos de `VacationStore` y delegan en repositorios separados por capacidad.

Los errores esperados de dominio y aplicación son subtipos de `DomainError`. El middleware central los traduce a un estado HTTP y un cuerpo con `code`, `message`, `requestId` y, cuando corresponde, `details`; los routers no interpretan mensajes para decidir el estado.

## Compatibilidad HTTP

Se conserva el prefijo `/api/v1` y los aliases existentes:

| Capacidad | Ruta principal | Alias compatible |
| --- | --- | --- |
| Cronogramas | `/api/v1/schedules` | `/api/v1/vacation-schedules` |
| Liquidaciones | `/api/v1/settlements` | `/api/v1/vacation-settlements` |
| Vista previa de empleados | `/api/v1/worker-imports/preview` | `/api/v1/import/preview` |

El detalle de estas rutas, incluidas las acciones históricas propias de cada alias, está en `docs/openapi.yaml`.

## Requisitos

- Node.js 24 LTS.
- npm 11.
- MongoDB Atlas o MongoDB con replica set para `STORAGE_MODE=mongo`.
- Variables locales definidas a partir de `.env.example`; no se deben versionar credenciales ni tokens.

La base lógica debe permanecer en `efagram_vacaciones`, separada de `efagram_nomina`.

## Inicio local

```bash
npm install
npm run build
npm run dev
```

- SPA: `http://localhost:5173`.
- API: `http://localhost:3000`.
- Proxy Vite: `/api` hacia `http://localhost:3000`.
- Health: `/api/v1/health`, `/api/v1/health/live` y `/api/v1/health/ready`.

El script `dev` del API ejecuta `apps/api/dist/src/bootstrap/server.js`; por eso se debe compilar antes del primer arranque y después de cambios backend. Para compilar y arrancar solo el API en una operación:

```bash
npm run build:dev --workspace @vaca-efa/api
```

El acceso inicial usa `BOOTSTRAP_ADMIN_USERNAME` y `BOOTSTRAP_ADMIN_PASSWORD` del entorno. La contraseña bootstrap debe cambiarse antes de producción.

## Importación de empleados

1. Descargar la plantilla con `GET /api/v1/worker-imports/template`.
2. Previsualizar y validar cada fila del CSV con `POST /api/v1/worker-imports/preview`.
3. Confirmar las filas con `POST /api/v1/import/employments` y un `Idempotency-Key` estable para ese contenido.
4. Consultar el estado con `GET /api/v1/worker-imports/:batchId`.
5. Reintentar un lote `FAILED`, con exactamente las mismas filas, mediante `POST /api/v1/worker-imports/:batchId/retry`.

La vista previa devuelve `validatedRows`, errores por fila y `payloadHash`; no modifica datos. La interfaz confirma únicamente las filas normalizadas marcadas como válidas y exige autorización explícita. Una confirmación nueva responde `201` si todas las filas son válidas o `207` si confirmó las válidas y reportó inválidas. Una repetición ya completada responde `200`; conflictos de contenido o estado responden `409`. El resultado incluye `metrics.durationMs`, `metrics.processedRows`, `metrics.databaseOperations` y `metrics.chunks`. El endpoint `confirm` se mantiene para recuperación compatible de lotes antiguos en `PROCESSING` o `FAILED`.

La plantilla usa `Cédula,Nombre,Fecha contrato,Fecha de retiro,Tipo de contrato,Proceso,Cargo,Supervisor`. La fecha de retiro puede estar vacía y las fechas de negocio se mantienen como `YYYY-MM-DD`. Al importar, por cada cédula queda un solo contrato activo: los contratos anteriores sin fecha de retiro quedan retirados con `endDate` el día anterior al inicio del contrato siguiente y sus períodos se cierran.

## Cierre histórico de períodos

El flujo canónico es empleados → períodos pendientes → disfrutadas → cierre masivo, y se describe completo en `docs/operations.md`. La fecha de corte vive en el ajuste `VACATION_CLOSURE_FROM_DATE` (`GET/PATCH /api/v1/admin/settings/VACATION_CLOSURE_FROM_DATE`, por defecto `2025-01-01`): la carga de disfrutadas cierra en toda la base los períodos anteriores al corte que no estén protegidos por pendientes (como disfrutado o como migración), y el cierre masivo aplica solo las decisiones seguras dejando las revisiones intactas.

## Validación

Desde la raíz, el mismo alcance usado por CI es:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

`npm test` ejecuta primero las pruebas del API y luego las de la SPA. La evidencia por requisito está en `docs/requirements-coverage.md`.

## Docker y reset

```bash
docker compose up --build
```

Docker inicia MongoDB con `--replSet rs0`, ejecuta `rs.initiate(...)` y levanta API y frontend. Para limpiar únicamente las colecciones del sistema de vacaciones y recrear el administrador:

```bash
npm run db:reset --workspace @vaca-efa/api
```

Antes del reset se debe confirmar `STORAGE_MODE=mongo` y `MONGODB_DATABASE=efagram_vacaciones`. El reset no usa `dropDatabase` y nunca debe ejecutarse contra una base de nómina.
