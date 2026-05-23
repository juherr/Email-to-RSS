import { Context } from "hono";
import { Env } from "../types";
import { getStats } from "../utils/stats";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json(await getStats(c.env));
}
