import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.js";

export const paginationSchema = {
  page: z
    .coerce.number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number (default 1)"),
  per_page: z
    .coerce.number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Results per page (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE})`),
};

export function formatPaginationNote(
  count: number,
  page: number,
  perPage: number,
): string {
  if (count < perPage) {
    return `Showing ${count} result(s).`;
  }
  return `Showing ${count} result(s) (page ${page}, ${perPage} per page). Request next page for more.`;
}
