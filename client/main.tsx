import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "../public/base.css";
import "../public/planner.css";
import "../public/sales.css";
import { App } from "./ui";

if (window.location.pathname === "/login") void import("../public/login.css");

const theme = createTheme({
  fontFamily: '"Bricolage Grotesque", "Avenir Next", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Menlo, monospace",
  primaryColor: "blue",
  colors: {
    blue: [
      "#e3e9f8", "#cad5f2", "#a9bceb", "#89a2e1", "#6a89d2",
      "#4e6fbe", "#1b3fa0", "#173584", "#142f7a", "#10235f",
    ],
  },
  defaultRadius: "md",
  radius: { xs: "4px", sm: "4px", md: "8px", lg: "16px", xl: "16px" },
  headings: {
    fontFamily: '"Bricolage Grotesque", "Avenir Next", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    fontWeight: "750",
  },
  focusRing: "auto",
});

const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      getStyleNonce={() => nonce ?? ""}
    >
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
