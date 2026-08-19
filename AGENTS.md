# AGENTS.md — Sistema Web Vaca EFA

Este archivo es la guía de trabajo para futuros cambios en el monorepo. El sistema controla empleados, vínculos laborales, causación de vacaciones, saldos, programación, liquidaciones, festivos, alertas, auditoría e importación masiva.

## 1. Alcance y estructura

El repositorio es un monorepo npm con tres proyectos:

~~~text
apps/api/          Backend Express + TypeScript + MongoDB
apps/web/          Frontend React + Vite + TypeScript
packages/contracts Contratos TypeScript compartidos entre API y SPA
docs/              OpenAPI, operación, arquitectura y cobertura
docker-compose.yml MongoDB replica set + API + frontend
~~~

La ruta de ejecución local es:

- Frontend: http://localhost:5173
- API: http://localhost:3000
- Proxy Vite: /api hacia http://localhost:3000

No se debe crear un segundo proyecto paralelo ni mover la base de vacaciones a la base de nómina. La base lógica actual es efagram_vacaciones y debe mantenerse separada de efagram_nomina.

## 2. Reglas generales para cualquier cambio

1. Leer primero README.md, docs/operations.md, docs/requirements-coverage.md y docs/openapi.yaml cuando el cambio afecte arquitectura, operación o API.
2. Mantener TypeScript estricto y los contratos compartidos en packages/contracts como fuente común para API y frontend.
3. Las fechas de negocio son YYYY-MM-DD (LocalDate). No usar new Date('YYYY-MM-DD') para cálculos de dominio ni introducir horas o zonas horarias en períodos laborales.
4. No guardar lógica de negocio en componentes React, rutas Express o adaptadores Mongo. La regla debe vivir en domain o application/services y exponerse mediante puertos.
5. Toda mutación debe validar entrada, permisos, versión cuando corresponda y registrar auditoría sin contraseñas, tokens ni secretos.
6. No imprimir ni commitear MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET, contraseñas, cookies o tokens. Los secretos solo viven en .env/secret manager; actualizar .env.example con marcadores seguros.
7. Mantener compatibilidad con las rutas existentes y sus alias (/schedules y /vacation-schedules, /settlements y /vacation-settlements) salvo que exista una migración explícita.
8. No hacer dropDatabase, git reset --hard ni borrar directorios amplios. db:reset es destructivo y solo aplica sobre la base dedicada de vacaciones.
9. No cambiar índices o nombres de colecciones sin revisar datos existentes, el script de reset, los adaptadores Memory/Mongo y la documentación.
10. Los cambios de comportamiento deben incluir prueba o actualizar la evidencia en docs/requirements-coverage.md.

## 3. Backend (apps/api)

### Capas

- src/domain: modelos y cálculos puros, independientes de Express/Mongo.
- src/application/services: casos de uso, invariantes, permisos de negocio y orquestación.
- src/application/ports: interfaces de repositorio y transacciones.
- src/adapters/outbound/memory: almacenamiento para pruebas rápidas.
- src/adapters/outbound/mongodb: persistencia oficial y transacciones MongoDB.
- src/bootstrap/app.ts: HTTP, validación Zod, cookies, rutas y manejo de errores.
- src/bootstrap/server.ts: composición de dependencias, escucha HTTP y scheduler.
- src/infrastructure: configuración, reportes y reset de base.

### Invariantes que nunca se deben romper

- Una cédula representa un único Worker normalizado.
- La misma cédula con la misma fecha de contrato actualiza el mismo vínculo.
- La misma cédula con otra fecha representa un reingreso histórico.
- El período en formación no entra en el saldo causado.
- Las asignaciones de un cronograma suman exactamente scheduledDays.
- Las asignaciones de una liquidación coinciden con días disfrutados y compensados.
- Una liquidación no puede consumir más saldo pendiente.
- Un cronograma no puede reservar más saldo disponible.
- Las fechas de retiro no pueden ser anteriores a la fecha de contrato.
- Las actualizaciones mutables deben respetar version/If-Match y devolver conflicto 409 si la versión está desactualizada.

### Persistencia MongoDB

- Usar MongoStore a través de VacationStore; no instanciar Mongo directamente desde rutas o componentes.
- Cada colección nueva requiere: modelo, puerto, MemoryStore, MongoStore, índices, reset, pruebas y documentación.
- Los documentos Mongo no deben exponer _id; usar strip como el resto del adaptador.
- Las operaciones compuestas de cronograma completado deben usar TransactionRepository.completeScheduleTransaction. En Mongo se ejecutan con client.withSession(...withTransaction(...)); en pruebas MemoryStore debe conservar la misma interfaz.
- MongoDB Atlas ya soporta transacciones. El Docker local debe iniciar mongod --replSet rs0 y mongo-init debe inicializar el replica set.
- No usar transacciones para una sola escritura innecesariamente, pero sí para liquidación + cronograma + auditorías.

### Autenticación y autorización

- Access y refresh JWT van en cookies HttpOnly; el frontend no debe guardar tokens en localStorage.
- Los refresh tokens se almacenan únicamente como hash en sessions, se rotan y se revocan al cerrar sesión.
- Contraseñas usan scrypt con salt; nunca almacenar ni retornar contraseñas.
- requireSession y permissionService son la fuente central de permisos. No agregar permisos ad hoc en una ruta.
- Roles vigentes: ADMIN, HR, VIEWER, READ_ONLY.
- Toda ruta nueva debe quedar clasificada en permissionFor y probar 401 sin sesión y 403 para un rol no autorizado.
- En producción usar HTTPS, cookies Secure, secretos independientes y CORS restringido. La contraseña bootstrap siempre debe venir del entorno y cambiarse después del primer acceso.

### Festivos, alertas y scheduler

- Festivos: colección holidays, CRUD administrativo, active como desactivación lógica y consulta pública por año.
- Un cronograma conserva los días solicitados por el usuario; los festivos activos solo se devuelven como holidayWarnings.
- El scheduler diario debe ser idempotente. La clave de ejecución es VACATION_ACCRUAL:YYYY-MM-DD.
- Las alertas usan identificadores determinísticos por fecha, vínculo y tipo; no crear duplicados al reintentar.
- Las ejecuciones se guardan en schedulerRuns y las alertas en vacationAlerts.
- Si se agregan tipos de alerta, actualizar el modelo, servicio, persistencia, endpoint, pruebas, OpenAPI y matriz de cobertura.

### Importación y reportes

- La carga masiva debe conservar validación por fila, límite MAX_IMPORT_ROWS e idempotencia mediante Idempotency-Key.
- No aceptar archivos o payloads sin límites. Mantener MAX_UPLOAD_MB y MAX_PAGE_SIZE configurables.
- Reportes deben continuar disponibles en JSON, CSV, XLSX y PDF cuando aplique.
- Toda celda exportada a Excel debe protegerse contra inyección de fórmulas (=, +, - y @).

## 4. Frontend (apps/web)

1. Usar React + TypeScript y los DTO de @vaca-efa/contracts; no duplicar interfaces de API en componentes.
2. Mantener credentials: include en fetch y el refresco automático ante 401 mediante /api/v1/auth/refresh.
3. No leer secretos ni construir URLs de Mongo en el navegador. Las llamadas deben usar rutas /api/v1/... y el proxy de Vite.
4. Mantener fechas como strings YYYY-MM-DD hasta la presentación; no convertirlas a Date para enviarlas al backend.
5. Los formularios deben mostrar errores del API, estados de carga, estado vacío y confirmación de operaciones mutables.
6. Respetar la separación visual actual: dashboard, empleados, períodos, cronograma, disfrutadas y auditoría. Los cambios de UI deben conservar navegación, responsive y accesibilidad básica de botones, labels e inputs.
7. Para empleados conservar los ocho campos funcionales: cédula, nombre, fecha de contrato, fecha de retiro, tipo de contrato, proceso, cargo y supervisor.
8. Las nuevas pantallas administrativas de festivos, catálogos, alertas o scheduler deben consumir los endpoints existentes y no calcular saldos legalmente en el cliente.
9. Si cambia un DTO, actualizar primero packages/contracts, luego backend y frontend, y verificar compilación de los tres proyectos.

## 5. Comandos de trabajo

Desde la raíz:

~~~bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run lint
~~~

El script del API ejecuta el JavaScript compilado desde apps/api/dist. Después de modificar backend, ejecutar npm run build o npm run build:dev --workspace @vaca-efa/api antes de levantar el entorno.

Para Mongo local:

~~~bash
docker compose up --build
~~~

Para limpiar solo la base dedicada de vacaciones y recrear el administrador:

~~~bash
npm run db:reset --workspace @vaca-efa/api
~~~

No ejecutar el reset contra una base de nómina. Confirmar STORAGE_MODE=mongo y MONGODB_DATABASE=efagram_vacaciones antes de usarlo.

## 6. Flujo de validación obligatorio

Antes de entregar un cambio:

1. Ejecutar npm run typecheck.
2. Ejecutar npm test y agregar pruebas para invariantes, seguridad o persistencia modificada.
3. Ejecutar npm run build.
4. Si cambia Mongo, verificar índices, reset y una prueba real contra Mongo o Docker replica set.
5. Si cambia una ruta, actualizar docs/openapi.yaml y comprobar 401, permisos, validación y formato de respuesta.
6. Si cambia UI, comprobar login, carga inicial, estados vacíos, errores y flujo principal en http://localhost:5173.
7. Revisar que no haya secretos en git diff, logs, artefactos ni archivos nuevos.
8. Actualizar README.md, docs/operations.md, ADR o requirements-coverage.md cuando cambie una decisión, operación o cobertura.

## 7. Archivos sensibles y de operación

- .env contiene secretos y nunca se versiona.
- .env.example solo contiene valores de ejemplo.
- dist/, coverage/, logs y dependencias instaladas son artefactos locales.
- docker-compose.yml debe conservar replica set para que las transacciones funcionen localmente.
- docs/operations.md es la referencia para despliegue, backups, scheduler, transacciones y seguridad.
- El administrador inicial es solo bootstrap local; cambiar la contraseña antes de producción.

## 8. Reglas de rendimiento y paginación

- No construir listados con `listEmployments()` seguido de una llamada `summary()` por cada vínculo. Esa pauta produce N+1 consultas y no es aceptable con MongoDB Atlas Free.
- Las tablas deben usar `GET /api/v1/employments?page=...&pageSize=...`; la interfaz permite 10, 20, 30 y 100 registros por página.
- La búsqueda de empleados debe priorizar cédula y ejecutarse en el servidor. Los formularios de cronograma y liquidación deben buscar cédula bajo demanda, no cargar todos los vínculos en un `<select>`.
- Los resúmenes de una página deben leer trabajadores, períodos, cronogramas y liquidaciones por lotes. El detalle completo solo se consulta para el vínculo seleccionado.
- El dashboard debe devolver indicadores filtrados por rango, estado y proceso y limitar la lista visual a los casos necesarios. Las exportaciones completas son acciones separadas.
- Toda colección que participe en una búsqueda o relación paginada debe tener índice revisado en `MongoStore.ensureIndexes()` y prueba de paginación en MemoryStore.
