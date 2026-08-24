# Operación y producción

## Seguridad

- Usar `NODE_ENV=production`, HTTPS en el proxy y `Secure` cookies.
- Cambiar el usuario/contraseña inicial y mantener secretos fuera de Git.
- Definir `JWT_REFRESH_SECRET` independiente del secreto de access tokens.
- Restringir `CORS_ORIGINS` a los orígenes corporativos.

## Modelo de ejecución

El API se compila a `apps/api/dist` y el script `dev` ejecuta `dist/src/bootstrap/server.js`; no transpila TypeScript durante el arranque. Después de cambiar el backend se debe ejecutar `npm run build` desde la raíz o `npm run build:dev --workspace @vaca-efa/api`. El bootstrap ensambla routers por capacidad, la facade `VacationService` y una facade de persistencia (`MemoryStore` o `MongoStore`) que delega en repositorios especializados.

Los fallos esperados usan `DomainError` y códigos estables. El middleware central responde con `code`, `message`, `requestId` y `details` seguros cuando existen. Los códigos de aplicación son `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `BUSINESS_RULE_VIOLATION` (422) e `INTERNAL_ERROR` (500).

## Scheduler

`SCHEDULER_ENABLED=true` activa `VacationAccrualScheduler`. `SCHEDULER_INTERVAL_MS` define la frecuencia; el valor recomendado para producción es `86400000` (24 horas). Cada ejecución queda en `schedulerRuns` y sus alertas determinísticas en `vacationAlerts`; repetir la misma fecha no duplica períodos, ejecución ni alertas. Se consultan en `/api/v1/admin/scheduler-runs` y `/api/v1/alerts`.

## Transacciones MongoDB

El registro de una liquidación desde un cronograma ejecuta `withTransaction` para guardar liquidación, cronograma completado y las dos auditorías en una sola operación. MongoDB Atlas ya provee el replica set requerido. Para Docker Compose, `mongodb` arranca con `--replSet rs0` y `mongo-init` lo inicializa automáticamente.

Cuando se cierra un contrato, los períodos de vacaciones pendientes no continúan abiertos: se cierran con la observación `Cierre de vacaciones por terminación de contrato`, no se eliminan y quedan en `auditEvents`. Para regularizar datos históricos, ejecutar con sesión ADMIN `POST /api/v1/admin/retired-employments/close-pending`. La operación lee períodos por lote y escribe lotes transaccionales idempotentes; una respuesta con `employmentsChanged: 0` y `periodsClosed: 0` confirma que no quedan cierres pendientes.

## Importación masiva

### Alcance y permisos

La carga masiva se ejecuta siempre sobre la base dedicada de vacaciones y con una sesión autorizada. Los flujos de empleados, períodos pendientes y vacaciones disfrutadas requieren permiso de creación; el cierre masivo administrativo requiere rol ADMIN. Ninguna vista previa modifica empleados, períodos, cronogramas ni liquidaciones. La vista previa de empleados es stateless; los otros flujos guardan un lote `PREVIEW` para vincular la autorización posterior.

| Flujo | Vista previa | Aplicación y consulta del lote |
| --- | --- | --- |
| Empleados | `POST /api/v1/worker-imports/preview` o el alias `POST /api/v1/import/preview` | `POST /api/v1/import/employments`; consulta con `GET /api/v1/worker-imports/:batchId`; recuperación con `POST /api/v1/worker-imports/:batchId/retry`; `POST /api/v1/worker-imports/:batchId/confirm` se conserva para compatibilidad |
| Períodos pendientes | `POST /api/v1/vacation-periods/import-pending/preview` | `POST /api/v1/vacation-periods/import-pending/:batchId/apply`; consulta con `GET /api/v1/vacation-periods/import-pending/:batchId` |
| Vacaciones disfrutadas | `POST /api/v1/vacation-settlements/import/preview` | `POST /api/v1/vacation-settlements/import/:batchId/apply`; consulta con `GET /api/v1/vacation-settlements/import/:batchId` |
| Cierre administrativo de períodos | `POST /api/v1/admin/vacation-period-closures/preview` | `POST /api/v1/admin/vacation-period-closures/:batchId/apply`; consulta con `GET /api/v1/admin/vacation-period-closures/:batchId` |

La plantilla de empleados se descarga desde `GET /api/v1/worker-imports/template`. El CSV usa las columnas `Cédula`, `Nombre`, `Fecha contrato`, `Fecha de retiro`, `Tipo de contrato`, `Proceso`, `Cargo` y `Supervisor`; la fecha de retiro puede quedar vacía. Las vacaciones disfrutadas, los períodos pendientes y los cierres administrativos aceptan CSV y hojas XLSX. ExcelJS procesa la primera hoja y conserva el número real de las filas pobladas. Los dos primeros flujos conservan líneas originales y el cierre conserva su plan de decisiones para trazabilidad. Todas las fechas de negocio deben permanecer como `YYYY-MM-DD`.

### Límites de entrada

- `MAX_UPLOAD_MB` limita el archivo decodificado que reciben los flujos basados en archivo. El valor predeterminado es 10 MB.
- `MAX_IMPORT_ROWS` limita las líneas de los flujos basados en archivo y las filas enviadas al aplicar empleados. El valor predeterminado es 5000.
- El límite global del cuerpo JSON contempla la expansión de Base64, pero no sustituye el límite aplicado al archivo decodificado.
- La vista previa de empleados recibe contenido CSV, valida el tamaño decodificado con `MAX_UPLOAD_MB` y rechaza más de `MAX_IMPORT_ROWS` antes de construir la autorización. La confirmación y los endpoints `confirm`/`retry` vuelven a limitar las filas JSON.
- Un archivo por encima de los límites debe dividirse en lotes independientes y trazables. No se deben elevar los valores sin revisar memoria, tiempo de transacción, tamaño de documentos y capacidad del clúster.

No cargar archivos de fuentes no confiables ni registrar su contenido completo. Los archivos pueden contener datos personales y deben conservarse únicamente en el repositorio documental corporativo autorizado, con el mismo control de acceso y retención que la información laboral.

### Flujo `preview` y confirmación

1. Confirmar que `/api/v1/health/ready` está disponible, que `MONGODB_DATABASE` apunta a `efagram_vacaciones` y que existe un backup recuperable.
2. Enviar el archivo a `preview`. Para períodos, liquidaciones y cierres, conservar de forma temporal el `batchId`, el `previewToken`, el nombre y exactamente los mismos bytes del archivo. La vista previa de empleados devuelve filas normalizadas, pero no crea lote ni token.
3. Revisar totales, filas inválidas, advertencias, conflictos, diferencias y elementos marcados para revisión. No autorizar un lote mientras existan errores, conflictos o decisiones `REVIEW`.
4. Solicitar confirmación explícita del operador. La interfaz nunca debe confirmar ni invocar `apply` automáticamente al seleccionar o analizar un archivo.
5. Para empleados, enviar las filas a `POST /api/v1/import/employments` con un `Idempotency-Key`. Para los demás flujos, enviar a `apply` el mismo `batchId`, `previewToken`, nombre y contenido; en cierres también deben coincidir las fechas de corte usadas en la vista previa.
6. Verificar el estado final del lote, los conteos, una muestra funcional de los datos y los eventos de auditoría.

Los flujos de períodos, liquidaciones y cierres vuelven a validar el plan antes de aplicar. Si cambió el archivo, el token, una versión de período o los datos relacionados, la API responde con conflicto y se debe generar una vista previa nueva. No se debe reutilizar el token con un archivo corregido. La importación de empleados no usa `previewToken`; su vista previa valida filas y la confirmación se protege con `Idempotency-Key` y hash del payload.

Para cada contrato incluido en la carga de períodos pendientes, `Periodo Pendiente` es el conteo contable autoritativo: se conservan los períodos causados abiertos más recientes hasta ese número y se cierran los demás. Un período con liquidación parcial o programación activa queda en `REVIEW` y bloquea la aplicación. Las marcas históricas `pendingImportProtected` no sustituyen el conteo del archivo. Después de desplegar esta regla sobre datos anteriores, se debe generar una vista previa nueva, revisar `KEEP`, `CLOSE` y `REVIEW`, y aplicar el lote autorizado para reconciliar los saldos persistidos.

### Idempotencia

- En empleados, enviar un `Idempotency-Key` opaco y único por lote lógico. Se debe reutilizar únicamente para reintentar exactamente las mismas filas; nunca para un archivo corregido o distinto. Si se omite, la API deriva una clave del contenido, pero en operación se recomienda enviarla explícitamente.
- Una cédula normalizada identifica un solo trabajador y la combinación de cédula y fecha de contrato identifica el vínculo. Reprocesar esos datos actualiza el vínculo correspondiente en vez de crear otra identidad.
- Si el archivo repite cédula y fecha de contrato, se aplica una sola mutación con la última fila válida. Para conservar la semántica secuencial, un vínculo nuevo cuenta una creación y sus repeticiones cuentan como actualizaciones; un vínculo preexistente cuenta todas sus apariciones válidas como actualizaciones. Una fecha de contrato distinta continúa siendo un reingreso.
- En vacaciones disfrutadas, el hash del archivo detecta archivos ya aplicados y cada liquidación conserva una `sourceKey` y hashes de línea. Un archivo modificado debe pasar por una vista previa nueva para mostrar sus diferencias.
- En períodos pendientes y cierres, el hash del archivo, el lote y el token enlazan la vista previa con la aplicación. Un lote `APPLIED` se consulta antes de cualquier reintento.
- La idempotencia evita duplicar entidades de negocio, pero no debe tratarse como entrega exactamente una vez ante una pérdida de red. El estado persistido del lote es la fuente para decidir si corresponde reintentar.

La carga de empleados valida y planifica todas las filas antes de escribir. Una respuesta `207` significa que las filas válidas quedaron creadas o actualizadas en una única confirmación transaccional y que las inválidas no formaron parte del plan. Corregir y previsualizar únicamente las filas fallidas como un lote nuevo evita reprocesamientos innecesarios.

### Estados, respuestas y métricas de empleados

El lote de empleados sigue `PROCESSING -> COMPLETED | COMPLETED_WITH_ERRORS | FAILED`. `attempt` identifica cada adquisición lógica del lote y `persistenceAttempts` registra cuántas veces se intentó la persistencia Mongo, incluido el intento exitoso, con un rango de 1 a 3.

| HTTP | Significado operativo |
| --- | --- |
| `200` | Repetición idempotente de un lote ya completado. No se escribieron de nuevo las entidades. |
| `201` | Intento nuevo completado sin filas inválidas. |
| `207` | Intento nuevo `COMPLETED_WITH_ERRORS`: se confirmaron las filas válidas y se devolvió el detalle de inválidas. |
| `409` | La clave o el lote pertenecen a otro contenido, ya están siendo procesados o no admiten la acción solicitada. |
| `422` | Una regla de negocio impidió confirmar el plan. |
| `500` | La persistencia no pudo completarse y el lote quedó `FAILED`; el detalle seguro puede incluir `batchId`. |

La respuesta de confirmación y reintento contiene `metrics.durationMs`, `metrics.processedRows`, `metrics.databaseOperations` y `metrics.chunks`. `databaseOperations` cuenta documentos lógicos planificados, incluidos lote y auditorías; `chunks` cuenta comandos `bulkWrite`, no filas ni lecturas. El lote persistido conserva esos valores para que `GET /api/v1/worker-imports/:batchId` sea la fuente de recuperación.

### Atomicidad y replica set

La aplicación de empleados, vacaciones disfrutadas, períodos pendientes y cierres administrativos prepara primero el plan completo y lo entrega a una operación explícita de `TransactionRepository`. MongoDB ejecuta cada operación compuesta dentro de `session.withTransaction`; ante un error confirma todo o revierte todo.

La importación de empleados tiene garantías adicionales verificables: workers, vínculos, períodos, auditorías y estado final del lote se escriben en chunks de máximo 500 operaciones, con `ordered: false`, lectura `snapshot`, primario y `writeConcern: majority` con journal. Solo esta operación implementa el reintento acotado propio de hasta tres intentos para etiquetas transitorias de MongoDB, red y `WriteConflict`. Una validación o una clave duplicada inesperada no se reintenta. Los demás flujos usan sus transacciones específicas, pero no se debe atribuirles automáticamente la misma métrica de chunks ni esa política adicional de reintento.

Las transacciones requieren un replica set. MongoDB Atlas ya ofrece esta capacidad. En local se debe usar `docker compose up --build`: `mongodb` inicia con `--replSet rs0`, `mongo-init` ejecuta `rs.initiate(...)` y la conexión incluye `replicaSet=rs0`. Un `mongod` standalone no es un sustituto válido y no se debe implementar una caída silenciosa a escrituras no transaccionales. Antes de importar, comprobar readiness y que el replica set tenga un primario disponible.

### Recuperación

1. Ante un timeout o una desconexión, detener nuevas aplicaciones y conservar el archivo original, el identificador del lote o la clave de idempotencia y el `X-Request-Id`. No ejecutar `db:reset`, no borrar lotes y no modificar estados directamente en MongoDB.
2. Consultar el lote. Para empleados se usa `GET /api/v1/worker-imports/:batchId`, que también acepta la clave de idempotencia histórica; para los demás flujos se usa el `GET` correspondiente con `:batchId`.
3. Si el estado es `COMPLETED`, `COMPLETED_WITH_ERRORS` o `APPLIED`, no volver a aplicar. Comparar conteos y `auditEvents`; en `COMPLETED_WITH_ERRORS`, preparar un lote nuevo solo con las filas corregidas. Invocar `retry` sobre un lote de empleados ya completado devuelve el resultado persistido con `replayed: true` y HTTP `200`.
4. Si el estado es `PREVIEW`, se puede aplicar el archivo original con el token original. Si la API devuelve `409`, descartar esa autorización y generar una vista previa nueva.
5. Si la persistencia de empleados falla, el lote queda `FAILED` con un resumen seguro y sin escrituras parciales. Reenviar exactamente las mismas filas a `POST /api/v1/worker-imports/:batchId/retry`; un contenido distinto responde `409` y un identificador inexistente responde `404`. Si una interrupción abrupta dejó un lote antiguo en `PROCESSING`, `POST /api/v1/worker-imports/:batchId/confirm` conserva la recuperación compatible y adquiere un intento nuevo mediante control compare-and-set de estado e intento.
6. Si un `apply` transaccional no tiene respuesta y el lote sigue en `PREVIEW`, MongoDB no confirmó el cambio compuesto y se puede reintentar con el mismo archivo y token. Si figura `APPLIED`, el commit terminó y no se debe repetir.
7. Si se aplicó un contenido funcionalmente incorrecto, no eliminar documentos ni restaurar parcialmente colecciones. Usar operaciones compensatorias trazables, como la anulación de liquidaciones, o coordinar una restauración completa y probada según la política de backups.

Después de una migración de vacaciones disfrutadas, validar saldos y liquidaciones antes de ejecutar la regularización de contratos retirados. Conservar el resumen del lote y la evidencia de revisión sin incluir tokens, cookies, cadenas de conexión ni credenciales.

## Flujo canónico de cierre histórico

La reconciliación de datos históricos se ejecuta en este orden y con una regla única: **un período abierto anterior a la fecha de corte se cierra cuando no está contemplado en la carga de pendientes ni registrado en la carga de disfrutadas**; la protección aplica únicamente a períodos con saldo pendiente de disfrute.

1. **Empleados** (`POST /api/v1/worker-imports/preview` + `/api/v1/import/employments`): por cada cédula queda un solo contrato `ACTIVE` (el más reciente sin fecha de retiro). Los contratos anteriores quedan `RETIRED`; si no traían fecha de retiro se les asigna el día anterior al inicio del contrato siguiente y sus períodos se cierran con `Cierre de vacaciones por terminación de contrato`. La auditoría registra `EMPLOYMENT_RETIRED_BY_IMPORT`.
2. **Períodos pendientes** (`/api/v1/vacation-periods/import-pending/*`): se reconcilia únicamente el contrato abierto. Se conservan protegidos (`KEEP`, `pendingImportProtected`) los N períodos causados abiertos más recientes. Los demás quedan `RELEASED` (`pendingImportReleased`): permanecen abiertos sin generar saldo, a la espera de la carga de disfrutadas. Una fila que solo coincide con un contrato retirado genera advertencia y no se modifica. `REVIEW` (liquidación parcial o cronograma activo) bloquea únicamente esta aplicación.
3. **Disfrutadas** (`/api/v1/vacation-settlements/import/*`): registra liquidaciones de todos los tiempos, incluidos contratos retirados, y crea el cronograma `COMPLETED` de cada liquidación importada. Al aplicar ejecuta el barrido global sobre toda la base:
   - períodos protegidos por pendientes: no se tocan;
   - períodos sin liquidaciones y no protegidos: se cierran con `Cerrado por migración` (`MASS_MIGRATION`);
   - períodos con liquidación completa: se cierran con `Disfrutado (liquidación registrada)` (`ACCOUNTING_LIQUIDATION`);
   - períodos con liquidación parcial: quedan abiertos y se reportan en `partiallyEnjoyedWarnings`.
   Cada cierre queda auditado como `VACATION_PERIOD_CLOSED_BY_SETTLEMENT_IMPORT`.
4. **Cierre masivo** (`/api/v1/admin/vacation-period-closures/*`): barrido final con la misma regla unificada. Aplica únicamente las decisiones `CLOSE` y conserva intactos `REVIEW` y `PROTECTED`; la respuesta reporta `closedPeriods` y `pendingReviewPeriods` para re-ejecutar la vista previa.
5. **Verificación**: el dashboard y el directorio de empleados no deben mostrar períodos históricos abiertos con saldo fuera del conteo pendiente.

La fecha de corte vive en el ajuste `VACATION_CLOSURE_FROM_DATE` (`GET/PATCH /api/v1/admin/settings/VACATION_CLOSURE_FROM_DATE`, formato `YYYY-MM-DD`, por defecto `2025-01-01`). La usan el barrido de disfrutadas y el cierre masivo cuando la operación no envía una fecha explícita. El panel de cierre masivo permite consultarla, sobreescribirla por operación y guardarla como valor del sistema.

## Festivos

Administración: `GET/POST /api/v1/admin/holidays`, `GET/PATCH/DELETE /api/v1/admin/holidays/:id`. DELETE aplica desactivación lógica para conservar trazabilidad. La consulta de lectura autenticada `GET /api/v1/holidays?year=YYYY` permite cargar el calendario sin exigir permiso administrativo. Al crear o editar un cronograma, los festivos activos incluidos entre inicio y fin se devuelven como `holidayWarnings`; no reducen silenciosamente los días solicitados.

## Backups

El backup debe programarse sobre la base `MONGODB_DATABASE` con retención corporativa, cifrado, control de acceso y una restauración de prueba periódica. El script `db:reset` no es un backup y solo debe usarse sobre la base de vacaciones cuando se requiera limpiar datos.

## Observabilidad

Las respuestas incluyen `X-Request-Id`; los errores internos se registran como JSON sin cookies, tokens ni contraseñas. Los health checks son `/api/v1/health/live` y `/api/v1/health/ready`, con aliases operativos `/health/live` y `/health/ready`.

La importación de empleados devuelve las métricas descritas en la sección de estados y registra el mismo resumen sin cédulas, nombres ni contenido de filas. Los eventos `employment_import_completed` y `employment_import_failed` incluyen identificador de lote, estado y conteos técnicos; no deben ampliarse con el payload.

## Paginación canónica

Todas las pantallas administrativas (auditoría, festivos, usuarios, catálogos, alertas, ejecuciones del scheduler, lotes de importación y conciliación de retirados) consumen endpoints `*/page` que devuelven el DTO genérico `PageDto<T>` definido en `@vaca-efa/contracts`:

```json
{
  "items": [...],
  "page": 1,
  "pageSize": 20,
  "total": 1234,
  "hasNext": true
}
```

- Las rutas anteriores sin sufijo `/page` (`/api/v1/admin/users`, `/audit`, `/alerts`, `/holidays`, `/admin/catalogs/:type`, `/admin/scheduler-runs`, `/admin/retired-employments/reconciliation`, `/admin/import-batches`) se conservan marcadas como `deprecated: true` y se eliminarán tras la migración total de consumidores. No deben usarse en UI nueva.
- El backend aplica `MAX_PAGE_SIZE` (200) en la validación Zod de cada query. Tamaños recomendados: 10, 20, 30, 100.
- El frontend reutiliza el hook `useServerPagination` y el componente `<Pagination>` (`apps/web/src/components/ui/Pagination.tsx`) que consolida: indicador de rango, primera/anterior/siguiente/última página, números con ventana y ellipsis clicable (salto a la página del extremo del bloque) y selector de tamaño de página. La accesibilidad cumple WAI-ARIA: `role="navigation"`, `aria-label` por botón, `aria-current="page"` en la página activa, etiqueta oculta para el selector.
- `MemoryStore` filtra, ordena y aplica `slice(start, start + pageSize)`; `MongoStore` usa `aggregate` con `$facet` sobre los índices declarados en `mongoStore.indexes`.
- Una respuesta de página nunca carga la colección completa del lado del cliente. Si una pantalla muestra un contador "X de Y", ese total proviene de `total` y los `items` son solo la página solicitada.

## Rendimiento con MongoDB Atlas Free

- La pantalla de empleados usa `GET /api/v1/employments` con `page`, `pageSize`, `search`, `status`, `process`, `from`, `to` y `accrualWithin`. El tamaño recomendado es 20; la interfaz permite 10, 20, 30 y 100.
- El backend no calcula un resumen haciendo consultas por empleado. Para una página carga los vínculos, trabajadores, períodos, cronogramas y liquidaciones en consultas por lote, con proyecciones e índices en MongoDB.
- El dashboard calcula sus indicadores en una sola carga por lotes y devuelve solo los 25 próximos casos. Por defecto la SPA filtra el mes actual y vínculos activos; el usuario puede cambiar el rango, estado y proceso. Cada indicador, categoría de salud y proceso abre bajo demanda una página de empleados desde `GET /api/v1/dashboard/employments`; el hover solo comunica que el control es interactivo y no dispara consultas.
- El detalle de un vínculo (`/api/v1/employments/:id`) es la única operación que carga períodos, cronogramas y liquidaciones completos. Los formularios buscan la cédula bajo demanda y no precargan los 1.818 vínculos.
- No usar `listEmployments()` más un `for` que llame `summary()` para construir tablas paginadas. Si se agrega una lista nueva, debe usar un método paginado del puerto y consultas por lote.
- Las exportaciones y reportes completos son operaciones explícitas; no deben usarse como fuente de datos para las tablas de la SPA.
- Los vínculos `RETIRED` no deben aparecer con saldo pendiente: el backend excluye períodos `CLOSED` del saldo y disponibilidad. Si se detecta un caso histórico, ejecutar la regularización administrativa y revisar `auditEvents`.
- El cronograma usa `GET /api/v1/schedules?page=1&pageSize=10&search=<cedula>&status=SCHEDULED&from=YYYY-MM-DD&to=YYYY-MM-DD`; las filas se enriquecen en una consulta por lote con nombre, cédula, proceso y cargo. No reemplazarlo por `listSchedules()` en tablas.
- Crear o editar un cronograma valida que las asignaciones coincidan con períodos causados o en formación, que no excedan el saldo y que estén dentro de la vigencia del contrato. Crear, editar y cancelar guardan el cronograma y su auditoría dentro de una transacción.
- Desde la ficha de un vínculo activo en `Empleados`, la acción `Programar vacaciones para este empleado` abre `Cronograma` con el vínculo precargado. El detalle del vínculo se consulta una sola vez y el selector continúa permitiendo cambiar por cédula.
- La programación se descarga con `GET /api/v1/reports/schedules/annual?from=YYYY-MM-DD&to=YYYY-MM-DD&status=SCHEDULED&search=<cedula|nombre|proceso>&format=pdf` y usa exactamente los filtros activos de la tabla del cronograma; sin fechas el PDF incluye todas las programaciones. El parámetro `year` se conserva por compatibilidad (equivale al 1-ene/31-dic de ese año). El nombre del archivo refleja el rango (`programacion-vacaciones-{desde}_a_{hasta}.pdf` o `programacion-vacaciones-completo.pdf`). La consulta cruza fechas con una agregación `$lookup` sin N+1 y el PDF (título "Programación de vacaciones" con el rango, resumen, resumen mensual con etiquetas año-conscientes, listado por programación, períodos de origen, estado y firmas) pagina de forma determinista sin páginas en blanco. Cada exportación deja `SCHEDULE_ANNUAL_REPORT_EXPORTED` en auditoría.

## Reportes

`/api/v1/reports/*?format=csv|xlsx|pdf` genera archivos cuando el endpoint admite ese formato. `exceljs` construye XLSX y lee la primera hoja de las importaciones XLSX/XLSM mediante un worker con timeout. Las celdas exportadas que comienzan por `=`, `+`, `-` o `@` se escapan para evitar inyección de fórmulas.

Los PDF tabulares y el informe anual usan `pdfkit`, se generan en memoria y no crean archivos temporales. El informe anual se descarga como `programacion-vacaciones-YYYY.pdf`; ningún reporte debe incluir tokens o credenciales.

## Comandos y CI

La instalación reproducible de CI usa `npm ci`. Desde la raíz, la validación completa es:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

El workflow `.github/workflows/ci.yml` ejecuta esos controles con Node.js 24 en cada `push` a `main`/`master` y en cada pull request. Markdown y `docs/openapi.yaml` están excluidos por `.prettierignore`; el chequeo de formato sí cubre el workflow y el código. OpenAPI se debe validar además como YAML y como documento OpenAPI después de modificarlo.
