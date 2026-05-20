import { Context } from "hono";
import { Env } from "../types";
import {
  ForwardEmailPayload,
  handleForwardEmail,
} from "../lib/forwardemail";

export async function handle(c: Context): Promise<Response> {
  try {
    const env = c.env as unknown as Env;
    const payload: ForwardEmailPayload = await c.req.json();

    console.log("Received email:", {
      to: payload.recipients?.[0],
      from: payload.from?.text || "Unknown",
      subject: payload.subject,
      contentType: payload.html ? "HTML" : "Text",
    });

    return handleForwardEmail(payload, env);
  } catch (error) {
    console.error("Error processing email:", error);
    return new Response("Error processing email", { status: 500 });
  }
}
