import { z } from "zod";
import {
  optionalQueryDateSchema,
  optionalQueryStringSchema,
  paginationQuerySchema,
} from "./common.js";

export function periodListQuerySchema(maxPageSize: number) {
  return paginationQuerySchema(maxPageSize).extend({
    employmentId: optionalQueryStringSchema,
    asOf: optionalQueryDateSchema,
  });
}

export const periodDetailParamsSchema = z.object({ periodId: z.string().min(1) });
