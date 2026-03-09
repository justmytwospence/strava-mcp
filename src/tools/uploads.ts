import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet, stravaPost } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import type { Upload } from "../types.js";

const DATA_TYPES = ["fit", "fit.gz", "tcx", "tcx.gz", "gpx", "gpx.gz"] as const;

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_upload",
    {
      title: "Get Upload Status",
      description:
        "Check the processing status of an upload. Returns status, error info, and the resulting activity ID once complete.",
      inputSchema: {
        upload_id: z.coerce.number().int().describe("The upload ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ upload_id }: { upload_id: number }) => {
      try {
        const upload = await stravaGet<Upload>(`/uploads/${upload_id}`);
        return jsonResult(upload);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_create_upload",
    {
      title: "Upload Activity File",
      description:
        "Upload an activity file (FIT, TCX, or GPX format) to create a new activity. The file content must be base64-encoded. Returns an upload ID to check processing status with strava_get_upload.",
      inputSchema: {
        file_content: z
          .string()
          .describe("Base64-encoded file content"),
        data_type: z
          .enum(DATA_TYPES)
          .describe("File format: fit, fit.gz, tcx, tcx.gz, gpx, gpx.gz"),
        name: z.string().optional().describe("Activity name"),
        description: z.string().optional().describe("Activity description"),
        trainer: z
          .boolean()
          .optional()
          .describe("Whether this is a trainer/indoor activity"),
        commute: z
          .boolean()
          .optional()
          .describe("Whether this is a commute"),
        external_id: z
          .string()
          .optional()
          .describe("External identifier for deduplication"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      file_content,
      data_type,
      name,
      description,
      trainer,
      commute,
      external_id,
    }: {
      file_content: string;
      data_type: string;
      name?: string;
      description?: string;
      trainer?: boolean;
      commute?: boolean;
      external_id?: string;
    }) => {
      try {
        const buffer = Buffer.from(file_content, "base64");
        const blob = new Blob([buffer]);

        const formData = new FormData();
        formData.append("file", blob, `upload.${data_type}`);
        formData.append("data_type", data_type);
        if (name) formData.append("name", name);
        if (description) formData.append("description", description);
        if (trainer !== undefined) formData.append("trainer", String(trainer));
        if (commute !== undefined) formData.append("commute", String(commute));
        if (external_id) formData.append("external_id", external_id);

        const upload = await stravaPost<Upload>("/uploads", formData as unknown as FormData);
        return jsonResult(upload);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
