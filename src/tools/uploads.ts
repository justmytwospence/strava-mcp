import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import { numericId } from "../validation.js";
import { CREATE, READ_ONLY } from "./annotations.js";

const DATA_TYPES = ["fit", "fit.gz", "tcx", "tcx.gz", "gpx", "gpx.gz"] as const;

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_upload",
    {
      title: "Get Upload Status",
      description:
        "Read upload processing status directly from Strava (one API request per call, never mirrored). Returns status, error and the resulting activity ID. Poll sparingly; check strava_sync_status or strava://mirror/budget and respect cooldown.",
      inputSchema: z.object({
        upload_id: numericId.describe("The upload ID"),
      }),
      annotations: READ_ONLY,
    },
    async ({ upload_id }) => {
      try {
        // Upload status is transient, so it is read through, never mirrored.
        const upload = await mirror().read(`/uploads/${upload_id}`);
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
        "Upload an activity file (FIT, TCX, GPX) to create a new activity (one API request plus later status polls). Requires activity:write. Maximum decoded file size 25 MiB; canonical base64 only. Do not replay a lost response; reconcile first. Returns an upload ID for strava_get_upload.",
      inputSchema: z.object({
        file_content: z
          .string()
          .min(4)
          .max(4 * Math.ceil((25 * 1024 * 1024) / 3))
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
          .refine(
            (v) =>
              Buffer.from(v, "base64").toString("base64") === v && Buffer.byteLength(v, "base64") <= 25 * 1024 * 1024,
            "Use canonical base64 of at most 25 MiB",
          )
          .describe("Base64-encoded file content (maximum decoded size 25 MiB)"),
        data_type: z.enum(DATA_TYPES).describe("File format: fit, fit.gz, tcx, tcx.gz, gpx, gpx.gz"),
        name: z.string().optional().describe("Activity name"),
        description: z.string().optional().describe("Activity description"),
        trainer: z.boolean().optional().describe("Whether this is a trainer/indoor activity"),
        commute: z.boolean().optional().describe("Whether this is a commute"),
        external_id: z.string().optional().describe("External identifier for deduplication"),
      }),
      annotations: CREATE,
    },
    async ({ file_content, data_type, name, description, trainer, commute, external_id }) => {
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

        const m = mirror();
        const upload = await m.write("POST", "/uploads", formData);
        // The new activity appears in the next listing; ask for one soon.
        await m.engine.enqueue("list_recent", "self", 5);
        return jsonResult(upload);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
