import { z } from "zod";
import { localDateSchema } from "./common.js";

export const fileImportInputSchema = z
  .object({
    fileName: z.string().trim().min(1),
    contentBase64: z.string().optional(),
    content: z.string().optional(),
  })
  .refine((value) => Boolean(value.contentBase64 || value.content), {
    message: "Debe seleccionar un archivo",
  });

export const closureDatesInputSchema = z.object({
  fromDate: localDateSchema.optional(),
  asOf: localDateSchema.optional(),
});

export const previewTokenInputSchema = z.object({ previewToken: z.string().min(1) });
export const csvContentInputSchema = z.object({ content: z.string().min(1) });

export function employmentImportInputSchema(maxRows: number) {
  return z.object({
    rows: z.array(z.unknown()).min(1).max(maxRows),
    idempotencyKey: z.string().trim().min(8).optional(),
  });
}

export function employmentImportConfirmationSchema(maxRows: number) {
  return z.object({ rows: z.array(z.unknown()).min(1).max(maxRows) });
}
