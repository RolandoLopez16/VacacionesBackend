import type { VacationStore } from "../../application/ports/repositories.js";
import type { AuthService } from "../../application/services/authService.js";
import type { VacationService } from "../../application/services/vacationService.js";

export interface RouteDependencies {
  store: VacationStore;
  service: VacationService;
  auth: AuthService;
}
