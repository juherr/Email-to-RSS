import { Context } from "hono";
import { Env } from "../types";
import { getAttachmentBucket } from "../utils/attachments";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  const bucket = getAttachmentBucket(c.env);
  if (!bucket) {
    return new Response("Attachment storage not configured", { status: 404 });
  }

  const attachmentId = c.req.param("attachmentId");
  const filename = c.req.param("filename");

  if (!attachmentId || !filename) {
    return new Response("Not found", { status: 404 });
  }

  const object = await bucket.get(attachmentId);

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  if (!headers.get("Content-Disposition")) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${decodeURIComponent(filename)}"`,
    );
  }

  return new Response(object.body, { headers });
}
