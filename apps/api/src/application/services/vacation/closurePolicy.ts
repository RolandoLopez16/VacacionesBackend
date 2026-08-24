import { parseLocalDate, type LocalDate } from "../../../domain/shared/localDate.js";
import type { VacationStore } from "../../ports/repositories.js";

export const CLOSURE_FROM_DATE_SETTING = "VACATION_CLOSURE_FROM_DATE";
export const DEFAULT_CLOSURE_FROM_DATE = "2025-01-01" as LocalDate;

const LOCAL_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDateString(value: string): boolean {
  if (!LOCAL_DATE_REGEX.test(value)) return false;
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

export async function readClosureFromDate(
  store: Pick<VacationStore, "findSystemSettingByKey">,
): Promise<LocalDate> {
  const setting = await store.findSystemSettingByKey(CLOSURE_FROM_DATE_SETTING);
  if (!setting?.value || !isLocalDateString(setting.value)) return DEFAULT_CLOSURE_FROM_DATE;
  return parseLocalDate(setting.value);
}
