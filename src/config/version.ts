import pkg from "../../package.json";

/**
 * The running app version, inlined from package.json at bundle time (the Worker
 * has no filesystem at runtime). Surfaced in the admin/status footer and the
 * /health JSON so a self-hoster can tell which build is deployed.
 */
export const APP_VERSION: string = pkg.version;
