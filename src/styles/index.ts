// Main style exports file
// Combines all style components and re-exports them for easy imports

import { variables, lightModeTheme, fontImport } from "./variables";
import { layoutStyles } from "./layout";
import { componentStyles } from "./components";
import { utilityStyles } from "./utilities";

// Combine all style components into a single CSS string
export const designSystem = `
  ${variables}
  ${lightModeTheme}
  ${fontImport}
  ${layoutStyles}
  ${componentStyles}
  ${utilityStyles}
`;

// Re-export everything for modular usage if needed
export {
  variables,
  lightModeTheme,
  fontImport,
  layoutStyles,
  componentStyles,
  utilityStyles,
};
