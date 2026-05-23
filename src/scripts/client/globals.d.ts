// Ambient declarations for browser globals injected at runtime via inline
// <script> bundles (see src/scripts/toast.ts and src/scripts/httpErrors.ts).
// Those helpers attach themselves to window rather than being importable, so the
// client TypeScript needs them declared here to type-check.

interface ToastOptions {
  type?: "info" | "success" | "warning" | "error" | (string & {});
  loading?: boolean;
  duration?: number;
}

interface ToastHandle {
  dismiss: () => void;
  update: (message: string, opts?: ToastOptions) => void;
}

interface ParseJsonOptions {
  prefix?: string;
  allowText?: boolean;
}

declare global {
  interface Window {
    showToast: (message: string, opts?: ToastOptions) => ToastHandle;
    parseJsonResponseOrThrow: (
      res: Response,
      opts?: ParseJsonOptions,
    ) => Promise<Record<string, unknown>>;
  }
}

export {};
