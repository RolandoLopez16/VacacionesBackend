# Operación y producción

## Seguridad

- Usar `NODE_ENV=production`, HTTPS en el proxy y `Secure` cookies.
- Cambiar el usuario/contraseña inicial y mantener secretos fuera de Git.
- Definir `JWT_REFRESH_SECRET` independiente del secreto de access tokens.
- Restringir `CORS_ORIGINS` a los orígenes corporativos.

## Scheduler

`SCHEDULER_ENABLED=true` activa `VacationAccrualScheduler`. `SCHEDULER_INTERVAL_MS` define la frecuencia; el valor recomendado para producción es `86400000` (24 horas). Cada ejecución queda en `schedulerRuns` y sus alertas determinísticas en `vacationAlerts`; repetir la misma fecha no duplica períodos, ejecución ni alertas. Se consultan en `/api/v1/admin/scheduler-runs` y `/api/v1/alerts`.

## Transacciones MongoDB

El registro de una liquidación desde un cronograma ejecuta `withTransaction` para guardar liquidación, cronograma completado y las dos auditorías en una sola operación. MongoDB Atlas ya provee el replica set requerido. Para Docker Compose, `mongodb` arranca con `--replSet rs0` y `mongo-init` lo inicializa automáticamente.

Cuando se cierra un contrato, los períodos de vacaciones pendientes no continúan abiertos: se cierran con la observación `Cierre de vacaciones por terminación de contrato`, no se eliminan y quedan en `auditEvents`. Para regularizar datos históricos, ejecutar con sesión ADMIN `POST /api/v1/admin/retired-employments/close-pending`. La operación lee períodos por lote y escribe lotes transaccionales idempotentes; una respuesta con `employmentsChanged: 0` y `periodsClosed: 0` confirma que no quedan cierres pendientes.

## Festivos

Administración: `GET/POST/PATCH /api/v1/admin/holidays`, `GET/PATCH/DELETE /api/v1/admin/holidays/:id`. DELETE aplica desactivación lógica para conservar trazabilidad. La consulta pública `GET /api/v1/holidays?year=YYYY` permite cargar el calendario. Al crear o editar un cronograma, los festivos activos incluidos entre inicio y fin se devuelven como `holidayWarnings`; no reducen silenciosamente los días solicitados.

## Backups

El backup debe programarse sobre la base `MONGODB_DATABASE` con retención corporativa, cifrado, control de acceso y una restauración de prueba periódica. El script `db:reset` no es un backup y solo debe usarse sobre la base de vacaciones cuando se requiera limpiar datos.

## Observabilidad

Las respuestas incluyen `X-Request-Id`; los errores internos se registran como JSON sin cookies, tokens ni contraseñas. Los health checks son `/health/live` y `/health/ready`.

## Rendimiento con MongoDB Atlas Free

- La pantalla de empleados usa `GET /api/v1/employments` con `page`, `pageSize`, `search`, `status`, `process`, `from`, `to` y `accrualWithin`. El tamaño recomendado es 20; la interfaz permite 10, 20, 30 y 100.
- El backend no calcula un resumen haciendo consultas por empleado. Para una página carga los vínculos, trabajadores, períodos, cronogramas y liquidaciones en consultas por lote, con proyecciones e índices en MongoDB.
- El dashboard calcula sus indicadores en una sola carga por lotes y devuelve solo los 25 próximos casos. Por defecto la SPA filtra el mes actual y vínculos activos; el usuario puede cambiar el rango, estado y proceso.
- El detalle de un vínculo (`/api/v1/employments/:id`) es la única operación que carga períodos, cronogramas y liquidaciones completos. Los formularios buscan la cédula bajo demanda y no precargan los 1.818 vínculos.
- No usar `listEmployments()` más un `for` que llame `summary()` para construir tablas paginadas. Si se agrega una lista nueva, debe usar un método paginado del puerto y consultas por lote.
- Las exportaciones y reportes completos son operaciones explícitas; no deben usarse como fuente de datos para las tablas de la SPA.
- Los vínculos `RETIRED` no deben aparecer con saldo pendiente: el backend excluye períodos `CLOSED` del saldo y disponibilidad. Si se detecta un caso histórico, ejecutar la regularización administrativa y revisar `auditEvents`.
- El cronograma usa `GET /api/v1/schedules?page=1&pageSize=10&search=<cedula>&status=SCHEDULED&from=YYYY-MM-DD&to=YYYY-MM-DD`; las filas se enriquecen en una consulta por lote con nombre, cédula, proceso y cargo. No reemplazarlo por `listSchedules()` en tablas.
- Crear o editar un cronograma valida que las asignaciones coincidan con períodos causados o en formación, que no excedan el saldo y que estén dentro de la vigencia del contrato. Crear, editar y cancelar guardan el cronograma y su auditoría dentro de una transacción.
- Desde la ficha de un vínculo activo en `Empleados`, la acción `Programar vacaciones para este empleado` abre `Cronograma` con el vínculo precargado. El detalle del vínculo se consulta una sola vez y el selector continúa permitiendo cambiar por cédula.
- La programación anual se descarga con `GET /api/v1/reports/schedules/annual?year=YYYY&status=SCHEDULED&format=pdf`. El filtro anual incluye cronogramas que se crucen con el año, excluye cancelados por defecto y consulta empleados, vínculos y cronogramas mediante una agregación con `$lookup`, sin N+1. El PDF contiene resumen, listado formal por programación, períodos de origen, estado, observaciones de festivos y espacios de elaboración/revisión/aprobación. Cada exportación deja `SCHEDULE_ANNUAL_REPORT_EXPORTED` en auditoría.

## Reportes

`/api/v1/reports/*?format=csv|xlsx|pdf` genera archivos. Las celdas Excel que comienzan por `=`, `+`, `-` o `@` se escapan para evitar inyección de fórmulas.

El informe anual usa `pdfkit`, se genera en memoria y se entrega como descarga con el nombre `programacion-vacaciones-YYYY.pdf`; no se persisten archivos temporales ni se incluyen tokens o credenciales.
