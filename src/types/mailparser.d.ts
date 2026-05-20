// Extend mailparser types for Buffer in worker environment
declare module "buffer-polyfill" {
  global {
    var Buffer: {
      from(
        data: string,
        encoding?: string,
      ): {
        toString(encoding?: string): string;
      };
    };
  }
}

// Add missing atob declaration
declare module "atob-polyfill" {
  global {
    function atob(data: string): string;
  }
}
