import { Context } from "hono";
import { Env } from "../types";

export const FAVICON_PATH = "/favicon.svg";

// Project favicon — reuses the header's envelope logo (brand orange #f6821f),
// rendered as a white envelope on a rounded orange square for legibility at 16px.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#f6821f"/>
  <g fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 9h18c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V11c0-1.1.9-2 2-2z"/>
    <polyline points="27,11 16,18.5 5,11"/>
  </g>
</svg>`;

export function handle(_c: Context<{ Bindings: Env }>): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
