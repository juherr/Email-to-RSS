import variablesCss from "../../styles/variables.css";
import layoutCss from "../../styles/layout.css";
import componentsCss from "../../styles/components.css";
import utilitiesCss from "../../styles/utilities.css";
import { interactiveScripts } from "../../scripts/index";

const designSystem = [variablesCss, layoutCss, componentsCss, utilitiesCss].join("\n");

type LayoutProps = {
  title: string;
  children: import("hono/jsx").Child;
};

export const Layout = ({ title, children }: LayoutProps) => {
  return (
    <html>
      <head>
        <title>{title} - Email to RSS Admin</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <style dangerouslySetInnerHTML={{ __html: designSystem }} />
        <script dangerouslySetInnerHTML={{ __html: interactiveScripts + ";" }} />
      </head>
      <body class="page">{children}</body>
    </html>
  );
};

export { Layout as layout };

export function clampText(value: string, maxLen: number): string {
  const raw = `${value || ""}`;
  if (raw.length <= maxLen) {
    return raw.trim();
  }
  if (maxLen <= 3) {
    return raw.slice(0, maxLen).trim();
  }
  return `${raw.slice(0, maxLen - 3).trimEnd()}...`;
}
