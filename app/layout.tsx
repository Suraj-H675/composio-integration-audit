import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Composio integration audit — 100 apps",
  description: "A 100-app research case study covering buildability, access, APIs, MCP capability, and Composio coverage.",
  applicationName: "Composio Integration Audit",
  keywords: ["Composio", "Product Ops", "MCP", "agent toolkit", "API audit"]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
