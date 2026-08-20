# Matriz de cobertura de la especificación

Esta matriz se mantiene como contrato de aceptación del Sistema Web de Control de Vacaciones. Cada nueva funcionalidad debe conservar las reglas de dominio y actualizar esta matriz con evidencia verificable (prueba, endpoint, pantalla o documento).

## Cobertura funcional

| Área de la especificación | Cobertura actual | Evidencia |
| --- | --- | --- |
| Worker y Employment, identidad por cédula y vínculos históricos | Implementado / reforzando idempotencia | `domain/workers`, `VacationService`, API de empleos |
| Fechas como `YYYY-MM-DD`, aniversarios y 29 de febrero | Implementado | `domain/shared/localDate.ts`, pruebas de dominio |
| Política, snapshot conceptual, período en formación y causación automática | Implementado | `domain/vacations/calculations.ts`, `VacationService.ensure` |
| Saldo derivado desde liquidaciones y saldo programable | Implementado | `pendingDays`, `scheduledDays`, `availableForScheduling` |
| Programación, reprogramación, cancelación y conversión a disfrute real | Implementado | `ScheduleManagement`, API paginada, validación de períodos/saldos y transacción de conversión |
| Asignación de cronograma desde Empleados | Implementado | Ficha del vínculo activo abre Cronograma con el empleado precargado y sus períodos bajo demanda |
| Liquidaciones, distribución por períodos y edición | Implementado en API; UI en evolución | rutas de `settlements`, validación de asignaciones |
| Importación masiva CSV, previsualización, validación e idempotencia | Implementado | `/api/v1/import/*`, `ImportBatch` lógico en respuesta |
| Dashboard, filtros y consultas | Implementado | `/api/v1/dashboard` con rango mensual/estado/proceso y `/api/v1/employments` con paginación, búsqueda por cédula, filtros y carga por lotes |
| Reportes de saldos, próximos a causar y auditoría | Implementado en API | `/api/v1/reports/*`, `/api/v1/audit` |
| MongoDB, índices, base aislada y documentos sin `_id` expuesto | Implementado | `MongoStore`, script `db:reset`, `.env.example` |
| Autenticación, cookies HttpOnly, JWT, hash scrypt y rate limit | Implementado | `AuthService`, middleware de sesión |
| Auditoría de operaciones mutables | Implementado | `auditEvents` y `AuditRepository` |
| Importación masiva de vacaciones disfrutadas, agrupación por documento, líneas originales y autorización de diferencias | Implementado | `SettlementManagement`, preview/apply transaccional, 80 liquidaciones activas validadas en Mongo |
| Cierre del ciclo de vacaciones al retiro del contrato | Implementado | `closeRetiredEmployments`, cierre idempotente por lotes, auditoría y 0 períodos abiertos en 1.254 retirados |

## Cobertura técnica y operativa

| Requisito | Estado | Próxima evidencia |
| --- | --- | --- |
| Arquitectura hexagonal y dependencias invertidas | Implementado | puertos, dominio, aplicación y adaptadores separados |
| TypeScript estricto y contratos compartidos | Implementado | `npm run typecheck` |
| Health live/ready y cierre ordenado | Implementado | endpoints y `server.ts` |
| OpenAPI y documentación de uso | Implementado | `docs/openapi.yaml`, `README.md` |
| Validación de archivos y límites de carga | Implementado | límite configurable y validación de filas |
| Concurrencia optimista | Implementado | `version` y `If-Match` en actualizaciones |
| Transacción Mongo para operaciones compuestas | Implementado | `withTransaction` persiste liquidación, cronograma y auditoría como una unidad; Docker usa replica set y Atlas soporta transacciones |
| Roles y permisos finos | Implementado | matriz centralizada `permissionService`, roles ADMIN/HR/VIEWER |
| Festivos configurables | Implementado | CRUD administrativo persistente, pantalla `Configuration`, filtro anual y advertencias de festivos dentro del cronograma |
| Excel/PDF, backups, observabilidad y CI/CD | Implementado / operativo | exportadores CSV/XLSX/PDF, request-id, workflow CI y guía de backups |
| Sesiones rotatorias y revocación | Implementado | colección `sessions`, hash de refresh token, rotación y logout |
| Scheduler diario | Implementado | `VacationAccrualScheduler`, activable por entorno e idempotente |
| Alertas persistidas | Implementado | colecciones `vacationAlerts` y `schedulerRuns`, claves determinísticas por fecha/vínculo/tipo y endpoints de consulta |
| Catálogos persistentes | Implementado | colección `catalogItems`, endpoints administrativos y pantalla `apps/web/src/components/Configuration.tsx` |
| Regularización masiva de retirados sin consultas N+1 | Implementado | `POST /api/v1/admin/retired-employments/close-pending`, `findByEmploymentIds` y transacciones por lotes |
| Cronograma paginado y búsqueda remota sin cargar todos los vínculos | Implementado | `GET /api/v1/schedules` con filtros, índices Mongo y `ScheduleManagement` |
| Programación anual entregable en PDF | Implementado | `GET /api/v1/reports/schedules/annual`, PDF horizontal con resumen, detalle, firmas y auditoría |

## Criterio de aceptación

No se considera terminada una operación si permite guardar datos que rompan alguno de estos invariantes:

1. Una misma cédula representa un solo `Worker`.
2. Una misma cédula con la misma fecha de ingreso representa el mismo vínculo.
3. Una cédula con otra fecha de ingreso representa un reingreso histórico.
4. Las asignaciones de una programación coinciden con sus días programados.
5. Las asignaciones de una liquidación coinciden con sus días disfrutados y compensados.
6. Una liquidación no puede consumir más saldo pendiente del vínculo.
7. Una programación no puede reservar más saldo disponible para programar.
8. El período en formación no se suma al saldo causado.
9. Toda mutación genera un evento de auditoría sin contraseñas ni tokens.
10. Los endpoints protegidos responden `401` sin una sesión válida.
