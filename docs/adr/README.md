# Architecture Decision Records

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
