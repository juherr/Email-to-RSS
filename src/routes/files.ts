import { Context } from "hono";
import { Env } from "../types";

export async function handle(c: Context): Promise<Response> {
  const env = c.env as unknown as Env;

  if (!env.ATTACHMENT_BUCKET) {
    return new Response("Attachment storage not configured", { status: 404 });
  }

  const attachmentId = c.req.param("attachmentId");
  const filename = c.req.param("filename");

  const object = await env.ATTACHMENT_BUCKET.get(attachmentId);

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
