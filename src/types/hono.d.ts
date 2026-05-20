import { Env } from "./index";

// Extend Hono's types to include our custom environment
declare module "hono" {
  interface ContextVariableMap {
    env: Env;
  }
}
