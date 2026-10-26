import { CHARACTER_LIMIT } from "../constants.js";
import { provenanceText } from "../format.js";
import type { Cached } from "../mirror.js";

/** Preserve the original body (especially XML) and expose provenance as separate context. */
export function resourceResult(uri: URL, value: Cached, mimeType = "application/json") {
  const text = mimeType === "application/json" ? JSON.stringify(value.data, null, 2) : String(value.data);
  if (text.length > CHARACTER_LIMIT) {
    throw new Error(
      `Resource exceeds ${CHARACTER_LIMIT} characters; it was not silently truncated. Use a bounded tool/query or a narrower schema resource.`,
    );
  }
  return {
    _meta: { provenance: value.meta },
    contents: [
      { uri: uri.href, text, mimeType, _meta: { provenance: value.meta } },
      { uri: `${uri.href}#provenance`, text: provenanceText(value.meta), mimeType: "text/plain" },
    ],
  };
}
