# Matriz de cobertura de la especificación

Esta matriz es el contrato de aceptación del Sistema Web de Control de Vacaciones. La evidencia automatizada referencia archivos y nombres de pruebas existentes; no usa conteos tomados de una base de producción como sustituto de una prueba reproducible.

## Cobertura funcional

| Área | Estado | Evidencia automatizada concreta |
| --- | --- | --- |
| Identidad única por cédula, actualización del mismo contrato y reingreso histórico | Implementado | `apps/api/tests/vacation.test.ts`: `keeps one worker, updates the same contract date, and creates a re-entry for a new date`; `apps/api/tests/bulkEmploymentImport.test.ts`: `preloads once, applies the last duplicate row and preserves sequential counts` |
| `LocalDate`, días calendario y aniversario del 29 de febrero | Implementado | `apps/api/tests/vacation.test.ts`: `calculates calendar days without timezone drift` y `handles leap-day anniversaries explicitly` |
| Período en formación, causación y saldo legal/programable | Implementado | `apps/api/tests/vacation.test.ts`: `keeps a period forming until the anniversary` y `separates legal pending from scheduled availability` |
| Cronograma: asignaciones, saldo, edición, cancelación y concurrencia | Implementado | `apps/api/tests/vacation.test.ts`: `enforces scheduling, settlement allocation, optimistic version and cancellation` y `paginates schedules, enriches the employee identity and rejects invalid future allocations` |
| Paginación canónica de listados administrativos | Implementado | `apps/api/tests/paginatedRepositories.test.ts`: `listAuditsPage returns the requested slice and the total count`, `filters by actorId, action and date range`, `listHolidaysPage paginates by year and active flag` y `listUsersPage filters by role, active and search`; `apps/web/tests/hooks.test.tsx`: `useServerPagination fetches a page, exposes total and reloads on demand` y `surfaces the error message when the fetcher rejects`; `apps/web/tests/components/AuditPage.test.tsx` y `HolidaysPanel.test.tsx` validan `page` server-side con mocks de `apiRequest` |
| Conversión transaccional de cronograma a disfrute | Implementado | `apps/api/tests/vacation.test.ts`: `requires completed schedules to reconcile exactly with the registered enjoyment` y `warns holidays and completes schedule settlement in one store operation` |
| Liquidaciones manuales, distribución, edición y anulación lógica | Implementado | `apps/api/tests/vacation.test.ts`: `enforces scheduling, settlement allocation, optimistic version and cancellation` y `annuls logically, removes from the active page and preserves the record` |
| Importación de vacaciones disfrutadas con agrupación y varios períodos | Implementado | `apps/api/tests/vacation.test.ts`: `groups split lines and distributes a multi-period liquidation without using calendar days` |
| Barrido global de cierre al aplicar disfrutadas | Implementado | `apps/api/tests/vacation.test.ts`: `sweeps the whole base at apply: enjoyed, migrated, protected, partial and recent periods` verifica cierres `Disfrutado (liquidación registrada)` y `Cerrado por migración` en empleados dentro y fuera del archivo, protección pendiente intacta, parcialidad abierta con advertencia y auditoría `VACATION_PERIOD_CLOSED_BY_SETTLEMENT_IMPORT` |
| Importación de períodos pendientes y liberación sin cierre | Implementado | `apps/api/tests/vacation.test.ts`: `reconciles legacy protections to the authoritative pending-period count` verifica tres períodos protegidos/45 días, 13 períodos `RELEASED` abiertos sin saldo ni protección y saldo total coherente; `warns and skips rows of retired contracts in the pending period import` conserva las filas retiradas como advertencia; `apps/api/tests/repositoryAdapters.test.ts`: `validates pending-import period versions again inside the Mongo transaction` |
| Cierre masivo con aplicación parcial y regla unificada | Implementado | `apps/api/tests/vacation.test.ts`: `applies the mass closure partially, closing only safe periods and preserving review` y `previews and applies the mass closure without closing protected historical enjoyment periods` |
| Fecha de corte central configurable | Implementado | `apps/api/tests/vacation.test.ts`: `uses the closure cutoff setting when the mass closure omits the date`; `apps/api/tests/http.integration.test.ts`: `validates and persists the closure cutoff setting` (401, 400, 200 y 404) |
| Retiro y regularización histórica sin saldo abierto | Implementado | `apps/api/tests/vacation.test.ts`: `closes every open period when a contract is retired and removes its pending balance` y `regularizes existing retired contracts with no persisted periods` |
| Dashboard calculado, desglose por proceso y detalle paginado | Implementado | `apps/api/tests/vacation.test.ts`: `calculates dashboard health and process coverage from active balances` comprueba salud, proceso, paginación y correspondencia de `pendingEmployees` con su detalle; `orders upcoming accruals to year end with overdue periods first and exposes the last causation` verifica la ventana al 31 de diciembre, el orden "vencidos primero" y `lastCausedAt`; `apps/api/tests/http.integration.test.ts`: acceso `401`, lectura autorizada y validación `400` de `/api/v1/dashboard/employments`; `apps/web/tests/components/DashboardPage.test.tsx`: carga diferida por clic, filtro exacto de proceso, "Ver más" de próximas causaciones y "Última causación" en el modal del gráfico de saldo |
| Scheduler, alertas, sesiones y permisos | Implementado | `apps/api/tests/vacation.test.ts`: `runs accrual scheduler idempotently, persists alerts and generates valid report files`, `rotates and revokes refresh sessions without storing the raw token` y `keeps permissions centralized by role` |
| Usuarios y protección del último administrador | Implementado | `apps/api/tests/vacation.test.ts`: `supports the user lifecycle while protecting administrator access`; `apps/api/tests/http.integration.test.ts`: caso `422` al intentar inactivar el administrador actual |
| Informe de programación por rango, estado y búsqueda | Implementado | `apps/api/tests/vacation.test.ts`: `builds the annual schedule report by year, status and employee without duplicate lookups` conserva la compatibilidad `year`; `filters the annual report by the current schedule date range` verifica el cruce `from/to`, el rango completo y las etiquetas mensuales año-conscientes; `builds the annual PDF without blank pages and with an exact page count` verifica 3 páginas exactas para 45 filas y 1 página para 1 fila |

## Importación de empleados

| Requisito | Estado | Evidencia automatizada concreta |
| --- | --- | --- |
| Precargas por lote y ausencia de consultas por fila | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: espías verifican una llamada a cada precarga y cero llamadas a búsquedas individuales en `preloads once, applies the last duplicate row and preserves sequential counts` |
| Regla "última fila válida gana", duplicados y conteos | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: mismo caso verifica un worker, dos vínculos, versiones, `created`, `updated` y `duplicateRows` |
| Un solo contrato activo por cédula al importar | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: `preloads once, applies the last duplicate row and preserves sequential counts` verifica que el contrato anterior queda `RETIRED` con `endDate` el día anterior al siguiente contrato, y la auditoría `EMPLOYMENT_RETIRED_BY_IMPORT` |
| Filas inválidas sin mutación parcial de esas filas | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: `returns row errors without applying invalid rows`; `apps/api/tests/http.integration.test.ts`: `returns 207 metrics for partial employment imports and protects retry` |
| Vista previa validada antes de autorizar | Implementado | `apps/api/tests/http.integration.test.ts`: `returns 207 metrics for partial employment imports and protects retry` verifica `validatedRows`, errores y `payloadHash`; `apps/web/tests/components/EmployeeImportModal.test.tsx`: `validates on the server and applies the exact preview only after authorization` y `shows server validation errors and blocks application` |
| Preservación de períodos, liquidaciones, cronogramas y saldo al actualizar | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: `preserves periods, settlements, schedules and their derived balance on updates` |
| Rollback, estado `FAILED` y retry atómico con las mismas filas | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: `rolls back partial writes, marks FAILED and retries the same rows atomically` |
| Idempotencia y conflicto por contenido distinto | Implementado | `apps/api/tests/bulkEmploymentImport.test.ts`: repetición sin nuevas precargas y rechazo con código `CONFLICT` en el primer caso del archivo |
| Chunks de 500, `ordered: false`, sesión única y mayoría | Implementado | `apps/api/tests/repositoryAdapters.test.ts`: `uses unordered bulkWrite chunks in one majority transaction for employment imports` |
| Máximo de tres reintentos transitorios y exclusión de duplicado inesperado | Implementado | `apps/api/tests/repositoryAdapters.test.ts`: `bounds retries to three transient attempts and excludes unexpected duplicate keys` |
| Respuesta `207`, métricas, consulta, replay, autenticación y permisos de retry | Implementado | `apps/api/tests/http.integration.test.ts`: `returns 207 metrics for partial employment imports and protects retry` verifica métricas, `GET`, replay `200`, `401` y `403`; los casos de éxito total e idempotencia se cubren en `bulkEmploymentImport.test.ts` |
| Volumen de referencia de 1.818 filas | Implementado como prueba de rendimiento local | `apps/api/tests/bulkEmploymentImport.benchmark.test.ts`: `imports 1,818 new employments in MemoryStore in under five seconds` |

## Cobertura técnica

| Requisito | Estado | Evidencia |
| --- | --- | --- |
| Arquitectura hexagonal modular | Implementado | `apps/api/src/application/services/vacationService.ts` es facade de servicios en `application/services/vacation`; `MemoryStore` y `MongoStore` delegan en repositorios por capacidad; `bootstrap/app.ts` ensambla routers de `bootstrap/routes` |
| Puertos y transacciones equivalentes Memory/Mongo | Implementado | `apps/api/tests/repositoryAdapters.test.ts`: tabla de contratos de repositorio y `MemoryStore transaction atomicity` verifica rollback observable |
| Errores tipados y traducción HTTP | Implementado | `apps/api/tests/domain.shared.test.ts`: `domain errors` verifica status/code; `apps/api/tests/http.integration.test.ts`: mapeo de `400`, `404`, `409` y `422`, además de `401` y `403` |
| Routers y aliases compatibles | Implementado | `apps/api/tests/http.integration.test.ts`: compara `/api/v1/schedules` con `/api/v1/vacation-schedules` y `/api/v1/settlements` con `/api/v1/vacation-settlements` |
| Mongo: índices, reset acotado y opciones de cliente | Implementado | `apps/api/tests/repositoryAdapters.test.ts`: `uses bounded client defaults suitable for the API` y `resets every declared collection and recreates all indexes` |
| XLSX con ExcelJS y protección de fórmulas | Implementado | `apps/api/tests/reportExporters.test.ts`: `protects every Excel formula prefix`, `builds an XLSX with safe cells beyond column Z` y `parses rich cells, formula results, sparse lines and LocalDate values` |
| PDF con PDFKit y paginación | Implementado | `apps/api/tests/reportExporters.test.ts`: `builds a valid multipage PDF without truncating the report` |
| HTTP con cookie, request-id y control de acceso | Implementado | `apps/api/tests/http.integration.test.ts`: `exposes health and protects authenticated routes`, `returns 403 when a read-only role invokes a mutation` y flujo autenticado con cookie HttpOnly |
| TypeScript, lint, formato, pruebas y build en CI | Implementado | scripts raíz en `package.json` y pasos de `.github/workflows/ci.yml` con Node.js 24 |
| Contrato OpenAPI | Implementado | `docs/openapi.yaml` documenta errores tipados, aliases, detalle paginado del dashboard e importación `worker-imports` con plantilla, preview validado, consulta, confirmación, retry, estados y métricas |

## Frontend

| Requisito | Estado | Evidencia automatizada concreta |
| --- | --- | --- |
| Navegación responsive y accesible en móvil | Implementado | `apps/web/tests/components/AppNavigation.test.tsx`: abre con menú hamburguesa, navega y cierra por overlay y `Escape` |
| Componente y estado de paginación | Implementado | `apps/web/tests/ui.test.tsx`: `calculates pagination bounds and changes pages` (rango, `aria-current` y navegación anterior/siguiente); `apps/web/tests/ui/Pagination.test.tsx`: 8 casos para rango, extremos, páginas numeradas, selector integrado, estado `disabled`, ellipsis y normalización cuando disminuye el total; `apps/web/tests/lib/paginationRange.test.ts`: 7 casos del helper puro (vacío, una página, ≤7, bordes lejanos, bordes cercanos, clamping) |
| Búsqueda diferida | Implementado | `apps/web/tests/hooks.test.tsx`: publica el último valor y cancela el pendiente obsoleto de `useDebouncedValue` |
| Paginación server-side de auditoría | Implementado | `apps/web/tests/components/AuditPage.test.tsx`: `loads the first page server-side and requests a new page on navigation` valida que `apiRequest` se llama con `page=1&pageSize=10` y luego `page=2&pageSize=10` al pulsar `Ir a la página siguiente`; `jumps to the last page and changes page size from the integrated controls` valida `Ir a la última página` (solicita `page=12`) y el cambio de tamaño en el selector integrado (`pageSize=30`) |
| Paginación server-side en `HolidaysPanel` con cambio de año | Implementado | `apps/web/tests/components/HolidaysPanel.test.tsx`: verifica que `HolidaysPanel` consulta `/api/v1/admin/holidays/page?page=1&pageSize=10&year=2026` y reconsulta con `year=2027` al cambiar el año |
| Cliente HTTP, cookies y refresh único concurrente | Implementado | `apps/web/tests/lib/api.test.ts`: `includes credentials...`, respuestas JSON/text/blob/204 y `shares one refresh between concurrent 401 responses and retries each request once` |
| Errores tipados del API en la SPA | Implementado | `apps/web/tests/lib/api.test.ts`: `throws a typed ApiError with server details` |
| Componentes compartidos de carga, vacío, toast, modal y badges | Implementado | `apps/web/tests/ui.test.tsx`: casos de campos/badges, cierre explícito y estados de carga/vacío/toast |
| Importaciones guiadas con validación visible y autorización explícita | Implementado | `apps/web/tests/components/SettlementImport.test.tsx`: análisis previo, errores por fila y archivo vacío; `EmployeeImportModal.test.tsx`: validación del servidor y bloqueo ante errores; `PendingPeriodsImport.test.tsx`: conserva la fecha de corte entre preview y apply |
| Extracción modular de configuración | Implementado | `apps/web/tests/components/VacationPolicyPanel.test.tsx`: conserva endpoint y payload después de extraer el panel |

## Límites de la evidencia

- Las pruebas de la SPA usan `jsdom`; no sustituyen un recorrido E2E en navegador ni la revisión visual de todos los breakpoints.
- Las pruebas de infraestructura Mongo verifican adaptadores, sesiones, chunks, retries, índices y reset con dobles controlados. La validación contra un replica set real sigue siendo una comprobación operativa separada.
- El benchmark de 1.818 filas usa `MemoryStore`; sirve para detectar regresiones algorítmicas, no para prometer latencia de Atlas.

## Criterio de aceptación

No se considera terminada una operación si permite guardar datos que rompan alguno de estos invariantes:

1. Una misma cédula representa un solo `Worker`.
2. Una misma cédula con la misma fecha de ingreso representa el mismo vínculo.
3. Una cédula con otra fecha de ingreso representa un reingreso histórico.
4. Las asignaciones de una programación coinciden con sus días programados.
5. Las asignaciones de una liquidación coinciden con sus días disfrutados y compensados.
6. Una liquidación no consume más saldo pendiente del vínculo.
7. Una programación no reserva más saldo disponible para programar.
8. El período en formación no se suma al saldo causado.
9. Una importación transaccional confirma todas sus escrituras planificadas o ninguna.
10. Toda mutación genera auditoría sin contraseñas, cookies, tokens ni secretos.
11. Los endpoints protegidos responden `401` sin sesión y `403` sin permiso.
12. Una versión obsoleta responde `409` y una regla de negocio responde `422`.
