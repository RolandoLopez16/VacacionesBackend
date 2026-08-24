# Registros de decisiones de arquitectura

## ADR-001 — Arquitectura hexagonal

El dominio y los casos de uso no importan Express, React ni MongoDB. Los puertos viven en `application/ports` y los adaptadores implementan esos puertos.

## ADR-002 — Driver oficial de MongoDB

Se utiliza el driver oficial para mantener el mapeo explícito, evitar hooks ocultos y conservar independencia frente a un ODM.

## ADR-003 — Estrategia `LocalDate`

Las fechas laborales se representan como `YYYY-MM-DD`; no se convierten en instantes horarios. Los aniversarios del 29 de febrero se resuelven al 28 de febrero en años no bisiestos.

## ADR-004 — Sesiones rotatorias en cookies HttpOnly

El access token y el refresh token viajan en cookies HttpOnly. Los refresh tokens se rotan y se guarda únicamente el hash del token en `sessions`; logout y refresh revocan la sesión anterior.

## ADR-005 — Saldos calculados

Los saldos no se persisten como fuente primaria: se derivan de períodos, liquidaciones y reservas para evitar desincronización.

## ADR-006 — Concurrencia optimista

Las entidades mutables tienen `version`. Las actualizaciones aceptan `If-Match` y devuelven conflicto cuando la versión enviada quedó obsoleta.

## ADR-007 — Causación idempotente y snapshot de política

`ensure` puede ejecutarse al crear, consultar o por scheduler sin duplicar períodos. Cada período conserva sus días otorgados al momento de generarse, aunque después cambie la política.

## ADR-008 — Modularización por capacidad con facades

**Estado:** Aceptado e implementado.

Los servicios de aplicación, la persistencia y HTTP evolucionan por capacidades diferentes y no deben volver a archivos monolíticos. La modularización vertical actual separa empleados, períodos, cronogramas, liquidaciones, importaciones, administración y reportes sin romper la arquitectura hexagonal.

- `VacationService` es una facade de compatibilidad. Delega en servicios dentro de `application/services/vacation` para lectura/causación, empleos, retiros, cronogramas, liquidaciones, reportes e importaciones.
- Los puertos de `application/ports/repositories.ts` son interfaces por capacidad. `VacationStore` los compone para simplificar el bootstrap, sin trasladar reglas legales al adaptador.
- `MemoryStore` y `MongoStore` son facades de persistencia. Delegan en repositorios de workers/employments, períodos, cronogramas, liquidaciones, importaciones, administración/autenticación, alertas/auditoría y transacciones.
- Las transacciones que cruzan agregados son operaciones explícitas de `TransactionRepository`; Express no coordina escrituras parciales.
- `bootstrap/routes` contiene routers por capacidad; `app.ts` conserva el ensamblaje, middleware global y montaje de aliases.
- Los schemas Zod viven en `bootstrap/schemas`, las utilidades HTTP en `bootstrap/lib` y los middleware de sesión, request-id y error en `bootstrap/middleware`.
- Se preservan `/schedules` y `/vacation-schedules`, `/settlements` y `/vacation-settlements`, además de `/worker-imports/preview` y `/import/preview`.

Esta decisión reduce conflictos de edición y permite probar cada caso de uso con dependencias estrechas. A cambio, aumenta el número de módulos y exige composición y delegación explícitas. No se aceptan dependencias circulares, reglas de negocio en routers ni acceso directo a Mongo fuera de los repositorios.

## ADR-009 — Errores tipados y traducción HTTP centralizada

**Estado:** Aceptado e implementado para dominio y aplicación.

Los fallos esperados de dominio y aplicación se representan mediante `DomainError` y subtipos con un `code` estable, estado y metadatos seguros. Los códigos públicos son `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `BUSINESS_RULE_VIOLATION` e `INTERNAL_ERROR`.

- Los casos de uso lanzan errores tipados, no dependen de Express y no obligan al router a interpretar textos.
- La validación de entrada se normaliza como `VALIDATION_ERROR`; los conflictos de versión e idempotencia usan `CONFLICT` y las invariantes legales usan `BUSINESS_RULE_VIOLATION`.
- Un único middleware HTTP traduce el error a estado y cuerpo con `code`, `message`, `requestId` y `details` opcional. Un error desconocido se responde como `INTERNAL_ERROR` sin exponer stack ni objetos Mongo.
- Los metadatos son opcionales, estructurados y no incluyen contraseñas, cookies, tokens, cadenas de conexión ni datos personales innecesarios.
- `apps/api/tests/domain.shared.test.ts` verifica status y código de los subtipos; `apps/api/tests/http.integration.test.ts` verifica traducción de `400`, `401`, `403`, `404`, `409` y `422`.

El código semántico, no el mensaje traducible, pasa a ser el contrato estable para consumidores y pruebas. El costo es migrar gradualmente los errores heredados y mantener una tabla explícita de traducción, pero se elimina el acoplamiento a coincidencias de texto.

## ADR-010 — `bulkWrite` transaccional para cambios masivos

**Estado:** Aceptado.

Las operaciones masivas que modifican varios tipos de documento se planifican y validan por completo en aplicación, y se confirman mediante una sola operación del puerto transaccional. En MongoDB, las colecciones afectadas masivamente se escriben con `bulkWrite` o `insertMany` dentro de `session.withTransaction`, y todas las demás escrituras reciben la misma sesión.

- El lote aplicado, las entidades de negocio y los eventos de auditoría se confirman o revierten como una unidad.
- Los filtros usan identificadores determinísticos y `replaceOne` con `upsert` cuando la operación es idempotente. Los arreglos vacíos no generan llamadas innecesarias.
- El adaptador Mongo es responsable de sesiones y primitivas `bulkWrite`; los servicios no importan el driver ni construyen operaciones Mongo.
- `MemoryStore` implementa el mismo puerto y las pruebas verifican los resultados observables, la idempotencia y la ausencia de estados parciales.
- La importación de empleados precarga identidades y relaciones una vez, colapsa duplicados por cédula normalizada y fecha de ingreso con regla "última fila válida gana", y confirma workers, vínculos, períodos, auditorías y lote en chunks de hasta 500 operaciones.
- Los reintentos de esa transacción se limitan a tres intentos y solo aplican a etiquetas transitorias de MongoDB, errores de red y conflictos de escritura. Las filas inválidas terminan en `COMPLETED_WITH_ERRORS` sin reintento; una clave duplicada inesperada durante la persistencia deja el lote `FAILED`.
- Los estados persistidos de empleados son `PROCESSING`, `COMPLETED`, `COMPLETED_WITH_ERRORS` y `FAILED`. Cada adquisición incrementa `attempt`; el intento Mongo final registra `persistenceAttempts`.
- Una confirmación nueva responde `201` o `207`; un replay responde `200`; un contenido o estado incompatible responde `409`. `GET /worker-imports/:batchId` permite consultar por ID o clave histórica y `POST /worker-imports/:batchId/retry` solo adquiere un lote `FAILED` con el mismo hash. El endpoint `confirm` se conserva para recuperación compatible.
- Las métricas persistidas y retornadas son duración, filas procesadas, documentos lógicos planificados y comandos `bulkWrite` (`durationMs`, `processedRows`, `databaseOperations`, `chunks`). No contienen filas ni datos personales.
- `MAX_IMPORT_ROWS` y `MAX_UPLOAD_MB` acotan el trabajo. Si un lote no cabe de forma segura en una transacción, se rechaza o se divide antes de la vista previa en lotes lógicos independientes; no se fragmenta silenciosamente un `apply` atómico.
- Después de un resultado de red incierto se consulta el estado persistido del lote antes de reintentar.

Esta decisión requiere MongoDB Atlas o un despliegue con replica set; Docker Compose mantiene `rs0`. No se ofrece un fallback a escrituras compuestas sin transacción, porque convertiría una falla operativa en inconsistencia de saldos y auditoría.

## ADR-011 — Estrategia de pruebas del frontend

**Estado:** Aceptado; adopción incremental.

El frontend usa Vitest con `jsdom`, Testing Library, `jest-dom` y `user-event`. Las pruebas se ubican en `apps/web/tests` y verifican comportamiento observable, no detalles internos de componentes.

- Las funciones puras cubren formato de `LocalDate`, moneda y transformaciones sin depender de zona horaria.
- Las pruebas de componentes actuales cubren los controles compartidos de carga, vacío y mensajes, además de navegación móvil, auditoría y política. Cada nueva mutación debe añadir error, éxito, permisos, validación y bloqueo del botón cuando corresponda.
- La cobertura actual incluye renovación única y concurrente tras `401`, errores tipados, paginación compartida, búsqueda diferida, navegación móvil, auditoría y el panel de política.
- La red se sustituye en el límite del cliente HTTP con respuestas tipadas y determinísticas. No se conecta a una API real ni a MongoDB desde las pruebas de la SPA.
- Se prefieren consultas accesibles por rol, label y texto. Los snapshots extensos y las aserciones sobre clases CSS no son la estrategia principal.
- Cada corrección de regresión agrega una prueba y `npm test` ejecuta API y frontend en CI. Aún se deben ampliar las pruebas de componente de listados remotos, control de versión e importaciones `preview`/confirmación. Los recorridos de navegador completos se reservan para una capa E2E posterior y no reemplazan estas pruebas rápidas.

La estrategia permite refactorizar componentes sin reescribir pruebas acopladas a su implementación. El costo es mantener fixtures representativos y límites de red claros; no se fija un umbral de cobertura artificial hasta contar con una línea base estable de flujos críticos.

## ADR-012 — ExcelJS para XLSX y PDFKit para PDF

**Estado:** Aceptado e implementado.

Los formatos documentales se generan y leen con bibliotecas mantenidas que conocen el formato real. `exceljs` es la única implementación XLSX y `pdfkit` es la única implementación PDF del API.

- `reportExporters.ts` normaliza cada celda antes de construir XLSX; los valores que empiezan por `=`, `+`, `-` o `@` reciben un apóstrofo para impedir evaluación como fórmula.
- `xlsxParser.ts` y `exceljsSync.ts` leen la primera hoja, conservan filas dispersas, resuelven rich text y resultados de fórmulas, y normalizan columnas de fecha a `YYYY-MM-DD`.
- El trabajo asíncrono de ExcelJS se ejecuta en un worker con intercambio por chunks y timeout, de modo que la interfaz síncrona heredada de reportes/importaciones no depende de APIs internas de ZIP.
- `reportExporters.ts` crea PDF tabular multipágina con `pdfkit`; `annualSchedulePdf.ts` genera el documento anual formal con la misma biblioteca.
- Los buffers se entregan directamente por HTTP y no se escriben archivos temporales.
- `apps/api/tests/reportExporters.test.ts` abre el XLSX generado con ExcelJS, prueba columnas posteriores a `Z`, fechas, fórmulas, rich text, filas dispersas y un PDF multipágina válido.

Esta decisión elimina generadores manuales de ZIP/PDF y concentra seguridad y compatibilidad en adaptadores de infraestructura. El costo es memoria proporcional al documento; por eso siguen vigentes `MAX_UPLOAD_MB`, `MAX_IMPORT_ROWS` y el timeout del worker.

## ADR-013 — Paginación canónica con `PageDto<T>` y server-side por defecto

**Estado:** Aceptado e implementado.

Todos los listados administrativos de la API devuelven un `PageDto<T>` canónico con `items`, `page`, `pageSize`, `total` y `hasNext`. La carga total en memoria deja de ser aceptable para tablas administrativas.

- El tipo genérico `PageDto<T>` y los alias nombrados por dominio (`HolidayPageDto`, `UserPageDto`, `CatalogPageDto`, `AuditPageDto`, `AlertPageDto`, `SchedulerRunPageDto`, `ImportBatchPageDto`, `RetiredReconciliationItemPageDto`, etc.) viven en `@vaca-efa/contracts` y son la única fuente de verdad para el frontend.
- Cada repositorio expone un `*PageQuery` con `page`, `pageSize` y filtros de dominio, y un `listXPage(query)` que devuelve `{ items, total }`. `MemoryStore` y `MongoStore` implementan la misma interfaz; Mongo usa `aggregate` con `$facet` sobre índices declarados.
- Las rutas planas previas (`GET /api/v1/admin/users`, `/audit`, `/alerts`, `/scheduler-runs`, `/holidays`, `/admin/holidays`, `/admin/catalogs/:type`, `/admin/import-batches`, `/admin/retired-employments/reconciliation`) se conservan con `deprecated: true` por compatibilidad. Las nuevas rutas `*/page` son las recomendadas.
- El frontend usa el hook `useServerPagination` (`apps/web/src/hooks/useServerPagination.ts`) que encapsula `loading`, `error`, `reload`, `setPageSize` y reset de página al cambiar el tamaño. El componente `<Pagination>` (`apps/web/src/components/ui/Pagination.tsx`) consolida rango, primera/anterior/siguiente/última, números con ventana + ellipsis clicable y selector de tamaño de página, todo en un único control accesible WCAG 2.1.
- Los schemas Zod de `bootstrap/schemas/admin.ts` validan `page` (≥ 1) y `pageSize` (1..200) antes de llegar al servicio. Un helper `compactQuery` elimina `undefined` y respeta `exactOptionalPropertyTypes: true`.
- Índices Mongo nuevos: `holidays { active:1, date:1 }`, `vacationAlerts { active:1, severity:1, asOf:-1 }`, `schedulerRuns { status:1, asOf:-1 }`, `users { active:1, username:1 }`, `users { role:1, username:1 }`, `auditEvents { createdAt:-1 }`, `auditEvents { entityType:1, entityId:1, createdAt:-1 }`, `auditEvents { action:1, createdAt:-1 }`, `auditEvents { actorId:1, createdAt:-1 }`, `importBatches { status:1, createdAt:-1 }`.
- Pruebas: `apps/api/tests/paginatedRepositories.test.ts` valida `listAuditsPage`, `listHolidaysPage` y `listUsersPage` en `MemoryStore`. `apps/web/tests/hooks.test.tsx` cubre el hook (carga, cambio de página, `setPageSize`, `reload`, error). `apps/web/tests/components/AuditPage.test.tsx` y `HolidaysPanel.test.tsx` validan server-side end-to-end con `apiRequest` mockeado.
- Las pruebas de frontend ya no cargan listas y hacen `slice` en cliente; los paneles consultan `*/page` y se actualizan ante cambios de filtro.

Esta decisión elimina el anti-patrón "loadAll + slice en cliente" en paneles administrativos. El costo es mantener dos rutas por dominio durante la transición; se documenta y elimina la plana una vez los consumidores hayan migrado.

## ADR-014 — Componente de paginación sin librería externa

**Estado:** Aceptado e implementado.

El control de paginación de la SPA se mantiene como implementación custom en `apps/web/src/components/ui/Pagination.tsx` con su helper puro `apps/web/src/lib/paginationRange.ts`. No se introduce `react-paginate`, `Mantine`, `@mui/material` ni `react-responsive-pagination`.

- El componente agrega botones de primera y última página (`«` / `»`), selector de tamaño de página integrado a la derecha del indicador de rango, y puntos suspensivos clicables que saltan al extremo del bloque de páginas visible (patrón WAI-ARIA APG).
- Cumple accesibilidad WCAG 2.1: `role="navigation"` con `aria-label`, `aria-current="page"` en la página activa, `aria-label` específico por botón, `<label>` oculto para el `<select>`, foco visible heredado de `.ghost`.
- Las opciones de tamaño de página (`pageSizeOptions`) se exponen por panel para respetar los casos especiales (catálogo `[5, 10, 20]`, alertas `[6, 10, 20]`, resto `[10, 20, 30, 100]`).
- Cobertura: `apps/web/tests/lib/paginationRange.test.ts` (7 casos del helper) y `apps/web/tests/ui/Pagination.test.tsx` (8 casos del componente, incluyendo accesibilidad, `disabled`, ellipsis, cambio de tamaño y normalización al disminuir el total).

Esta decisión se tomó tras comparar la implementación custom con `react-paginate` (sin first/last nativos), `react-responsive-pagination` (sin first/last), `Mantine` y `MUI` (cuyo peso y lock-in de tema eran incompatibles con la decisión ADR-008 de mantener CSS plano + componentes UI reducidos). Todos los listados paginados consumen el nuevo `<Pagination>` y dejan de usar el antiguo `PageSizeSelect` independiente.

El costo es mantener la lógica de la paginación en el proyecto, pero la suite cubre todas las transiciones y el componente es de ~150 líneas con un helper de ~30 líneas aislado y testeable. Si en el futuro la complejidad crece (p. ej. internacionalización de los textos de control), se reconsiderará.
