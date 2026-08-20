# AGENTS.md — Backend Vaca EFA

## Propósito

Este proyecto contiene la API REST del Sistema Web Vaca EFA. Es responsable de autenticación, empleados, vínculos laborales, causación de vacaciones, saldos, cronogramas, liquidaciones, festivos, catálogos, alertas, scheduler, auditoría, reportes e importación masiva.

La API se ejecuta normalmente en:

- Desarrollo: http://localhost:3000
- Prefijo de rutas: /api/v1
- Base de datos MongoDB: efagram_vacaciones
- Modo de pruebas: STORAGE_MODE=memory

## Arquitectura obligatoria

Respeta la separación por capas:

- src/domain: modelos y reglas puras del negocio.
- src/application/services: casos de uso, validaciones e invariantes.
- src/application/ports: interfaces de repositorio y transacciones.
- src/adapters/outbound/memory: persistencia en memoria para pruebas.
- src/adapters/outbound/mongodb: persistencia MongoDB oficial.
- src/bootstrap/app.ts: rutas HTTP, Zod, cookies, middleware y errores.
- src/bootstrap/server.ts: composición, servidor HTTP y scheduler.
- src/infrastructure: configuración, reset y exportadores.

No coloques reglas legales de vacaciones directamente en Express, MongoStore o componentes del frontend. Toda regla reusable debe estar en domain o application/services.

## Reglas de fechas

- Las fechas laborales usan LocalDate con formato YYYY-MM-DD.
- No usar Date para cálculos de períodos laborales.
- No usar new Date('YYYY-MM-DD'), porque puede introducir desplazamientos de zona horaria.
- Usar las funciones existentes de src/domain/shared/localDate.ts.
- Los aniversarios, años bisiestos y límites de períodos deben mantener pruebas específicas.
- Las fechas de retiro no pueden ser anteriores a la fecha de contrato.

## Invariantes laborales y de vacaciones

Todo cambio debe conservar estas reglas:

1. Una cédula normalizada representa un solo Worker.
2. La misma cédula y fecha de contrato actualiza el mismo Employment.
3. La misma cédula con otra fecha de contrato representa un reingreso histórico.
4. El período FORMING no se suma al saldo causado.
5. Los días causados vienen de períodos, no de valores calculados por el frontend.
6. Las asignaciones de un VacationSchedule deben sumar scheduledDays.
7. Las asignaciones de una VacationSettlement deben coincidir con enjoyedDays y compensatedDays.
8. Una liquidación no puede consumir más saldo pendiente.
9. Un cronograma no puede superar el saldo disponible para programar.
10. Las ediciones concurrentes deben validar version/If-Match y devolver 409 cuando la versión sea obsoleta.
11. Toda mutación debe generar un AuditEvent sin incluir contraseñas, tokens, cookies, URI de Mongo ni secretos.
12. Cuando un Employment pasa a RETIRED, la causación se detiene en endDate y todos sus períodos persistidos que aún estén abiertos se cierran con `Cierre de vacaciones por terminación de contrato`; los períodos CLOSED no generan saldo pendiente ni disponibilidad para programar.
13. La regularización de contratos retirados existentes usa `POST /api/v1/admin/retired-employments/close-pending`. Debe ser idempotente, usar lotes transaccionales pequeños y registrar el cierre del vínculo y de cada período en `auditEvents`.

## Persistencia

La aplicación depende de la interfaz VacationStore. Cuando agregues una entidad o capacidad:

1. Crea o actualiza el modelo de dominio.
2. Actualiza el puerto en src/application/ports/repositories.ts.
3. Implementa MemoryStore.
4. Implementa MongoStore.
5. Agrega índices en ensureIndexes.
6. Agrega la colección al resetVacationDatabase si corresponde.
7. Agrega pruebas unitarias.
8. Actualiza OpenAPI y la documentación operativa.

MongoStore debe ocultar _id mediante strip. No expongas documentos Mongo crudos.

La base de vacaciones debe continuar aislada de la base de nómina:

- MONGODB_DATABASE=efagram_vacaciones
- Nunca ejecutar reset contra efagram_nomina.
- No utilizar dropDatabase.
- El reset solo elimina las colecciones del sistema de vacaciones y recrea el usuario bootstrap.

## Transacciones MongoDB

La operación de convertir un cronograma en liquidación debe usar TransactionRepository.completeScheduleTransaction.

La implementación Mongo debe guardar dentro de withTransaction:

- VacationSettlement.
- VacationSchedule actualizado a COMPLETED.
- Auditoría de liquidación.
- Auditoría de cierre del cronograma.

MongoDB Atlas debe usar una configuración compatible con transacciones. Docker debe conservar:

- mongod --replSet rs0
- servicio mongo-init
- conexión con replicaSet=rs0

MemoryStore debe implementar la misma interfaz, aunque su comportamiento sea secuencial para pruebas.

## Autenticación y autorización

- Access y refresh JWT se entregan en cookies HttpOnly.
- No almacenar tokens en respuestas de negocio ni en logs.
- Refresh tokens se guardan únicamente como hash en sessions.
- El refresh token debe rotarse y el anterior debe revocarse.
- Las contraseñas se almacenan con scrypt y salt.
- Nunca devolver passwordHash ni passwordSalt.
- Usar requireSession como middleware global.
- Usar permissionService como matriz central de permisos.
- Roles válidos: ADMIN, HR, VIEWER y READ_ONLY.
- Toda ruta nueva debe clasificarse en permissionFor.
- Verificar siempre 401 sin sesión y 403 para roles no autorizados.
- En producción usar HTTPS, cookies Secure, CORS restringido y secretos independientes.

No imprimir:

- MONGODB_URI.
- JWT_SECRET.
- JWT_REFRESH_SECRET.
- Contraseñas.
- Cookies.
- Access tokens.
- Refresh tokens.
- Datos personales innecesarios.

## Scheduler y alertas

VacationAccrualScheduler debe ser idempotente:

- La clave de ejecución es VACATION_ACCRUAL:YYYY-MM-DD.
- Una ejecución COMPLETED para la misma fecha no se repite.
- Las ejecuciones se almacenan en schedulerRuns.
- Las alertas se almacenan en vacationAlerts.
- Las alertas usan IDs determinísticos por fecha, employmentId y tipo.
- No duplicar alertas al reintentar.

## Cronograma

- `GET /api/v1/schedules` siempre debe paginar y aceptar búsqueda por cédula/nombre/proceso, estado y rango de fechas.
- La tabla debe consumir `VacationService.schedulePage`, que obtiene empleos y trabajadores por lote; nunca hacer una consulta por fila.
- Una asignación `CAUSED` debe identificar un período causado y coincidir exactamente con sus fechas. Una asignación `FUTURE` debe coincidir con el período `FORMING` correspondiente y no puede enviar `periodId`.
- No permitir programar vínculos retirados ni fechas fuera de la vigencia contractual, ni consumir más saldo que el disponible. Los festivos se devuelven como `holidayWarnings` y no reducen silenciosamente los días.
- Crear, editar y cancelar cronogramas deben usar `TransactionRepository.saveScheduleAndAudit`. Convertir a disfrute debe exigir que días disfrutados más compensados coincidan con `scheduledDays` y usar `completeScheduleTransaction`.
- `GET /api/v1/reports/schedules/annual` debe consultar por cruce de fechas del año, excluir `CANCELLED` por defecto, enriquecer mediante agregación/lotes y no ejecutar consultas N+1.
- El informe anual se entrega como PDF generado por `annualSchedulePdf.ts`, con resumen, detalle por programación, períodos de origen, firmas y nombre `programacion-vacaciones-YYYY.pdf`. Cada descarga debe auditarse como `SCHEDULE_ANNUAL_REPORT_EXPORTED`.
- El scheduler solo debe procesar vínculos activos.
- ensure debe seguir siendo idempotente.
- SCHEDULER_INTERVAL_MS recomendado: 86400000.

Tipos actuales de alerta:

- UPCOMING_ACCRUAL.
- OVERDUE_PERIOD.
- UPCOMING_VACATION.
- PENDING_AND_UPCOMING.

## Festivos y catálogos

Festivos:

- Colección holidays.
- CRUD administrativo.
- active representa desactivación lógica.
- GET /api/v1/holidays?year=YYYY es consulta pública autenticada por sesión de aplicación.
- Los cronogramas devuelven holidayWarnings.
- Los festivos no deben reducir silenciosamente scheduledDays.

Catálogos:

- Colección catalogItems.
- Tipos actuales: contract-types, processes, positions y supervisors.
- Los nombres deben poder consultarse y administrarse sin duplicados.
- Si se agregan tipos nuevos, actualizar UI, API, pruebas y documentación.

## API y validación

- Validar cuerpos con Zod antes de entrar al servicio.
- Mantener límites MAX_UPLOAD_MB, MAX_IMPORT_ROWS y MAX_PAGE_SIZE.
- Mantener Idempotency-Key en importaciones masivas.
- El cargue de vacaciones disfrutadas usa `/api/v1/vacation-settlements/import/preview` y `/api/v1/vacation-settlements/import/:batchId/apply`; nunca aplicar un archivo directamente sin vista previa, hash, token y autorización.
- Aceptar XLSX y CSV, conservar cada línea original en `sourceLines` y agrupar por cédula + documento de liquidación. Los días tomados y compensados se distribuyen sobre períodos anuales; `Días disfruta` solo es metadato calendario.
- Las liquidaciones importadas deben ser idempotentes por `sourceKey` y hash de línea. Un archivo igual no genera cambios; un archivo modificado debe mostrar diferencia y conservar auditoría.
- No eliminar liquidaciones: usar estado `ANULADA`, motivo, actor, versión e historial. Las anuladas se excluyen de saldos y listados activos, pero permanecen consultables por detalle y filtro.
- La lista de liquidaciones debe ser paginada y excluir `sourceLines` de la consulta de tabla; cargar el detalle original bajo demanda.
- La aplicación del lote debe ejecutarse en `TransactionRepository.applyVacationSettlementImport`; los períodos anteriores al 2025-01-01 se cierran con `Liquidación masiva por migración` y esa operación debe quedar auditada.
- La regularización de retiros debe ejecutarse después de validar la importación de disfrutes: `closeRetiredEmployments` carga períodos por lote, evita consultas N+1, cierra el ciclo a la fecha de retiro y no elimina liquidaciones ni períodos.
- Respetar las respuestas existentes y sus alias:
  - /api/v1/schedules y /api/v1/vacation-schedules.
  - /api/v1/settlements y /api/v1/vacation-settlements.
- Los errores deben usar códigos consistentes: UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, BUSINESS_RULE_VIOLATION, VALIDATION_ERROR e INTERNAL_ERROR.
- Las rutas de reportes deben conservar CSV, XLSX y PDF cuando ya estén soportadas.
- Las celdas XLSX deben protegerse contra inyección de fórmulas.

## Comandos

Desde la raíz del monorepo:

~~~bash
npm install
npm run typecheck
npm test
npm run build
npm run lint
~~~

Desde apps/api:

~~~bash
npm run typecheck
npm test
npm run build
npm run build:dev
npm run db:reset
~~~

El script dev del backend ejecuta dist/src/bootstrap/server.js. Después de cambiar TypeScript, compila antes de iniciar si no usas build:dev.

Para levantar todo:

~~~bash
npm run dev
~~~

## Pruebas obligatorias

Antes de entregar un cambio backend:

1. npm run typecheck.
2. npm test.
3. npm run build.
4. Probar el caso nuevo en MemoryStore.
5. Si cambia Mongo, validar índices y persistencia real.
6. Si cambia autenticación, probar login, refresh, logout, expiración, rotación y permisos.
7. Si cambia una ruta, probar validación, 401, 403, 404, 409 y respuesta exitosa.
8. Si cambia scheduler, probar idempotencia de ejecuciones, períodos y alertas.
9. Si cambia transacciones, verificar que las escrituras compuestas queden consistentes.
10. Revisar git diff para asegurar que no haya secretos.

## Rendimiento de consultas

## Administración de usuarios

- El perfil público de usuario incluye `displayName` y `jobTitle`; si una cuenta antigua no tiene estos campos, la API debe devolver valores de respaldo desde el usuario y el rol.
- `AuthService` normaliza los nombres de usuario, no devuelve hashes ni sales de contraseña y registra las altas, ediciones, activaciones e inactivaciones mediante auditoría en las rutas administrativas.
- Las cuentas se inactivan mediante `PATCH /api/v1/admin/users/:id` con `{ "active": false }`; no se eliminan. Activarlas usa `{ "active": true }`.
- Debe existir siempre al menos un administrador activo y un administrador no puede retirar su propio acceso. Mantener estas reglas si se cambia la interfaz o el repositorio.
- Las ediciones pueden cambiar usuario, rol y contraseña; la contraseña es opcional en una edición y nunca se persiste en texto plano.

- `/api/v1/employments` debe delegar paginación, búsqueda y filtros al puerto `EmploymentRepository.listEmploymentPage` cuando no se requiera un filtro calculado.
- Cuando el listado solicite `sort=pendingDays` o filtre por `vacationStatus`, `VacationService.listPage` debe calcular los resúmenes por lote, ordenar por `pendingDays` descendente y exponer `PENDING`, `SCHEDULED`, `OVERDUE` o `CLEAR`; no volver a usar la alerta de causación como estado de vacaciones.
- `VacationService.summariesFor` es la ruta obligatoria para construir una página o dashboard: obtiene trabajadores, períodos, liquidaciones y cronogramas por lote y los agrupa en memoria.
- No llamar `summary()` dentro de un `for` para una tabla. `summary()` y `detail()` quedan reservados para mutaciones o un vínculo seleccionado.
- Los métodos `listWorkersByIds`, `findByEmploymentIds`, `findSchedulesByEmploymentIds` y `findSettlementsByEmploymentIds` deben conservarse en MemoryStore y MongoStore.
- Los endpoints de períodos sin `employmentId` deben paginar vínculos y no ejecutar `ensure` sobre todos los empleados.
- El dashboard debe calcular salud, cobertura y desglose por proceso desde `summariesFor`; nunca introducir porcentajes fijos en la respuesta.
- La regularización masiva de retiros debe usar `findByEmploymentIds` una sola vez y `closeRetiredEmploymentsTransaction` en lotes; nunca llamar `findByEmploymentId` dentro de un bucle masivo.

## Documentación

Actualizar cuando corresponda:

- README.md.
- docs/openapi.yaml.
- docs/operations.md.
- docs/requirements-coverage.md.
- docs/adr/README.md para decisiones arquitectónicas.

No marcar una funcionalidad como Implementado si no existe evidencia en código, pruebas, endpoint o documentación.
